// Parsers for `hermes auth list` / `hermes auth status <provider>` output (plan 2.9.2). Pure; headers only,
// credential labels / ids / values are never read.

/** `<provider> (<n> credentials):` headers -> provider id + count. Everything else is ignored. */
export function parseHermesAuthList(stdout: string): { id: string; count: number }[] {
  const out: { id: string; count: number }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9][\w.-]*)\s+\((\d+)\s+credentials?\)\s*:\s*$/.exec(line.trim());
    if (m) out.push({ id: m[1] as string, count: Number(m[2]) });
  }
  return out;
}

/** `openai-codex: logged in` -> true, `anthropic: logged out` -> false, anything else -> null. */
export function parseHermesAuthStatus(stdout: string): boolean | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /:\s*logged (in|out)\b/i.exec(line);
    if (m) return (m[1] as string).toLowerCase() === 'in';
  }
  return null;
}
