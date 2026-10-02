import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_DATA_DIR_NAME, userDataDir, userDataDirIn } from '../../src/main/paths';

// The app was renamed Hopecode -> deltax. userData stays in `<appData>/Hopecode` (no move), so existing settings,
// threads and Local Storage are read as they are. These cases run against a temp appData fixture only.
let appData: string;
let previous: string | undefined;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'userdata-'));
  previous = process.env['HOPECODE_HOME'];
});
afterEach(() => {
  if (previous === undefined) delete process.env['HOPECODE_HOME'];
  else process.env['HOPECODE_HOME'] = previous;
  rmSync(appData, { recursive: true, force: true });
});

function seedOld(): string {
  const old = join(appData, 'Hopecode');
  mkdirSync(join(old, 'threads'), { recursive: true });
  writeFileSync(join(old, 'state.json'), '{"projects":[]}');
  return old;
}

describe('userData after the rename', () => {
  it('keeps the old folder name', () => {
    expect(USER_DATA_DIR_NAME).toBe('Hopecode');
  });

  it('only the old folder exists: uses it and leaves it untouched', () => {
    const old = seedOld();
    expect(userDataDirIn(appData)).toBe(old);
    expect(readFileSync(join(old, 'state.json'), 'utf8')).toBe('{"projects":[]}');
    expect(readdirSync(appData)).toEqual(['Hopecode']);
  });

  it('both folders exist: still the old one, the deltax folder is ignored', () => {
    const old = seedOld();
    mkdirSync(join(appData, 'deltax'));
    expect(userDataDirIn(appData)).toBe(old);
    expect(existsSync(join(old, 'state.json'))).toBe(true);
  });

  it('nothing exists or appData is unreadable: same path, nothing is created', () => {
    expect(userDataDirIn(appData)).toBe(join(appData, 'Hopecode'));
    expect(readdirSync(appData)).toEqual([]);
    const missing = join(appData, 'missing');
    expect(userDataDirIn(missing)).toBe(join(missing, 'Hopecode'));
    expect(existsSync(missing)).toBe(false);
  });

  it('HOPECODE_HOME still isolates test runs', () => {
    process.env['HOPECODE_HOME'] = appData;
    expect(userDataDir()).toBe(join(appData, 'userData'));
  });
});
