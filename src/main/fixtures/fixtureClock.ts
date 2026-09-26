// Fixture-mode (`HOPECODE_FIXTURES=1`, e2e) clock for the 예약 scheduler. e2e moves it from the main process
// (`electronApp.evaluate(() => globalThis.__hopecodeFixtureClock.set(ms))`); it is never created in a real run,
// so there is no IPC surface for it.

export interface FixtureClock {
  now(): number;
  /** Jumps the clock to `ms` and runs one scheduler evaluation. */
  set(ms: number): Promise<void>;
}

declare global {
  // Only defined in fixture mode (see index.ts).
  var __hopecodeFixtureClock: FixtureClock | undefined;
}

export function createFixtureClock(onSet: () => Promise<void>): FixtureClock {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    async set(ms) {
      offset = ms - Date.now();
      await onSet();
    },
  };
}
