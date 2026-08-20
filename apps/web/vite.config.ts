import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import fs from 'fs';

const apiTarget = process.env.API_PROXY_TARGET ?? 'https://localhost:3000';

/**
 * Dev-server TLS, read lazily.
 *
 * These certs are ONLY needed by `vite dev`. They used to be read with a
 * top-level `fs.readFileSync`, which runs when the config module loads — so
 * `vite build` also required them and died with ENOENT on any machine without
 * them. `certs/` is gitignored, so that meant the web app could not be built on
 * a fresh clone, a CI runner, or a deployment host (hit on the EC2 deploy,
 * 2026-07-25).
 *
 * Returning undefined when the certs are absent makes the dev server fall back
 * to plain HTTP instead of crashing, and lets `vite build` run anywhere.
 */
function devHttps() {
  const keyPath = path.resolve(__dirname, '../../certs/server.key');
  const certPath = path.resolve(__dirname, '../../certs/server.crt');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  return undefined;
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'DigiLog - 21 CFR Part 11 Compliance',
        short_name: 'DigiLog',
        description: '21 CFR Part 11 compliant administration and instrument monitoring',
        theme_color: '#0891b2',
        background_color: '#f8fafc',
        display: 'standalone',
        orientation: 'any',
        start_url: '/m',
        scope: '/',
        categories: ['business', 'productivity'],
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
        shortcuts: [
          {
            name: 'Instruments',
            short_name: 'Operations',
            url: '/m',
            icons: [{ src: '/pwa-192x192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        // Audit 2026-05-04 fix (web-plumbing review H): without skipWaiting +
        // clientsClaim, a freshly-deployed SW waits until ALL tabs close
        // before activating. Operators on long-running tablet shifts kept
        // submitting requests under the OLD bundle's contract long after the
        // server upgraded. Now: new SW takes over on next request; the
        // ReloadPrompt component (apps/web/src/components/pwa-reload-prompt.tsx)
        // shows a dismissable banner so the operator can refresh to pick up
        // the new bundle's UI and shape changes too.
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Read @digilog/shared straight from its TypeScript SOURCE in dev/build
      // instead of the compiled packages/shared/dist. Vite transpiles the .ts on
      // the fly, so edits to permissions / sidebar items / reauth actions are
      // live with HMR — no `npx tsc` rebuild needed for the web app. (The API
      // still reads dist via tsx, which start-digilog.bat rebuilds at launch.)
      '@digilog/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  build: {
    sourcemap: 'hidden',
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          swr: ['swr'],
        },
      },
    },
  },
  server: {
    // Port and API target are env-overridable so this clone can run alongside
    // another checkout of the same app (which owns 5175 / 3000 by default).
    port: Number(process.env.WEB_PORT ?? 5175),
    strictPort: true,
    host: true,
    https: devHttps(),
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
      '/uploads': {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
