# Nostr File Relay Architecture

The Nostr file relay is an opt-in Manual Exchange variant (Advanced options → "Relay file
through Nostr", max 100 MB) that replaces the direct WebRTC connection with encrypted
pieces carried through public Nostr relays. The peers never connect to each other; both
only need internet access to the relays. It is experimental.

This document is the architecture reference for the two relay methods. For the user-facing
guide see [MANUAL_EXCHANGE.md](MANUAL_EXCHANGE.md#experimental-relay-file-through-nostr);
for how this mode fits into the rest of the app see [ARCHITECTURE.md](ARCHITECTURE.md).
All code lives in [`src/lib/nostr-file/`](../src/lib/nostr-file/) (see the
[code map](#code-map) at the end).

## The Two Methods

| | **Stored, two copies** | **Live, single copy** |
|---|---|---|
| Payload `type` | `nostr-file` | `nostr-file-live` |
| Choreography | Store-and-forward: upload everything first, then hand out the code | Hand out the code immediately, upload while the receiver downloads |
| Copies per chunk | 2, striped up front | 1, plus targeted re-sends on demand |
| Upload bandwidth | ~2× file size | ~1× file size + failed pieces |
| Peer coordination | None — one-way, no connection between peers | Encrypted control channel on the same relays |
| Both online at once? | No | Yes, both pages stay open |
| Sender delivery confirmation | None | Receiver progress shown; completes on verified `done` |
| Receiver's time window | 1 hour minus upload time | Full hour — the clock and the code start together |
| Entry points | `upload.ts` / `download.ts` | `upload-live.ts` / `download-live.ts` / `control.ts` |

Both methods share the chunk events, codec, relay discovery/health check, manifest, and
payload framing described next; they differ only in choreography. The stored flow follows
nostrsave's design, adapted for explicitly temporary data.

## Shared Foundations

### Relay discovery and health check (`relay-pool.ts`)

1. **Discover candidates** via NIP-66 relay-discovery events (kind 30166) and NIP-65 relay
   lists (kind 10002) queried against the seed relays (`DEFAULT_RELAYS` from
   `src/lib/nostr/relays.ts`). The seeds themselves are always part of the result, so
   discovery failure degrades to seeds-only rather than failing the transfer. Candidates
   are capped (`DISCOVERY_CANDIDATE_CAP` = 150) and cached in localStorage for 24 h
   (`ptransfer:nostr-file:relay-pool:v1`).
2. **Health-check candidates** with a real write→read round trip per relay: a
   production-shaped probe event through the full codec at the full chunk size
   (`HEALTH_CHECK_PROBE_BYTES` = 32 KiB), read back and byte-compared. A relay with a
   small event-size cap therefore fails here instead of rejecting real chunks mid-upload.
   Probes carry the same NIP-40 expiration as everything else. Checking stops once
   `HEALTH_CHECK_TARGET_COUNT` (20) relays pass — some rotation headroom without probing
   the whole candidate list (only ~1 in 6 public candidates passes the full-size probe).
   Per-relay round-trip time is measured (`HealthyRelay.rttMs`) and the fastest passers
   are kept.
3. **Select the batch**: up to `UPLOAD_RELAY_COUNT` (16) relays via a rotating cursor
   persisted with the candidate cache, load-balancing across uploads. The minimum viable
   batch is two relays. The batch order **is the placement ring** recorded in the
   manifest.

### Chunking and content codec (`codec.ts`, `z85.ts`)

The plaintext (file or ZIP, materialized in memory, ≤ 100 MB) is split into
`NOSTR_FILE_CHUNK_SIZE` = 32 KiB chunks. Each chunk goes through:

```
deflate → AES-256-GCM (nonce ‖ ciphertext ‖ tag) → Z85
```

- The AES-256-GCM key is random per transfer and travels **only** inside the manual
  payload, never to relays.
- AAD = `ptransfer-nostr-file:v1:<transferId>:<index>:<total>` binds every chunk to its
  transfer and position — a tampered, substituted, or misplaced chunk fails GCM and is
  simply treated as missing.
- Z85 (base85) matches nostrsave: ~1.25× expansion vs base64's ~1.33×, and JSON-escape
  free. A 32 KiB incompressible chunk encodes to ~41 KB, comfortably under the ~64 KB
  event-content ceiling the public relay population is known to accept. A 100 MB file is
  3200 chunks.

### Chunk event schema (`events.ts`)

Chunks (and health probes) are NIP-78 addressable events, kind `30078`:

| Tag | Value |
|-----|-------|
| `d` | `<transferId>:<chunkIndex>` (derived — the manifest needs no per-chunk event ids) |
| `x` | `<transferId>` |
| `chunk` | `<index> <totalChunks>` |
| `encryption` | `deflate+aes-256-gcm` |
| `expiration` | `created_at + 3600` (NIP-40) |

Events are signed by an ephemeral Nostr identity generated per transfer, and deliberately
carry no filename, size, or plaintext hash — file metadata travels only inside the manual
payload, and the random `transferId` (rather than the file hash) prevents known-file
confirmation against public relays.

**Every published event carries the NIP-40 `expiration` tag (1 hour), health-check probes
and control messages included** — this mode never asks relays to hold data beyond one
transfer window. The 1-hour value is a client-enforced transfer deadline plus a deletion
*request*: compliant relays stop serving and prune expired events, but NIP-40 does not
guarantee deletion or provide cryptographic erasure — a non-compliant relay could retain
its copy. Confidentiality never depends on relay deletion: chunks orphaned by a cancelled
or failed upload are AES-256-GCM ciphertext under a key that was never published.

### Manifest and payload (`manifest.ts`, `manual-signaling.ts`)

The `NostrFileManifest` travels inside the PT01 manual payload and is never published:
version, file name/size/MIME, base64 SHA-256 of the plaintext, `transferId` (16 random
bytes, hex), the ephemeral pubkey, chunk size, total chunks, the relay ring in placement
order, replication factor, and created/expiry timestamps. The payload wrapper
(`NostrFilePayload` / `NostrFileLivePayload`) adds `type` and the base64 AES key —
~700 bytes total, 2–3 QR codes. The live payload requires `replication` = 1.

Because chunk `d` tags are derived from `transferId` and index, the manifest needs no
per-chunk event pointers; integrity comes from the per-chunk GCM tags plus the whole-file
hash, authenticity from Nostr signatures under the manifest's pubkey.

The receiver auto-detects the payload type on paste/scan (`parseAnyManualPayload`) — there
is no separate receive mode, and unlike normal Manual Exchange there is **no answer step**.

### Expiry and clocks

Everything must finish within `NOSTR_FILE_EXPIRATION_SEC` (1 hour) of the transfer start.
The receiver rejects an expired manifest up front, tolerating
`CLOCK_SKEW_TOLERANCE_SEC` (±10 min) of wall-clock disagreement. Both UIs show the
remaining time. In the stored variant the clock starts when the *upload* starts, so a slow
100 MB upload shortens the receiver's window; in the live variant the code is handed out
at the start, so the receiver gets the full hour.

## Stored Variant (two copies, `upload.ts` / `download.ts`)

### Sender flow (`use-nostr-relay-send.ts` → `upload.ts`)

1. Materialize the file/ZIP into memory (≤ 100 MB), SHA-256 it, generate a random 16-byte
   `transferId`, a random 32-byte AES-256-GCM key, and an ephemeral Nostr identity
2. Discover, health-check, and select up to 16 relays as described above
3. Split into 32 KiB chunks, 16 in flight; each publish retries up to 3× per relay with
   exponential backoff (500 ms base, 5 s cap, 250 ms jitter)
4. **Placement ring**: chunk `i` is striped onto `CHUNK_REPLICATION` (2) consecutive
   relays starting at `relays[i % N]` (`stripeRelays`), so each relay stores only 2/N of
   the file and total upload volume is ~2× the file size regardless of batch size. A
   chunk counts as saved at `MIN_CHUNK_RELAY_SUCCESS` (2) relay acks; if a placed relay
   rejects, the uploader continues around the ring until 2 copies exist. A chunk that
   cannot reach 2 relays at all **aborts the entire upload** — the receiver can never be
   handed a code for a partial file
5. Only after **all** chunks are confirmed, embed the manifest + key into the PT01 payload
   and show it (multi-QR / copy-paste). One-way: there is no answer step and no in-app
   delivery confirmation

```mermaid
sequenceDiagram
    participant S as Sender
    participant R1 as Relay ring (up to 16)
    participant V as Receiver

    S->>R1: NIP-66/65 discovery + full-size write→read probes
    Note over S: Select 16 fastest passers (rotating cursor)
    loop every chunk i (16 in flight)
        S->>R1: chunk event → relays[i % N] and relays[(i+1) % N]
        Note over S,R1: on rejection: walk the ring until 2 acks
    end
    Note over S: All chunks at 2 copies → show PT01 code
    S-->>V: manifest + key via QR / copy-paste (trusted channel)
    V->>R1: placement pass: per-relay #35;d filters for its striped chunks
    V->>R1: up to 2 sweep passes: every relay, whatever is still missing
    Note over V: decrypt under AAD, assemble, verify SHA-256
```

### Receiver flow (`use-nostr-relay-receive.ts` → `download.ts`)

After the expiry check, the receiver reads all relays in parallel:

1. **Placement pass**: asks each relay only for the chunks striped onto it (derived `d`
   tags, `authors` + `#d` filters, ≤ `D_TAG_FILTER_BATCH` (50) ids per filter, ~2 MB of
   content per query)
2. **Sweep passes**: up to `DOWNLOAD_SWEEP_PASSES` (2) full passes ask *every* relay for
   whatever is still missing, covering fallback placements (the manifest's placement is a
   hint, not a guarantee) and transient failures

Each chunk is decrypted under the AAD binding — a tampered or substituted chunk fails GCM
and stays missing for another relay's copy. The assembled file must match the manifest's
SHA-256.

## Live Variant (single copy, `upload-live.ts` / `download-live.ts` / `control.ts`)

Same chunk events, codec, relay discovery, and manifest (`replication` fixed at 1, payload
`type: 'nostr-file-live'`), with a different choreography: the sender hands out the code
as soon as relays are selected and then keeps running, and the receiver joins while the
upload is still in progress. Instead of storing every piece twice up front, redundancy is
created on demand — a piece is re-sent only after the receiver reports it could not fetch
it, so the upload costs ~1× the file size plus the failed pieces.

### Control channel (`control.ts`)

Both peers derive an AES-256-GCM control key from the file key in the payload (HKDF, info
`ptransfer-nostr-file:v1:control`, salt = `transferId`), so only the code holder can read
or forge control messages.

Messages are addressable events of the chunk kind (the kind the health probe validated)
with a unique `d` tag per message (`<transferId>:ctl:<role>:<n>`), an `x` tag
`<transferId>:ctl` for the subscription filter, and the usual NIP-40 expiration; they
carry the sealed, deflated JSON as base64. Because they are stored, a peer that subscribes
late or whose socket dropped (`SimplePool` runs with reconnect enabled) recovers the
backlog through the `since` filter. Control messages publish to every ring relay and count
as delivered at the first acceptance.

Anti-replay/misuse properties:

- The AAD binds every message to the transfer and the sending role — a receiver message
  can never replay as a sender message
- A per-side monotonic counter `n` rejects replays and reordering within a role
- The sender pins the first receiver pubkey that produces a valid message and ignores all
  others

### Message vocabulary

| Message | Direction | Fields | Meaning |
|---|---|---|---|
| `hello` | receiver → sender | `n` | Receiver is online and subscribed |
| `avail` | sender → receiver | `n`, `upto`, `map`, `gens` | Chunks `[0, upto)` are uploaded. `map` has one character per chunk giving the ring position of the relay holding it (`POSITION_ALPHABET`, bounding the ring at 64 relays); `gens` lists re-sent chunks with their current generation |
| `ack` | receiver → sender | `n`, `avail`, `have`, `missing` | Outcome of fetching what avail `avail` announced: total chunks held, plus `missing` as `[index, pos, gen]` triples — tried at that exact placement and not found / not decryptable |
| `done` | receiver → sender | `n` | Whole-file SHA-256 verified |
| `cancel` | either side | `n` | Abort |

The complete placement travels in every `avail`, so a lost announcement costs nothing;
bodies are deflated before sealing, which collapses the near-periodic map to a few hundred
bytes even for 3200 chunks.

### Sender loop

Chunk `i` is published to `relays[i % N]`, walking the ring on rejection until one relay
accepts (16 in flight). An `avail` is announced every `LIVE_BATCH_CHUNKS` (64) chunks
(2 MiB) and on completion, and repeated as a `LIVE_HEARTBEAT_MS` (15 s) heartbeat so a
lost announcement or acknowledgement in either direction is recovered on the next beat.

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
already placed there before the first acknowledgement need a second copy.

**Abort conditions.** A chunk re-sent more than `max(N, LIVE_MIN_RETRANSMITS_PER_CHUNK)`
times, a chunk no relay accepts, expiry, or the receiver falling silent for
`LIVE_IDLE_TIMEOUT_MS` (3 min) after the upload completed all abort the transfer; the
sender completes on `done`.

### Receiver loop

On each `avail`, the receiver fetches every announced chunk it lacks from the one relay it
was placed on (grouped per relay, in parallel, `authors` + `#d` filters), skipping chunks
whose `(pos, gen)` it already tried, then answers with an `ack` listing what is still
missing at the placement it actually asked — never the newest announced one, so an
announcement landing mid-fetch cannot blame a relay this cycle never queried.
Announcements that arrive mid-fetch coalesce into one more cycle. When every chunk is
present the assembled file must match the manifest's SHA-256 before `done` is sent.
Expiry, or a sender silent for 3 minutes, aborts.

```mermaid
sequenceDiagram
    participant S as Sender
    participant R as Relay ring
    participant V as Receiver

    Note over S: Relays selected → show PT01 code immediately
    S-->>V: manifest + key via QR / copy-paste (trusted channel)
    V->>R: subscribe #35;x = transferId:ctl
    V->>R: hello (sealed control event)
    R->>S: hello
    loop upload, 16 in flight
        S->>R: chunk i → relays[i % N] (walk ring on rejection)
        S->>R: avail {upto, map, gens} every 64 chunks + 15s heartbeat
        R->>V: avail
        V->>R: fetch announced chunks from their placed relays
        V->>R: ack {avail, have, missing[index,pos,gen]}
        R->>S: ack
        Note over S: re-send missing chunks to next ring position,<br/>bump gen, demote relays with 2+ misses
    end
    Note over V: all chunks present → SHA-256 verifies
    V->>R: done
    R->>S: done
    Note over S,V: both sides complete
```

### Trade-offs versus the stored variant

Both devices must stay online (a closed sender page ends the transfer); the payload is
available immediately rather than after the full upload, so the receiver's window is not
shortened by upload time; a relay that drops a piece costs one targeted re-send instead of
a pre-paid second copy; and the relays additionally see the small sealed control messages
and the timing of the two peers' activity.

## Security Model

- **Relays see**: ciphertext, chunk count/sizes, timing, and an ephemeral pubkey — never
  plaintext, filenames, or the file hash. In the live variant, additionally the sealed
  control messages and the two peers' activity timing
- **The code IS the key**: unlike the WebRTC signaling payload (obfuscated, but key
  material is only ECDH public keys), this payload **contains the decryption key**, so
  the trusted-channel requirement is absolute: anyone holding the payload before expiry
  can download and decrypt
- **Integrity**: per-chunk AES-GCM tags under a position-binding AAD, plus the whole-file
  SHA-256 in the manifest. In the live variant, control messages are sealed under a
  role-binding AAD with per-side monotonic counters
- **Availability is best-effort**: relays may drop data before the 1-hour expiry. Stored
  mitigates with two copies per chunk; live mitigates with targeted re-sends. Neither
  guarantees delivery — the data is temporary by design, so durability is traded for
  relay load (unlike nostrsave's full replication)

## Limits and Tunables (`constants.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `NOSTR_FILE_MAX_BYTES` | 100 MiB | Hard cap on the plaintext payload |
| `NOSTR_FILE_CHUNK_SIZE` | 32 KiB | Plaintext chunk size (~41 KB encoded) |
| `EVENT_KIND_FILE_CHUNK` | 30078 | NIP-78 addressable kind for chunks, probes, and control |
| `NOSTR_FILE_EXPIRATION_SEC` | 3600 | NIP-40 lifetime on every event; transfer deadline |
| `UPLOAD_RELAY_COUNT` | 16 | Relay batch per upload (placement ring size) |
| `CHUNK_REPLICATION` | 2 | Copies per chunk (stored variant; live uses 1) |
| `MIN_CHUNK_RELAY_SUCCESS` | 2 | Acks for a chunk to count as saved (stored) |
| `PUBLISH_MAX_RETRIES` | 3 | Per-relay publish retries (backoff 500 ms → 5 s + jitter) |
| `UPLOAD_CHUNK_CONCURRENCY` | 16 | Chunks in flight |
| `HEALTH_CHECK_TARGET_COUNT` | 20 | Stop probing once this many relays pass |
| `D_TAG_FILTER_BATCH` | 50 | Max `d` ids per fetch filter (~2 MB per query) |
| `DOWNLOAD_SWEEP_PASSES` | 2 | Full-relay sweeps after the placement pass (stored) |
| `LIVE_BATCH_CHUNKS` | 64 | Chunks per `avail` announcement (2 MiB) |
| `LIVE_HEARTBEAT_MS` | 15 s | Re-announce cadence when nothing changed |
| `LIVE_IDLE_TIMEOUT_MS` | 3 min | Give up on a silent peer |
| `LIVE_MIN_RETRANSMITS_PER_CHUNK` | 4 | Floor on re-sends per chunk before failing (actual: `max(N, 4)`) |
| `LIVE_RELAY_DEMOTE_MISSES` | 2 | Reported misses before a relay is demoted |
| `CLOCK_SKEW_TOLERANCE_SEC` | ±600 | Tolerated sender/receiver wall-clock disagreement |

## Code Map

| File | Role |
|---|---|
| `src/lib/nostr-file/constants.ts` | All tunables above, with rationale comments |
| `src/lib/nostr-file/codec.ts`, `z85.ts` | Chunk content pipeline (deflate → AES-256-GCM → Z85) |
| `src/lib/nostr-file/events.ts` | Chunk/probe event construction and fetch filters |
| `src/lib/nostr-file/manifest.ts` | Manifest schema/validation, `stripeRelays` placement |
| `src/lib/nostr-file/relay-pool.ts` | NIP-66/65 discovery, health probes, batch selection |
| `src/lib/nostr-file/pool.ts`, `mock-pool.ts` | `NostrFilePool` abstraction + in-memory relay network for tests |
| `src/lib/nostr-file/upload.ts`, `download.ts` | Stored variant |
| `src/lib/nostr-file/upload-live.ts`, `download-live.ts`, `control.ts` | Live variant + control channel |
| `src/lib/nostr-file/fetch.ts` | Shared relay chunk fetching (expiry check, filter batching) |
| `src/lib/nostr-file/sync.ts` | `Deferred`/`Signal` async helpers |
| `src/hooks/use-nostr-relay-send.ts` | Stored sender hook |
| `src/hooks/use-nostr-relay-live-send.ts` | Live sender hook |
| `src/hooks/use-nostr-relay-receive.ts` | Receiver hook (both variants, auto-detected) |
| `src/hooks/nostr-relay-source.ts` | Shared source materialization / progress estimation |
| `src/lib/manual-signaling.ts` | `NostrFilePayload` / `NostrFileLivePayload` PT01 framing |

Payload detection and routing into these hooks happens in the normal Manual Exchange
receive flow (`parseAnyManualPayload` → `receive-tab.tsx`). Tests are colocated
(`src/lib/nostr-file/*.test.ts`) and run against the injectable in-memory relay network in
`mock-pool.ts`; end-to-end coverage against real relay behavior lives in
`tests/live_nostr_file_e2e.ts`.
