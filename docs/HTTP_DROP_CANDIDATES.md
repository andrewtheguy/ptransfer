# Public HTTP Drops as a Relay Fallback

When WebRTC finds no route, the encrypted payload has nowhere to go (see
`docs/ROADMAP.md`). One answer is to push it through a public HTTP host: the
sender uploads ciphertext, the receiver downloads it, and the host sees only
bytes it cannot read. This document records which public hosts are actually
usable for that, and — more usefully — which are not and why, so the same dead
ends are not surveyed twice.

**Outcome: rejected.** Measured over Tor on 2026-08-26, every candidate below
failed. The idea is closed in `docs/ROADMAP.md` under *Public HTTP Drops as a
Relay Fallback: Closed*; the direction to pursue instead is a Tor hidden service
transport, where the rendezvous is the Tor network itself and there is no host
operator who can refuse the connection.

The survey is kept because host policies change and because the reasoning
generalises: anything reached over a Tor exit inherits that exit's reputation.

The survey below was run on 2026-08-25 with `curl` and `openssl s_client`.

## Why CORS is not a criterion

An earlier pass ranked these hosts by whether they send
`Access-Control-Allow-Origin`, and almost none do. That turns out not to matter:
the request does not have to come from the browser. `webtor-rs` exposes
`AnonymousSignalingClient.httpRequest()`, which builds and sends an HTTP/1.1
request inside WASM over a Tor stream, exactly as the exit verification does.
Nothing in that path is a browser request, so no origin policy applies to it.

That swaps one filter for a harder one. The question is no longer "does this
host permit a browser to read its response" but "does this host answer a Tor
exit address at all" — and file hosts have far stronger abuse incentives to
block Tor than Nostr relays do. Only a run over a real circuit could answer
that; a throwaway probe page did, and *Result* below is what it measured.

## What a candidate has to satisfy

1. **TLS 1.3 with ChaCha20-Poly1305.** `subtle-tls` pins 1.3 and offers only
   ChaCha20 suites, because its record layer needs a synchronous AEAD. Every
   host below was checked with
   `openssl s_client -tls1_3 -ciphersuites TLS_CHACHA20_POLY1305_SHA256`; all of
   them pass, so this filtered nothing out in practice. It would matter for a
   1.2-only host.
2. **A plain upload and a plain download.** One request to put the bytes in, one
   to get them back. This is a hard rule, not a preference — see *Excluded*.
3. **Chunked upload**, so the sender does not have to buffer the whole
   ciphertext. Every host in the list accepted a body piped in with no
   `Content-Length`.
4. **Retention measured in hours**, ideally caller-chosen.
5. **`Range` on download**, without which an interrupted transfer restarts.

## Shape mismatch, and why the list is store-and-forward anyway

These are drops, not pipes. `piping-server` (ppng.io) is the right shape — the
sender `POST`s, the receiver `GET`s the same path, and bytes stream through
without being stored — but only two public instances still exist, both run by
the same person, and one of those sits behind Cloudflare. A drop host that
answers a Tor exit is worth more than a pipe that refuses the connection, so
both are worth probing.

The mismatch is real and should be stated plainly. With a drop host:

- the sender's upload must finish before the receiver can start, so there is no
  streaming and the transfer is capped by the host's file limit;
- the ciphertext rests on a third party's disk for hours or days rather than
  transiting a blind pipe;
- the URL comes back to the *sender*, so it has to be relayed to the receiver
  over signaling — except at `filebin.net`, whose path is chosen before the
  upload and could therefore be derived from the PAKE secret directly, as a
  piping path would be.

## Probed hosts

| Host | Upload | Cap | Retention | Range | Fronted by |
| --- | --- | --- | --- | --- | --- |
| x0.at | multipart `file`, `secret=`, `expires=1` | 1024 MiB | 1 h with `expires=1` | yes | nothing |
| transfer.archivete.am | `PUT` body | unpublished | unpublished | **no** | BunnyCDN |
| uguu.se | multipart `files[]` | 128 MiB | 3 h, fixed | yes | nothing |
| filebin.net | `PUT` body to a chosen path | unpublished | 6 days | unknown | Varnish |
| catbox.moe | multipart `fileToUpload` | 200 MiB | **permanent** | yes | nothing |

`x0.at` is the strongest candidate: the largest cap, an unguessable URL and a
one-hour expiry both available as upload fields, `Range` support, and plain
nginx with nothing in front of it. `catbox.moe` is probed to learn whether Tor
is accepted, not as something to ship — permanent, undeletable anonymous
uploads are the wrong shape for a transfer fallback.

