# Hopecode design notes (v12, "Dark World")

v12 restyles Hopecode as a dark pixel RPG dialogue screen. The values live in `src/renderer/styles/tokens.css`. The
bundled art (the mark, the heart, the subagent characters) is original. Users can swap in their own fonts, sprites and
colors through the local theme folder (see README, "Theme").

## The language in one paragraph

Black panes sit edge to edge and are split by 2px lines. Content sits in square boxes with a white pixel frame and no
soft shadow. Floating layers (menus, dialogs, the palette) get a 3px white frame and a hard violet drop. The agent
speaks from a portrait box beside a dialogue box whose first line is its name tag (`* CLAUDE`). The user's lines sit
in a violet frame. Selection works like an RPG menu: the selected row turns yellow and gets a red pixel-heart cursor.
Buttons are solid blocks with a bevel and a hard drop, and they sink onto the drop when pressed. Type is pixel type.
Code stays in a smooth monospace.

## Palette

| Role | Value | Notes |
| --- | --- | --- |
| Canvas, sidebar, cards, statusline | `#000000` | |
| Conversation well | `#07050C` | |
| Muted field (code, settings rows) | `#0E0A18` | |
| Text / secondary / faint | `#FFFFFF` / `#B8B0CC` / `#6E6685` | |
| Frame | `#FFFFFF` (2px cards, 3px dialogue boxes and floating layers) | lines: white at 16% / 32% |
| Primary | `#9B4DFF` (hover `#B077FF`, press / bevel `#6A2BD9`) | buttons, send, user frame, running state |
| Primary wash | `#1F1238` | selected thread, active chips |
| Hard drop | `#4A1F94` | offset 3px (buttons) / 6px (popovers) / 8px (dialogs), no blur |
| Selection | `#FFE14D` | selected text, open chips, focus ring, name tags |
| Heart | `#FF2B45` | cursor sprite, typing cursor, caret |
| Inline code | `#4FE3F0` | |
| ok / warn / crit / run | `#3CE07A` / `#FFB23D` / `#FF3B4E` / `#9B4DFF` | status pills are frames in their color, no fill |
| Diff add / del | `#0D2A17` + `#5CF097` / `#2E0C12` + `#FF6B79` | |
| HP gauge (5h) | `#FFE14D` on `#6B0F1A` | |
| TP gauge (ctx) | `#FF9A3D` on `#2A1A00` | |

## Type

| Use | Face | Size |
| --- | --- | --- |
| UI, statusline, menus | Galmuri11 | 12px / 20px |
| Conversation body, composer | Galmuri14 | 15px / 25px |
| Titles | Galmuri11 Bold | 18px / 24px (thread, dialogs), 24px / 32px (pages, draft) |
| Wordmark | Silkscreen | 16px, caps, 0.08em tracking |
| Code, diffs, terminal | JetBrains Mono | 12.5px / 13px |

Pixel faces render without font smoothing, only at the sizes they were drawn for. Other sizes blur the grid.
Monospace text turns smoothing back on.

## Components

- **Agent reply**: a 52px portrait box (agent logo, 2px white frame) and a dialogue box (3px white frame, notched
  corners). The first item of a run carries the name tag. When the run opens with a tool card, the tag sits above
  the card.
- **User message**: a violet-ink box with a 3px violet frame, right-aligned.
- **Lists, menus, palette**: a `--heart-gutter` of left padding. The selected or hovered row shows the heart and
  yellow text. In menus the heart follows the pointer and rests on the checked item.
- **Buttons, chips, send**: square. Primary buttons use a bevel and a hard drop. Chips use a 2px line, and an open
  chip uses a yellow frame. The send button shows the heart as a white silhouette (CSS mask).
- **Statusline**: the model in a framed box, an HP gauge (5h) and a TP gauge (ctx) as white-framed bars, other meters
  as plain framed bars.
- **Subagents**: a PARTY line that lines the characters up in small frames. The sprite outline is `#E9E2FF` so it
  reads on black.
- **Motion**: the motion tokens and their reduced-motion collapse are unchanged. Pixel elements (the cursor blink,
  the running frame, the tool sweep, the sprite bob) step instead of tweening.

## Brand

The mark is a 16x16 drawing of a white dialogue frame with notched corners, a red pixel heart and a yellow block
cursor. `BrandMark.tsx` draws it in the app, sized in multiples of 16. `build/icon.svg` draws it on the macOS squircle
(`build/icon.png`, `build/icon.icns`, `docs/logo.png`). The lockup is the mark plus HOPECODE in Silkscreen, with
"CODE" in yellow.
