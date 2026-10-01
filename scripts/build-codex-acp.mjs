// Compiles @agentclientprotocol/codex-acp (a Node ACP server script) into one native darwin-arm64 executable with
// the pinned `bun` devDependency: build/bin/codex-acp. The packaged app cannot run Node scripts (runAsNode fuse off),
// so it ships this binary via electron-builder extraResources; dev and tests resolve the same path.
//
// A bun standalone executable autoloads `.env` and `bunfig.toml` from its working directory by default, which would let
// a repository opened in Hopecode inject code (bunfig `preload`) or env (`CODEX_PATH`) into the adapter. The compile
// turns every runtime autoload off (COMPILE_FLAGS) and every run re-checks it against a hostile directory.
//
// Reuse: the binary is kept when build/bin/codex-acp.stamp matches the codex-acp / bun versions and compile flags AND
// the binary's sha256 still matches the one recorded at compile time. `--fresh` (predist:dir) always recompiles.
// `--version` / the autoload check run with a minimal env and a throwaway HOME (the user's ~/.codex is never touched).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TARGET = 'bun-darwin-arm64';
export const OUT_DIR = join(ROOT, 'build', 'bin');
export const OUT = join(OUT_DIR, 'codex-acp');
export const STAMP = join(OUT_DIR, 'codex-acp.stamp');
export const BUN = join(ROOT, 'node_modules', '.bin', 'bun');

/** No runtime autoload of cwd config: `.env`, `bunfig.toml`, `tsconfig.json`, `package.json`. */
export const COMPILE_FLAGS = [
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig',
  '--no-compile-autoload-tsconfig',
  '--no-compile-autoload-package-json',
];

const BUNFIG_MARKER = 'HOPECODE_BUNFIG_AUTOLOADED';
const DOTENV_MARKER = 'HOPECODE_DOTENV_AUTOLOADED';

/** `bun build` argv for one standalone executable. */
export function compileArgs(entry, outfile, target = TARGET) {
  return ['build', entry, '--compile', '--minify', ...COMPILE_FLAGS, `--target=${target}`, '--outfile', outfile];
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Stamp line 1 = what was compiled (versions, target, flags); line 2 = the output's sha256. */
export function stampKey(name, version, bunVersion) {
  return `${name}@${version} bun@${bunVersion} ${TARGET} flags=${COMPILE_FLAGS.join(',')}`;
}

/** The binary may be reused only when the key matches and the file is byte-identical to what was compiled. */
export function stampMatches(stampText, key, sha256) {
  const [line1, line2] = stampText.trim().split('\n');
  return line1 === key && line2 === `sha256=${sha256}`;
}

/**
 * Runs `bin --version` and `bin cli` from a directory holding a hostile `bunfig.toml` (preload that prints a marker)
 * and `.env` (CODEX_PATH = a script that prints a marker). Any marker in the output = the binary autoloads cwd config.
 * Minimal env, throwaway HOME / CODEX_HOME, no CODEX_PATH: nothing real is run.
 */
export function checkNoAutoload(bin) {
  const dir = mkdtempSync(join(tmpdir(), 'hopecode-autoload-check-'));
  try {
    const marker = join(dir, 'marker.sh');
    writeFileSync(join(dir, 'preload.js'), `console.log(${JSON.stringify(BUNFIG_MARKER)});\n`);
    writeFileSync(join(dir, 'bunfig.toml'), 'preload = ["./preload.js"]\n');
    writeFileSync(marker, `#!/bin/sh\necho ${DOTENV_MARKER}\n`);
    chmodSync(marker, 0o755);
    writeFileSync(join(dir, '.env'), `CODEX_PATH=${marker}\n`);
    const env = { PATH: '/usr/bin:/bin', HOME: dir, CODEX_HOME: join(dir, '.codex') };
    let output = '';
    for (const args of [['--version'], ['cli']]) {
      const r = spawnSync(bin, args, { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
      output += `$ ${args.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}`;
    }
    const loaded = [BUNFIG_MARKER, DOTENV_MARKER].filter((m) => output.includes(m));
    return { ok: loaded.length === 0, loaded, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isExecutable(path) {
  return existsSync(path) && (statSync(path).mode & 0o111) === 0o111;
}

/** `--version` with a minimal env and a temporary HOME / CODEX_HOME, from a fresh empty cwd. */
function adapterVersion(bin) {
  const home = mkdtempSync(join(tmpdir(), 'hopecode-codex-acp-build-'));
  try {
    return execFileSync(bin, ['--version'], {
      cwd: home,
      env: { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: join(home, '.codex') },
      encoding: 'utf8',
      timeout: 30_000,
    }).trim();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export function build({ fresh = false } = {}) {
  const require = createRequire(join(ROOT, 'package.json'));
  const pkgJsonPath = require.resolve('@agentclientprotocol/codex-acp/package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const entry = join(dirname(pkgJsonPath), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['codex-acp']);
  const pinnedBun = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies.bun;
  const bunPkg = JSON.parse(readFileSync(require.resolve('bun/package.json'), 'utf8'));

  if (!existsSync(BUN)) throw new Error(`[codex-acp] bun not found at ${BUN} (npm install; bun's postinstall must be allowed)`);
  const bunVersion = execFileSync(BUN, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim();
  if (bunVersion !== pinnedBun || bunPkg.version !== pinnedBun) {
    throw new Error(`[codex-acp] bun ${bunVersion} (package ${bunPkg.version}) does not match the pinned bun ${pinnedBun}`);
  }

  const key = stampKey(pkg.name, pkg.version, bunVersion);
  const reusable = !fresh && isExecutable(OUT) && existsSync(STAMP) && stampMatches(readFileSync(STAMP, 'utf8'), key, sha256File(OUT));
  if (reusable) {
    console.log(`[codex-acp] up to date: ${OUT} (${key})`);
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    rmSync(STAMP, { force: true });
    rmSync(OUT, { force: true });
    console.log(`[codex-acp] compiling ${pkg.name}@${pkg.version} with bun ${bunVersion} (${TARGET})${fresh ? ' [fresh]' : ''}`);
    execFileSync(BUN, compileArgs(entry, OUT), { cwd: ROOT, stdio: 'inherit' });
    chmodSync(OUT, 0o755);
  }

  const autoload = checkNoAutoload(OUT);
  if (!autoload.ok) {
    rmSync(STAMP, { force: true });
    rmSync(OUT, { force: true });
    throw new Error(`[codex-acp] ${OUT} autoloads cwd config (${autoload.loaded.join(', ')}); binary removed\n${autoload.output}`);
  }
  const version = adapterVersion(OUT);
  if (!version.includes(pkg.version)) throw new Error(`[codex-acp] ${OUT} --version printed "${version}", expected ${pkg.version}`);
  if (!reusable) writeFileSync(STAMP, `${key}\nsha256=${sha256File(OUT)}\n`);
  console.log(`[codex-acp] ok: ${version} (${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB), no cwd autoload`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build({ fresh: process.argv.includes('--fresh') });
}
