import { SAFE_ID_PATTERN } from '../../shared/constants';

/** Ids become file names; anything outside `[A-Za-z0-9_-]{1,64}` could escape the directory (M2). */
export function assertSafeId(id: string, what: string): string {
  if (typeof id !== 'string' || !SAFE_ID_PATTERN.test(id)) throw new Error(`invalid ${what}: ${JSON.stringify(id)}`);
  return id;
}
