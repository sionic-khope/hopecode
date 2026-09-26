// Model list cache (models.json in the app data folder). Filled by a message-less startup probe (an SDK Query
// that only initializes: no prompt is ever sent) and by live sessions' supportedModels(); persisted so the next
// launch shows real names immediately, broadcast as `models:updated` whenever it changes.
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ModelInfo, Options } from '@anthropic-ai/claude-agent-sdk';
import { EFFORT_LEVELS, MODEL_PROBE_TIMEOUT_MS } from '../../shared/constants';
import type { EffortLevel, ModelOption } from '../../shared/types';
import type { Broadcaster, QueryFn } from '../contracts';
import { PRIVATE_FILE_MODE, mkdirPrivate } from '../persistence/jsonl';

/** SDK ModelInfo -> the renderer's ModelOption (label = the SDK's displayName). */
export function toModelOption(m: ModelInfo): ModelOption {
  return {
    value: m.value,
    label: m.displayName,
    description: m.description,
    ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
    ...(m.supportsEffort === false
      ? { effortLevels: [] }
      : m.supportedEffortLevels
        ? { effortLevels: [...m.supportedEffortLevels] }
        : {}),
  };
}

const isEffort = (v: unknown): v is EffortLevel => typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);

/** A cached row read back from disk; anything malformed is dropped (the file is ours but may be stale / damaged). */
function parseOption(raw: unknown): ModelOption | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.value !== 'string' || !o.value || typeof o.label !== 'string') return null;
  const option: ModelOption = { value: o.value, label: o.label };
  if (typeof o.description === 'string') option.description = o.description;
  if (typeof o.resolvedModel === 'string' && o.resolvedModel) option.resolvedModel = o.resolvedModel;
  if (Array.isArray(o.effortLevels)) option.effortLevels = o.effortLevels.filter(isEffort);
  return option;
}

interface CacheFile {
  version: 1;
  fetchedAt: number;
  models: ModelOption[];
}

export interface ModelCatalog {
  /** Read models.json (missing / unreadable -> empty catalog). */
  load(): Promise<void>;
  /** Cached list, or null before anything was reported. */
  get(): ModelOption[] | null;
  fetchedAt(): number | null;
  /** Replace the list (SDK report); persists and broadcasts only when it changed. */
  update(models: ModelOption[]): Promise<void>;
}

export interface ModelCatalogDeps {
  filePath: string;
  broadcaster?: Broadcaster;
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
}

export function createModelCatalog(deps: ModelCatalogDeps): ModelCatalog {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string, err?: unknown) => console.error(message, err ?? ''));
  let models: ModelOption[] | null = null;
  let fetchedAt: number | null = null;
  let writing: Promise<void> = Promise.resolve();

  async function persist(): Promise<void> {
    const data: CacheFile = { version: 1, fetchedAt: fetchedAt ?? now(), models: models ?? [] };
    await mkdirPrivate(dirname(deps.filePath));
    const tmp = `${deps.filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
      await rename(tmp, deps.filePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(deps.filePath, 'utf8')) as Partial<CacheFile>;
        const parsed = Array.isArray(raw.models) ? raw.models.map(parseOption).filter((o): o is ModelOption => o !== null) : [];
        if (parsed.length > 0) {
          models = parsed;
          fetchedAt = typeof raw.fetchedAt === 'number' ? raw.fetchedAt : null;
        }
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') log('[models] cache unreadable; using the fallback list', err);
      }
    },
    get: () => models,
    fetchedAt: () => fetchedAt,
    async update(next) {
      if (next.length === 0) return;
      const changed = JSON.stringify(next) !== JSON.stringify(models);
      models = next;
      fetchedAt = now();
      if (!changed) return;
      deps.broadcaster?.emit('models:updated', next);
      const write = writing.then(persist, persist);
      writing = write.catch((err: unknown) => log('[models] cache save failed', err));
      await writing;
    },
  };
}

export interface ModelProbeInput {
  query: QueryFn;
  cwd: string;
  env: Record<string, string>;
  pathToClaudeCodeExecutable: string;
  timeoutMs?: number;
  log?: (message: string, err?: unknown) => void;
}

/**
 * Opens a streaming-input Query whose input never yields, waits for the CLI's initialize answer (models, account)
 * and closes it. No user message is sent, so no API turn happens; nothing is persisted (`persistSession: false`).
 * Rejects on timeout or CLI failure; the Query is always closed.
 */
export async function probeModels(input: ModelProbeInput): Promise<ModelOption[]> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  async function* never(): AsyncGenerator<never, void> {
    await gate;
  }
  const abort = new AbortController();
  const options: Options = {
    cwd: input.cwd,
    env: input.env,
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    persistSession: false,
    // Same settings layer as an untrusted thread: a `model` set in the user's settings changes what `default` runs as.
    settingSources: ['user'],
    abortController: abort,
    stderr: (data: string) => input.log?.(`[models:probe] ${data.trimEnd()}`),
  };
  const q = input.query({ prompt: never(), options });
  // Drain the stream so the CLI's messages never back up; its end is awaited after close().
  const drained = (async () => {
    try {
      for await (const _ of q) {
        // init / status messages carry nothing the probe needs.
      }
    } catch {
      // close() / abort ends the stream with an error on some CLI versions.
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('model probe timed out')), input.timeoutMs ?? MODEL_PROBE_TIMEOUT_MS);
    });
    const init = await Promise.race([q.initializationResult(), timeout]);
    return (init.models ?? []).map(toModelOption);
  } finally {
    clearTimeout(timer);
    release();
    try {
      q.close();
    } catch {
      abort.abort();
    }
    await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
}
