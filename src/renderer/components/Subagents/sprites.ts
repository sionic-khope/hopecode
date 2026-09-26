// Original 12x12 pixel characters for subagents (decorative). Each row is 12 palette keys; '.' is transparent.
// A subagent type always maps to the same character (FNV-1a hash of the type string).

export const SPRITE_GRID = 12;

/** Muted palette tuned for the light theme (pixel art only; UI colors come from tokens.css). */
export const SPRITE_PALETTE: Readonly<Record<string, string>> = {
  k: '#3d4353', // outline ink
  w: '#ffffff',
  c: '#f4ebdd', // cream
  B: '#8fb0de', // soft blue
  b: '#6a8cbd', // blue shade
  T: '#cf806d', // terracotta
  t: '#b36a58', // terracotta shade
  S: '#a9c19f', // sage
  s: '#8aa681', // sage shade
  O: '#d9ae62', // ochre
  W: '#a88462', // owl brown
  N: '#56627a', // penguin slate
  p: '#e8a99b', // blush
};

export interface SpriteDef {
  id: string;
  /** Korean name (tooltip / accessible label). */
  name: string;
  rows: readonly string[];
}

export const SPRITES: readonly SpriteDef[] = [
  {
    id: 'robot',
    name: '로봇',
    rows: [
      '.....O......',
      '.....k......',
      '..kkkkkkkk..',
      '..kBBBBBBk..',
      '..kBwBBwBk..',
      '..kBBBBBBk..',
      '..kBkkkkBk..',
      '..kkkkkkkk..',
      '.kbBBBBBBbk.',
      '.kbBOBBOBbk.',
      '..kBBBBBBk..',
      '..kk....kk..',
    ],
  },
  {
    id: 'cat',
    name: '고양이',
    rows: [
      '.k.......k..',
      '.kk.....kk..',
      '.kTk...kTk..',
      '.kTTkkkTTk..',
      '.kTTTTTTTk..',
      '.kTkTTTkTk..',
      '.kTTTpTTTk..',
      '..kTTTTTk...',
      '..kTcccTk.k.',
      '..kTcccTkkTk',
      '..kTTTTTkTk.',
      '..kk.k.kkk..',
    ],
  },
  {
    id: 'ghost',
    name: '유령',
    rows: [
      '....kkkk....',
      '..kkwwwwkk..',
      '.kwwwwwwwwk.',
      '.kwwwwwwwwk.',
      'kwwkwwwwkwwk',
      'kwwkwwwwkwwk',
      'kwpwwwwwwpwk',
      'kwwwwkkwwwwk',
      'kwwwwwwwwwwk',
      'kBwwwwwwwwBk',
      'kwwkwwwkwwwk',
      '.kk.kkk.kkk.',
    ],
  },
  {
    id: 'slime',
    name: '슬라임',
    rows: [
      '............',
      '............',
      '.....kk.....',
      '....kSSk....',
      '...kSSSSk...',
      '..kSwSSSSk..',
      '.kSwSSSSSSk.',
      '.kSSkSSkSSk.',
      'kSSSSSSSSSSk',
      'kSSSSkkSSSSk',
      'ksSSSSSSSSsk',
      '.kkkkkkkkkk.',
    ],
  },
  {
    id: 'mushroom',
    name: '버섯',
    rows: [
      '...kkkkkk...',
      '.kkTTcTTTkk.',
      'kTTccTTTcTTk',
      'kTTTTTTccTTk',
      'kcTTTcTTTTck',
      'kttttttttttk',
      '.kkkkkkkkkk.',
      '...kcccck...',
      '...kkcckk...',
      '...kcccck...',
      '...kcpcck...',
      '...kkkkkk...',
    ],
  },
  {
    id: 'star',
    name: '별',
    rows: [
      '.....kk.....',
      '....kOOk....',
      '....kOOk....',
      '...kOOOOk...',
      'kkkkOOOOkkkk',
      '.kOOOOOOOOk.',
      '..kOkOOkOk..',
      '...kOOOOk...',
      '..kOOppOOk..',
      '..kOOkkOOk..',
      '.kOk....kOk.',
      '.kk......kk.',
    ],
  },
  {
    id: 'owl',
    name: '부엉이',
    rows: [
      '.kk......kk.',
      '.kWk....kWk.',
      '.kWWkkkkWWk.',
      '.kWWWWWWWWk.',
      'kWccWWWWccWk',
      'kWckWWWWkcWk',
      'kWccWOOWccWk',
      'kWWWWWOWWWWk',
      'kWcWcWcWcWWk',
      'kWWcWcWcWWWk',
      '.kWWWWWWWWk.',
      '..kOk..kOk..',
    ],
  },
  {
    id: 'penguin',
    name: '펭귄',
    rows: [
      '....kkkk....',
      '...kNNNNk...',
      '..kNNNNNNk..',
      '..kNwNNwNk..',
      '..kNNOONNk..',
      '.kNNwwwwNNk.',
      'kNNwwwwwwNNk',
      'kNkwwwwwwkNk',
      '.kkwwwwwwkk.',
      '..kwwwwwwk..',
      '..kkwwwwkk..',
      '..kOOkkOOk..',
    ],
  },
];

/** FNV-1a (32-bit) of a string. */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Character of a subagent type (case-insensitive, trimmed): same type, same character. */
export function spriteForType(subagentType: string): SpriteDef {
  const key = subagentType.trim().toLowerCase();
  return SPRITES[hashString(key) % SPRITES.length]!;
}

export interface SpriteRect {
  x: number;
  y: number;
  w: number;
  fill: string;
}

/** Horizontal runs of same-colored pixels (one `<rect>` each). */
export function spriteRects(sprite: SpriteDef): SpriteRect[] {
  const rects: SpriteRect[] = [];
  sprite.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const key = row[x]!;
      let end = x + 1;
      while (end < row.length && row[end] === key) end++;
      const fill = SPRITE_PALETTE[key];
      if (fill) rects.push({ x, y, w: end - x, fill });
      x = end;
    }
  });
  return rects;
}
