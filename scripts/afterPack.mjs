// electron-builder afterPack hook. node-pty ships a small `spawn-helper` binary (used on macOS/Linux to
// spawn the shell); node-pty's own loader tries `build/Release` first and falls back to
// `prebuilds/<platform>-<arch>` only if that native build is missing (see node_modules/node-pty/lib/utils.js).
// `build/Release/spawn-helper` already has its +x bit here (electron-builder's `npmRebuild` rebuilds it), but
// the `prebuilds/*` copies do not -- some npm/CI environments don't preserve exec bits through
// pack/unpack. If a future build ever falls back to a prebuild (e.g. npmRebuild disabled, or a target this
// project doesn't currently rebuild for), a non-executable spawn-helper would make `pty.spawn()` fail and the
// terminal would silently never open (H1: "터미널이 안 열린다"). Belt-and-suspenders: chmod +x every
// spawn-helper we can find under the packaged node-pty, not just the one path we know is used today.
import { chmodSync, readdirSync, statSync } from 'node:fs';
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

/** @param {{ appOutDir: string, packager: { appInfo: { productFilename: string } } }} context */
export default async function afterPack(context) {
  const nodePtyDir = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
  );
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
