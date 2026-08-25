/**
 * Directory snapshot served alongside the app.
 *
 * Downloading the consensus and the microdescriptors inside the browser, over
 * one Snowflake circuit and one small chunk at a time, is the least reliable
 * step of a Tor bootstrap. When the site serves a snapshot of the same two
 * documents (see `scripts/fetch-tor-directory.ts`), that step is skipped
 * entirely: Rust validates the snapshot and builds its circuit from it.
 *
 * The snapshot is optional. A missing file, a slow fetch, or a snapshot whose
 * consensus has expired leaves webtor downloading the directory itself.
 */

const SNAPSHOT_URL = '/tor-directory.json';
/**
 * A snapshot of the whole network is tens of megabytes, so this is generous.
 * It exists only so a stalled fetch falls through to webtor's own download
 * instead of spending the caller's bootstrap deadline waiting.
 */
const SNAPSHOT_TIMEOUT_MS = 120_000;

function snapshotLog(message: string, detail: unknown): void {
  console.info(
    `[Anonymous signaling] ${message}`,
    detail instanceof Error ? detail.message : detail,
  );
}

export async function loadTorDirectorySnapshot(): Promise<string | undefined> {
  try {
    const response = await fetch(SNAPSHOT_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    });
    if (!response.ok) {
      snapshotLog(
        'No served Tor directory snapshot:',
        `HTTP ${response.status}`,
      );
      return undefined;
    }

    const body = await response.text();
    // A single-page app usually answers an unknown path with index.html, so a
    // 200 alone does not mean the snapshot exists.
    if (!body.startsWith('{')) {
      snapshotLog('Served Tor directory snapshot is not usable:', body.length);
      return undefined;
    }
    return body;
  } catch (error) {
    snapshotLog('Could not fetch the Tor directory snapshot:', error);
    return undefined;
  }
}
