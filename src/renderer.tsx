import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './renderer/App';
import './index.css';

if (new URLSearchParams(window.location.search).get('window') === 'activity') {
  document.documentElement.classList.add('activity-window');
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Sotto could not find its renderer root.');
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
