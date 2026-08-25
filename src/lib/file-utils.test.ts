import { describe, expect, it } from 'vitest';
import { formatFileSize, getMimeTypeDescription } from './file-utils';

describe('File Utils', () => {
  describe('formatFileSize', () => {
    it('should format bytes', () => {
      expect(formatFileSize(0)).toBe('0 B');
      expect(formatFileSize(100)).toBe('100 B');
    });

    it('should format KiB', () => {
      expect(formatFileSize(1024)).toBe('1.0 KiB');
      expect(formatFileSize(1536)).toBe('1.5 KiB');
    });

    it('should format MiB', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.0 MiB');
      expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MiB');
    });

    it('should format GiB', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GiB');
    });

    it('should handle negative or invalid inputs', () => {
      expect(formatFileSize(-1)).toBe('0 B');
      expect(formatFileSize(NaN)).toBe('0 B');
    });
  });

  describe('getMimeTypeDescription', () => {
    it('should return description for known types', () => {
      expect(getMimeTypeDescription('application/pdf')).toBe('PDF Document');
      expect(getMimeTypeDescription('image/jpeg')).toBe('JPEG Image');
      expect(getMimeTypeDescription('text/plain')).toBe('Text File');
    });

    it('should return mime type itself for unknown types', () => {
      expect(getMimeTypeDescription('application/unknown-format')).toBe(
        'application/unknown-format',
      );
    });

    it('should return Unknown for empty inputs', () => {
      expect(getMimeTypeDescription('')).toBe('Unknown');
    });
  });
});
