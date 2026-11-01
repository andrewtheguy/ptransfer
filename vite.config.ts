import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import type { ManifestOptions } from 'vite-plugin-pwa';
import { VitePWA } from 'vite-plugin-pwa';
import { configDefaults, defineConfig } from 'vitest/config';
import {
  type HeadContent,
  HTML_LANG,
  headFor,
  INDEXED_PAGES,
  manifestHref,
  pageFileName,
  SITE_ORIGIN,
} from './src/i18n/pages';
import {
  DEFAULT_LOCALE,
  LOCALES,
  type Locale,
  localizePath,
} from './src/lib/i18n';

const INTEGRATION_TESTS = 'src/lib/nostr-file/live.test.ts';

// The terminal UI's tests drive OpenTUI, which loads a native Zig core over
// FFI and needs Bun or Node 26.4; this run is neither. They are `bun test`
// files — `bun run test:tui` — and vitest must not try them.
const TUI_TESTS = '**/*.tui.test.tsx';

function getGitCommitHash(): string {
  // Cloudflare Pages exposes the deployed commit via this env var. Local builds
  // fall back to a placeholder to avoid confusion about which commit is running.
  const cfSha = process.env.CF_PAGES_COMMIT_SHA;
  return cfSha ? cfSha.slice(0, 7) : 'local';
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function replaceOnce(html: string, search: RegExp, replacement: string) {
  if (!search.test(html)) {
    throw new Error(`index.html no longer has ${search}`);
  }
  return html.replace(search, replacement);
}

/**
 * The PWA manifest of one language. vite-plugin-pwa writes the default
 * locale's; `localizedPages` writes the others beside it, and links each
 * page to its own language's.
 */
function webManifest(locale: Locale): Partial<ManifestOptions> {
  return {
    name: 'pTransfer',
    short_name: 'pTransfer',
    description: headFor('/', locale).description,
    lang: HTML_LANG[locale],
    theme_color: '#000000',
    background_color: '#000000',
    display: 'standalone',
    orientation: 'portrait',
    scope: '/',
    start_url: localizePath('/', locale),
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
  };
}

function withHead(template: string, head: HeadContent, locale: Locale): string {
  const links = [
    ...(head.canonical
      ? [`<link rel="canonical" href="${escapeHtml(head.canonical)}" />`]
      : []),
    ...head.alternates.map(
      ({ hreflang, href }) =>
        `<link rel="alternate" hreflang="${hreflang}" href="${escapeHtml(href)}" />`,
    ),
  ];
  let html = replaceOnce(
    template,
    /<html lang="[^"]*">/,
    `<html lang="${head.lang}">`,
  );
  html = replaceOnce(
    html,
    /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${escapeHtml(head.description)}" />`,
  );
  if (locale !== DEFAULT_LOCALE) {
    html = replaceOnce(
      html,
      /<link rel="manifest" href="[^"]*">/,
      `<link rel="manifest" href="${manifestHref(locale)}">`,
    );
  }
  return replaceOnce(
    html,
    /<title>[^<]*<\/title>/,
    [`<title>${escapeHtml(head.title)}</title>`, ...links].join('\n  '),
  );
}

/**
 * One HTML file per indexed page and locale, each with its own language,
 * title, description, canonical link and alternates in its head, and a
 * sitemap listing them — what a search engine reads before running the app.
 * `es/about.html` is served at `/es/about`; any other path gets the host's
 * fallback, `index.html`, and the app sets its head once it runs.
 */
function localizedPages(): Plugin {
  return {
    name: 'ptransfer:localized-pages',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      if (index?.type !== 'asset') {
        throw new Error('the build emitted no index.html');
      }
      const template = String(index.source);
      for (const path of Object.keys(INDEXED_PAGES)) {
        for (const locale of LOCALES) {
          const html = withHead(template, headFor(path, locale), locale);
          const fileName = pageFileName(path, locale);
          if (fileName === 'index.html') {
            index.source = html;
          } else {
            this.emitFile({ type: 'asset', fileName, source: html });
          }
        }
      }

      const urls = Object.keys(INDEXED_PAGES).flatMap((path) =>
        LOCALES.map((locale) => {
          const alternates = headFor(path, locale).alternates.map(
            ({ hreflang, href }) =>
              `    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${escapeHtml(href)}" />`,
          );
          return [
            '  <url>',
            `    <loc>${escapeHtml(`${SITE_ORIGIN}${localizePath(path, locale)}`)}</loc>`,
            ...alternates,
            '  </url>',
          ].join('\n');
        }),
      );
      for (const locale of LOCALES) {
        if (locale === DEFAULT_LOCALE) continue;
        this.emitFile({
          type: 'asset',
          fileName: manifestHref(locale).slice(1),
          source: `${JSON.stringify(webManifest(locale))}\n`,
        });
      }

      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
          ...urls,
          '</urlset>',
          '',
        ].join('\n'),
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  test: {
    // `src/lib/nostr-file/live.test.ts` drives whole transfers through the
    // mock relay network and waits out real-time heartbeats, retry clocks and
    // idle deadlines — ~60s against ~6s for every other file combined — so it
    // is a project of its own rather than part of the unit run. Splitting it
    // here (not just in a package script) is what keeps `fileParallelism: false`
    // attached to the file: its real-time deadlines must never compete with
    // parallel unit workers, however the run was started.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [...configDefaults.exclude, INTEGRATION_TESTS, TUI_TESTS],
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
    __GIT_COMMIT_HASH__: JSON.stringify(getGitCommitHash()),
  },
  server: {
    allowedHosts: ['.trycloudflare.com'],
    // Keep a page on one coherent module set when WASM is rebuilt during development.
    hmr: false,
  },
  plugins: [
    tailwindcss(),
    react(),
    localizedPages(),
    VitePWA({
      registerType: 'prompt',
      devOptions: {
        enabled: false, // Disable PWA in development to avoid caching issues
      },
      workbox: {
        // Cache all static assets including workers and WASM
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,wasm}'],
        // The browser Tor client is 1.7 MB and only the Tor transfer mode ever
        // loads it — and that mode needs the network anyway, so precaching it
        // for offline use would cost every visitor the download for nothing.
        globIgnores: ['**/webtor_wasm_bg*.wasm'],
        // Increase max file size for WASM files (zxing-wasm can be large)
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB
      },
      manifest: webManifest(DEFAULT_LOCALE),
    }),
  ],
  optimizeDeps: {
    // The browser Tor client is loaded lazily, so Vite would only discover it
    // mid-transfer and re-optimize — which reloads the page and takes the
    // in-flight transfer with it. It is also a wasm-bindgen package whose glue
    // resolves its binary relative to itself, which pre-bundling breaks.
    exclude: ['@andrewtheguy/webtor-wasm'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
