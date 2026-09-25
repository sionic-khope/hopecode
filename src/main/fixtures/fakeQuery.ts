// Scripted fake of the SDK `query()` (plan 4.2 fixtures). Used by 2A unit tests and by
// `HOPECODE_FIXTURES=1` fixture mode / e2e. Implements the Query subset ThreadRunner uses:
// async iteration, interrupt, close, setPermissionMode, setModel, applyFlagSettings (effortLevel), supportedModels,
// getContextUsage.
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  CanUseTool,
  ModelInfo,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { RateLimitInfoLite, StructuredPatchHunk } from '../../shared/types';
import type { QueryFn } from '../contracts';

export const FAKE_CLI_VERSION = '2.1.282';
export const FAKE_DEFAULT_MODEL = 'claude-fable-5';

export type FakeStep =
  /** stream_event text deltas (split into `chunks`) followed by the full assistant text message. */
  | { type: 'text'; text: string; chunks?: number }
  /** stream_event text deltas only (no final assistant message): a reply cut off mid-stream. */
  | { type: 'partial'; text: string }
  /** assistant tool_use -> optional canUseTool -> user tool_result (+ tool_use_result.structuredPatch). */
  | {
      type: 'tool';
      name: string;
      input: Record<string, unknown>;
      result?: string;
      structuredPatch?: StructuredPatchHunk[];
      permission?: boolean;
      suggestions?: PermissionUpdate[];
    }
  | { type: 'rateLimit'; info: RateLimitInfoLite }
  | { type: 'assistantError'; error: 'rate_limit' | 'authentication_failed' }
  | { type: 'apiRetry'; error: 'rate_limit' }
  | { type: 'result'; isError?: boolean; apiErrorStatus?: number; message?: string }
  /** Block until controller.release(), interrupt() or close(). */
  | { type: 'pause' };

export interface FakeTurnContext {
  /** Index of the query() call (0-based, across the controller). */
  callIndex: number;
  /** Turn index within this Query. */
  turnIndex: number;
  prompt: string;
  configDir: string | undefined;
  options: Options;
  /** Model in effect for this turn (`options.model`, updated by `setModel()`); undefined = default. */
  model: string | undefined;
  /** Permission mode in effect for this turn (`options.permissionMode`, updated by `setPermissionMode()`). */
  permissionMode: string;
  /** Effort in effect (`options.effort`, updated by `applyFlagSettings({effortLevel})`); undefined = model default. */
  effort: string | undefined;
}

/** Steps for one turn. A success `result` is appended unless the steps contain a `result`. */
export type FakeScenario = (ctx: FakeTurnContext) => FakeStep[];

export interface FakeCall {
  index: number;
  options: Options;
  configDir: string | undefined;
  resume: string | undefined;
  /** true when `resume` was requested but `<configDir>/projects/*\/<sid>.jsonl` did not exist (writeTranscript only). */
  resumeMissing: boolean;
  sessionId: string;
  prompts: string[];
  permissionModes: string[];
  models: (string | undefined)[];
  /** `applyFlagSettings({effortLevel})` values, in order (null = back to the model default). */
  efforts: (string | null)[];
  interrupts: number;
  /** canUseTool results returned by the host, in order. */
  permissionResults: PermissionResult[];
  closed: boolean;
  /** true once the consumer received the end of the message stream. */
  ended: boolean;
}

export interface FakeQueryOptions {
  scenario?: FakeScenario;
  /** getContextUsage().percentage */
  contextPercentage?: number;
  /** Simulate CLI transcript files under `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<sid>.jsonl` (+ `<sid>/`). */
  writeTranscript?: boolean;
  models?: ModelInfo[];
}

export interface FakeQueryController {
  query: QueryFn;
  calls: FakeCall[];
  /** Ordered timeline: `open:<i>`, `prompt:<i>`, `close:<i>`, `end:<i>`, `interrupt:<i>`, ... */
  timeline: string[];
  /** Resolve every pending `pause` step. */
  release(): void;
  setContextPercentage(value: number): void;
}

