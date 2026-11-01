/**
 * Formatting for sizes and MIME types. Pure, and shared by both hosts: the
 * browser tab shows these in its status, the CLI prints them.
 */

import { type Localized, t } from '@/lib/i18n';

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  // Guard against zero, negative, or non-finite input
  if (bytes <= 0 || !Number.isFinite(bytes)) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1,
  );

  // Bytes are whole numbers; larger units always show one decimal (e.g.
  // "5.0 MiB"), written with the locale's decimal mark ("5,0 MiB").
  const value = bytes / k ** i;
  const shown = i === 0 ? String(value) : value.toFixed(1);
  return `${t({ en: shown, es: shown.replace('.', ',') })} ${sizes[i]}`;
}

/**
 * Get a user-friendly MIME type description
 */
export function getMimeTypeDescription(mimeType: string): string {
  const descriptions: Record<string, Localized> = {
    'application/pdf': { en: 'PDF Document', es: 'Documento PDF' },
    'application/zip': { en: 'ZIP Archive', es: 'Archivo ZIP' },
    'application/json': { en: 'JSON File', es: 'Archivo JSON' },
    'text/plain': { en: 'Text File', es: 'Archivo de texto' },
    'text/html': { en: 'HTML File', es: 'Archivo HTML' },
    'text/css': { en: 'CSS File', es: 'Archivo CSS' },
    'text/javascript': { en: 'JavaScript File', es: 'Archivo JavaScript' },
    'image/jpeg': { en: 'JPEG Image', es: 'Imagen JPEG' },
    'image/png': { en: 'PNG Image', es: 'Imagen PNG' },
    'image/gif': { en: 'GIF Image', es: 'Imagen GIF' },
    'image/webp': { en: 'WebP Image', es: 'Imagen WebP' },
    'image/svg+xml': { en: 'SVG Image', es: 'Imagen SVG' },
    'audio/mpeg': { en: 'MP3 Audio', es: 'Audio MP3' },
    'audio/wav': { en: 'WAV Audio', es: 'Audio WAV' },
    'video/mp4': { en: 'MP4 Video', es: 'Video MP4' },
    'video/webm': { en: 'WebM Video', es: 'Video WebM' },
  };
  const description = Object.hasOwn(descriptions, mimeType)
    ? descriptions[mimeType]
    : undefined;
  if (description) return t(description);
  return mimeType || t({ en: 'Unknown', es: 'Desconocido' });
}
