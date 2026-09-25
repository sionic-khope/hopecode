// Minimal runtime type guards for IPC request payloads (plan 3.3 "입력 검증(최소 타입 가드)").
// IPC input crosses a trust boundary (renderer), so every handler in registerIpc.ts narrows
// `unknown` with these before touching a field, regardless of what the InvokeMap types claim.
import { EFFORT_LEVELS, UI_PERMISSION_MODES } from '../../shared/constants';
import type { EffortLevel, PermissionDecision, UiPermissionMode } from '../../shared/types';

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function isOptionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === 'string';
}

export function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function isUiPermissionMode(v: unknown): v is UiPermissionMode {
  return typeof v === 'string' && (UI_PERMISSION_MODES as readonly string[]).includes(v);
}

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

const PERMISSION_DECISIONS: readonly PermissionDecision[] = ['allow', 'allow-session', 'deny'];

export function isPermissionDecision(v: unknown): v is PermissionDecision {
  return typeof v === 'string' && (PERMISSION_DECISIONS as readonly string[]).includes(v);
}

export class InvalidIpcRequestError extends Error {
  constructor(channel: string, detail: string) {
    super(`invalid request for ${channel}: ${detail}`);
    this.name = 'InvalidIpcRequestError';
  }
}

/** Throws `InvalidIpcRequestError` when `ok` is false. Call at the top of every handler. */
export function assertReq(channel: string, ok: boolean, detail: string): asserts ok {
  if (!ok) throw new InvalidIpcRequestError(channel, detail);
}
