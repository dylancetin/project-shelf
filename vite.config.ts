import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The framed controls page is not an installable app, so it should not advertise the web manifest the
// PWA plugin adds to every page it builds.
const embedWithoutManifest = (): Plugin => ({
  name: 'embed-without-manifest',
  enforce: 'post',
  transformIndexHtml: {
    order: 'post',
    handler: (html, context) => context.filename.endsWith('embed.html') ? html.replace(/\s*<link rel="manifest"[^>]*>/, '') : html,
  },
});

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
      // The framed controls page follows live settings and the current build's asset hashes,
      // so a worker must neither precache it nor answer its navigations with the shell.
      globIgnores: ['embed.html'],
      navigateFallback: '/index.html',
      navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/search(?:[/?]|$)/, /^\/opensearch\.xml(?:[/?]|$)/, /^\/embed\.html(?:[/?]|$)/],
      cleanupOutdatedCaches: true,
      clientsClaim: true,
      // The versioned shell is cache-first; worker updates download in the
      // background. useShelfData restores saved metadata immediately and
      // revalidates it without caching API responses (which include runtime).
      // Never replay commands or present cached status/logs as live responses.
      runtimeCaching: [],
    },
  }), embedWithoutManifest()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        embed: fileURLToPath(new URL('./embed.html', import.meta.url)),
      },
    },
  },
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
