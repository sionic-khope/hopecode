import './Chat.css';

/**
 * The full-width "N줄 더 보기" / "접기" line under a shortened diff, code block or tool output. `count` null shows
 * "접기" (the block is open and can fold back).
 */
export function MoreButton({ count, onClick, className }: { count: number | null; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      className={`hc-more${className ? ` ${className}` : ''}`}
      aria-expanded={count === null}
      data-sfx={count === null ? 'back' : 'select'}
      onClick={onClick}
    >
      <span className="hc-more__glyph" aria-hidden>
        {count === null ? '▴' : '▾'}
      </span>
      {count === null ? '접기' : `${count}줄 더 보기`}
    </button>
  );
}
