import type { Thread } from '../../../shared/types';

/** A chat without a project runs in an app-managed folder with no git: changes, commit, PR and branch are unavailable. */
export const isScratchThread = (thread: Pick<Thread, 'projectId'>): boolean => thread.projectId === null;

export const SCRATCH_NO_GIT_NOTE = '프로젝트 없는 채팅은 git을 사용하지 않아요. 결과 파일은 폴더에서 확인하세요.';
