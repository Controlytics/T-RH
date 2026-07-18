import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import fs from 'fs';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'DigiLog - Filter Management',
        short_name: 'DigiLog',
        description: 'Digital Filter Management System - 21 CFR Part 11 Compliant',
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
            name: 'Filter Operations',
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
    port: 5175,
    strictPort: true,
    host: true,
    https: {
      key: fs.readFileSync(path.resolve(__dirname, '../../certs/server.key')),
      cert: fs.readFileSync(path.resolve(__dirname, '../../certs/server.crt')),
    },
    proxy: {
      '/api': {
        target: 'https://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
      '/uploads': {
        target: 'https://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
