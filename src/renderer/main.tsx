import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { applyThemeOverlay } from './theme/themeOverlay';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root missing');
const root = rootEl;

// xterm measures its cell size once, on open, from whatever face is ready. Load the bundled faces and the local theme
// overlay (palette, fonts, sprites from ~/.hopecode/theme) first -- local files, a few ms -- so the first paint is
// already in the final theme and the terminal grid is measured against the final mono face, not a fallback.
void Promise.allSettled([
  document.fonts.load('12px "Galmuri11"'),
  document.fonts.load('700 12px "Galmuri11"'),
  document.fonts.load('15px "Galmuri14"'),
  document.fonts.load('16px "Silkscreen"'),
  document.fonts.load('13px "JetBrains Mono"'),
  applyThemeOverlay(),
]).then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
