import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTorDirectorySnapshot } from './tor-directory-snapshot';

function jsonResponse(body: string, init?: ResponseInit): Response {
  return {
    ok: init?.status ? init.status < 400 : true,
    status: init?.status ?? 200,
    text: async () => body,
  } as Response;
}

describe('Tor directory snapshot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the served snapshot', async () => {
    const fetchMock = vi.fn(async () => jsonResponse('{"version":1}'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadTorDirectorySnapshot()).resolves.toBe('{"version":1}');
    expect(fetchMock).toHaveBeenCalledWith(
      '/tor-directory.json',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('stays optional when no snapshot is served', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('Not found', { status: 404 })),
    );

    await expect(loadTorDirectorySnapshot()).resolves.toBeUndefined();
  });

  it('ignores the index page a single-page host answers with', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('<!doctype html><html lang="en">')),
    );

    await expect(loadTorDirectorySnapshot()).resolves.toBeUndefined();
  });

  it('stays optional when the fetch fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await expect(loadTorDirectorySnapshot()).resolves.toBeUndefined();
  });
});
