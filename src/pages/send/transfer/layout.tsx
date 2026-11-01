import { ArrowLeft, Send } from 'lucide-react';
import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useSend } from '@/contexts/send-context';
import { useLocaleNavigate, useT } from '@/i18n/locale-context';

export function SendTransferLayout() {
  const t = useT();
  const navigate = useLocaleNavigate();
  const { config, clearConfig } = useSend();

  // Redirect to the send tool if no config (user navigated directly here)
  useEffect(() => {
    if (!config) {
      navigate('/send', { replace: true });
    }
  }, [config, navigate]);

  const handleBack = () => {
    navigate('/send');
    clearConfig();
  };

  if (!config) {
    return null; // Will redirect
  }

  return (
    <div className="flex w-full justify-center">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBack}
              className="h-8 w-8 p-0"
              aria-label={t({
                en: 'Go back to send',
                es: 'Volver a enviar',
              })}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <CardTitle className="text-2xl flex items-center gap-2">
                <Send className="h-6 w-6" />
                {t({ en: 'Secure Send', es: 'Envío seguro' })}
              </CardTitle>
              <CardDescription>
                {t({
                  en: `Transferring ${config.selectedFiles.length} file(s)`,
                  es: `Transfiriendo ${config.selectedFiles.length} archivo(s)`,
                })}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <Outlet />
        </CardContent>
      </Card>
    </div>
  );
}
