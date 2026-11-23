import vue from '@vitejs/plugin-vue';
import { defaultClientConditions, defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const THEME_COLOR = '#0f766e';
/** Shown in 설정 so the family can tell which app build they are running. */
const APP_BUILD = process.env.APP_BUILD ?? new Date().toISOString().slice(0, 16).replace('T', ' ');
const apiProxy = {
  '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
};

export default defineConfig({
  define: { __APP_BUILD__: JSON.stringify(APP_BUILD) },
  build: {
    // ECharts is one lazily loaded chunk (~540 kB, ~185 kB gzip) used only by
    // chart screens; the app shell stays small.
    chunkSizeWarningLimit: 600,
  },
  resolve: {
    // Use @budget/shared TypeScript sources directly; no prebuild needed.
    conditions: ['@budget/source', ...defaultClientConditions],
  },
  plugins: [
    vue(),
    VitePWA({
      // Updates wait for the user (or the next start) instead of swapping code
      // under an open screen; src/pwa.ts registers the worker and applies them.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.ico', 'favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        id: '/',
        name: '우리집 가계부',
        short_name: '가계부',
        description: '가족이 함께 쓰는 가계부',
        lang: 'ko',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f5f6f8',
        theme_color: THEME_COLOR,
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [{ name: '내역 추가', short_name: '추가', url: '/add' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: '/index.html',
        // API calls must always hit the network and never get the app shell.
        navigateFallbackDenylist: [/^\/api(?:\/|$)/],
        cleanupOutdatedCaches: true,
        // Take control on first install; later versions wait (see src/pwa.ts).
        clientsClaim: true,
      },
    }),
  ],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
});
