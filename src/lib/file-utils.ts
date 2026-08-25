/**
 * Trigger a file download in the browser. `data` may be disk-backed (an OPFS
 * file); the browser streams it to the download without materializing it.
 */
export function downloadFile(
  data: Blob,
  fileName: string,
  mimeType: string,
): void {
  // slice() with a type override is a zero-copy way to relabel the Blob.
  const blob =
    data.type === mimeType ? data : data.slice(0, data.size, mimeType);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Deferred revoke: revoking synchronously can abort a still-starting
  // download of a large disk-backed Blob in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

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
