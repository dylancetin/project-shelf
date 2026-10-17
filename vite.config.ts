import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'prompt',
    includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'pwa-192.png', 'pwa-512.png', 'pwa-maskable-512.png'],
    manifest: {
      id: '/',
      name: 'Project Shelf',
      short_name: 'Shelf',
      description: 'Your projects and local services, with saved destinations available offline.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#f1f4f8',
      theme_color: '#f1f4f8',
      icons: [
        { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,svg,png,jpg,json,webmanifest}'],
      navigateFallback: '/index.html',
      navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/search(?:[/?]|$)/, /^\/opensearch\.xml(?:[/?]|$)/],
      cleanupOutdatedCaches: true,
      clientsClaim: true,
      // The versioned shell is cache-first; worker updates download in the
      // background. useShelfData restores saved metadata immediately and
      // revalidates it without caching API responses (which include runtime).
      // Never replay commands or present cached status/logs as live responses.
      runtimeCaching: [],
    },
  })],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT || 4958),
    strictPort: true,
    allowedHosts: ['beelinkk', 'beelinkk.tail750ac6.ts.net'],
    proxy: {
      '/api': `http://127.0.0.1:${process.env.API_PORT || 4959}`,
      '^/search(?:[/?]|$)': { target: `http://127.0.0.1:${process.env.API_PORT || 4959}`, changeOrigin: false },
      '^/opensearch\\.xml(?:[/?]|$)': { target: `http://127.0.0.1:${process.env.API_PORT || 4959}`, changeOrigin: false },
    },
  },
});
