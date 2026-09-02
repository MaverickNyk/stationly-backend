import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';

import './design/tokens.css';
import './design/board.css';

/**
 * `basename` matches the mount path in ../src/tempWebHost.ts and Vite's `base`.
 * All three are the same string and must move together; on extraction all three
 * become '/'.
 */
createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <BrowserRouter basename="/kiosk">
            <App />
        </BrowserRouter>
    </React.StrictMode>,
);
