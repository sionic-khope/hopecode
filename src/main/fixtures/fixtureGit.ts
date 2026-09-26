// Fixture-mode (`HOPECODE_FIXTURES=1`, e2e) GitPublisher: records push / PR calls, never touches the network.
import type { GitPublisher } from '../git/gitService';

export const FIXTURE_PR_URL = 'https://github.com/example/hopecode-fixture/pull/1';

export type FixturePublisherCall =
  | { kind: 'push'; cwd: string; remote: string; branch: string }
  | { kind: 'createPr'; cwd: string; title: string; body: string; base: string; head: string };

export function createFixturePublisher(): GitPublisher & { calls: FixturePublisherCall[] } {
  const calls: FixturePublisherCall[] = [];
  return {
    calls,
    async ghAvailable() {
      return true;
    },
    async push(cwd, remote, branch) {
      calls.push({ kind: 'push', cwd, remote, branch });
    },
    async createPr(cwd, opts) {
      calls.push({ kind: 'createPr', cwd, ...opts });
      return FIXTURE_PR_URL;
    },
  };
}
