import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root missing');
const root = rootEl;

// xterm measures its cell size once, on open, from whatever face is ready. Load the bundled Geist faces
// first (local files, a few ms) so the terminal grid is measured against Geist Mono, not a fallback.
void Promise.allSettled([document.fonts.load('14px "Geist"'), document.fonts.load('14px "Geist Mono"')]).then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
