// electron-builder afterPack hook. node-pty ships a small `spawn-helper` binary (used on macOS/Linux to
// spawn the shell); node-pty's own loader tries `build/Release` first and falls back to
// `prebuilds/<platform>-<arch>` only if that native build is missing (see node_modules/node-pty/lib/utils.js).
// `build/Release/spawn-helper` already has its +x bit here (electron-builder's `npmRebuild` rebuilds it), but
// the `prebuilds/*` copies do not -- some npm/CI environments don't preserve exec bits through
// pack/unpack. If a future build ever falls back to a prebuild (e.g. npmRebuild disabled, or a target this
// project doesn't currently rebuild for), a non-executable spawn-helper would make `pty.spawn()` fail and the
// terminal would silently never open (H1: "터미널이 안 열린다"). Belt-and-suspenders: chmod +x every
// spawn-helper we can find under the packaged node-pty, not just the one path we know is used today.
//
// The bundled codex-acp binary (@zed-industries/codex-acp-darwin-<arch>/bin/codex-acp) is spawned directly for Codex
// threads; it must exist under app.asar.unpacked and be executable, otherwise the build fails here (never silently).
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function findSpawnHelpers(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      findSpawnHelpers(path, out);
    } else if (entry.name === 'spawn-helper') {
      out.push(path);
    }
  }
}

/** chmod 0755 when any execute bit is missing; returns true when the mode changed. */
function ensureExecutable(path) {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o111) === 0o111) return false;
  chmodSync(path, 0o755);
  return true;
}

/** Every `@zed-industries/codex-acp-darwin-*` package's `bin/codex-acp`; throws when none is packaged. */
function ensureCodexAcp(unpackedModules) {
  const scope = join(unpackedModules, '@zed-industries');
  const bins = (existsSync(scope) ? readdirSync(scope) : [])
    .filter((name) => name.startsWith('codex-acp-darwin-'))
    .map((name) => join(scope, name, 'bin', 'codex-acp'))
    .filter((bin) => existsSync(bin));
  if (bins.length === 0) {
    throw new Error(`[afterPack] codex-acp binary missing under ${scope} (asarUnpack must include codex-acp-darwin-*)`);
  }
  for (const bin of bins) {
    const changed = ensureExecutable(bin);
    console.log(`[afterPack] codex-acp ${changed ? 'chmod +x' : 'ok'}: ${bin}`);
  }
}

/** @param {{ appOutDir: string, packager: { appInfo: { productFilename: string } } }} context */
export default async function afterPack(context) {
  const unpackedModules = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
  );
  ensureCodexAcp(unpackedModules);
  const nodePtyDir = join(unpackedModules, 'node-pty');
  const helpers = [];
  findSpawnHelpers(nodePtyDir, helpers);
  let fixed = 0;
  for (const helper of helpers) {
    try {
      const mode = statSync(helper).mode & 0o777;
      if ((mode & 0o111) !== 0o111) {
        chmodSync(helper, 0o755);
        fixed += 1;
      }
    } catch (err) {
      console.warn(`[afterPack] failed to chmod ${helper}:`, err);
    }
  }
  if (helpers.length > 0) console.log(`[afterPack] node-pty spawn-helper: ${helpers.length} found, ${fixed} chmod +x`);
}
