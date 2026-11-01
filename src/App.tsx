import { Route, Routes, useLocation } from 'react-router-dom';
import { Footer } from '@/components/footer';
import { Navbar } from '@/components/navbar';
import { LocaleProvider } from '@/i18n/locale-provider';
import { useDocumentHead } from '@/i18n/use-document-head';
import { splitLocalePath } from '@/lib/i18n';
import { AboutPage } from '@/pages/about';
import { CliPage } from '@/pages/cli';
import { DebugPage } from '@/pages/debug';
import { HomePage } from '@/pages/home';
import { NotFoundPage } from '@/pages/not-found';
import { ReceivePage } from '@/pages/receive';
import { ReceiveChunkedPage } from '@/pages/receive-chunked';
import { SendPage } from '@/pages/send';
import { SendLayout } from '@/pages/send/layout';
import { SendTransferPage } from '@/pages/send/transfer';
import { SendTransferLayout } from '@/pages/send/transfer/layout';

function App() {
  const location = useLocation();
  // Every page is declared once, on its unprefixed path; the locale prefix
  // (`/es/send`) only says which language to show it in. Matching the same
  // tree in every language is what keeps a page's state — a transfer under
  // way — when the language is switched.
  const { locale, path } = splitLocalePath(location.pathname);
  useDocumentHead(path, locale);

  return (
    <LocaleProvider locale={locale}>
      <div className="min-h-screen flex flex-col bg-gradient-to-b from-background to-muted/20">
        <Navbar />
        <main className="flex-1 px-6 py-6 sm:py-10">
          <Routes location={{ ...location, pathname: path }}>
            <Route path="/" element={<HomePage />} />
            {/* Send tool routes wrapped with SendLayout */}
            <Route element={<SendLayout />}>
              <Route path="/send" element={<SendPage />} />
              <Route path="/send/transfer" element={<SendTransferLayout />}>
                <Route index element={<SendTransferPage />} />
              </Route>
            </Route>
            <Route path="/receive" element={<ReceivePage />} />
            <Route path="/r" element={<ReceiveChunkedPage />} />
            <Route path="/cli" element={<CliPage />} />
            <Route path="/about" element={<AboutPage />} />
            {/* Relay diagnostics: unlinked on purpose, reachable by URL. */}
            <Route path="/debug" element={<DebugPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </LocaleProvider>
  );
}

export default App;
