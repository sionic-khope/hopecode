// Launch built Electron main in smoke mode: verifies SDK ESM import + node-pty load/spawn, then exits.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, HOPECODE_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => {
  out += d;
  process.stdout.write(d);
});
child.stderr.on('data', (d) => process.stderr.write(d));

const timer = setTimeout(() => {
  console.error('[smoke] timeout');
  child.kill('SIGKILL');
  process.exit(1);
}, 60_000);

child.on('exit', (code) => {
  clearTimeout(timer);
  const pass = code === 0 && out.includes('[smoke] PASS');
  console.log(`[smoke] electron exited with ${code} -> ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
});
