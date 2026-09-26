import { agentDescriptor } from '../../../shared/agents';
import type { AgentKind } from '../../../shared/types';
import { GlyphAgent } from '../common/glyphs';

// Agent logos bundled from src/renderer/assets/agents/ (claude-code.svg is the official Claude mark); when one is
// missing, the neutral Hopecode glyph is shown instead.
const bundled = import.meta.glob<string>('../../assets/agents/*.{svg,png}', { eager: true, query: '?url', import: 'default' });

/** Bundled logo URL for an agent (its `iconAsset`, e.g. `agents/claude-code.svg`), or null. */
export function agentLogoUrl(kind: AgentKind): string | null {
  const asset = agentDescriptor(kind).iconAsset;
  const hit = Object.entries(bundled).find(([path]) => path.endsWith(`/assets/${asset}`));
  return hit ? hit[1] : null;
}

/** Agent mark: the official logo when bundled, otherwise the neutral prompt glyph. */
export function AgentIcon({ kind, size = 16, className }: { kind: AgentKind; size?: number; className?: string }) {
  const url = agentLogoUrl(kind);
  if (url) return <img className={className} src={url} width={size} height={size} alt="" draggable={false} />;
  return <GlyphAgent className={className} width={size} height={size} />;
}
