import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles/app.css';

const root = document.getElementById('root')!;
const tree = (
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);

// "/" is prerendered (scripts/prerender.mjs), so it hydrates; every other route renders into app.html's empty root.
if (root.firstElementChild) hydrateRoot(root, tree);
else createRoot(root).render(tree);
