# Hopecode design notes (v5)

v5 reworks Hopecode's look using the design language of an internal Korean team-chat desktop app as the reference.
Only the language was carried over: the values below were re-expressed on Hopecode's own tokens
(`src/renderer/styles/tokens.css`) and components. No code, stylesheets, images or icons came from that project.

## The language in one paragraph

A calm, flat, light workspace. Panes sit edge to edge and are split by 1px hairlines instead of floating on a
canvas. Content lives on white cards with a hairline border and next to no shadow. One saturated blue marks primary
actions and selection, a pale blue wash marks selected rows and chips, and a warm terracotta shows up rarely, for
the agent's own marks. Titles use a Korean serif display face, and everything else uses a humanist Korean sans.
Motion is short and quiet.

## Palette (light)

| Role | Value | Notes |
| --- | --- | --- |
| Text | `#17171A` | near-black with a slight warmth |
| Text, muted / faint | same ink at 56% / 38% | secondary labels, placeholders, timestamps |
| Hairline / strong hairline | same ink at 8% / 14% | every border and divider |
| Conversation pane | `#F8FAFF` | blue-tinted white |
| Sidebar, statusline | `#F3F7FF` | one step deeper than the pane |
| Cards, pane header bar | `#FFFFFF` | |
| Inputs | `#FCFCFC` | fields sit a hair off the white card |
| Primary | `#0053FD` (hover `#0047D9`, press `#003DBD`) | buttons, send, selection bar, links |
| Primary wash | `#E6EEFF` | selected rows, active chips and toggles |
| User bubble | `#F0F5FF` with a terracotta hairline | "you" is the only warm-bordered surface |
| Terracotta | `#CF806D` | streaming caret, greeting eyebrow, warning borders |
| Success / warning / danger | `#1F9D55` / `#E0A43A` on `#FFF6E8` / `#C8372D` (unread red `#E5484D`) | danger surfaces use an 8% tint and a 35% border |

Status pastels are tints of the solid colors (8–12%), never separate hues. Avatars use muted mid-tones, so white
initials stay readable.

## Typography

- UI: **IBM Plex Sans KR** (400/500/600/700). Body 13px/20px, conversation 14px/23px, secondary 12px, meta 11px,
  micro 10.5px. Korean text needs the taller line height.
- Display: **Hahmlet** (variable, semibold), used for the thread title (17px), sheet and dialog titles (19px), and
  page and greeting titles (24–26px), plus the sidebar wordmark. Tracking is slightly negative (-0.01em).
- Mono: **JetBrains Mono** for code, diffs, the terminal, branch names, counts and the model pill.
- Section labels are small (12px) semibold muted text, not uppercase.

## Shape

- Radius: 12px for cards, the composer and popovers; 8px for controls, rows and inline code blocks; 16px for
  dialogs; pill for chips, badges, the send button and status pills.
- Spacing: a 4px grid, with 12/16/20/28 for card and pane padding.
- Elevation: cards carry a hairline plus an almost invisible 1px drop. Only floating layers (menus, popovers,
  dialogs, toasts) get a real shadow: a soft, blue-tinted 12/32px drop with a 2/6px contact shadow.
- Focus: a 2px ring in primary, offset by 2px of the pane color. Text fields instead get a primary border plus a
  3px 12% primary halo.

## Components

- **Sidebar**: a flat `#F3F7FF` column with a hairline right edge. Nav rows are 36px with 8px radius. Hover is a 5%
  primary wash. The selected row is the primary wash, semibold text, and a 2px primary bar on its leading edge.
  Section headers are small semibold muted labels with a mono count. The profile footer sits under a hairline.
- **Thread header**: a white bar with a bottom hairline. The title is in the display face, and the project name
  appears as a muted `#name` tag. Toolbar buttons are quiet 32px icon buttons, and an active toggle turns into the
  primary wash with a primary glyph.
- **Messages**: agent turns have no bubble. User turns sit in a pale blue bubble with a terracotta hairline and a
  12px radius. The streaming caret is terracotta.
- **Tool / diff cards**: white, hairline, 12px radius. The tool glyph sits in a small primary-wash square. Result
  and diff blocks are 8px hairline boxes on the pane color.
- **Permission card**: a primary-bordered card with a faint 3px primary halo and a red "승인 필요" badge before the
  question. Actions are primary / outlined / danger-outlined.
- **Composer**: a white 12px card with a strong hairline. Focus adds a primary border and a soft halo. Chips are
  pill-shaped and quiet, and an open chip takes the primary wash. The send button is a round primary disc that fades
  to a 30% primary tint when disabled.
- **Buttons**: primary is filled blue with an inset top highlight. Secondary is the input color with a strong
  hairline and turns primary-bordered on hover. Danger is outlined red. Pressing moves a button 0.5px down instead
  of scaling it.
- **Menus / popovers**: solid white, 12px radius, float shadow, 8px-radius items, a primary-wash hover, and a
  primary checked item.
- **Dialogs**: a 16px radius, a display-face title, and a footer separated by a hairline. The backdrop is a light
  navy scrim with a 2px blur.
- **Pages** (settings, accounts): a pane header with a large display title, a muted lede and a bottom hairline,
  followed by hairline section cards.
- **Statusline**: flat, on the sidebar color, under a hairline. Segments are separated by short hairlines. Numbers
  are mono, meters are 4px flat bars, and the model is shown as an outlined mono pill.

## Motion

- Two durations: 120ms for hover and press, 200ms for enter and exit (280ms for pane width changes). One curve:
  `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Popovers, dialogs and new messages rise 8px from 98.5% scale while fading in. The backdrop fades.
- Busy indicators are a pulsing dot ring and a linear spinner. There is no bounce and no overshoot.
- `prefers-reduced-motion`: every duration token collapses to 0ms and the rise distance and scale go to their
  neutral values, so every token-driven transition and keyframe becomes instant.

## Fonts and licenses

All three families are SIL Open Font License 1.1. They are bundled in `src/renderer/assets/fonts/`, and their license
texts in `assets/fonts/licenses/` ship in the app as `Resources/font-licenses`.

- IBM Plex Sans KR: IBM's official web woff2 files (`@ibm/plex-sans-kr` 1.1.0), unmodified. "Plex" is a Reserved Font
  Name, so these files are not subset or altered.
- Hahmlet: converted to woff2 from google/fonts and subset to Latin, Hangul and common symbols (no Reserved Font
  Name).
- JetBrains Mono: converted to woff2 from google/fonts with the full glyph set (no Reserved Font Name).
