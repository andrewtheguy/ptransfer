import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { configDefaults, defineConfig } from 'vitest/config';

const INTEGRATION_TESTS = 'src/lib/nostr-file/live.test.ts';

function getGitCommitHash(): string {
  // Cloudflare Pages exposes the deployed commit via this env var. Local builds
  // fall back to a placeholder to avoid confusion about which commit is running.
  const cfSha = process.env.CF_PAGES_COMMIT_SHA;
  return cfSha ? cfSha.slice(0, 7) : 'local';
}

// The Tor WASM client is a `file:` dependency, so npm links it into
// node_modules as a symlink to a sibling checkout. Vite serves it through its
// real path, which lies outside the project root and would otherwise be
// refused by the dev server's filesystem allow list.
function anonymousSignalingWasmDir(): string {
  const require = createRequire(path.join(__dirname, 'package.json'));
  return fs.realpathSync(
    path.dirname(
      require.resolve('@andrewtheguy/anonymous-signaling-wasm/package.json'),
    ),
  );
}

// https://vite.dev/config/
export default defineConfig({
  test: {
    // `src/lib/nostr-file/live.test.ts` drives whole transfers through the
    // mock relay network and waits out real-time heartbeats, retry clocks and
    // idle deadlines — ~60s against ~6s for every other file combined — so it
    // is a project of its own rather than part of the unit run. Splitting it
    // here (not just in an npm script) is what keeps `fileParallelism: false`
    // attached to the file: its real-time deadlines must never compete with
    // parallel unit workers, however the run was started.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [...configDefaults.exclude, INTEGRATION_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [INTEGRATION_TESTS],
          fileParallelism: false,
        },
      },
    ],
  },
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
    __GIT_COMMIT_HASH__: JSON.stringify(getGitCommitHash()),
  },
  server: {
    allowedHosts: ['.trycloudflare.com'],
    fs: {
      allow: [__dirname, anonymousSignalingWasmDir()],
    },
    // Keep a page on one coherent module set when WASM is rebuilt during development.
    hmr: false,
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
        // Cache all static assets including workers and WASM. The QR WASM is
        // precached because Code Exchange has to work offline.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,wasm}'],
        // The browser Tor client is a multi-megabyte, opt-in WASM asset that
        // is useless offline anyway: fetch it on demand when Anonymous
        // Signaling is enabled instead of pushing it onto every install.
        globIgnores: ['**/anonymous_signaling_wasm_bg*.wasm'],
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
