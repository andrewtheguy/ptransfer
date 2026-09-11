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
