// Branch-name check for "브랜치 생성" (renderer hint and main guard). Mirrors `git check-ref-format --branch`;
// main still runs git's own check before `git switch -c`.

export const BRANCH_NAME_MAX = 200;

/** Why `name` cannot be a branch name, or null when it can. */
export function branchNameError(name: string): string | null {
  if (name.length === 0) return '브랜치 이름을 입력하세요';
  if (name.length > BRANCH_NAME_MAX) return `브랜치 이름은 ${BRANCH_NAME_MAX}자 이하여야 합니다`;
  if (/[\x00-\x20\x7f]/.test(name)) return '공백이나 제어 문자는 쓸 수 없습니다';
  if (/[~^:?*[\\]/.test(name)) return '~ ^ : ? * [ \\ 문자는 쓸 수 없습니다';
  if (name.startsWith('-')) return '-로 시작할 수 없습니다';
  if (name === '@') return '@만으로는 이름을 만들 수 없습니다';
  if (name.includes('..')) return '..을 포함할 수 없습니다';
  if (name.includes('@{')) return '@{를 포함할 수 없습니다';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return '/로 시작·끝나거나 //를 포함할 수 없습니다';
  if (name.endsWith('.')) return '.으로 끝날 수 없습니다';
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return '각 부분은 .으로 시작할 수 없습니다';
    if (part.endsWith('.lock')) return '.lock으로 끝날 수 없습니다';
  }
  return null;
}
