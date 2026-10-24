import './tokens.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startThemeSync } from './theme';
import './style.css';
import './editor.css';
import './space-files.css';

startThemeSync();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
