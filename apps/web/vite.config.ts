import vue from '@vitejs/plugin-vue';
import { defaultClientConditions, defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const THEME_COLOR = '#0f766e';
const apiProxy = {
  '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
};

export default defineConfig({
  resolve: {
    // Use @budget/shared TypeScript sources directly; no prebuild needed.
    conditions: ['@budget/source', ...defaultClientConditions],
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
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
      },
    }),
  ],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
});