## Excluded, with reasons

Deliberately absent from the probe set. A host that needs a workaround today
needs a different one tomorrow, so the workaround is documented instead of
maintained.

- **tmpfiles.org** — works, and its API is the tidiest here, but the download
  does not. The upload returns a landing page URL; rewriting the path to `/dl/`
  looks correct and 302s straight back to the interstitial. The bytes sit behind
  a signed, time-limited link
  (`/dl/<unixtime>.<hash>/<id>/<name>`) that only appears inside that page's
  HTML, so a download means scraping it. Verified working end to end, `Range`
  included — and rejected anyway, because it is a scrape.
- **0x0.st** — the upstream of the `0x0` codebase that `x0.at` runs. Its landing
  page asks automated clients to stay away in as many words. Use `x0.at`, or
  self-host: the operator publishes the source and asks people to.
- **litterbox.catbox.moe** — right retention model (1 h to 72 h, chosen per
  upload) but a BunkerWeb WAF sits in front and already answered 403 to a
  non-browser user agent on clear net.
- **temp.sh** — accepts the upload and returns a URL that serves an HTML
  interstitial instead of the file.
- **ttm.sh** — another `0x0` instance; every request from here timed out and the
  TLS probe never completed.
- **qu.ax** — pomf-style, rejects a `.bin` upload with "file type is not
  allowed".
- **fileditch.com** — `TLS connect error: tlsv1 alert internal error`.
- **file.io** — 301s to Cloudflare.
- **pixeldrain.com** — `PUT /api/file/` returns 401; the API needs a key.
- **gofile.io** — works, and has the largest capacity of anything surveyed, but
  it is a two-step API (`GET /servers`, then upload to the chosen store) and the
  response is a download *page* plus a guest token, not a byte URL.
- **transfer.sh** — connection refused. **envs.sh**, **bashupload.com** — no DNS
  record at all. **oshi.at** — broken certificate chain. **sprunge.us**,
  **clbin.com** — gone.

## Result

A run on 2026-08-26 over a Snowflake circuit: the control passed —
`POST https://httpbingo.org/post` returned a 64-byte body byte-identical in
874 ms — and every one of the five candidates failed its round trip. Because
the control shares the circuit, that is the hosts answering, not the client
failing.

The conclusion is about the category rather than any one host. A public file
host carries far more abuse risk from Tor than a Nostr relay does, and prices
it in: the same exit that a relay will happily talk to is one a file host has
every reason to turn away. Nothing here suggests a different five would behave
differently, which is why the answer is to stop reaching through an exit at all
rather than to keep looking for a friendlier host.

## How it was measured

The probe was a throwaway page, and it was removed once it had answered. This
section is the record of how it worked, so a future run can be rebuilt rather
than redesigned.

It bootstrapped the Tor client, ran a control, then for each selected host
uploaded a random payload, downloaded it back through any redirects, compared
the bytes, and issued a `Range` request. One circuit carried every probe, so a
host that failed while its neighbours succeeded failed on its own account rather
than the network's.

Bootstrap only proves that a GET works — it is the exit check — so without a
control a run where every host fails is unreadable: a hostile host and a broken
request path look identical. The control POSTed random bytes to
`https://httpbingo.org/post` and checked that the same bytes came back, which
exercises POST, a Content-Type header, a binary body and the response parser
against a server known to answer. A passing control means the failures beside it
are the hosts' own answers; a failing one means they are not evidence about the
hosts at all.

**The control ran first and was not optional.** httpbingo was chosen over the
obvious alternatives for the same reasons that narrow the candidate list: httpbin.org offers no TLS 1.3 ChaCha20 suite, and
postman-echo.com sits behind Cloudflare, which is the very thing being tested
for.

Requests carried a two-minute deadline. `httpRequest` has no timeout of its own,
so a stalled circuit would otherwise leave a run waiting on one host forever and
read as a hang rather than as a result.

The byte comparison was the load-bearing check: a host that serves an
interstitial instead of the file returns a body that is the wrong length and the
wrong content, which shows up as a mismatch rather than as a pass.

Two caveats when reading such a run. `httpRequest` buffers whole responses and
caps them at 8 MiB, so the payloads have to be small — this measures
reachability, not throughput. And a failure is ambiguous in one direction: it
proves the host did not serve this exit, not that it blocks Tor as a policy. A
re-run picks a different circuit and usually a different exit.
