// Types behind the sidebar navigation pages: 풀 리퀘스트 (gh), 예약 (scheduler), 플러그인 (shared ~/.claude).
import type { EffortLevel, UiPermissionMode } from './types';

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export type PrReviewState = 'approved' | 'changes-requested' | 'review-required' | null;
export type PrCheckState = 'success' | 'failure' | 'pending' | null;

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  /** Head branch (`headRefName`). */
  branch: string;
  baseBranch: string;
  author: string | null;
  draft: boolean;
  review: PrReviewState;
  checks: PrCheckState;
  updatedAt: number | null;
}

export interface ProjectPullRequests {
  projectId: string;
  projectName: string;
  /** `owner/repo` from the remote URL when it can be read. */
  repo: string | null;
  prs: PullRequestInfo[];
  /** gh failed for this repo (the other repos still list). */
  error: string | null;
}

/**
 * `missing`: gh is not installed. `unauthenticated`: gh has no login (`gh auth login`). `ok`: `repos` lists every
 * registered project that has a remote (projects without one are left out).
 */
export interface PullRequestList {
  gh: 'ok' | 'missing' | 'unauthenticated';
  repos: ProjectPullRequests[];
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** Mon=1 .. Sun=0, as `Date.getDay()`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ScheduleRepeat =
  | { kind: 'once'; /** Local wall time, epoch ms. */ at: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; weekday: Weekday; time: string };

/** Permission modes a schedule may use: bypassPermissions is never allowed unattended. */
export type ScheduleMode = Exclude<UiPermissionMode, 'bypassPermissions'>;

export interface ScheduleInput {
  projectId: string;
  prompt: string;
  model: string;
  permissionMode: ScheduleMode;
  effort: EffortLevel | null;
  repeat: ScheduleRepeat;
  enabled: boolean;
}

export type ScheduleRunStatus = 'started' | 'waiting' | 'missed' | 'failed';

export interface ScheduleRun {
  /** Occurrence the run belongs to (epoch ms). */
  scheduledAt: number;
  /** When it was handled (started / judged missed). */
  at: number;
  status: ScheduleRunStatus;
  threadId: string | null;
  /** Missed occurrences folded into this entry (app was closed through several). */
  missedCount?: number;
  error?: string;
}

export interface Schedule extends ScheduleInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Next occurrence, or null (a finished one-off, or disabled). */
  nextRunAt: number | null;
  /** Newest first, capped. */
  runs: ScheduleRun[];
}

// ---------------------------------------------------------------------------
// Plugins (read-only inventory of the shared ~/.claude)
// ---------------------------------------------------------------------------

export type PluginItemKind = 'plugin' | 'skill' | 'agent' | 'output-style' | 'mcp' | 'hook';

export interface PluginItem {
  kind: PluginItemKind;
  name: string;
  description: string | null;
  /** Where it comes from: `사용자`, a marketplace, a plugin name, `settings.json`. */
  source: string;
  /** null when the state cannot be told (e.g. a skill file). */
  enabled: boolean | null;
  /** Extra line (version, command). */
  detail?: string;
}

export interface PluginProblem {
  /** Path relative to the shared folder. */
  path: string;
  message: string;
}

export interface PluginInventory {
  /** Shared folder that was read (absolute). */
  sourceDir: string;
  exists: boolean;
  items: PluginItem[];
  /** Entries skipped because they could not be parsed. */
  problems: PluginProblem[];
}
