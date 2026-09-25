// React hooks over the store for selectors that build new arrays (L12): `useShallow` keeps the result
// referentially stable while its elements are unchanged, so subscribers don't re-render on every store update.
import { useShallow } from 'zustand/react/shallow';
import type { PermissionRequest } from '../../shared/types';
import { useAppStore } from './appStore';
import { selectPendingPermissions } from './selectors';

export function usePendingPermissions(threadId?: string): PermissionRequest[] {
  return useAppStore(useShallow((s) => selectPendingPermissions(s, threadId)));
}
