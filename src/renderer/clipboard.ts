// Clipboard write for copy buttons. The async Clipboard API needs a focused document; a background window (or a
// hidden one) falls back to a selection + execCommand('copy'), which Chromium allows inside a user gesture.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyWithSelection(text);
  }
}

function copyWithSelection(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  const active = document.activeElement as HTMLElement | null;
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    area.remove();
    active?.focus?.({ preventScroll: true });
  }
  return ok;
}
