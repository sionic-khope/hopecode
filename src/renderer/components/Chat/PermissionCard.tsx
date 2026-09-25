import { useEffect, useRef } from 'react';
import type { PermissionDecision, PermissionRequest } from '../../../shared/types';
import { Button } from '../common';
import './Chat.css';

export interface PermissionCardProps {
  request: PermissionRequest;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
}

function formatInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  // Prefer a single dominant field (command/path/pattern) rendered raw; else pretty JSON.
  for (const key of ['command', 'file_path', 'pattern', 'url', 'description']) {
    const v = input[key];
    if (typeof v === 'string') return v;
  }
  return JSON.stringify(input, null, 2);
}

/** Allow / Allow for session / Deny card shown before a tool runs (plan 4.4, permissionBroker). */
export function PermissionCard({ request, onDecide }: PermissionCardProps) {
  const denyRef = useRef<HTMLButtonElement>(null);
  const allowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (request.defaultToNo) denyRef.current?.focus();
    else allowRef.current?.focus();
  }, [request.defaultToNo]);

  const inputPreview = formatInput(request.input);

  return (
    <div className="hc-permission" role="alertdialog" aria-label={request.title ?? request.toolName}>
      <div className="hc-permission__title">{request.title ?? `Run ${request.displayName ?? request.toolName}?`}</div>
      {request.description ? <div className="hc-permission__desc">{request.description}</div> : null}
      {inputPreview ? <pre className="hc-permission__input">{inputPreview}</pre> : null}
      <div className="hc-permission__actions">
        <Button ref={allowRef} variant="primary" size="sm" onClick={() => onDecide(request.requestId, 'allow')}>
          Allow
        </Button>
        {request.hasSessionSuggestion ? (
          <Button variant="secondary" size="sm" onClick={() => onDecide(request.requestId, 'allow-session')}>
            Allow for session
          </Button>
        ) : null}
        <Button ref={denyRef} variant="destructive" size="sm" onClick={() => onDecide(request.requestId, 'deny')}>
          Deny
        </Button>
      </div>
    </div>
  );
}
