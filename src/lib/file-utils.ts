/**
 * Formatting for sizes and MIME types. Pure, and shared by both hosts: the
 * browser tab shows these in its status, the CLI prints them.
 */

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

  // Bytes are whole numbers; larger units always show one decimal (e.g. "5.0 MiB")
  const value = bytes / k ** i;
  return `${i === 0 ? value : value.toFixed(1)} ${sizes[i]}`;
}

/**
 * Get a user-friendly MIME type description
 */
export function getMimeTypeDescription(mimeType: string): string {
  const descriptions: Record<string, string> = {
    'application/pdf': 'PDF Document',
    'application/zip': 'ZIP Archive',
    'application/json': 'JSON File',
    'text/plain': 'Text File',
    'text/html': 'HTML File',
    'text/css': 'CSS File',
    'text/javascript': 'JavaScript File',
    'image/jpeg': 'JPEG Image',
    'image/png': 'PNG Image',
    'image/gif': 'GIF Image',
    'image/webp': 'WebP Image',
    'image/svg+xml': 'SVG Image',
    'audio/mpeg': 'MP3 Audio',
    'audio/wav': 'WAV Audio',
    'video/mp4': 'MP4 Video',
    'video/webm': 'WebM Video',
  };
  return descriptions[mimeType] || mimeType || 'Unknown';
}
