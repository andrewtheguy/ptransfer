import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { type Localized, splitLocalePath } from '@/lib/i18n';

export function PwaUpdatePrompt() {
  // Rendered beside `App`, outside its `LocaleProvider`, so it reads the
  // locale from the URL itself.
  const { locale } = splitLocalePath(useLocation().pathname);
  const t = (messages: Localized) => messages[locale];
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 top-0 z-50 p-4">
      <Alert className="mx-auto max-w-md shadow-lg">
        <RefreshCw />
        <AlertTitle>
          {t({ en: 'Update available', es: 'Actualización disponible' })}
        </AlertTitle>
        <AlertDescription>
          {t({
            en: 'A new version is available. Reload to update.',
            es: 'Hay una nueva versión disponible. Recarga para actualizar.',
          })}
        </AlertDescription>
        <div className="col-start-2 mt-2 flex gap-2">
          <Button size="sm" onClick={() => updateServiceWorker(true)}>
            {t({ en: 'Reload', es: 'Recargar' })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setNeedRefresh(false)}
          >
            {t({ en: 'Dismiss', es: 'Descartar' })}
          </Button>
        </div>
      </Alert>
    </div>
  );
}
