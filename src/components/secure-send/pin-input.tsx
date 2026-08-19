import { AlertCircle, CheckCircle2 } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Input } from '@/components/ui/input';
import {
  derivePakeSecret,
  getPinLocator,
  isValidPin,
  PIN_CHARSET,
  PIN_LENGTH,
  wipeBufferSource,
} from '@/lib/crypto';

const MASK_CHAR = '*';

export interface PinChangePayload {
  /** SPAKE2 password scalar derived from the PIN (see derivePakeSecret). */
  pakeSecret: Uint8Array | null;
  /**
   * The PIN's public locator segment, needed to derive the rendezvous lookup
   * hints. Public by design, so unlike `pakeSecret` it is emitted as a plain
   * string.
   */
  locator: string | null;
  isValid: boolean;
  length: number;
}

interface PinInputProps {
  onPinChange: (payload: PinChangePayload) => void;
  disabled?: boolean;
}

export interface PinInputRef {
  clear: () => void;
}

/**
 * A single native input for the case-sensitive 8-character PIN.
 *
 * Once a complete, valid PIN is entered, the plaintext is reduced to its
 * SPAKE2 password scalar and removed from component state. Editing the
 * masked value starts a fresh entry.
 */
export const PinInput = forwardRef<PinInputRef, PinInputProps>(
  ({ onPinChange, disabled }, ref) => {
    const [pin, setPin] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isSecured, setIsSecured] = useState(false);

    const inputRef = useRef<HTMLInputElement>(null);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const generationRef = useRef(0);
    const securedSecretRef = useRef<Uint8Array | null>(null);
    const securedLocatorRef = useRef<string | null>(null);

    useEffect(() => {
      return () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        // Wipe the secured scalar on unmount. Inlined rather than calling
        // dropSecuredSecret so this cleanup stays free of callback deps.
        if (securedSecretRef.current) {
          wipeBufferSource(securedSecretRef.current);
          securedSecretRef.current = null;
        }
        securedLocatorRef.current = null;
      };
    }, []);

    const emitChange = useCallback(
      (valid: boolean, length: number) => {
        onPinChange({
          pakeSecret: valid ? securedSecretRef.current : null,
          locator: valid ? securedLocatorRef.current : null,
          isValid: valid,
          length,
        });
      },
      [onPinChange],
    );

    const dropSecuredSecret = useCallback(() => {
      if (securedSecretRef.current) {
        wipeBufferSource(securedSecretRef.current);
      }
      securedSecretRef.current = null;
      securedLocatorRef.current = null;
    }, []);

    const clearAll = useCallback(() => {
      generationRef.current++;
      dropSecuredSecret();
      setPin('');
      setIsSecured(false);
      setError(null);
      emitChange(false, 0);
    }, [dropSecuredSecret, emitChange]);

    useImperativeHandle(ref, () => ({ clear: clearAll }));

    const flashError = useCallback((message: string) => {
      setError(message);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setError(null), 1500);
    }, []);

    const securePin = useCallback(
      async (candidate: string) => {
        const generation = generationRef.current;
        try {
          const pakeSecret = await derivePakeSecret(candidate);
          if (generationRef.current !== generation) {
            wipeBufferSource(pakeSecret);
            return;
          }

          securedSecretRef.current = pakeSecret;
          securedLocatorRef.current = getPinLocator(candidate);
          setPin('');
          setIsSecured(true);
          setError(null);
          emitChange(true, PIN_LENGTH);
        } catch (err) {
          if (generationRef.current !== generation) return;
          console.error('Failed to secure PIN', err);
          dropSecuredSecret();
          emitChange(false, candidate.length);
          setError('Failed to secure PIN');
        }
      },
      [dropSecuredSecret, emitChange],
    );

    const commitPin = (value: string, invalid: boolean) => {
      generationRef.current++;
      dropSecuredSecret();
      setIsSecured(false);
      setPin(value);
      if (inputRef.current) {
        inputRef.current.value = value;
      }

      if (invalid) flashError('Invalid character');

      if (value.length === PIN_LENGTH && isValidPin(value)) {
        void securePin(value);
      } else {
        emitChange(false, value.length);
      }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = isSecured
        ? e.target.value.replaceAll(MASK_CHAR, '')
        : e.target.value;
      const validCharacters = [...raw].filter((char) =>
        PIN_CHARSET.includes(char),
      );
      commitPin(
        validCharacters.slice(0, PIN_LENGTH).join(''),
        validCharacters.length !== raw.length,
      );
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const raw = e.clipboardData.getData('text');
      const validCharacters = [...raw].filter((char) =>
        PIN_CHARSET.includes(char),
      );
      const value = validCharacters.slice(0, PIN_LENGTH).join('');
      commitPin(value, validCharacters.length !== raw.length);
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(value.length, value.length);
      });
    };

    const displayLength = isSecured ? PIN_LENGTH : pin.length;
    const isComplete = displayLength === PIN_LENGTH;
    const isValid = isSecured || (isComplete && isValidPin(pin));
    const hasChecksumError = isComplete && !isValid;

    return (
      <div className="flex flex-col gap-3">
        <Input
          ref={inputRef}
          type="text"
          inputMode="text"
          value={isSecured ? MASK_CHAR.repeat(PIN_LENGTH) : pin}
          onChange={handleChange}
          onPaste={handlePaste}
          placeholder={'•'.repeat(PIN_LENGTH)}
          aria-label="PIN"
          className={`font-mono text-xl text-center tracking-[0.2em] ${
            error || hasChecksumError
              ? 'border-destructive'
              : isComplete
                ? 'border-green-500'
                : ''
          }`}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
          maxLength={PIN_LENGTH}
        />

        <div className="flex justify-between items-center text-xs">
          <div className="flex items-center gap-1.5">
            {isComplete && !hasChecksumError ? (
              <span className="text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> PIN Valid
              </span>
            ) : hasChecksumError ? (
              <span className="text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> Invalid PIN — check for
                typos
              </span>
            ) : (
              <span className="text-muted-foreground">
                {displayLength}/{PIN_LENGTH} characters
              </span>
            )}
            {error && <span className="text-destructive">• {error}</span>}
          </div>
          <span className="text-muted-foreground">Case sensitive</span>
        </div>
      </div>
    );
  },
);
