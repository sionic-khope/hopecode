// "New Task Start" (draft composer button / ⌘⇧N / command palette): placeholder substitution for the
// user-configurable template (settings' 일반 section, AppSettings.newTaskTemplate). Pure: no fs, no Electron.

/** `YYYY-MM-DD` from local date parts (not UTC). */
export function formatDateYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Substitutes every `{project}` with the current folder's name and `{date}` with today, `YYYY-MM-DD`. */
export function fillNewTaskTemplate(template: string, projectName: string | null, now: Date = new Date()): string {
  return template.split('{project}').join(projectName ?? '').split('{date}').join(formatDateYMD(now));
}
