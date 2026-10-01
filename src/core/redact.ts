// Masks secret-looking runs before text reaches a log or notice. Pure.
// Every pattern is linear (no lookahead over unbounded runs); value checks run in the replace callback.
import type { RedactFn } from './acpTypes';

const MASK = '[redacted]';

type Rule = [RegExp, (match: string, ...groups: string[]) => string];

const mask = (): string => MASK;

/** `Basic <base64>` only when it decodes to `user:pass` (so "Basic setup" stays readable). */
function maskBasic(match: string, token: string): string {
  try {
    return atob(token).includes(':') ? MASK : match;
  } catch {
    return match;
  }
}

// Order matters: key/value and Bearer headers first, so the generic runs below do not split them.
const RULES: Rule[] = [
  // `api_key=...`, `"token": "..."`, `Authorization: Bearer ...`: the key stays, the value is masked.
  [
    // Prefixed keys too (ANTHROPIC_AUTH_TOKEN, client_secret, OPENROUTER_API_KEY). The match only starts where no
    // word char precedes (`_` included), which keeps the lazy prefix linear.
    /((?<![A-Za-z0-9_])[A-Za-z0-9_]*?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization))(["']?[ \t]*[:=][ \t]*["']?)(?:(?:Bearer|Basic)[ \t]+)?[^\s"',;&]+/gi,
    (_m, key, sep) => `${key}${sep}${MASK}`,
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, mask],
  [/\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})/g, maskBasic],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, mask],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, mask],
  [/\b(?:sk|rt|xai|gsk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}/g, mask],
  [/\b[A-Fa-f0-9]{32,}\b/g, mask],
  // Long base64-ish runs that contain a digit (plain long words / paths stay).
  [/[A-Za-z0-9+_-]{40,}={0,2}/g, (m) => (/\d/.test(m) ? MASK : m)],
];

export const redact: RedactFn = (text) => RULES.reduce((out, [re, fn]) => out.replace(re, fn), text);
