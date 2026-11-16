import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles/app.css';

// a static host (or a file server) may show the copied shells as /keeper/index.html: route them as /keeper
if (/\/index\.html$/.test(location.pathname)) {
  history.replaceState(null, '', location.pathname.replace(/index\.html$/, '').replace(/(.)\/$/, '$1') + location.search + location.hash);
}

// "/" ships prerendered markup (scripts/prerender.mjs) so it reads without script; the client renders the same tree
// over it rather than hydrating, so a tool or extension that touched the DOM first never breaks the page.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
