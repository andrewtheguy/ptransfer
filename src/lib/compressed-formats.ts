/**
 * Files whose format is compressed already, which deflate cannot shrink: it
 * would spend the time and send about as many bytes, or a few more. Judged by
 * what the file says it is — its MIME type and its extension — never by
 * sniffing its bytes, so both hosts decide alike before anything is read.
 */

/**
 * Audio and video formats are compressed, all but the ones listed in
 * `UNCOMPRESSED_MIME_TYPES`.
 */
const COMPRESSED_MIME_PREFIXES = ['audio/', 'video/'];

/** Raw PCM audio, which deflate does shrink. */
const UNCOMPRESSED_MIME_TYPES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/aiff',
  'audio/x-aiff',
  'audio/l8',
  'audio/l16',
  'audio/l20',
  'audio/l24',
  'audio/pcm',
]);

const COMPRESSED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/jxl',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-bzip2',
  'application/x-xz',
  'application/zstd',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/java-archive',
  'application/epub+zip',
  'application/vnd.android.package-archive',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

const COMPRESSED_EXTENSIONS = new Set([
  // Audio
  'mp3',
  'aac',
  'm4a',
  'ogg',
  'oga',
  'opus',
  'flac',
  'wma',
  // Video
  'mp4',
  'm4v',
  'mov',
  'mkv',
  'webm',
  'avi',
  'wmv',
  'flv',
  '3gp',
  'mpg',
  'mpeg',
  'ts',
  // Images
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'heic',
  'heif',
  'jxl',
  // Archives and compressed streams
  'zip',
  'gz',
  'tgz',
  'bz2',
  'tbz2',
  'xz',
  'txz',
  'zst',
  'lz4',
  'br',
  '7z',
  'rar',
  // ZIP containers
  'jar',
  'apk',
  'epub',
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
]);

/**
 * Whether the file named `name`, of MIME type `mimeType` (empty when
 * unknown), is a format that is compressed already.
 */
export function isCompressedFormat(name: string, mimeType: string): boolean {
  const type = mimeType.split(';')[0].trim().toLowerCase();
  if (UNCOMPRESSED_MIME_TYPES.has(type)) return false;
  if (
    COMPRESSED_MIME_TYPES.has(type) ||
    COMPRESSED_MIME_PREFIXES.some((prefix) => type.startsWith(prefix))
  ) {
    return true;
  }
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return (
    dot > 0 && COMPRESSED_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
  );
}
