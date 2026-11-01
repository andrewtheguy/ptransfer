import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import { PwaUpdatePrompt } from '@/components/pwa-update-prompt';
import { ThemeProvider } from '@/components/theme-provider';
import { localizePath, splitLocalePath } from '@/lib/i18n';
import { linkLocale } from '@/lib/link-locale';
import { sweepTransferScratch } from '@/lib/scratch-sink';
import App from './App.tsx';

// A link a sender handed over names the sender's language in its fragment
// (`/receive#p=<pin>&l=es`); open it on that language's path before anything
// renders, with the fragment intact for the page that reads it.
{
  const { pathname, search, hash } = window.location;
  const linked = linkLocale(hash);
  const { locale, path } = splitLocalePath(pathname);
  if (linked && linked !== locale) {
    window.history.replaceState(
      window.history.state,
      '',
      `${localizePath(path, linked)}${search}${hash}`,
    );
  }
}

// Remove receive-scratch plaintext a crashed or closed session left in OPFS.
void sweepTransferScratch();

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
      <BrowserRouter>
        <PwaUpdatePrompt />
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
