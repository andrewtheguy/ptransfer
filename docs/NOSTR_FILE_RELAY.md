# Nostr File Relay Architecture

The Nostr file relay is the **Code Exchange data-path fallback** — the stand-in for
TURN. When a direct WebRTC connection between the two devices cannot be established, an
eligible encrypted file (up to 100 MiB) automatically attempts delivery through public
Nostr relays. There is no toggle and no separate code, and **nothing is uploaded ahead of
time** — the file engine runs only once the direct connection has failed, so a transfer
that would have connected directly never puts a byte of the file on a storage relay. What
*does* run ahead of time is relay preparation: as soon as the offer's relays
are known, the sender discovers and health-checks a storage ring and keeps probing the
relay population behind the exchange (`prepareStorageRelays`), so the shared relay cache
is warmed either way and a failed direct attempt finds its ring ready. What matters is only that the
offer named proven relays: both sides share those relays and the session derived from
the exchange. When there is no relay path at all — the offer
named no relays or the file is over the 100 MiB cap — the fallback is unavailable. It can
also fail later if too few storage relays work or the selected relays do not deliver the
pieces.

This document is the architecture reference. For the user-facing guide see
[CODE_EXCHANGE.md](CODE_EXCHANGE.md); for how this mode fits into the rest of the app
see [ARCHITECTURE.md](ARCHITECTURE.md). All code lives in
[`src/lib/nostr-file/`](../src/lib/nostr-file/) (see the [code map](#code-map) at the end).

## Overview

The session is **derived, not carried**. The offer/answer exchange has already produced
an ECDH shared secret; when the direct connection then fails, both sides run
`deriveRelaySession` (HKDF over that secret, `src/lib/nostr-file/session.ts`) to arrive
at the same transfer id (the `d`/`x` tag namespace on relays) and the same raw 32-byte
file key. No key or id ever appears in a code — the trust position is exactly the
exchange's own.

Two separate relay sets do two different jobs:

- **Control relays** (2–6): the proven relays the offer already named
  (`resolveTransferRelays`, `src/lib/nostr-file/upload.ts`). They carry only the
  encrypted control channel — a relay that caps event sizes or rate-limits large writes
  (fine for signaling, useless for 48 KiB chunks) still serves perfectly here.
- **Storage relays** (the ring, up to 16, discovered): hold the encrypted pieces. The
  ring is announced over the control channel. The whole `DEFAULT_RELAYS` signaling pool
  is barred from the ring, so the two sets never overlap.

Because the offer already proved the control relays, the sender's first act on
fallback is to hash and chunk the file and send the **manifest as the first control
message**; the storage ring, prepared behind the exchange since the offer was built, is
adopted as soon as it has resolved. It then keeps running: each
piece is uploaded **once** while the receiver downloads alongside, and the two sides
coordinate over the control channel. Redundancy is created on demand — a piece is re-sent
only after the receiver reports it could not fetch it, so the upload costs ~1× the file
size plus the failed pieces. Both pages stay open until the receiver confirms the
verified file. The outer Code Exchange session still ends one hour after the offer was
created; relay-file manifests and chunks created after fallback begins carry their own
one-hour NIP-40 window, but that does not extend the enclosing session.

## Shared Foundations

### Control relays (the offer's `relays` field)

The control relays are not resolved here at all — they are the relays the offer named,
proved while the offer was built by `resolveTransferRelays`
(`src/lib/nostr-file/upload.ts`): the six `DEFAULT_RELAYS` seeds probed with a
control-sized write→read round trip (`CONTROL_PROBE_BYTES` 256 B,
`CONTROL_PROBE_TIMEOUT_MS` 4 s). When fewer than `CONTROL_RELAY_COUNT` (6) pass, storage
discovery runs and its candidates are full-size-probed **only until the gap is filled**:
each defunct default is replaced by a relay proven to serve real chunks, not by a weaker
control-sized discovery, and the probe stops the moment enough have passed. Nothing else
blocks the code — the 16-relay storage ring is never built before it. Whatever that probe
left over (relays that passed after the gap filled, candidates never reached) is handed
to the background ring preparation so it does not discover or probe twice. Passing
defaults are proven for control-sized messages; only their discovered replacements are
also proven at full chunk size. An offer that resolves fewer than `MIN_CONTROL_RELAYS` (2)
names no relays at all — and then there is no relay fallback. See the offer-relays section in
[ARCHITECTURE.md](ARCHITECTURE.md#offer-relays-srclibcode-signalingts).

### Storage relay discovery and health check (`relay-pool.ts`)

1. **Discover candidates** via NIP-66 relay-discovery events (kind 30166) and NIP-65 relay
   lists (kind 10002) queried against the seed relays (`DEFAULT_RELAYS` from
   `src/lib/nostr/relays.ts`). The seeds are only queried, never candidates themselves:
   `DEFAULT_RELAYS` is the signaling pool and never carries chunks, so a failed discovery
   fails the transfer with the not-enough-relays error rather than degrading to the
   seeds. Candidates are capped (`DISCOVERY_CANDIDATE_CAP` = 150) and cached in
   IndexedDB for 24 h. Fresh discovery is merged with the valid cache on every run, so
   new candidates are learned without discarding cached fallbacks. Every candidate has a
   canonical-URL-keyed `relay-health` record containing its discovery/check/success
   timestamps, latest RTT, consecutive failures, and proven control/storage
   capabilities. Recently successful low-RTT relays are prioritized for 24 h on later
   runs, but are always probed again before receiving file chunks. Cache schema changes
   reset IndexedDB and recreate only the current stores; cached data is never migrated.
2. **Health-check candidates** with a real write→read round trip per relay: a
   production-shaped probe event through the full codec at the full chunk size
   (`HEALTH_CHECK_PROBE_BYTES` = 48 KiB), read back and byte-compared. A relay with a
   small event-size cap therefore fails here instead of rejecting real chunks mid-upload.
   Probes carry the same NIP-40 expiration as everything else. Checking stops once
   `HEALTH_CHECK_TARGET_COUNT` (16, the storage ring) relays pass, without probing the
   whole candidate list (only ~1 in 6 public candidates passes the full-size probe).
   Per-relay round-trip time is measured (`HealthyRelay.rttMs`) and the fastest passers
   are kept. Sockets are dropped as soon as a relay has no further job — a failed probe,
   a pass after the target filled, a seed once discovery finishes, or a healthy relay the
   batch selection skipped — because with reconnect enabled a
   lingering dead socket would retry forever, spamming connections for the rest of the transfer. Both engines
   run on a tracked pool (`createTransferPool`) that force-closes even sockets still
   mid-handshake — nostr-tools only closes fully open ones — and refuses new sockets
   after `destroy()`, so no connection or reconnect loop outlives the transfer.
3. **Select the batch**: up to `UPLOAD_RELAY_COUNT` (16) relays via a
   rotating cursor persisted with the candidate cache, load-balancing across uploads. The transfer's
   control relays and the whole `DEFAULT_RELAYS` signaling pool are filtered out of the
   candidates first (also catching stale caches written before seeds were barred). The
   storage ring and the control relays are mutually exclusive, so chunk traffic never
   competes with the control channel on a shared relay. The minimum viable batch is two
   relays. The batch order
   **is the placement ring**, announced to the receiver inside every `avail` control
   message (never stored in the manifest).

### Chunking and content codec (`codec.ts`, `z85.ts`)

The plaintext (file or ZIP, materialized in memory, ≤ 100 MiB) is passed through
`compressPayload`, then the resulting payload is split into
`NOSTR_FILE_CHUNK_SIZE` = 48 KiB chunks. A single-file payload is deflated once as a
whole; a multi-file/folder ZIP is already compressed and travels unchanged. Each chunk
then goes through:

```
[whole-file deflate for a single file | identity for a generated ZIP]
    → chunk → AES-256-GCM (nonce ‖ ciphertext ‖ tag) → Z85
```

- Compressing before chunking means a highly compressible single file collapses into a
  few chunks instead of one event per 48 KiB of plaintext. Single files are always
  deflated, even when the output is slightly larger; only payloads from the
  multi-file/folder ZIP flow use `compression: 'none'`, because their entries have
  already been deflated and the archive is never recompressed.
  The manifest carries `payloadSize` (the chunked byte count) next to `fileSize`; the
  receiver assembles `payloadSize` bytes, inflates with the output bounded by
  `fileSize` (decompression-bomb guard, exact-size match required), then verifies the
  plaintext hash.
- The AES-256-GCM key is the session file key both sides derived from the Code
  Exchange ECDH secret (`deriveRelaySession`). It never travels anywhere — not in a
  code, not to relays.
- AAD = `ptransfer-nostr-file:v1:<transferId>:<index>:<total>` binds every chunk to its
  transfer and position — a tampered, substituted, or misplaced chunk fails GCM and is
  simply treated as missing.
- Z85 (base85): ~1.25× expansion vs base64's ~1.33×, and JSON-escape free. A 48 KiB
  chunk encodes to ~60 KiB, just under the ~63 KiB event-content ceiling measured
  against the public relay population. A 100 MiB incompressible file is
  ~2134 chunks.

### Chunk event schema (`events.ts`)

Chunks (and health probes) are NIP-78 addressable events, kind `30078`:

| Tag | Value |
|-----|-------|
| `d` | `<transferId>:<chunkIndex>` (derived — the manifest needs no per-chunk event ids) |
| `x` | `<transferId>` |
| `chunk` | `<index> <totalChunks>` |
| `encryption` | `aes-256-gcm` |
| `expiration` | `created_at + 3600` (NIP-40) |

Events are signed by an ephemeral Nostr identity generated per transfer, and deliberately
carry no filename, size, or plaintext hash — file metadata travels only in the sealed
manifest, and the `transferId` derived from the exchange's ECDH secret (rather than the
file hash) reveals nothing and prevents known-file confirmation against public relays.

**Every published event carries a NIP-40 `expiration` tag, health-check probes and control
messages included.** Chunk and probe events request one hour of retention from their
creation; control events use the applicable session/manifest deadline and may request
less. These values are client-enforced deadlines plus deletion *requests*: compliant
relays stop serving and prune expired events, but NIP-40 does not
guarantee deletion or provide cryptographic erasure — a non-compliant relay could retain
its copy. Confidentiality never depends on relay deletion: chunks orphaned by a cancelled
or failed upload are AES-256-GCM ciphertext under a key that was never published.

### Manifest (`manifest.ts`)

The `NostrFileManifest` (v7) is the **first control-channel message** (`t: 'manifest'`),
sealed under the session key like every other control message and never carried in a
code: version, file name/size/MIME, base64 SHA-256 of the plaintext, the ephemeral
pubkey, the whole-payload compression mode (`deflate` or `none`) and the compressed
payload size, chunk size, total chunks, and created/expiry timestamps. The transfer id
and control relays are session-level — the id is derived from the ECDH secret
(`session.ts`), the relays are the offer's relays — so neither is repeated in the
manifest. The storage ring is not in it either — that arrives in the `avail` messages.

Because chunk `d` tags are derived from `transferId` and index, the manifest needs no
per-chunk event pointers; integrity comes from the per-chunk GCM tags plus the whole-file
hash, authenticity from Nostr signatures under the manifest's pubkey. The receiver takes
exactly one manifest, only from the pubkey it names, and rejects it if its window is
already over (`assertManifestWindow`).

### Expiry and clocks

The outer Code Exchange session expires one hour after the offer's `createdAt`, so the
hooks can end the transfer before the relay engine's own later window. When fallback
starts, the sender stamps the manifest and chunk events with a fresh
`NOSTR_FILE_EXPIRATION_SEC` (1 hour) window; receiver control events retain the earlier
offer deadline. The receiver initially watches from the offer window, then validates the
manifest's fallback-time window with `CLOCK_SKEW_TOLERANCE_SEC` (±10 min) of clock-skew
tolerance. None of these later event timestamps extends the enclosing Code Exchange
session.

## Transfer Protocol (`upload-live.ts` / `download-live.ts` / `control.ts`)

### Control channel (`control.ts`)

Both peers derive an AES-256-GCM control key from the session file key (HKDF, info
`ptransfer-nostr-file:v1:control`, salt = `transferId`), which itself comes from the
Code Exchange ECDH secret — so only the two peers of that exchange can read or forge
control messages.

Messages ride the offer's **control relays** (already proved with a control-sized event,
so the same relay never has to accept both control messages and 48 KiB chunks) as addressable events of the chunk kind with a unique `d` tag per message
(`<transferId>:ctl:<role>:<n>`), an `x` tag `<transferId>:ctl` for the subscription
filter, and the usual NIP-40 expiration; they carry the sealed, deflated JSON as base64.
Because they are stored, a peer that subscribes late or whose socket dropped
(`SimplePool` runs with reconnect enabled) recovers the backlog through the `since`
filter. Control messages publish to every control relay and count as delivered at the
first acceptance.

Anti-replay/misuse properties:

- The AAD binds every message to the transfer and the sending role — a receiver message
  can never replay as a sender message
- A per-side monotonic counter `n` rejects replays and reordering within a role
- The sender pins the first receiver pubkey that produces a valid message and ignores all
  others; the receiver pins the sender pubkey named in the manifest and ignores every
  other author from then on

### Message vocabulary

| Message | Direction | Fields | Meaning |
|---|---|---|---|
| `manifest` | sender → receiver | `n`, `manifest` | First message: what is being relayed (file metadata, chunk layout, sender pubkey). Sizes the receiver's state; an `avail` before it arrives is rejected |
| `hello` | receiver → sender | `n` | Receiver is online and subscribed; sent only after its direct attempt failed, so a sender still trying the direct route treats it as "no direct connection is possible" and switches to relays right away |
| `avail` | sender → receiver | `n`, `upto`, `relays`, `map`, `gens` | Chunks `[0, upto)` are uploaded. `relays` is the storage ring in placement order (empty while discovery is still running — presence only; the receiver adopts the first non-empty ring and drops any avail naming a different one); `map` has one character per chunk giving the position in this message's `relays` of the relay holding it (`POSITION_ALPHABET` — 64 positions of encoding headroom; the actual ring is capped at `UPLOAD_RELAY_COUNT` = 16); `gens` lists re-sent chunks with their current generation |
| `ack` | receiver → sender | `n`, `avail`, `have`, `missing` | Outcome of fetching what avail `avail` announced: total chunks held, plus `missing` as `[index, pos, gen]` triples — tried at that exact placement and not found / not decryptable |
| `done` | receiver → sender | `n` | Whole-file SHA-256 verified |
| `cancel` | either side | `n` | Abort |

The complete ring and placement travel in every `avail`, so a lost announcement costs
nothing; bodies are deflated before sealing, which collapses the near-periodic map and
the shared-prefix relay URLs to a few hundred bytes even for ~2100 chunks.

### Sender loop

The control channel opens as soon as the direct connection is known to have failed; the
sender sends the `manifest` first (so a receiver that joins later reads it from the
backlog before any placement), then an empty-ring `avail` immediately so the receiver
sees the sender is online while storage discovery finishes. Once the ring is selected, chunk `i`
is published to `ring[i % N]`, walking the ring on rejection until one relay
accepts (16 in flight); each publish retries up to 3× per relay with exponential backoff
(500 ms base, 5 s cap, 250 ms jitter). An `avail` is announced every `LIVE_BATCH_CHUNKS`
(64) chunks (3 MiB) and on completion, and repeated as a `LIVE_HEARTBEAT_MS` (15 s)
heartbeat so a lost announcement or acknowledgement in either direction is recovered on
the next beat.

**Re-sends.** An `ack` whose `missing` entry matches the chunk's *current* placement
queues a re-send (entries for a placement already replaced are ignored — the receiver
simply has not seen the newer announcement yet); the re-send starts from the next ring
position after the last attempt, bumps the chunk's generation `gen`, and goes out ahead of
new chunks with the next announcement.

**Relay demotion.** Misses are also counted per relay: a relay reported
`LIVE_RELAY_DEMOTE_MISSES` (2) times is **demoted** — it acknowledged the writes but does
not serve them (ephemeral or read-restricted relays pass the write→read health probe yet
behave this way under load), so new chunks and re-sends skip it while any other relay
remains, and the placement walk tries healthy relays first. Without this, a ring with
several such relays re-sends a third or more of a large file; with it, only the chunks
already placed there before the first acknowledgement need a second copy. Publish-side
failure demotes too: a relay that gives up `LIVE_RELAY_DEMOTE_GIVEUPS` (3) publishes
(every retry rejected — a rate limiter or size cap that surfaced only after the health
probe) stops being walked first, since each chunk starting its walk there otherwise burns
the whole retry-with-backoff schedule before landing elsewhere.

**Abort conditions.** A chunk re-sent more than `max(N, LIVE_MIN_RETRANSMITS_PER_CHUNK)`
times, a chunk no relay accepts, expiry, or the receiver falling silent for
`LIVE_IDLE_TIMEOUT_MS` (3 min) after the upload completed all abort the transfer; the
sender completes on `done`.

### Receiver loop

On each `avail`, the receiver fetches every announced chunk it lacks from the one relay it
was placed on (grouped per relay, in parallel, `authors` + `#d` filters, ≤
`D_TAG_FILTER_BATCH` (50) ids per filter, ~3 MiB of content per query), skipping chunks
whose `(pos, gen)` it already tried within the last `LIVE_FETCH_RETRY_MS` (10 s), then
answers with an `ack` listing what is still missing at the placement it actually asked —
never the newest announced one, so an announcement landing mid-fetch cannot blame a relay
this cycle never queried. Announcements that arrive mid-fetch coalesce into one more
cycle. The receiver also runs on its own retry clock: when announced pieces are still
missing and no cycle has started for `LIVE_FETCH_RETRY_MS`, it runs one anyway — a
cooled-down placement is fetched again (a timed-out or not-yet-propagated copy recovers
without costing a re-send) and the missing list is re-asked, so a lost announcement or
acknowledgement never strands a piece. When every chunk is present the assembled file
must match the manifest's SHA-256 before `done` is sent. Expiry, or a sender silent for
3 minutes, aborts.

```mermaid
sequenceDiagram
    participant S as Sender
    participant C as Control relays
    participant R as Storage ring
    participant V as Receiver

    Note over S: offer built: discover + health-check storage ring in background, then sweep
    Note over S,V: Code Exchange offer/answer done, direct WebRTC attempt running
    Note over S,V: both derive session (transferId + file key) from the ECDH secret
    S->>C: subscribe #x = transferId:ctl (watch for hello during the direct attempt)
    Note over V: ICE fails fast on the receiver's side
    V->>C: subscribe #x = transferId:ctl
    V->>C: hello (sealed control event)
    C->>S: hello — sender abandons the direct attempt at once
    S->>C: manifest (sealed; file metadata + chunk layout)
    S->>C: avail {upto: 0, relays: []} (sender online, ring still resolving)
    C->>V: manifest
    loop upload, 16 in flight
        S->>R: chunk i → ring[i % N] (walk ring on rejection)
        S->>C: avail {upto, relays: ring, map, gens} every 64 chunks + 15s heartbeat
        C->>V: avail (receiver adopts the ring on first sight)
        V->>R: fetch announced chunks from their placed relays
        V->>C: ack {avail, have, missing[index,pos,gen]}
        C->>S: ack
        Note over S: re-send missing chunks to next ring position,<br/>bump gen, demote relays with 2+ misses
    end
    Note over V: all chunks present → SHA-256 verifies
    V->>C: done
    C->>S: done
    Note over S,V: both sides complete
```

## Security Model

- **Relays see**: ciphertext, chunk count/sizes, timing, an ephemeral pubkey, the sealed
  control messages, and the two peers' activity timing — never plaintext, filenames, or
  the file hash
- **The key is derived, never carried**: the file key comes from the Code Exchange
  ECDH secret (`deriveRelaySession`), the same secret that already secured the direct
  transfer. No code contains it, and whoever could authentically deliver the offer
  can download and decrypt
- **Integrity**: per-chunk AES-GCM tags under a position-binding AAD, plus the whole-file
  SHA-256 in the manifest. Control messages are sealed under a role-binding AAD with
  per-side monotonic counters
- **Availability is best-effort**: relays may drop data before the 1-hour expiry;
  targeted re-sends mitigate this but do not guarantee delivery — the data is temporary
  by design, so durability is traded for relay load

## Limits and Tunables (`constants.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `NOSTR_FILE_MAX_BYTES` | 100 MiB | Hard cap on the plaintext payload |
| `NOSTR_FILE_CHUNK_SIZE` | 48 KiB | Compressed-or-identity payload chunk size (~60 KiB encoded) |
| `EVENT_KIND_FILE_CHUNK` | 30078 | NIP-78 addressable kind for chunks, probes, and control |
| `NOSTR_FILE_EXPIRATION_SEC` | 3600 | Manifest/chunk window from fallback start; the outer Code Exchange deadline may end the transfer earlier |
| `UPLOAD_RELAY_COUNT` | 16 | Storage relay batch per upload (placement ring size) |
| `MIN_UPLOAD_RELAYS` | 2 | Fewest usable storage relays for an upload to start |
| `CONTROL_RELAY_COUNT` | 6 | Target control relays (the relays the offer names) |
| `MIN_CONTROL_RELAYS` | 2 | Fewest control relays; below this the offer names none and there is no fallback |
| `CONTROL_PROBE_BYTES` | 256 | Control probe payload (a sealed control message is a few hundred bytes) |
| `CONTROL_PROBE_TIMEOUT_MS` | 4 s | Control probe timeout — bounds code-ready time when a seed is dead |
| `PUBLISH_MAX_RETRIES` | 3 | Per-relay publish retries (backoff 500 ms → 5 s + jitter) |
| `UPLOAD_CHUNK_CONCURRENCY` | 16 | Chunks in flight |
| `HEALTH_CHECK_TARGET_COUNT` | 16 | Stop once the storage ring has passed (the signaling backfill stops at its own gap size) |
| `RELAY_CANDIDATE_TTL_MS` | 24 h | Lifetime of discovered candidates and relay-health priority |
| `D_TAG_FILTER_BATCH` | 50 | Max `d` ids per fetch filter (~3 MiB per query) |
| `LIVE_BATCH_CHUNKS` | 64 | Chunks per `avail` announcement (3 MiB) |
| `LIVE_HEARTBEAT_MS` | 15 s | Re-announce cadence when nothing changed |
| `LIVE_FETCH_RETRY_MS` | 10 s | Receiver retry clock: re-fetch a still-missing placement and re-run a cycle without a new announcement |
| `LIVE_IDLE_TIMEOUT_MS` | 3 min | Give up on a silent peer |
| `LIVE_MIN_RETRANSMITS_PER_CHUNK` | 4 | Floor on re-sends per chunk before failing (actual: `max(N, 4)`) |
| `LIVE_RELAY_DEMOTE_MISSES` | 2 | Reported misses before a relay is demoted |
| `LIVE_RELAY_DEMOTE_GIVEUPS` | 3 | Publish give-ups (all retries rejected) before a relay is demoted |
| `CLOCK_SKEW_TOLERANCE_SEC` | ±600 | Tolerated sender/receiver wall-clock disagreement |

## Code Map

| File | Role |
|---|---|
| `src/lib/nostr-file/constants.ts` | All tunables above, with rationale comments |
| `src/lib/nostr-file/codec.ts`, `z85.ts` | Whole-payload deflate + chunk content pipeline (AES-256-GCM → Z85) |
| `src/lib/nostr-file/events.ts` | Chunk/probe event construction and fetch filters |
| `src/lib/nostr-file/manifest.ts` | Manifest schema/validation |
| `src/lib/nostr-file/relay-pool.ts` | NIP-66/65 discovery, health probes, batch selection |
| `src/lib/nostr-file/pool.ts`, `mock-pool.ts` | `NostrFilePool` abstraction + in-memory relay network for tests |
| `src/lib/nostr-file/transfer-pool.ts` | `createTransferPool`: SimplePool with guaranteed socket teardown |
| `src/lib/nostr-file/upload.ts` | Publish-with-retry, control/storage relay resolution, and background storage preparation |
| `src/lib/nostr-file/session.ts` | `deriveRelaySession`: transfer id + file key from the exchange's ECDH secret |
| `src/lib/nostr-file/upload-live.ts`, `download-live.ts`, `control.ts` | Transfer engines + control channel (manifest is the first control message) |
| `src/lib/nostr-file/fetch.ts` | Relay chunk fetching (expiry check, filter batching) |
| `src/lib/nostr-file/sync.ts` | `Deferred`/`Signal` async helpers |
| `src/hooks/use-code-send.ts`, `use-code-receive.ts` | Code Exchange hooks; each starts the relay engine when its direct WebRTC connection fails |
| `src/hooks/nostr-relay-source.ts` | Source materialization / progress estimation |

The relay engine is started from the Code Exchange hooks the moment a direct connection
fails (see `use-code-send.ts` / `use-code-receive.ts`). Tests are colocated
(`src/lib/nostr-file/*.test.ts`) and run against the injectable in-memory relay network in
`mock-pool.ts`. They are split into two vitest projects. `npm test` runs the `unit`
project only (~6s). `live.test.ts` is the `integration` project: it drives whole transfers
and waits out real-time heartbeats, retry clocks, and idle deadlines, so it takes ~60s on
its own and is opt-in via `npm run test:integration:nostr-file`. Its project sets
`fileParallelism: false` so those deadlines never compete with parallel unit workers,
however the run was started. `npm run test:all` runs both, and is what to run before
pushing a change to the transfer engine.

Public-relay end-to-end coverage is opt-in because it publishes expiring events to shared
infrastructure. Run `npm run test:live` to execute `tests/live_nostr_file_e2e.ts` followed
by `tests/live_web_to_web_e2e.ts`. The aggregate command deliberately runs them
sequentially so the scenarios never contend for the same real Nostr relays; each scenario
also has its own `test:live:*` command for targeted diagnosis.
