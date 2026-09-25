import { KEYCHAIN_SERVICE_BASE } from '../shared/constants';

/**
 * macOS Keychain service name used by Claude Code:
 * `Claude Code-credentials` or `Claude Code-credentials-<sha256(configDir).hex[:8]>`.
 * configDir is hashed verbatim (not expanded). Hash fn injected: core must not import node:crypto.
 */
export function keychainServiceName(
  configDir: string | undefined,
  sha256Hex: (s: string) => string,
): string {
  if (!configDir) return KEYCHAIN_SERVICE_BASE;
  const hash = sha256Hex(configDir).slice(0, 8);
  return `${KEYCHAIN_SERVICE_BASE}-${hash}`;
}
