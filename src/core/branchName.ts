// Branch-name check for "브랜치 생성" (renderer hint and main guard). Mirrors `git check-ref-format --branch`;
// main still runs git's own check before `git switch -c`.
import { t } from '../shared/i18n';

export const BRANCH_NAME_MAX = 200;

/** Why `name` cannot be a branch name, or null when it can. */
export function branchNameError(name: string): string | null {
  if (name.length === 0) return t('branch.enterName');
  if (name.length > BRANCH_NAME_MAX) return t('branch.tooLong', { max: BRANCH_NAME_MAX });
  if (/[\x00-\x20\x7f]/.test(name)) return t('branch.noSpaces');
  if (/[~^:?*[\\]/.test(name)) return t('branch.badChars');
  if (name.startsWith('-')) return t('branch.noLeadingDash');
  if (name === '@') return t('branch.notAt');
  if (name.includes('..')) return t('branch.noDotDot');
  if (name.includes('@{')) return t('branch.noAtBrace');
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return t('branch.badSlash');
  if (name.endsWith('.')) return t('branch.noTrailingDot');
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return t('branch.partLeadingDot');
    if (part.endsWith('.lock')) return t('branch.noLock');
  }
  return null;
}
