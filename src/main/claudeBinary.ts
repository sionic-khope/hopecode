// Resolves the packaged `claude` executable and the SDK CLI version (plan 4.2 claudeBinary.ts).
// The SDK platform package has no `exports` map restricting `manifest.json`/`claude` subpath
// access via `require.resolve`, but the main `@anthropic-ai/claude-agent-sdk` package does
// restrict subpaths, so its manifest is read by joining `dirname(mainEntry)` instead of
// resolving `.../manifest.json` directly.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, sep } from 'node:path';
import { CLI_VERSION_PATTERN } from '../shared/constants';
import type { ClaudeBinary } from './contracts';

const requireFromHere = createRequire(import.meta.url);

const ASAR_MARKER = `${sep}app.asar${sep}`;
const ASAR_UNPACKED_MARKER = `${sep}app.asar.unpacked${sep}`;

/** Packaged asar path -> asar.unpacked path (no-op outside a packaged app). */
export function unpackAsarPath(path: string): string {
  if (path.includes(ASAR_UNPACKED_MARKER)) return path;
  return path.includes(ASAR_MARKER) ? path.replace(ASAR_MARKER, ASAR_UNPACKED_MARKER) : path;
}

export interface ClaudeBinaryDeps {
  arch?: NodeJS.Architecture;
  pathEnv?: string;
  require?: NodeRequire;
}

export function createClaudeBinary(deps: ClaudeBinaryDeps = {}): ClaudeBinary {
  const arch = deps.arch ?? process.arch;
  const req = deps.require ?? requireFromHere;
  let cachedPath: string | null | undefined;

  function resolveFromSdkPlatformPackage(): string | null {
    try {
      const pkgJsonPath = req.resolve(`@anthropic-ai/claude-agent-sdk-darwin-${arch}/package.json`);
      const binPath = unpackAsarPath(join(dirname(pkgJsonPath), 'claude'));
      return existsSync(binPath) ? binPath : null;
    } catch {
      return null;
    }
  }

  function resolveFromPath(): string | null {
    const pathEnv = deps.pathEnv ?? process.env['PATH'] ?? '';
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, 'claude');
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  return {
    resolvePath() {
      if (cachedPath === undefined) {
        cachedPath = resolveFromSdkPlatformPackage() ?? resolveFromPath();
      }
      if (!cachedPath) {
        throw new Error('claude executable not found (sdk platform package or PATH)');
      }
      return cachedPath;
    },
    getCliVersion() {
      try {
        const mainEntry = req.resolve('@anthropic-ai/claude-agent-sdk');
        // The SDK main package stays inside app.asar (readable through Electron's fs); only the
        // platform binary package is unpacked.
        const packed = join(dirname(mainEntry), 'manifest.json');
        const manifestPath = existsSync(packed) ? packed : unpackAsarPath(packed);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
        const version = typeof manifest.version === 'string' ? manifest.version : null;
        return version && CLI_VERSION_PATTERN.test(version) ? version : null;
      } catch {
        return null;
      }
    },
  };
}
