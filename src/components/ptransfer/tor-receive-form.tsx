import { AlertCircle, Download } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/locale-context';
import { classifyPin, PIN_LENGTH } from '@/lib/crypto';
import { DEFAULT_TOR_BRIDGE, type TorBridge } from '@/lib/tor/bridge';
import { TorBridgeChoice } from './tor-bridge-choice';

interface TorReceiveFormProps {
  /** The address just recognized, shown back so a mis-paste is visible. */
  address: string;
  onSubmit: (password: string, bridge: TorBridge) => void;
  onCancel: () => void;
}

/**
 * The second half of the Tor rendezvous, asked for once an onion address has
 * been recognized: the one-time password, and which Snowflake bridge this tab
 * reaches Tor through.
 *
 * The password is checked for its checksum before anything is bootstrapped —
 * building circuits to find out a character was mistyped would cost minutes.
 */
export function TorReceiveForm({
  address,
  onSubmit,
  onCancel,
}: TorReceiveFormProps) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [bridge, setBridge] = useState<TorBridge>(DEFAULT_TOR_BRIDGE);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(() => {
    const trimmed = password.trim();
    // A Tor password is always a standard-length PIN: nothing about it selects
    // a relay pool, so the longer anonymous-signaling form has no meaning here
    // and is rejected as the typo it would be.
    if (classifyPin(trimmed) !== 'standard') {
      setError(
        trimmed.length === PIN_LENGTH
          ? t({
              en: 'That password is not valid — check for typos.',
              es: 'Esa contraseña no es válida: revisa que esté bien escrita.',
            })
          : t({
              en: `The password is ${PIN_LENGTH} characters long.`,
              es: `La contraseña tiene ${PIN_LENGTH} caracteres.`,
            }),
      );
      return;
    }
    setError(null);
    setPassword('');
    onSubmit(trimmed, bridge);
  }, [bridge, onSubmit, password, t]);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {t({ en: 'Onion address', es: 'Dirección onion' })}
        </p>
        <code className="block overflow-x-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all">
          {address}
        </code>
      </div>

      <div className="space-y-2">
        <label htmlFor="tor-password" className="text-sm font-medium">
          {t({
            en: 'One-time password',
            es: 'Contraseña de un solo uso',
          })}
        </label>
        <Input
          id="tor-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
          placeholder={'X'.repeat(PIN_LENGTH)}
          className="font-mono tracking-[0.2em]"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={PIN_LENGTH}
        />
        <p className="text-xs text-muted-foreground">
          {t({
            en: `Every character is case-sensitive, and all ${PIN_LENGTH} of them are secret — unlike a PIN, nothing about this password is public.`,
            es: `Cada carácter distingue entre mayúsculas y minúsculas, y los ${PIN_LENGTH} son secretos: a diferencia de un PIN, nada de esta contraseña es público.`,
          })}
        </p>
      </div>

      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        <p className="text-sm font-medium">
          {t({
            en: 'How this tab reaches Tor',
            es: 'Cómo se conecta esta pestaña a Tor',
          })}
        </p>
        <TorBridgeChoice
          value={bridge}
          onChange={setBridge}
          idPrefix="receive-tor-bridge"
        />
        <p className="text-xs text-muted-foreground">
          {t({
            en: "The sender's choice does not have to match yours: the two only meet inside the Tor network.",
            es: 'La elección del emisor no tiene por qué coincidir con la tuya: los dos solo se encuentran dentro de la red Tor.',
          })}
        </p>
      </div>

      {error && (
        <p className="text-xs text-destructive flex items-center">
          <AlertCircle className="h-3 w-3 mr-1" />
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button variant="outline" onClick={onCancel} className="flex-1">
          {t({ en: 'Back', es: 'Atrás' })}
        </Button>
        <Button
          onClick={submit}
          disabled={!password.trim()}
          className="flex-1 bg-cyan-600 hover:bg-cyan-700 dark:bg-cyan-600 dark:hover:bg-cyan-700"
        >
          <Download className="mr-2 h-4 w-4" />
          {t({ en: 'Connect over Tor', es: 'Conectar por Tor' })}
        </Button>
      </div>
    </div>
  );
}
