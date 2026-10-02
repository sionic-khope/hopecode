import type { Thread } from '../../../shared/types';
import { t } from '../../../shared/i18n';

/** A chat without a project runs in an app-managed folder with no git: changes, commit, PR and branch are unavailable. */
export const isScratchThread = (thread: Pick<Thread, 'projectId'>): boolean => thread.projectId === null;

export const scratchNoGitNote = (): string => t('scratch.noGit');
