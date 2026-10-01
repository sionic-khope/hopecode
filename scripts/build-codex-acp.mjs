// Compiles @agentclientprotocol/codex-acp (a Node ACP server script) into one native darwin-arm64 executable with
// the pinned `bun` devDependency: build/bin/codex-acp. The packaged app cannot run Node scripts (runAsNode fuse off),
// so it ships this binary via electron-builder extraResources; dev and tests resolve the same path.
// Skips the compile when the binary is already built from the same codex-acp / bun versions (build/bin/codex-acp.stamp).
// The result is checked with `--version` under a throwaway HOME (the user's ~/.codex is never touched).
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const TARGET = 'bun-darwin-arm64';
const OUT_DIR = join(ROOT, 'build', 'bin');
const OUT = join(OUT_DIR, 'codex-acp');
const STAMP = join(OUT_DIR, 'codex-acp.stamp');

const pkgJsonPath = require.resolve('@agentclientprotocol/codex-acp/package.json');
const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
const entry = join(dirname(pkgJsonPath), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['codex-acp']);
const bunPkg = JSON.parse(readFileSync(require.resolve('bun/package.json'), 'utf8'));
const bun = join(ROOT, 'node_modules', '.bin', 'bun');
const stamp = `${pkg.name}@${pkg.version} bun@${bunPkg.version} ${TARGET}`;

function isExecutable(path) {
  return existsSync(path) && (statSync(path).mode & 0o111) === 0o111;
}

/** `--version` with a minimal env and a temporary HOME / CODEX_HOME. */
function adapterVersion() {
  const home = mkdtempSync(join(tmpdir(), 'hopecode-codex-acp-build-'));
  try {
    return execFileSync(OUT, ['--version'], {
      env: { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: join(home, '.codex') },
      encoding: 'utf8',
      timeout: 30_000,
    }).trim();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (isExecutable(OUT) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === stamp) {
  console.log(`[codex-acp] up to date: ${OUT} (${stamp})`);
} else {
  if (!existsSync(bun)) throw new Error(`[codex-acp] bun not found at ${bun} (npm install; bun's postinstall must be allowed)`);
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(STAMP, { force: true });
  console.log(`[codex-acp] compiling ${pkg.name}@${pkg.version} with bun ${bunPkg.version} (${TARGET})`);
  execFileSync(bun, ['build', entry, '--compile', '--minify', `--target=${TARGET}`, '--outfile', OUT], { cwd: ROOT, stdio: 'inherit' });
  chmodSync(OUT, 0o755);
  writeFileSync(STAMP, `${stamp}\n`);
}

const version = adapterVersion();
if (!version.includes(pkg.version)) throw new Error(`[codex-acp] ${OUT} --version printed "${version}", expected ${pkg.version}`);
console.log(`[codex-acp] ok: ${version} (${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
