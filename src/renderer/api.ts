// Type-safe wrapper around `window.hopecode` (plan 4.4 `api.ts`).
// Every other renderer module (store, components) should import from here instead of touching
// `window.hopecode` directly, so the preload boundary has exactly one call site.
import type { EventChannel, EventPayload, InvokeChannel, InvokeRequest, InvokeResponse } from '../shared/ipc';

function bridge() {
  if (!window.hopecode) {
    throw new Error('window.hopecode is unavailable (preload script did not run)');
  }
  return window.hopecode;
}

export function invoke<K extends InvokeChannel>(
  channel: K,
  ...req: InvokeRequest<K> extends void ? [] : [InvokeRequest<K>]
): Promise<InvokeResponse<K>> {
  return bridge().invoke(channel, ...req);
}

export function on<K extends EventChannel>(channel: K, cb: (payload: EventPayload<K>) => void): () => void {
  return bridge().on(channel, cb);
}

export const api = { invoke, on };
