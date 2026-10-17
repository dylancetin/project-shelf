import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: './',
  publicDir: false,
  plugins: [react()],
  resolve: { alias: { 'virtual:pwa-register/react': path.resolve(root, 'src/pwa-stub.ts') } },
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: path.resolve(root, 'newtab.html') } },
});
