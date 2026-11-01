import { AlertCircle, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/locale-context';
import {
  CONFIRMATION_CODE_LENGTH,
  normalizeCrockfordBase32,
} from '@/lib/crypto';

interface ConfirmationCodeInputProps {
  /** Returns whether the code matched; a mismatch leaves the send parked. */
  onSubmit: (code: string) => boolean;
}

/**
 * The sender's half of the anti-front-running check.
 *
 * A receiver has claimed the transfer and is showing a code derived from the
 * ECDH exchange. Nothing — not the confirm event, not a WebRTC offer, not a
 * byte of the file — leaves this side until the operator types a matching one,
 * so whoever claimed first still has to prove they are the person the sender
 * meant to send to.
 */
export function ConfirmationCodeInput({
  onSubmit,
}: ConfirmationCodeInputProps) {
  const t = useT();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Normalizing on entry means the hyphen the receiver sees, lowercase typing,
  // and the classic O/0 and I/1 mix-ups all land on the same value.
  const normalized = normalizeCrockfordBase32(value);
  const isComplete = normalized.length === CONFIRMATION_CODE_LENGTH;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isComplete) return;
    if (onSubmit(normalized)) return;
    setError(
      t({
        en: "That code doesn't match. Check it with your receiver and try again — if it keeps failing, cancel and start a new transfer.",
        es: 'Ese código no coincide. Compruébalo con tu receptor e inténtalo de nuevo; si sigue fallando, cancela e inicia una nueva transferencia.',
      }),
    );
    setValue('');
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border bg-muted/40 p-4 flex flex-col gap-3"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4" />
        {t({
          en: "Enter the receiver's confirmation code",
          es: 'Introduce el código de confirmación del receptor',
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        {t({
          en: 'Someone has claimed this transfer. Ask the person you meant to send to for the code on their screen — nothing is sent until it matches.',
          es: 'Alguien ha reclamado esta transferencia. Pide a la persona a la que querías enviarla el código que aparece en su pantalla: no se envía nada hasta que coincida.',
        })}
      </p>

      <Input
        type="text"
        inputMode="text"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        placeholder={'•'.repeat(CONFIRMATION_CODE_LENGTH)}
        aria-label={t({
          en: 'Confirmation code',
          es: 'Código de confirmación',
        })}
        className={`font-mono text-xl text-center tracking-[0.2em] ${
          error ? 'border-destructive' : isComplete ? 'border-green-500' : ''
        }`}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        autoFocus
      />

      {error ? (
        <span className="text-xs text-destructive flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
          {error}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">
          {t({
            en: `${normalized.length}/${CONFIRMATION_CODE_LENGTH} characters`,
            es: `${normalized.length}/${CONFIRMATION_CODE_LENGTH} caracteres`,
          })}
        </span>
      )}

      <Button type="submit" disabled={!isComplete} className="self-start">
        {t({ en: 'Start transfer', es: 'Iniciar transferencia' })}
      </Button>
    </form>
  );
}