export const FAKE_MODELS: ModelInfo[] = [
  {
    value: 'default',
    displayName: 'Default',
    description: 'Recommended model',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'fable',
    displayName: 'Fable',
    description: 'Most capable',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'sonnet',
    displayName: 'Sonnet',
    description: 'Fast everyday model',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
];

export function defaultFakeScenario(): FakeStep[] {
  return [{ type: 'text', text: 'Hello from the fake session.', chunks: 3 }];
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function promptText(msg: SDKUserMessage): string {
  const content = msg.message.content;
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Microtask-only delay so close() -> stream end is observably asynchronous even under fake timers. */
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

class Channel<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T, void>) => void)[] = [];
  private ended = false;
  constructor(private readonly onEnd: () => void) {}

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.items.length === 0) this.flushEnd();
  }

  private flushEnd(): void {
    const waiters = this.waiters;
    this.waiters = [];
    if (waiters.length > 0) this.onEnd();
    for (const w of waiters) w({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<T, void>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
    if (this.ended) {
      this.onEnd();
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export function createFakeQuery(opts: FakeQueryOptions = {}): FakeQueryController {
  const scenario = opts.scenario ?? defaultFakeScenario;
  const models = opts.models ?? FAKE_MODELS;
  let contextPercentage = opts.contextPercentage ?? 42;
  const calls: FakeCall[] = [];
  const timeline: string[] = [];
  const pauseWaiters = new Set<() => void>();
  let requestCounter = 0;

  function release(): void {
    for (const w of [...pauseWaiters]) w();
    pauseWaiters.clear();
  }

  const query = ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
    const options = params.options ?? {};
    const index = calls.length;
    const configDir = options.env?.CLAUDE_CONFIG_DIR;
    // Real SDK session ids are UUIDs (the runner refuses to resume anything else).
    const sessionId = options.resume ?? randomUUID();
    const cwd = options.cwd ?? process.cwd();
    const transcriptDir = configDir ? join(configDir, 'projects', encodeCwd(cwd)) : undefined;

    let resumeMissing = false;
    if (opts.writeTranscript && options.resume && configDir) {
      const projects = join(configDir, 'projects');
      resumeMissing =
        !existsSync(projects) ||
        !readdirSync(projects).some((d) => existsSync(join(projects, d, `${options.resume}.jsonl`)));
    }

    const call: FakeCall = {
      index,
      options,
      configDir,
      resume: options.resume,
      resumeMissing,
      sessionId,
      prompts: [],
      permissionModes: [],
      models: [],
      efforts: [],
      interrupts: 0,
      permissionResults: [],
      closed: false,
      ended: false,
    };
    calls.push(call);
    timeline.push(`open:${index}`);

    const out = new Channel<SDKMessage>(() => {
      if (!call.ended) {
        call.ended = true;
        timeline.push(`end:${index}`);
      }
    });
    const emit = (m: Record<string, unknown>) => out.push(m as unknown as SDKMessage);

    const writeTranscript = (line: Record<string, unknown>) => {
      if (!opts.writeTranscript || !transcriptDir) return;
      mkdirSync(join(transcriptDir, sessionId), { recursive: true });
      appendFileSync(join(transcriptDir, `${sessionId}.jsonl`), `${JSON.stringify({ ...line, writer: configDir })}\n`);
      writeFileSync(join(transcriptDir, sessionId, 'meta.json'), JSON.stringify({ writer: configDir }));
    };

    let turnIndex = 0;
    let currentModel = options.model;
    let currentPermissionMode: string = options.permissionMode ?? 'default';
    let currentEffort: string | undefined = typeof options.effort === 'string' ? options.effort : undefined;
    let initSent = false;
    let interruptTurn: (() => void) | null = null;
    let finished = false;

    async function runTurn(text: string): Promise<void> {
      if (!initSent) {
        initSent = true;
        emit({
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          claude_code_version: FAKE_CLI_VERSION,
          model: options.model && options.model !== 'default' ? options.model : FAKE_DEFAULT_MODEL,
          permissionMode: options.permissionMode ?? 'default',
          cwd,
          tools: [],
        });
      }
      writeTranscript({ type: 'user', text });

      const steps = scenario({
        callIndex: index,
        turnIndex: turnIndex++,
        prompt: text,
        configDir,
        options,
        model: currentModel,
        permissionMode: currentPermissionMode,
        effort: currentEffort,
      });
      let interrupted = false;
      const interruptPromise = new Promise<void>((resolve) => {
        interruptTurn = () => {
          interrupted = true;
          resolve();
        };
      });
      const result = (isError: boolean, apiErrorStatus?: number, message?: string) =>
        emit({
          type: 'result',
          subtype: isError ? 'error_during_execution' : 'success',
          is_error: isError,
          ...(apiErrorStatus !== undefined ? { api_error_status: apiErrorStatus } : {}),
          ...(message !== undefined ? { errors: [message] } : {}),
          total_cost_usd: 0,
          session_id: sessionId,
        });

      let sawResult = false;
      for (const step of steps) {
        await ticks(1);
        if (interrupted || call.closed) break;
        switch (step.type) {
          case 'text': {
            const n = Math.max(1, step.chunks ?? 1);
            const size = Math.ceil(step.text.length / n);
            for (let i = 0; i < step.text.length; i += size) {
              emit({
                type: 'stream_event',
                event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text.slice(i, i + size) } },
                session_id: sessionId,
              });
            }
            emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: step.text }] }, session_id: sessionId });
            writeTranscript({ type: 'assistant', text: step.text });
            break;
          }
          case 'tool': {
            const toolUseId = `toolu_fake_${index}_${turnIndex}_${++requestCounter}`;
            emit({
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: step.name, input: step.input }] },
              session_id: sessionId,
            });
            let decision: PermissionResult = { behavior: 'allow' };
            if (step.permission && options.canUseTool) {
              const abort = new AbortController();
              const canUseTool: CanUseTool = options.canUseTool;
              const pending = canUseTool(step.name, step.input, {
                signal: abort.signal,
                suggestions: step.suggestions,
                toolUseID: toolUseId,
                requestId: `req_fake_${requestCounter}`,
                title: `Claude wants to use ${step.name}`,
                displayName: step.name,
              });
              const INTERRUPTED = Symbol('interrupted');
              const raced = await Promise.race([pending, interruptPromise.then((): typeof INTERRUPTED => INTERRUPTED)]);
              if (raced === INTERRUPTED) {
                abort.abort();
                await pending;
                break;
              }
              // A null result would block the tool forever in the real CLI; the fake treats it as a deny.
              decision = raced ?? { behavior: 'deny', message: 'canUseTool returned null' };
              call.permissionResults.push(decision);
            }
            const denied = decision.behavior === 'deny';
            emit({
              type: 'user',
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    content: decision.behavior === 'deny' ? decision.message : (step.result ?? 'ok'),
                    is_error: denied,
                  },
                ],
              },
              parent_tool_use_id: null,
              tool_use_result: !denied && step.structuredPatch ? { structuredPatch: step.structuredPatch } : undefined,
              session_id: sessionId,
            });
            break;
          }
          case 'partial':
            emit({
              type: 'stream_event',
              event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } },
              session_id: sessionId,
            });
            break;
          case 'rateLimit':
            emit({ type: 'rate_limit_event', rate_limit_info: step.info, session_id: sessionId });
            break;
          case 'assistantError':
            emit({ type: 'assistant', message: { role: 'assistant', content: [] }, error: step.error, session_id: sessionId });
            break;
          case 'apiRetry':
            emit({
              type: 'system',
              subtype: 'api_retry',
              error: step.error,
              error_status: 429,
              retry_delay_ms: 1000,
              session_id: sessionId,
            });
            break;
          case 'result':
            sawResult = true;
            result(step.isError === true, step.apiErrorStatus, step.message);
            break;
          case 'pause':
            await Promise.race([
              new Promise<void>((resolve) => pauseWaiters.add(resolve)),
              interruptPromise,
            ]);
            break;
        }
      }
      interruptTurn = null;
      if (call.closed) return;
      if (interrupted) result(true);
      else if (!sawResult) result(false);
    }

    async function finish(): Promise<void> {
      if (finished) return;
      finished = true;
      await ticks(5);
      // The real CLI flushes the transcript on exit.
      writeTranscript({ type: 'flush' });
      out.end();
    }

    // Drive the conversation from the streaming input.
    void (async () => {
      if (typeof params.prompt === 'string') {
        call.prompts.push(params.prompt);
        timeline.push(`prompt:${index}`);
        await runTurn(params.prompt);
        await finish();
        return;
      }
      const iterator = params.prompt[Symbol.asyncIterator]();
      while (!call.closed) {
        const next = await iterator.next();
        if (next.done || call.closed) break;
        const text = promptText(next.value);
        call.prompts.push(text);
        timeline.push(`prompt:${index}`);
        await runTurn(text);
      }
      await finish();
    })();

    const fake = {
      next: () => out.next(),
      return: async () => {
        fake.close();
        return { value: undefined, done: true as const };
      },
      throw: async (err: unknown) => {
        fake.close();
        throw err;
      },
      [Symbol.asyncIterator]() {
        return fake;
      },
      async interrupt() {
        call.interrupts += 1;
        timeline.push(`interrupt:${index}`);
        interruptTurn?.();
        return undefined;
      },
      close() {
        if (call.closed) return;
        call.closed = true;
        timeline.push(`close:${index}`);
        interruptTurn?.();
        void finish();
      },
      async setPermissionMode(mode: string) {
        call.permissionModes.push(mode);
        currentPermissionMode = mode;
      },
      async setModel(model?: string) {
        call.models.push(model);
        currentModel = model;
      },
      async applyFlagSettings(settings: { effortLevel?: string | null }) {
        if ('effortLevel' in settings) {
          call.efforts.push(settings.effortLevel ?? null);
          currentEffort = settings.effortLevel ?? undefined;
        }
      },
      async supportedModels() {
        return models;
      },
      async getContextUsage() {
        return { percentage: contextPercentage, totalTokens: 0, maxTokens: 200_000, rawMaxTokens: 200_000, categories: [], gridRows: [] };
      },
    };
    return fake as unknown as Query;
  }) as QueryFn;

  return {
    query,
    calls,
    timeline,
    release,
    setContextPercentage(value) {
      contextPercentage = value;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture-mode scenario (HOPECODE_FIXTURES=1 / e2e)
// ---------------------------------------------------------------------------

export const FIXTURE_EDIT_PATCH: StructuredPatchHunk[] = [
  {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [' # Hopecode fixture', '-Hello world', '+Hello Hopecode', ' '],
  },
];

/**
 * Scripted fixture conversation keyed on prompt markers:
 * - `[ratelimit]`: first attempt is rejected (five_hour, no output), the retry on the next account succeeds.
 * - `[overage]`: allowed event with `isUsingOverage` (account blocked from the next turn), then normal text.
 * - `[text]`: streaming text only.
 * - `[exhaust]`: the first two attempts are rejected (five_hour, resets in 10s, no output) so a pool with one
 *   exhausted account ends up waiting; the attempt after the reset succeeds.
 * - `[whoami]`: replies `model=<model> resume=<sid|none> account=<config dir name> permissionMode=<mode>
 *   effort=<level|default>` (e2e assertions).
 * - otherwise: streaming text, an Edit tool_use that asks for permission (structuredPatch), closing text.
 */
export function createFixtureScenario(): FakeScenario {
  const rejectedOnce = new Set<string>();
  const exhaustRejections = new Map<string, number>();
  return ({ prompt, options, configDir, model, permissionMode, effort }) => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    if (prompt.includes('[exhaust]') && (exhaustRejections.get(prompt) ?? 0) < 2) {
      exhaustRejections.set(prompt, (exhaustRejections.get(prompt) ?? 0) + 1);
      const soon = Math.floor(Date.now() / 1000) + 10;
      return [
        { type: 'rateLimit', info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: soon, utilization: 1 } },
        { type: 'result', isError: true, apiErrorStatus: 429 },
      ];
    }
    if (prompt.includes('[exhaust]')) {
      return [{ type: 'text', text: 'Resumed after the limit reset.', chunks: 3 }];
    }
    if (prompt.includes('[whoami]')) {
      const account = configDir ? (configDir.split('/').filter(Boolean).pop() ?? 'none') : 'none';
      return [
        {
          type: 'text',
          text: `model=${model ?? 'default'} resume=${options.resume ?? 'none'} account=${account} permissionMode=${permissionMode} effort=${effort ?? 'default'}`,
        },
      ];
    }
    if (prompt.includes('[ratelimit]') && !rejectedOnce.has(prompt)) {
      rejectedOnce.add(prompt);
      return [
        { type: 'rateLimit', info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt, utilization: 1 } },
        { type: 'result', isError: true, apiErrorStatus: 429 },
      ];
    }
    if (prompt.includes('[overage]')) {
      return [
        {
          type: 'rateLimit',
          info: { status: 'allowed', rateLimitType: 'overage', isUsingOverage: true, overageInUse: true, resetsAt },
        },
        { type: 'text', text: 'This turn used extra usage; the next turn will switch accounts.', chunks: 3 },
      ];
    }
    if (prompt.includes('[text]')) {
      return [{ type: 'text', text: 'Streaming reply from the fixture session.', chunks: 4 }];
    }
    return [
      { type: 'text', text: 'I will update the README greeting.', chunks: 4 },
      {
        type: 'tool',
        name: 'Edit',
        input: { file_path: 'README.md', old_string: 'Hello world', new_string: 'Hello Hopecode' },
        result: 'The file README.md has been updated.',
        structuredPatch: FIXTURE_EDIT_PATCH,
        permission: true,
        suggestions: [
          { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'localSettings' },
        ],
      },
      { type: 'text', text: 'Done. The greeting now says "Hello Hopecode".', chunks: 3 },
    ];
  };
}

/**
 * Fake query for fixture mode (context 31%, scripted fixture scenario). `writeTranscript` simulates CLI
 * transcripts under the (temp) account config dirs so cross-account resume goes through transcript sync.
 */
export function createFixtureQuery(opts: { writeTranscript?: boolean } = {}): FakeQueryController {
  return createFakeQuery({ scenario: createFixtureScenario(), contextPercentage: 31, writeTranscript: opts.writeTranscript });
}
