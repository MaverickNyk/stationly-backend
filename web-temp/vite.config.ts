import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The app is served by the backend at `/kiosk` (see ../src/tempWebHost.ts), so
 * every asset URL has to be prefixed. `base` is the ONE place that path is
 * written down on the frontend side; the backend writes it once in tempWebHost.
 *
 * On extraction this becomes '/' and nothing else changes.
 */
export default defineConfig({
    base: '/kiosk/',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        // A café TV browser may be old and is certainly not fast. One file each
        // beats a waterfall of chunks over whatever wifi the café has.
        cssCodeSplit: false,
    },
    server: {
        port: 5174,
        proxy: {
            '/kiosk-api': 'http://localhost:3000',
            '/kiosk-stream': {
                target: 'http://localhost:3000',
                ws: true,
            },
            '/icons': 'http://localhost:3000',
        },
    },
});
