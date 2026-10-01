// ACP permission option -> app decision mapping (plan 2.5). Pure.
import type { AcpPermissionOptionLite } from '../shared/types';
import type { PickOptionFn, PickSessionOptionFn } from './acpTypes';

const SESSION_RE = /session/i;

export const pickSessionOption: PickSessionOptionFn = (options) => {
  const always = options.filter((o) => o.kind === 'allow_always');
  return always.find((o) => SESSION_RE.test(o.optionId) || SESSION_RE.test(o.name)) ?? always[0] ?? null;
};

const selected = (option: AcpPermissionOptionLite | undefined) =>
  option ? ({ outcome: 'selected', optionId: option.optionId } as const) : null;

export const pickOption: PickOptionFn = (decision, options) => {
  switch (decision) {
    case 'allow':
      return selected(options.find((o) => o.kind === 'allow_once'));
    case 'allow-session':
      return selected(pickSessionOption(options) ?? undefined);
    case 'deny':
      // reject_always would silently deny every later request, so it is never picked.
      return selected(options.find((o) => o.kind === 'reject_once')) ?? { outcome: 'cancelled' };
  }
};
