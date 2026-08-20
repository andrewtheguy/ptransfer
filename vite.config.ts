import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function getGitCommitHash(): string {
  // Cloudflare Pages exposes the deployed commit via this env var. Local builds
  // fall back to a placeholder to avoid confusion about which commit is running.
  const cfSha = process.env.CF_PAGES_COMMIT_SHA;
  return cfSha ? cfSha.slice(0, 7) : 'local';
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
    __GIT_COMMIT_HASH__: JSON.stringify(getGitCommitHash()),
  },
  server: {
    allowedHosts: ['.trycloudflare.com'],
  },
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      registerType: 'prompt',
      devOptions: {
        enabled: false, // Disable PWA in development to avoid caching issues
      },
      workbox: {
        // Cache all static assets including workers and WASM
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,wasm}'],
        // Increase max file size for WASM files (zxing-wasm can be large)
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB
      },
      manifest: {
        name: 'pTransfer',
        short_name: 'pTransfer',
        description:
          'Share files and folders securely with end-to-end encryption',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
