import { describe, expect, it } from 'vitest';
import { isCompressedFormat } from './compressed-formats';

describe('isCompressedFormat', () => {
  it('knows audio and video by MIME type, whatever the name', () => {
    expect(isCompressedFormat('recording', 'audio/mpeg')).toBe(true);
    expect(isCompressedFormat('clip.bin', 'video/mp4')).toBe(true);
    expect(isCompressedFormat('clip', 'video/webm; codecs=vp9')).toBe(true);
  });

  it('knows a compressed format by its extension when the type is unknown', () => {
    expect(isCompressedFormat('holiday/IMG_0001.JPG', '')).toBe(true);
    expect(isCompressedFormat('song.flac', 'application/octet-stream')).toBe(
      true,
    );
    expect(isCompressedFormat('backup.tar.gz', '')).toBe(true);
    expect(isCompressedFormat('report.docx', '')).toBe(true);
  });

  it('leaves everything else to be compressed', () => {
    expect(isCompressedFormat('notes.txt', 'text/plain')).toBe(false);
    expect(isCompressedFormat('image.bmp', 'image/bmp')).toBe(false);
    expect(isCompressedFormat('data', 'application/octet-stream')).toBe(false);
    expect(isCompressedFormat('.mp4', '')).toBe(false);
    expect(isCompressedFormat('mp4/notes', '')).toBe(false);
  });
});
