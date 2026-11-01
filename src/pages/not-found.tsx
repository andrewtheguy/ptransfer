import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/locale-context';
import { LocaleLink } from '@/i18n/locale-link';

export function NotFoundPage() {
  const t = useT();
  return (
    <div className="flex w-full justify-center">
      <div className="w-full max-w-2xl rounded-xl border bg-card p-8 text-card-foreground shadow-sm">
        <div className="flex items-center gap-3">
          <div className="rounded-full border bg-muted p-2">
            <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t({ en: 'Page not found', es: 'Página no encontrada' })}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t({
                en: 'The page you tried to reach doesn’t exist or was moved.',
                es: 'La página que buscas no existe o se movió.',
              })}
            </p>
          </div>
        </div>

        <div className="mt-6 space-y-4 text-sm text-muted-foreground">
          <p>
            {t({
              en: 'Check the URL or head back home to start a transfer.',
              es: 'Revisa la URL o vuelve al inicio para empezar una transferencia.',
            })}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <LocaleLink to="/">
                {t({ en: 'Go home', es: 'Ir al inicio' })}
              </LocaleLink>
            </Button>
            <Button asChild variant="outline">
              <LocaleLink to="/send">
                {t({ en: 'Send files', es: 'Enviar archivos' })}
              </LocaleLink>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
