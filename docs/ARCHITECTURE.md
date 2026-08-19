# Architecture

## Overview

Secure Send is a browser-based encrypted file and folder transfer application. It supports rotating-PIN-authenticated Nostr signaling, a manual exchange method (QR or copy/paste with time-bucketed obfuscation), and direct P2P (WebRTC) data transfer. In Nostr mode the content-encryption key comes from a SPAKE2 password-authenticated key exchange driven by the PIN (fresh ephemeral scalars on both sides per run); in manual mode it comes from an ephemeral ECDH exchange authenticated by the QR/clipboard path.

## Core Principles

1. **WebRTC-Only File Transfer**: File bytes are transferred only over a direct WebRTC data channel. Nostr and Manual Exchange are signaling methods only; neither carries file content and there is no non-WebRTC transfer path in the app.
2. **Single Data-Channel Transfer Path**: `src/lib/p2p-transfer.ts` is the only implementation of file transfer once signaling has opened a WebRTC data channel. Both signaling methods converge here before any file bytes are sent.
3. **Application-Layer Chunk Encryption**: File content is encrypted at the application layer using AES-256-GCM in 128KB chunks regardless of WebRTC DTLS transport encryption.
4. **Memory-Efficient Receive Path**: Receivers validate the advertised size, preallocate a scratch sink of that size (an in-memory buffer for payloads of 100MB or less, an OPFS scratch file above that), then decrypt, authenticate, and write each chunk directly to its indexed position as it arrives. Nostr cryptographically authenticates its metadata; Manual Exchange relies on the authenticity of the user-controlled QR/clipboard exchange path.
5. **Pluggable Signaling, Fixed Transfer**: Nostr and QR/clipboard flows only exchange setup material: metadata, keys, SDP, and ICE candidates. The encrypted chunk framing, `DONE:<chunkCount>:<byteCount>` terminator, and data-channel `ACK` are identical after signaling completes.
6. **PIN Locates and Authenticates via PAKE (Nostr mode)**: A short rotating PIN (8 case-sensitive letters/digits, fresh every 2 minutes) locates the sender's rendezvous event and drives a SPAKE2 (RFC 9382, P-256) password-authenticated key exchange. Content and signaling keys are HKDF derivations off the SPAKE2 shared secret — which mixes fresh ephemeral scalars from both sides — so nothing published to relays can test a PIN guess offline, and a PIN recovered after the fact decrypts nothing.
7. **Confidentiality and Authenticity, Not Availability**: The system defends what is transferred and who receives it. It does not defend that a transfer completes: signaling depends on third-party relays and P2P setup is STUN-only, so failure — accidental or induced — is a first-class outcome that costs a retry, never data. See *Availability Is a Non-Goal*.

## Signaling Methods

By default, Nostr is used for signaling. Manual Exchange is available as an alternative under the Transfer mode selector in the send/receive UI. Both sender and receiver must use the same method.

| Feature | Nostr (Default) | Manual Exchange (No Signaling Server) |
|---------|-----------------|---------------------------------------|
| Signaling Server | Decentralized relays | None (QR or copy/paste) |
| ICE servers | STUN only (Google + Cloudflare); no TURN | STUN only (same WebRTC config); no TURN |
| Reliability | P2P only | P2P only |
| Privacy | Better (no central server) | No signaling server; QR/clipboard payload is only obfuscated |
| Complexity | More complex | Manual exchange (QR or copy/paste) |
| Internet Required | Yes | No (if on same local network) |
| Network Requirement | Any (via internet) | Same local network (without internet) |
| Recommended For | Remote transfers and automatic signaling | Offline/local transfers, or avoiding signaling relays |

## Transfer Flow

Secure Send has two method-specific signaling paths, but only one file-transfer path. Nostr and Manual Exchange differ only until both peers have enough SDP/ICE/key material to open a WebRTC data channel. After that convergence point, both modes call the same shared transfer layer in `src/lib/p2p-transfer.ts`.

### Unified Transfer Flow (All Signaling Methods)

```mermaid
flowchart TD
    subgraph Nostr[Nostr setup]
        N1[Rotating rendezvous event<br/>plaintext + blinded SPAKE2 element]
        N2[Claim / confirm handshake<br/>sealed with PAKE session keys]
        N3[Encrypted WebRTC signals<br/>PAKE-derived signals key]
        N1 --> N2
        N2 --> N3
    end

    subgraph Manual[Manual setup]
        M1[QR/clipboard offer<br/>obfuscated SS03 payload]
        M2[QR/clipboard answer<br/>obfuscated SS03 payload]
        M1 --> M2
    end

    N3 --> Channel[Unified transfer inputs ready:<br/>open WebRTC data channel + CryptoKey]
    M2 --> Channel

    Channel --> Transfer[Unified transfer layer<br/>src/lib/p2p-transfer.ts]
    Transfer --> Chunks[128KB AES-GCM chunks<br/>authenticated chunk index]
    Chunks --> Done[DONE:&lt;chunkCount&gt;:&lt;byteCount&gt;]
    Done --> Verify[Receiver verifies count, indexes,<br/>sizes, and authentication tags]
    Verify --> Ack[Data-channel ACK]
```

Both modes derive the opaque `CryptoKey` from an ephemeral key exchange — Nostr from the SPAKE2 run the PIN authenticates, Manual Exchange from an ECDH exchange whose authenticity rests on the user-controlled QR/clipboard path. `src/lib/p2p-transfer.ts` receives that key plus an open data channel and then runs the same chunk encryption, validation, `DONE:<chunkCount>:<byteCount>` terminator, and final `ACK` flow for every signaling method.

### Signaling Setup Diagrams

### Nostr Mode - Signaling Setup
```mermaid
sequenceDiagram
    participant Sender
    participant Receiver
    loop Every 2 min until claimed (max 30 min)
        Sender->>Receiver: Rendezvous event (fresh PIN generation: locator hint, nonce, blinded SPAKE2 element pA)
    end
    Receiver-->>Sender: Claim (SPAKE2 element pB + body sealed with the session claim key)
    Note over Sender: First claim that opens verifies PIN knowledge and locks the transfer
    Sender->>Receiver: Confirm (sealed with the session confirm key; carries file metadata)
    Note over Receiver: Verifies the confirm, derives and displays the confirmation code
    Note over Sender,Receiver: Human channel: receiver reads the code, sender types it
    Note over Sender: Publishes no WebRTC signal until the typed code matches
    Note over Sender,Receiver: Both hold PAKE-derived session keys (signals + content)
    Sender->>Receiver: WebRTC Offer
    Receiver-->>Sender: WebRTC Answer
    Sender->>Receiver: WebRTC data channel opens
```

### Nostr Mode - P2P Connection Failure
```mermaid
sequenceDiagram
    participant Sender
    participant Receiver
    Sender->>Receiver: Rendezvous event (via Nostr)
    Receiver-->>Sender: Claim
    Sender->>Receiver: Confirm
    Note over Sender,Receiver: P2P connection timeout (30s)
    Note over Sender,Receiver: Transfer fails — UI suggests offline-QR app
```

### Manual Exchange Mode - Signaling Setup
```mermaid
sequenceDiagram
    participant Sender
    participant Receiver
    Sender->>Sender: Generate ECDH keypair, create WebRTC offer
    Sender->>Sender: Obfuscate signaling payload (includes salt)
    Sender->>Sender: Split payload into URL-based QR chunks
    Sender->>Receiver: Display multi-QR grid (URL QR codes)
    Receiver->>Receiver: Scan any QR with phone camera → opens /r page
    Receiver->>Receiver: Scan remaining QR codes in-app
    Receiver->>Receiver: Reassemble chunks, parse payload, derive shared secret
    Receiver->>Receiver: Create WebRTC answer
    Receiver-->>Sender: Display Answer QR (single binary QR)
    Sender->>Receiver: Process answer, establish WebRTC
    Sender->>Receiver: WebRTC data channel opens
```

**Requirements:**
- Receiver needs a phone camera to scan the sender's URL QR codes (or can use clipboard copy/paste as fallback)
- Sender needs a camera OR clipboard to receive the answer back

**Network Requirements:**
- **With internet**: Can work across different networks when ICE finds a direct route; STUN assists discovery but does not relay traffic
- **Without internet**: Devices must be on same local network (WiFi, LAN, etc.)
- **Not air-gapped**: Requires some network connectivity between devices

**How it works:**
- With internet: Google and Cloudflare STUN servers help discover direct ICE candidates. Restrictive NAT or firewall rules can still prevent a connection because TURN relaying is not supported.
- Without internet: WebRTC discovers local ICE candidates directly, connection establishes via local IP addresses

**QR Code Format:**

*Sender → Receiver (Offer):* Multi-QR URL-based chunking
- Offer payload uses `maxDataBytes = 400` payload bytes per chunk (headers are added after payload slicing).
- Chunk wire format (raw bytes before base64url):
  - `chunk_index`: `u8` (1 byte, 0-based)
  - `total_chunks`: `u8` (1 byte, valid range `1..255`)
  - `payload_crc32_be_u32` (carried only in chunk `0`): 4-byte big-endian CRC-32/ISO-HDLC over the full reassembled payload (poly `0x04C11DB7`, reflected input/output, init `0xFFFFFFFF`, xorout `0xFFFFFFFF`; reflected table form `0xEDB88320`)
  - Chunk `0`: `[chunk_index:u8][total_chunks:u8][payload_crc32_be_u32][data]`
  - Chunk `1..N-1`: `[chunk_index:u8][total_chunks:u8][data]`
- Header overhead and usable payload bytes:
  - Chunk `0` header size: `6` bytes (`chunk_index` 1 + `total_chunks` 1 + `payload_crc32_be_u32` 4) -> usable payload data up to `400` bytes, raw chunk bytes up to `406`.
  - Chunk `1..N-1` header size: `2` bytes (`chunk_index` 1 + `total_chunks` 1) -> usable payload data up to `400` bytes, raw chunk bytes up to `402`.
- Chunk data rebalancing (to avoid a tiny last QR payload):
  - After `total_chunks = ceil(payload_bytes / 400)` is chosen, data bytes are distributed evenly: `base_size = floor(payload_bytes / total_chunks)`, `remainder = payload_bytes % total_chunks`.
  - The first `remainder` chunks carry `base_size + 1` data bytes; the remaining chunks carry `base_size` data bytes (difference between chunk payload sizes is at most 1 byte).
- Base64url size expansion (for raw chunk length `n` bytes, unpadded):
  - `n % 3 == 0` -> encoded length `4 * (n / 3)`
  - `n % 3 == 1` -> encoded length `4 * floor(n / 3) + 2`
  - `n % 3 == 2` -> encoded length `4 * floor(n / 3) + 3`
- Typical `1200`-byte payload example:
  - `total_chunks = ceil(1200 / 400) = 3` (data slices are `400`, `400`, `400` bytes).
  - Chunk `0`: `406` raw bytes -> `542` base64url chars in hash payload -> URL fragment `#` length `543` chars (`/r#` length `545`, excluding origin).
  - Chunk `1`: `402` raw bytes -> `536` base64url chars in hash payload -> URL fragment `#` length `537` chars (`/r#` length `539`, excluding origin).
  - Chunk `2`: same as chunk `1`.
- Limits implied by the `u8` headers:
  - Maximum chunks: `255` (`chunk_index` valid range `0..254`, with `chunk_index < total_chunks`)
  - With `400` data bytes per chunk, maximum payload size is `102,000` bytes (`255 * 400`) before base64url encoding.
- CRC32 sequencing and failure handling:
  - Scope: this CRC-32 is a **signaling-payload error-detection** checksum for multi-QR reassembly only (it detects a misread/garbled QR before the offer is parsed). It is **not** file-content integrity and is not a substitute for it — transferred file bytes are protected separately by per-chunk AES-GCM authentication over the WebRTC data channel (see *Streaming Encryption*).
  - CRC32 is carried only in chunk `0`; receivers MUST buffer chunk `1..N-1` data until chunk `0` is received (this spec does not define a streaming-without-chunk-0 mode).
  - CRC32 validation is deferred until full reassembly is complete and chunk `0` (with `payload_crc32_be_u32`) is available.
  - On CRC32 failure after full reassembly, receivers MUST drop the reassembled payload, log a checksum/protocol error, and fail the current transfer attempt (retry/rescan is an implementation-level recovery action).
- Each chunk is base64url-encoded and embedded in a URL: `{origin}/r#{base64url}`
- Deployment requirement: app must be hosted at domain root (no subpath), because chunk URLs are built from `window.location.origin` and append `/r` directly
- Displayed as a grid of URL QR codes, each scannable by a phone's native camera
- For a typical `1200`-byte offer: `3` QR codes. Single-chunk payloads (`≤400` payload bytes) produce `1` QR code.
- Copy/paste fallback: base64-encoded full binary for clipboard

*Receiver → Sender (Answer):* Single binary QR code
- Answer payloads are smaller (no file metadata) and use a single binary QR code (8-bit byte mode)
- The sender is already in-app with scanner active, so URL navigation is unnecessary

## Key Components

### Cryptography (`src/lib/crypto/`)

| Component | Description |
|-----------|-------------|
| `pin.ts` | Rotating 8-character PIN: generation, weighted checksum, validation, locator extraction, and the locator-keyed rendezvous hint |
| `spake2.ts` | SPAKE2 (RFC 9382) over P-256 via @noble/curves: PIN-to-scalar derivation, blinded element generation, and the transcript-keyed root-key derivation. The PAKE math runs outside Web Crypto (which has no group operations); the root is locked into a non-extractable HKDF CryptoKey immediately and intermediates are wiped |
| `kdf.ts` | Session-key derivation off the SPAKE2 root (HKDF-SHA256, `signals`/`content`/`claim`/`confirm` labels), the confirmation-code (short authentication string) derivation, and salt generation |
| `ecdh.ts` | ECDH key agreement for Manual Exchange mode (non-extractable keys); authenticated by the QR/clipboard path |
| `aes-gcm.ts` | AES-256-GCM encryption/decryption |
| `base32.ts` | Crockford Base32 encoding and forgiving normalization for the confirmation code |
| `stream-crypto.ts` | Streaming encryption/decryption (128KB chunks, protocol-agnostic) |
| `constants.ts` | Crypto parameters, 55-character PIN alphabet, rotation/TTL windows, online-guess budgets |

### Shared P2P Transfer Layer (`src/lib/p2p-transfer.ts`)

Once signaling establishes an open WebRTC data channel, both Nostr and Manual Exchange use one shared file-transfer protocol:

1. Sender reads a lazy transfer source and coalesces its output into `ENCRYPTION_CHUNK_SIZE` (`128KB`) chunks. For multi-file/folder sends, this source emits ZIP bytes while fflate is still reading and packaging entries.
2. Each slice is encrypted with `encryptChunk`, producing `[chunk_index_be_u16][nonce_12][ciphertext][tag_16]`.
3. Sender sends encrypted chunks with WebRTC backpressure enabled (`bufferedAmountLowThreshold` defaults to 1MB).
4. Sender sends the control string `DONE:<totalChunks>:<totalBytes>`.
5. Receiver waits for all pending decryptions, validates both `DONE` values, verifies that every expected index arrived exactly once, and checks the total plaintext byte count. The final byte count seals streamed ZIPs whose final size was unknown during signaling.
6. Receiver sends the control string `ACK` on the same data channel.
7. Sender waits up to `ACK_TIMEOUT_MS` (`30s`) for `ACK`; timeout is a transfer failure.

Both sides run an idle/stall watchdog (`STALL_TIMEOUT_MS`, `60s`) over the active transfer instead of any overall wall-clock deadline. On the sender each chunk hand-off (`sendWithBackpressure`) must complete within the window, so a receiver that stops draining the channel aborts the send. On the receiver the window resets on every incoming data-channel message (armed once the channel opens via `start()`), so a sender that goes quiet mid-stream aborts the receive. Either side timing out rejects with `P2PConnectionError`, which the UI treats as a connection failure.

The receiver rejects duplicate indexes, out-of-range indexes, malformed chunk lengths, transfers exceeding the application limit, and malformed final counts.

### PIN Architecture

The Nostr-mode PIN is a short-lived pairing code, not an encryption root. It has exactly two jobs — *locate* the sender's rendezvous event and *authenticate* the key exchange as the password in a SPAKE2 run — and it expires minutes after it is shown. Content confidentiality never rests on it. Since the PIN can be shoulder-surfed off the sender's screen, anyone who saw it can win the first-claim lock and derive a valid session — so neither the PIN nor the session it authenticates identifies *who* receives the file. That gap is closed by the confirmation code *together with an authenticated human channel*: the code proves possession of the locked session, and the sender's operator learning it from the intended receiver — before anything is sent — is what ties that session to the intended person.

#### Why a PAKE
The previous protocol sealed the handshake under a PBKDF2 stretch of the PIN, which made every captured rendezvous/claim/confirm an *offline* dictionary target — the PIN had to carry ~49 bits and the KDF 600,000 iterations just to keep grinding uneconomical. SPAKE2 removes the target instead of out-muscling it: both published elements are password-blinded group elements, and the sealed payloads are keyed by a transcript hash that includes the fresh ephemeral shared point. A relay transcript does not provide an efficient offline PIN verifier under SPAKE2's computational security assumptions — each blinded element is consistent with every candidate PIN, and checking a guess against the sealed payloads requires solving the underlying group problem. The only way to test a guess in practice is to run the protocol live against a peer, which the sender meters (see *Online guessing*). That is what pays for the shorter, friendlier PIN.

The cost is that Web Crypto cannot express the group math, so the SPAKE2 arithmetic runs in @noble/curves and the shared secret transits JavaScript memory briefly before being locked into a non-extractable HKDF `CryptoKey` (intermediate bytes wiped, bigint scalars dropped). That trade is acceptable here because every secret involved is transfer-scoped and dead minutes later — there are no long-lived secrets in this protocol at all.

#### Format
- **Length**: 12 ungrouped characters.
- **Charset**: 55 case-sensitive letters and digits, excluding ambiguous `0`, `1`, `I`, `O`, `i`, `l`, and `o`. No symbols — the code types cleanly on any mobile keyboard.
- **Segments**: the first `PIN_LOCATOR_LENGTH` (3) characters are the **locator**, the next 8 are the **secret** data characters, and the 12th is a checksum over all 11 data characters.
- **Entropy**: the locator is public by construction (see below), so effective strength is 55⁸ ≈ **46.3 bits** — deliberately sized for a threat model with *no offline attack*, where the only guessing channel is metered online claims.
- **Rotation**: the sender mints a fresh PIN (and a fresh SPAKE2 run) and publishes a new rendezvous event every `PIN_ROTATION_MS` (2 minutes). When verifying a claim, it honors only PINs minted in its current or immediately previous bucket (`PIN_ACTIVE_BUCKETS` = 2), so a PIN is usable for roughly 2–4 minutes and is dead at the end of its second bucket.

#### Why the PIN is split
The `#h` lookup tag is published to public relays. Deriving it from the whole PIN would make every rendezvous event a cheap oracle for confirming PIN guesses — the one offline foothold the PAKE otherwise eliminates. Carving out an explicitly public locator confines the tag to a segment that opens nothing on its own, and leaves the secret characters testable only through live claims the sender counts.

An attacker enumerates all 55³ = 166,375 locators against a published hint, learns the locator, and is left with 55⁸ ≈ 8.4×10¹³ possibilities reachable *only* by publishing claims — at most `CLAIM_VERIFY_LIMIT` (100) of which the sender will verify per generation. The control that defends against a PIN someone *read* rather than guessed is the confirmation code, and its strength does not depend on the PIN at all.

#### Typo Detection (Weighted Checksum)
- **Algorithm**: `sum(char_index * one_based_position) % 55`.
- **Detection**: catches common substitutions and adjacent transpositions before a network request is made.
- The input UI rejects a mistyped code the moment the 12th character lands, before anything touches the network.

#### Key Derivation (SPAKE2 root + HKDF fan-out)
`derivePakeSecret` reduces the PIN to the SPAKE2 password scalar `w` (HKDF-SHA256 widened to 384 bits, reduced mod the P-256 order). There is deliberately no expensive KDF: stretching only helps when something permits offline guessing, and nothing here does. The whole PIN goes in, locator included — it adds no strength (the locator is public) but costs nothing and keeps a wrong locator from producing a working handshake.

Each side blinds a fresh ephemeral scalar with the RFC 9382 constants (`pA = x·G + w·M` for the sender, `pB = y·G + w·N` for the receiver), and `finishPake` hashes the RFC transcript — a versioned context with the transfer id, both Nostr identities, both elements, the shared point `K`, and `w` — into the session **root key**, a non-extractable HKDF `CryptoKey`. Everything else fans out from that root with the public per-transfer salt and distinct info labels:

| Derivation | Key material | HKDF info | Output | Purpose |
|------------|--------------|-----------|--------|---------|
| Wire hint | Locator segment (public) | `hint:<bucket>` | 8 hex chars | `#h` lookup tag on the rendezvous event; `<bucket> = floor(now_ms / PIN_ROTATION_MS)` |
| Claim key | SPAKE2 root | `claim` | AES-256-GCM key | Seals the receiver's claim payload |
| Confirm key | SPAKE2 root | `confirm` | AES-256-GCM key | Seals the sender's confirm payload (file metadata included) |
| Signals key | SPAKE2 root | `signals` | AES-256-GCM key | Encrypts relay-carried WebRTC signaling |
| Content key | SPAKE2 root | `content` | AES-256-GCM key | Encrypts P2P file chunks |

Successfully sealing or opening under the claim/confirm keys *is* the PAKE's key confirmation: only a peer that ran the same session — same PIN, same elements, same identities, same transfer — holds them.

- **Receiver look-back**: the published hint is scoped to the rotation bucket it was minted in. The receiver mirrors the sender's rule by deriving its current and immediately previous bucket (`PIN_HINT_LOOKBACK_BUCKETS` = 1) and filtering `#h` on both. As with any wall-clock bucket protocol, clocks must not differ by more than the accepted look-back window.
- **Hint properties**: the tag is 8 hex characters wide but carries at most log2(55³) ≈ **17.3 bits**, because it is a function of the locator alone. Collisions are therefore expected rather than exotic, and — unlike the previous protocol — the receiver cannot disambiguate candidates locally, because the rendezvous is plaintext and proves nothing. It claims up to `MAX_CLAIM_CANDIDATES` (8) structurally valid candidates and lets the handshake decide: only the true sender's confirm can open under one of the claimed sessions' keys. The `#h` query limit (50) leaves headroom for collision walking.

#### Claim / Confirm Handshake (mutual PIN proof via PAKE key confirmation)
The rendezvous event is **plaintext**: `transferId`, the sender's Nostr pubkey (checked against the event author), the blinded SPAKE2 element `pA`, a fresh per-rotation nonce, and relay hints. Nothing in it is PIN-testable, and the file metadata is deliberately absent (see below). The handshake then runs over kind-24242 events:

1. **Claim (receiver → sender)**: carries the receiver's element `pB` in plaintext (the sender needs it to finish the PAKE before any key exists) and the plaintext `target` — the transcript hash of the exact rendezvous the claim was derived against, which routes the claim to the single-use element it spends — plus a body sealed with the session claim key: `transferId`, the echoed sender nonce, a fresh receiver nonce, both peers' Nostr pubkeys, and the rendezvous transcript hash (see below). The receiver publishes one claim per rendezvous candidate it collected, and re-claims replacement rendezvous events (same transfer, same author) with a fresh `y` while waiting for the confirm, up to `MAX_CLAIM_ATTEMPTS` total claims.
2. **Verify + lockout (sender)**: the claim's `target` routes it to the one retained generation whose current element it names — provided that generation's bucket is current-or-previous and its verification budget is not exhausted; a claim naming a spent, expired, or foreign target costs nothing. The element is consumed before verification (single-use, RFC 9382 §7), the attempt burns a unit of the generation's `CLAIM_VERIFY_LIMIT` budget (the online-guessing meter), and the sender finishes the SPAKE2 run against `pB` and tries the seal. A body that opens *and* matches the publication's nonce, the transfer id, the sender's own pubkey, the claim event's author, and the publication's transcript hash — the plaintext target routed but carries no authority; this sealed echo does — is proof the receiver knows a live PIN *and* is acting on the rendezvous this sender actually published. The bucket is checked again after the asynchronous verification so a boundary crossing cannot admit an expired claim. The **first verified claim locks the transfer** to that receiver: rotation stops, rendezvous publishing stops, retained PAKE secrets are wiped, and all other claims are ignored. A claim that fails verification consumed the element, so the sender publishes a replacement rendezvous for that generation (fresh `x`, element, and nonce; same transfer, hint, bucket, and salt) — the honest receiver that lost the race re-claims it. Invalid claims are otherwise silently ignored (transfer tags are public, so treating them as fatal would allow trivial denial of service).
3. **Confirm (sender → receiver)**: published *immediately* on verification, sealed with the session confirm key. It echoes both nonces, both pubkeys, and the transcript hash, and it **delivers the file metadata** (`fileName`, `fileSize`, `fileSizeExact`, `mimeType`, `contentType`). This is the sender's PIN proof in the reverse direction, tells the receiver which of its claims won, and is what lets the receiver display anything at all. It is *not* gated on the confirmation code — the code gates the WebRTC offer and the file bytes, which is where the harm lives. A front-runner who knew the PIN learns the metadata here, exactly as they could under the old protocol by decrypting the rendezvous.
4. **Confirmation code (human channel)**: the receiver verifies the confirm, derives the code, and displays it; the sender parks until its operator types the matching code, then starts WebRTC signaling. See the next section.

Both sides hold the session keys from the same root (`deriveNostrSessionKeys`: `signals` and `content` labels). A relay man-in-the-middle cannot substitute either SPAKE2 element: without `w` an element cannot be unblinded, a substituted element lands each side on a different root key, and every seal — claim, confirm, signals — simply fails.

- **Why nonces**: the sender nonce is fresh per rotation and the receiver nonce is fresh per claim, and both are bound into the transcript, so nothing captured replays across rotations, transfers, or directions (claim and confirm also use distinct HKDF labels and differ by their `type` field). The ephemeral scalars are fresh per claim on both sides — see *Single-use elements* — so the nonces are belt-and-suspenders for replay, not the only defense.
- **Offline guessing does not exist**: this is the PAKE's core property. Blinded elements and transcript-keyed seals give a passive observer nothing to grind against, at any hardware budget. The metadata that used to sit behind a PIN-derived seal on the rendezvous — the one thing offline recovery ever bought — now travels only inside the confirm, keyed by the session.
- **Online guessing is metered**: an active attacker must publish a claim per guess and gets no feedback for failures. The sender verifies at most `CLAIM_VERIFY_LIMIT` (100) claims per generation against a 55⁸ ≈ 8.4×10¹³ space, so a full 30-minute session (≈15 generations) concedes ~1,500 guesses — a ~1.8×10⁻¹¹ success probability, and a *successful* guess still stalls at the confirmation code. Exhausting a generation's budget stalls that generation (see *Availability Is a Non-Goal*); rotation mints a fresh one.
- **Single-use elements (RFC 9382 §7)**: every ephemeral scalar runs exactly one protocol execution. The receiver picks a fresh `y` per claim; the sender picks a fresh `x` per published rendezvous element, and the first claim targeting an element consumes it — one `finishPake`, verified or not. A failed verification is answered with a replacement rendezvous (fresh `x`, same PIN generation), never by reusing the scalar, so the RFC's fresh-scalar assumption holds structurally instead of resting on a deployment argument. The replacement traffic is bounded by the same `CLAIM_VERIFY_LIMIT` budget that meters guesses, and the receiver's re-claims are bounded by `MAX_CLAIM_ATTEMPTS` (16) — which is also what stops a claimed candidate's author from milking extra guesses by rotating replacement elements.
- **The mirrored guess channel**: any PAKE lets a fake *sender* extract one guess per claim the receiver sends, by publishing forged rendezvous events matching the receiver's hint. The receiver caps this at `MAX_CLAIM_CANDIDATES` (8) initial claims and `MAX_CLAIM_ATTEMPTS` (16) claims in total per attempt — ~1.9×10⁻¹³ per attempt — and each forged candidate costs the attacker a published event.

#### Confirmation Code (anti front-running)
A PIN is a value a human reads off a screen and says out loud. Anything that can see it — a shoulder-surfer, a screen share, a photo — can claim the transfer, and the first-claim lockout hands the file to whoever got there first. A PAKE cannot help with this: it proves knowledge of the PIN, which is exactly what the attacker has. The confirmation code closes the gap by moving the final go/no-go onto a channel the attacker does not control — the sender's operator learns the code from the intended receiver directly.

`deriveConfirmationCode` (`kdf.ts`) is a short authentication string: HKDF-SHA256 over the SPAKE2 root with the public per-transfer salt, info label `secure-send:nostr-session:v4:confirmation` bound to the transfer id, both handshake nonces, the rendezvous transcript hash, and the metadata hash, truncated to 40 bits and encoded as 8 Crockford Base32 characters.

- **Receiver**: derives and displays the code once the sender's confirm verifies — which delivered the metadata the code must attest to. The wait is short: the confirm is published on claim verification, with no human in that leg.
- **Sender**: derives the same value from the claim it locked onto, publishes its confirm, and parks. No WebRTC offer and no file bytes leave the sender until its operator types a matching code. A mismatch is retryable — a typo must not kill a transfer — and never settles the gate.
- **Why it works**: the code proves possession of the *locked* session, not receiver identity — a front-runner that won the claim race holds that session and can compute the code. What it cannot do is deliver it: the sender's operator learns the code from the intended receiver over an authenticated human channel (in person, a call), and when a front-runner holds the lock, the intended receiver never got a confirm and has no code to give. The gate therefore never opens, and no signal or file byte leaves the sender.
- **What it covers**: the shared secret, the transfer id, both nonces, the rendezvous transcript hash, and the file-metadata hash — so the code attests to *what* is being transferred and *who* published it as well as to the keys. See *Transcript Binding*.
- **It also subsumes key confirmation**: a relay that tampered with either SPAKE2 element would land the two sides on different roots and therefore different codes — though the sealed handshake will have failed long before the humans compare anything.
- **Guessing**: 40 bits, blind. There is deliberately **no attempt counter and no rate limit** — a mismatch is retryable so a typo cannot kill a transfer, so attempts are bounded only by what a human can type before `CONFIRM_CODE_ENTRY_TIMEOUT_MS` expires. That is sound because the guesser is not the attacker: only the sender's own operator can submit a code, and they are reading the real one off a phone call. An attacker would have to talk that operator into typing wrong codes repeatedly, and even unlimited machine-speed entry inside the window covers a negligible fraction of 2⁴⁰. Crockford Base32 normalization folds `I`/`L` → `1` and `O` → `0` so transcription slips do not read as mismatches.
- **Denial of service is explicitly out of scope**: a front-runner that keeps winning claim races can stall transfers, since the sender still locks on the first claim. The design goal here is that they never receive data, not that they cannot be a nuisance — the same trade the system makes everywhere else. See *Availability Is a Non-Goal*.

#### Transcript Binding (what the PAKE alone does not cover)
The SPAKE2 transcript keys every session to the transfer id, both Nostr identities, and both elements — so a rewrapped identity, a forwarded claim, or a substituted element yields a different root and every seal fails on its own. Two things live *outside* that transcript and need explicit binding:

- **The rest of the rendezvous record.** `computeRendezvousTranscriptHash` (`nostr/transcript.ts`) is SHA-256 over a canonical JSON array — a versioned label, `type`, `transferId`, `senderPubkey`, the SPAKE2 element, the nonce, the relay list, and the salt. The receiver hashes the rendezvous it acted on into its sealed claim; the sender compares against the hash of what it actually published, per generation. Any altered plaintext field — a swapped salt, a doctored relay list — is rejected automatically. The same digest feeds the confirmation-code KDF, so even a missed check would surface as two humans reading different codes. (A JSON array rather than an object so element order is fixed; JSON string escaping so no field value can forge a delimiter into another.)
- **The file metadata**, which no longer exists at claim time — it travels inside the sealed confirm. Its own digest, `computeTransferMetadataHash` (same canonicalization: versioned label, `contentType`, `fileName`, `fileSize`, `fileSizeExact`, `mimeType`), is bound into the confirmation-code KDF on both sides. The AES-GCM seal on the confirm already authenticates the metadata cryptographically; the code binding makes the string the humans compare attest to *what* is being transferred, closing the class of attack where genuine bytes are delivered under an attacker-chosen name and MIME type. (`fileSize` is additionally enforced in-band — `p2p-transfer.ts` rejects a DONE byte count that disagrees with the metadata.)

### User Interface Architecture

#### `PinInput` (Receiver Side)
The input component is designed for fast, error-proof manual entry:
- **Single Native Input**: Entry uses one ungrouped 12-character text field so cursor movement, selection, insertion, deletion, and replacement retain normal browser behavior.
- **Exact Entry**: PINs are case-sensitive. During both ordinary entry and paste, characters outside the 55-character alphabet are filtered out and a brief error is shown; supported characters remain in their original order.
- **Instant Checksum Feedback**: A complete-but-mistyped code is flagged the moment the 8th character lands.
- **Robust Pasting**: A paste replaces the current entry with up to the first 8 supported characters. Unsupported characters are filtered out with the same brief error used for ordinary entry; they do not reject the entire paste or remain in the field.
- **No Plaintext Retention**: Once valid, the PIN is immediately reduced to its SPAKE2 password scalar (`derivePakeSecret`), its public locator segment is captured, the inputs are masked, and the plaintext is cleared. The scalar bytes are wiped once the receive flow has built its claims.

#### `PinDisplay` (Sender Side)
The display component focuses on secure and clear communication:
- **Rotation Countdown**: A progress bar and an m:ss countdown under the PIN show the time until the next 2-minute rotation replaces it. The previous-bucket grace window is deliberately not surfaced in the countdown; it is a claim-validation detail, while users should share the currently displayed PIN.
- **On-Demand Refresh**: A prominent "Generate a new PIN" action mints and publishes a fresh PIN immediately. Unlike an automatic rotation, it drops every retained generation (previously shown PINs stop authenticating — their relay events linger until NIP-40 expiry but their claims are no longer honored) and restarts the rotation cadence, while reusing the transfer's file bytes, ephemeral keys, and relay connections. An epoch counter guards against an in-flight rotation publish registering or displaying a pre-reset PIN.
- **Quiet Backstop**: A muted footnote notes when waiting stops automatically (30 minutes); it is deliberately unobtrusive because rotation, not this window, is the security-relevant timer.
- **Next Step**: A note that a confirmation code will appear on the receiver's screen and must be entered here, so the sender is not surprised by the prompt.

#### `ConfirmationCodeDisplay` / `ConfirmationCodeInput`
- **Display (receiver)**: renders the 8 characters grouped `XXXX-XXXX` in large monospace with a copy button, and states plainly that the transfer does not start until the sender enters it.
- **Input (sender)**: normalizes on every keystroke through `normalizeCrockfordBase32`, so the display hyphen, lowercase entry, and `O`/`0` or `I`/`1` slips all land on the same value. A mismatch shows an inline error and clears the field; the send stays parked.
- **The expected code is never exposed to the sender's UI.** `useNostrSend` holds it in a ref and returns only a `submitConfirmationCode(code): boolean` predicate — showing it would defeat the entire mechanism.

**Key Parameters:**
- `MAX_MESSAGE_SIZE`: 2GB (maximum transferred payload size; every stage streams, see Streaming Encryption)
- `ENCRYPTION_CHUNK_SIZE`: 128KB (application-level encryption chunk size for all methods)
- `PIN_ROTATION_MS`: 2 minutes (fresh PIN + SPAKE2 run + rendezvous event cadence)
- `PIN_ACTIVE_BUCKETS`: 2 (only the sender's current and immediately previous buckets are honored; `PIN_TTL_MS` = 4 minutes is the maximum possible age)
- `PIN_WAIT_TIMEOUT_MS`: 30 minutes (sender rotation/wait backstop — a resource bound, not a security control; rotation already caps each PIN's exposure)
- `PIN_LOCATOR_LENGTH`: 3 (public prefix characters; the sole input to the `#h` hint)
- `CLAIM_VERIFY_LIMIT`: 100 (SPAKE2 claim verifications per PIN generation — the online-guessing meter)
- `MAX_CLAIM_CANDIDATES`: 8 (rendezvous candidates the receiver will claim per attempt)
- `MAX_CLAIM_ATTEMPTS`: 16 (total claims per receive attempt, initial candidates plus re-claims of replacement elements)
- `CONFIRMATION_CODE_LENGTH`: 8 Crockford Base32 characters (40 bits)

### Nostr Signaling (`src/lib/nostr/`)

Uses Nostr protocol for decentralized signaling between sender and receiver.

**Event Kinds:**
| Kind | Purpose |
|------|---------|
| 24243 | Rendezvous - rotating plaintext record: transferId, sender pubkey, blinded SPAKE2 element, handshake nonce, relay hints (NIP-40 expiry = PIN_TTL_MS); tagged with the locator-derived `#h` hint. Carries no file metadata and nothing PIN-testable |
| 24242 | Data Transfer - claim/confirm handshake and WebRTC signals |

**Event Types (via tags):**
- `rendezvous`: Initial transfer setup; republished with a fresh PIN/hint/nonce/element every 2 minutes until claimed
- `claim`: Receiver's SPAKE2 element in plaintext plus a body sealed with the PAKE session's claim key. Tags are plaintext for routing; opening the seal is the receiver's PIN proof, and the body repeats the transfer id and nonces for authentication
- `confirm`: Sender's mutual PIN proof, sealed with the session's confirm key; published immediately on claim verification and carries the file metadata. The confirmation code gates the WebRTC offer, not this event
- `signal`: WebRTC signaling (offer/answer/candidates), encrypted in the event content with the PAKE-derived `signals` key

**Files:**
- `types.ts`: Type definitions for payloads and events
- `events.ts`: Event creation and parsing functions
- `client.ts`: Nostr relay connection management
- `relays.ts`: Default relay configuration
- `availability.ts`: Relay availability probing

### Manual Exchange Signaling (`src/lib/manual-signaling.ts`)

Signaling method using QR codes or copy/paste for WebRTC offer/answer exchange. Camera is optional; signaling data can be exchanged via clipboard. **Network requirements:** With internet, STUN can help devices on different networks discover a direct ICE route, but success is not guaranteed. Without internet, devices must be able to reach each other directly, normally on the same local network (not air-gapped). TURN relaying is not supported.

**How it works:**
- Sender generates WebRTC offer with ICE candidates
- Both offer and answer include a required `createdAt` timestamp; receivers refuse to proceed if the offer is expired or missing TTL
- Payload is obfuscated using a time-bucketed seed to avoid casual inspection.

> [!IMPORTANT]
> **Security boundary**: Manual signaling payloads are not cryptographically confidential. The time-bucketed obfuscation deters casual inspection and the 1-hour TTL prevents stale offers from starting a session, but someone who captures the QR/clipboard payload can potentially recover metadata and SDP/ICE details. File-content confidentiality comes from the ECDH-derived AES-256-GCM key, assuming the offer and answer are exchanged over an authentic QR/clipboard path.

**Binary Payload Format (SS03):**

The payload consists of two distinct layers to balance rapid identification with obfuscation of the content.

| Component | Length | Status | Description |
|-----------|--------|--------|-------------|
| **Outer Magic** | 4 bytes | Plaintext | Fixed header: `"SS03"` (`0x53 0x53 0x30 0x33`) |
| **Inner Buffer** | Variable | **Obfuscated** | Time-bucketed XOR-obfuscated content (detailed below) |

**Obfuscated Inner Buffer Structure:**

The following structure is revealed *after* successful de-obfuscation using the correct hourly seed:

| Component | Length | Status | Description |
|-----------|--------|--------|-------------|
| **Inner Magic** | 4 bytes | Obfuscated | Fixed marker: `"mag!"` (`0x6d 0x61 0x67 0x21`) |
| **Payload** | Variable | Obfuscated | Deflate-compressed `SignalingPayload` JSON |

**Verification Process:**
1. **Identification**: The receiver checks the first 4 bytes for the plaintext `"SS03"` header.
2. **Seed Testing**: The receiver iterates through candidate seeds for the current and previous hour (2-hour sliding window). 
3. **Optimized Check**: For each candidate seed, only the first 4 bytes of the inner buffer are de-obfuscated. If they match the `"mag!"` marker, the correct seed has been found.
4. **Full Processing**: The rest of the buffer is de-obfuscated, decompressed via deflate, and parsed as JSON.

**Time-Bucketed Obfuscation:**

The obfuscation seed changes every hour to make the payload **look more random** and limit casual reuse. This provides several benefits:
- **Casual Protection**: Offers a layer of deterrence against casual non-technical observers by making the raw data unreadable without the correct hourly seed.
- **Stale Session Prevention**: Combined with the explicit `createdAt` TTL checks, stale signaling data cannot start a new transfer session.
- **Payload Randomness**: Ensures that signaling data generated at different times results in significantly different binary outputs.

Primary file-content confidentiality is provided by ECDH + AES-256-GCM (see note above); obfuscation is additive and not a cryptographic control.

- **Bucket Size**: 1 hour (`3600` seconds).
- **Input (`bucketEpoch`)**: `floor(unix_timestamp_seconds / 3600)`.
- **Base Seed**: `0x9e3779b9`.
- **Algorithm**: A 32-bit MurmurHash3-style finalizer/mixer.

**Seed Derivation Steps:**
To ensure cross-implementation compatibility, the seed MUST be derived using the following steps (using 32-bit signed integer multiplication and unsigned right shifts):

1.  Initialize: `h = 0x9e3779b9 ^ bucketEpoch`
2.  Mix 1: `h = (h ^ (h >>> 16)) * 0x85ebca6b`
3.  Mix 2: `h = (h ^ (h >>> 13)) * 0xc2b2ae35`
4.  Finalize: `seed = (h ^ (h >>> 16)) >>> 0`

*Note: In environments like JavaScript, `Math.imul` should be used for the multiplication steps to ensure consistent 32-bit integer behavior.*

**Obfuscation Parse Window & Edge Cases:**
A 2-hour sliding window (current bucket + 1 previous bucket) is used to find the obfuscation seed. This is separate from the hard 1-hour session TTL enforced via `createdAt`.

-   **Session Validity**: A parsed payload is still rejected once `Date.now() - createdAt > TRANSFER_EXPIRATION_MS`.
-   **Parseability Window**: A payload may remain parseable for roughly 1-2 hours depending on bucket boundaries, but parseability does not imply transfer validity.
-   **Clock Relationship**: The receiver accepts payloads encoded in its current hour bucket or the immediately previous bucket. This tolerates a sender clock that falls into the receiver's previous bucket, but it is not symmetric: a sender in the receiver's next/future bucket cannot be decoded.
-   **Boundary Transitions**: When the hour rolls over, the old current bucket becomes the accepted previous bucket and the older bucket is dropped.
-   **Out-of-Sync Clocks**: De-obfuscation fails when the sender encodes into a bucket ahead of the receiver or older than the receiver's immediately previous bucket.

> [!NOTE]
> The obfuscation's goal is simply to avoid casual inspection. It should not be treated as encryption, and expiry is not cryptographic erasure of a captured QR/clipboard payload.

**Encoding Pipeline:**
1. `SignalingPayload` object → JSON string.
2. Compress with deflate (variable length).
3. Prepend fixed-length `"mag!"` marker (4 bytes).
4. XOR-obfuscate this inner buffer with the current hourly seed.
5. Prepend fixed-length plaintext `"SS03"` header (4 bytes).
6. Result: Final binary payload.




**Output Methods:**

*Offer (Sender → Receiver):*
| Method | Encoding | Use Case |
|--------|----------|----------|
| Multi-QR URL | Chunked payload → base64url → URL QR codes | Primary: receiver scans with phone camera to open app |
| Copy/Paste | Base64-encoded full binary | Fallback: no camera, text-safe for clipboard |

*Answer (Receiver → Sender):*
| Method | Encoding | Use Case |
|--------|----------|----------|
| QR Code | SS03 obfuscated binary (single QR) | Camera available, sender already in-app |
| Copy/Paste | Base64-encoded binary | No camera, text-safe for clipboard |

**Key Features:**
- No signaling server required - manual exchange via QR scan or copy/paste
- Multi-QR offer: payload split into URL-based QR codes (~400 bytes each) for easy phone scanning
- Receiver scans any QR code with phone camera → app opens at `/r` route with first chunk → scans remaining codes in-app
- Copy/paste fallback for environments without camera
- No internet required when devices are on same local network
- With internet: STUN can assist direct candidate discovery across different networks; a restrictive NAT/firewall can still make the connection fail
- Not air-gapped: requires network connectivity between devices (either local network or internet)
- URL QR codes are generated from URL text with auto-selected QR encoding; answer QR uses binary mode (8-bit byte)
- Uses the bundled QR WASM packages for generation and scanning

**Security Model:**
- **Nostr**: The rotating PIN drives a SPAKE2 exchange; the mutual claim/confirm handshake is sealed with session keys only matching PAKE peers hold, and signals and content are encrypted with keys off the same root. Nothing published can test a PIN offline, public transfer IDs cannot start the sender state machine, and a leaked PIN decrypts no content — file metadata is never exposed to relays in plaintext (the published confirm is sealed ciphertext relays cannot decrypt)
- **Manual**: Signaling is obfuscated and time-limited, not encrypted; content confidentiality is provided by ECDH-derived AES-256-GCM over the data channel when the QR/clipboard exchange is authentic
- **All modes**: Once WebRTC connection is established, DTLS encrypts all data in transit, and file content is additionally encrypted with the shared chunk protocol

### WebRTC (`src/lib/webrtc.ts`)

Handles direct peer-to-peer connections using WebRTC data channels.

**Features:**
- ICE candidate queuing for reliable connection establishment
- Google and Cloudflare STUN servers for direct ICE candidate discovery; TURN relay candidates are never configured
- 128KB encrypted chunk messages with backpressure (WebRTC handles fragmentation)
- Backpressure support (waits for buffer to drain before sending more data)
- Connection state monitoring

### React Hooks (`src/hooks/`)

**`use-nostr-send.ts`** - Sender logic (Nostr):
1. Read content; generate transfer salt and ephemeral Nostr identity
2. Rotate: every 2 minutes mint a fresh PIN, start a fresh SPAKE2 run, and publish a plaintext rendezvous event carrying the blinded element (up to 30 minutes)
3. On each incoming claim, route by its plaintext target to the single retained generation whose current element it names, consume that element (single-use, budgeted by `CLAIM_VERIFY_LIMIT`), finish the PAKE against the claimant's element and try the sealed body; first verified claim locks the transfer, a failed claim triggers a replacement rendezvous publish (invalid claims are otherwise ignored)
4. Derive session keys and the confirmation code from the winning session's root; publish the confirm (sealed metadata included) immediately
5. Wait for the operator to enter the code the receiver is showing (`CONFIRM_CODE_ENTRY_TIMEOUT_MS`); mismatches are retryable and no WebRTC signal is published until one matches
6. Attempt P2P connection (30s timeout for connection only)
7. If P2P connects: transfer via data channel
8. If P2P connection fails: transfer fails — no TURN or automatic transfer fallback; a `P2PConnectionError` is surfaced so the UI can suggest the offline-QR app ([src/lib/errors.ts](../src/lib/errors.ts))
9. Wait for the receiver's data-channel `ACK` after `DONE:<chunkCount>:<byteCount>`

**`use-nostr-receive.ts`** - Receiver logic (Nostr):
1. Derive hints for the current and previous buckets from the PIN's public locator segment and query rendezvous candidates within the maximum 4-minute freshness bound
2. Structurally validate candidates (author/transfer binding, element validity) — the rendezvous is plaintext, so nothing distinguishes the real one yet
3. Run the receiver side of the PAKE against each candidate (up to `MAX_CLAIM_CANDIDATES`) and publish one sealed claim each, naming its rendezvous transcript hash as the plaintext target; re-claim replacement rendezvous events from claimed senders while waiting (up to `MAX_CLAIM_ATTEMPTS` total), then wipe the PIN scalar
4. Wait (`CONFIRM_TIMEOUT_MS`, 60s) for a confirm that opens under one claimed session's confirm key; verify its echoes and take its sealed file metadata
5. Derive the confirmation code (bound to the metadata) and display it for the user to read to the sender
6. Listen for P2P signals — the sender's first signal means the code matched (`OFFER_WAIT_TIMEOUT_MS`, 3 minutes); derive session keys from the same root
7. Receive via data channel
8. Send data-channel `ACK` after all chunks authenticate and reassemble; no relay completion event is published

**Manual Exchange Mode:**

**`use-manual-send.ts`** - Sender logic (Manual Exchange):
1. Read content (file), validate size
2. Generate ECDH keypair and salt
3. Create WebRTC offer with ICE candidates
4. Wait for ICE gathering to complete
5. Obfuscate offer payload (includes salt, ECDH public key, file metadata): JSON → deflate → obfuscate → binary
6. Display as multi-QR URL grid (chunked into ~400-byte URL QR codes) + base64 copy button
7. Wait for user to input receiver's answer (scan or paste)
8. Process answer, derive shared secret from ECDH, establish WebRTC connection
9. Encrypt and send data in 128KB chunks via data channel
10. Wait for receiver `ACK` on the data channel

**`use-manual-receive.ts`** - Receiver logic (Manual Exchange):
1. Wait for offer data (from multi-QR chunk collector or paste)
2. De-obfuscate offer, extract metadata, ECDH public key, and salt
3. Generate ECDH keypair, derive shared secret and AES key
4. Create WebRTC answer with ICE candidates
5. Obfuscate answer payload: JSON → deflate → obfuscate → single binary QR code
6. Display QR code and base64 copy button
7. Wait for WebRTC connection to establish
8. Receive encrypted chunks, decrypt/authenticate each chunk as it arrives, and write it to the receive sink (in memory ≤100MB, OPFS above)
9. After `DONE:<chunkCount>:<byteCount>` validates, send data-channel `ACK`
10. Present content

**`use-chunk-collector.ts`** - Multi-QR chunk collection (used by `/r` receive page):
1. Parse incoming chunks (from URL fragment or scanned QR codes)
2. Track collection progress with `Map<index, data>`
3. Reject chunks with mismatched `total` (guards against mixing different offers)
4. Auto-reassemble when all chunks collected

## Data Encryption

### Unified Transfer Layer

Both signaling methods (Nostr, Manual Exchange) enter the same transfer code path with an open WebRTC data channel and an already-derived AES-GCM `CryptoKey`. In both modes that key comes from an ephemeral exchange — the SPAKE2 run in Nostr mode, ECDH authenticated by the QR/clipboard path in Manual — and the unified transfer layer treats it as an opaque AES key with the same encrypted chunk framing for file content.

**Why encrypt when WebRTC provides DTLS?**
- **Defense in depth**: Multiple encryption layers protect against implementation bugs
- **Consistent chunk format**: P2P file data uses the same authenticated chunk layout in both modes
- **Key control**: File encryption keys are application-managed (exchange-derived in both modes), not WebRTC keys
- **Verification**: Application-level encryption authenticates each chunk and its write position

### Rendezvous Payload

In Nostr mode, the rendezvous payload is published as plaintext JSON — deliberately, because with a PAKE nothing in it may be PIN-testable, and encrypting it under a PIN-derived key would reintroduce the offline guessing target the PAKE removes. It carries:

- **Transfer identity**: a `transferId` and the sender's ephemeral Nostr public key (which must match the event author), used to route and authenticate subsequent handshake/signal events.
- **Handshake material**: the sender's blinded SPAKE2 element and a fresh per-rotation nonce.
- **Sender relay hints**: an optional list of preferred relays for signaling.

**File metadata is absent.** File name, size, MIME type, and content type travel inside the sender's sealed confirm — after the handshake, under a key only the authenticated peer holds — so relays carry them only as ciphertext they cannot decrypt, never in plaintext.

### Encryption Flow

**Nostr Mode:**
1. **PIN Generation**: fresh 12-character case-sensitive PIN every 2 minutes (11 random chars + check digit)
2. **Salt Generation**: 16 random bytes (public, in the rendezvous event tags; HKDF salt for the session keys)
3. **SPAKE2 Run**: the PIN reduces to the password scalar `w` (no key stretching — there is nothing to stretch against); each side blinds a fresh ephemeral scalar and the transcript hash becomes the non-extractable session root. The `#h` hint is a separate HKDF keyed by the public locator segment
4. **Handshake Seal Keys**: HKDF off the root (`claim` and `confirm` labels) — opening either seal is the PAKE's key confirmation
5. **Confirmation Code**: HKDF over the root, bound to the transfer id, both nonces, the rendezvous transcript hash, and the metadata hash, rendered as 8 Crockford Base32 characters — displayed by the receiver, typed by the sender, and required before the sender publishes any WebRTC signal
6. **Session Key Derivation**: both sides derive `signals` and `content` AES-GCM keys off the same root via HKDF with the transfer salt
7. **Chunk Encryption**: AES-256-GCM with 12-byte nonce per 128KB chunk using the PAKE-derived `content` key

### What's Encrypted Where

| Data | Nostr P2P | Manual P2P |
|------|-----------|------------|
| Rendezvous | Plaintext by design (blinded SPAKE2 element, nonce, relay hints — nothing PIN-testable, no file metadata) | Obfuscated only; metadata and SDP/ICE are not cryptographically confidential |
| Handshake (claim/confirm) | Sealed (AES-GCM with PAKE session claim/confirm keys; binds nonces, both Nostr pubkeys, and the transcript hash; tags remain plaintext for relay filtering). The confirm carries the file metadata; the out-of-band confirmation code gates the WebRTC offer | No relay event; authenticity comes from the QR/clipboard path |
| WebRTC Signals | Encrypted (AES-GCM with PAKE-derived `signals` key) | Included in obfuscated QR/clipboard offer/answer |
| Transfer completion | Plain `ACK` control string on the WebRTC data channel after authenticated chunk reassembly | Plain `ACK` control string on the WebRTC data channel after authenticated chunk reassembly |
| File Content | Encrypted (AES-GCM with SPAKE2-derived `content` key, 128KB chunks, authenticated chunk index) | Encrypted (AES-GCM, 128KB chunks, authenticated chunk index) |

### Streaming Encryption (All Methods)

All P2P transfers (Nostr, Manual Exchange) encrypt content in 128KB chunks using identical logic:

- **Sender side**: a lazy source is coalesced into 128KB chunks, so only bounded in-flight data is materialized. A picked `File` streams from the browser; a multi-file/folder source feeds fflate output directly into the same chunker. Each chunk is encrypted with the transfer key and its own authenticated index, then sent in order.
- **Receiver side (all P2P modes)**: exact-size files use positional writes. ZIPs with an unknown compressed size append in reliable data-channel order to an adaptive sink, which starts in memory and migrates to OPFS before crossing 100MB. There is no intermediate encrypted-chunk storage; each authenticated chunk is written and dropped immediately.
- **Completion**: the sender finishes with `DONE:<totalChunks>:<totalBytes>`. The receiver verifies the chunk count, received index set, and final decrypted byte count before sending `ACK` on the data channel.

**OPFS scratch lifecycle (privacy):** for received payloads over 100MB, plaintext transiently touches browser-managed disk in `transfer-scratch` files until the transfer is reset. Senders do not create scratch files. Payloads of 100MB or less stay in memory and never touch disk. Every receiver abandonment path (cancel mid-transfer, transfer error, reset, starting a new receive) discards its scratch file, and a boot-time sweep plus a pre-transfer sweep remove files that crashed or closed sessions left behind, so leftovers never outlive the next visit.

**Streamed archive creation:** multi-file and folder sends are packaged with fflate's streaming `Zip`/`ZipPassThrough`. Each input file is stored chunk by chunk in a backpressured `TransformStream`; generated ZIP bytes flow immediately into encryption and WebRTC. Store mode avoids fflate's intermittent streaming-deflate CRC corruption while preserving ZIP's per-entry CRC-32 checksums and bounded memory use. The sender never assembles the ZIP in memory or OPFS, and later entries need not be read before earlier archive bytes are sent.

**No whole-file checksum:** File-content integrity relies solely on per-chunk AES-GCM authentication (auth tag + authenticated chunk index) together with the completeness checks above and the final `ACK`. There is deliberately **no digest/hash computed over the assembled file** — neither sender nor receiver hashes the whole file, and no metadata/manifest carries a file digest. This avoids an additional integrity value and verification pass. An incremental digest could be added without materializing the whole file, but it is not part of this protocol and would be redundant with the protocol's authenticated-chunk and completeness checks.

**Encrypted Chunk Format:**
```
[2 bytes: chunk index (big-endian)][12 bytes: nonce][ciphertext][16 bytes: auth tag]
```

The 2-byte chunk index is also passed to AES-GCM as additional authenticated data. A receiver rejects the chunk if the index prefix is changed or swapped with another chunk's ciphertext.

**Benefits:**
- **Defense in depth**: AES-GCM on top of WebRTC DTLS
- **Streaming decryption in all P2P modes**: Each chunk is decrypted as it arrives
- **Memory efficiency**: the sender always needs only bounded chunk buffers, including while generating ZIPs; the receiver streams payloads over 100MB to disk and buffers smaller payloads in memory
- **Order handling**: exact-size files support positional out-of-order writes; unknown-size ZIP streams require the data channel's reliable default ordering so they can append without seeking

```mermaid
flowchart TD
    Secret[PIN handshake or authentic manual exchange] --> Signaling[Signaling offer/answer/ICE]
    Signaling --> Key[Exchange-derived AES content key<br/>SPAKE2 in Nostr mode, ECDH in Manual]
    Signaling --> DTLS[WebRTC handshake<br/>DTLS]
    DTLS --> Channel[P2P data channel]
    Channel --> Chunks[128KB encrypted chunks]
    Key --> Write[Decrypt + direct buffer write at idx * 128KB]
    Chunks --> Write
    Write --> Ack[Data-channel ACK]
```

Both receive modes reject extra, duplicate, out-of-range, malformed, and oversized encrypted chunks against the advertised transfer size before completion is acknowledged.

## Size Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max transferred payload size | 2GB (`MAX_MESSAGE_SIZE`) | Bounded by the application limit and disk quota, not RAM: multi-file/folder sends are zipped directly into the encrypted data channel, and the receiver writes decrypted chunks to an adaptive memory/OPFS sink. Payloads at or below 100MB (`MEMORY_SINK_MAX_BYTES`) are buffered in memory; larger received payloads require OPFS. `FileSystemFileHandle.createWritable` is feature-detected at runtime, so unsupported receivers fail with a clear error only if the payload crosses the threshold. |
| Encryption chunk size | 128KB | Balance of encryption overhead and streaming efficiency |
| PIN length | 12 chars (3 public locator + 8 secret data + check digit, ~46.3 effective bits) | Sized for online-only guessing: the SPAKE2 handshake leaves no offline target, the sender meters claim verifications (`CLAIM_VERIFY_LIMIT`), and the locator is spent on the public `#h` tag so no published value commits to the secret characters. Front-running is handled by the confirmation code rather than by PIN entropy |
| Confirmation code | 8 Crockford Base32 chars (40 bits) | Short enough to dictate over a phone call, long enough that a blind guess inside the entry window is hopeless |

## Timeout Configuration

| Timeout | Duration | Purpose |
|---------|----------|---------|
| Nostr P2P connection | 30 seconds | Time to establish WebRTC connection after relay signaling starts |
| Manual P2P connection | 120 seconds | Time to establish WebRTC connection after the answer is scanned/pasted |
| ICE gathering | 5 seconds | Bounded wait while preparing Manual offer/answer QR payloads |
| Nostr P2P offer retry | 5 seconds | Interval to retry WebRTC offer if no answer event has been processed |
| Data-channel ACK wait | 30 seconds | Sender wait after `DONE:<chunkCount>:<byteCount>` for receiver `ACK` |
| P2P transfer stall | 60 seconds | Idle/stall window (`STALL_TIMEOUT_MS`) applied to both sides of an active transfer. The receiver arms it via the watchdog's `start()` when the data channel opens (not only after the first chunk arrives); the sender applies it per chunk hand-off. It resets on each chunk sent / message received, so a steadily-progressing transfer of any size never trips it; a peer that goes quiet aborts after this span. There is no overall transfer deadline. |
| PIN rotation | 2 minutes | Fresh PIN + rendezvous event cadence (`PIN_ROTATION_MS`) |
| PIN validity | Roughly 2–4 minutes | A PIN is honored only in the bucket where it was minted and the immediately following bucket; `PIN_TTL_MS` = 4 minutes is the maximum age bound, while NIP-40 expiry is the exact end of the second bucket |
| Receiver confirm wait | 60 seconds | Receiver wait for the sender's confirm after publishing its claims (`CONFIRM_TIMEOUT_MS`). Short because the sender confirms on verification with no human in the loop; this is also where a mistyped-but-checksum-valid PIN surfaces |
| Receiver offer wait | 3 minutes | Receiver wait for the sender's first WebRTC signal after the confirm (`OFFER_WAIT_TIMEOUT_MS`). Generous because the sender's operator is typing the confirmation code in between |
| Sender confirmation-code entry | 150 seconds | Sender wait for its operator to type the receiver's code (`CONFIRM_CODE_ENTRY_TIMEOUT_MS`). Deliberately shorter than the receiver's offer wait, so a slow typist makes the side with a person in front of it report the timeout |
| Sender PIN rotation/wait backstop | 30 minutes | Resource bound on an unclaimed transfer (relay publishing + retained file handle) before it is canceled (`PIN_WAIT_TIMEOUT_MS`); not a security window — bucket validation caps each PIN at roughly 2–4 minutes. Note this deadline is tracked twice and independently: a `setTimeout` inside the sender's claim wait, and `PinDisplay`'s own `requestAnimationFrame` countdown that fires `onExpire`. Whichever fires first ends the wait |
| Manual transfer TTL | 1 hour | Manual Exchange session validity (`TRANSFER_EXPIRATION_MS`) |
| Receiver PIN inactivity | 5 minutes | Clears PIN input if no changes made |

## TTL / Expiration Spec

Secure Send enforces hard session TTLs. Expired requests MUST NOT establish a session or begin transfer, even if the PIN/key is correct.

**Duration**
- **Nostr**: current-or-previous bucket acceptance (roughly 2–4 minutes, with `PIN_TTL_MS` = 4 minutes as the maximum freshness bound) inside a `PIN_WAIT_TIMEOUT_MS` (30 minute) resource-backstop wait window
- **Manual Exchange**: `TRANSFER_EXPIRATION_MS` (currently 1 hour)

**TTL Anchor (start time)**
- **Nostr**: rendezvous event `created_at` (seconds since epoch), one event per rotation
- **Manual Exchange**: `SignalingPayload.createdAt` (milliseconds since epoch)

**Enforcement Points (hard fail)**
- **Receiver-side (pre-session)**:
  - Reject rendezvous events older than `PIN_TTL_MS` before claiming (Nostr); reject expired/missing TTL before answering (Manual).
- **Sender-side (pre-transfer)**:
  - Only verify claims against retained PIN generations whose recorded bucket is the sender's current or immediately previous bucket (and whose `CLAIM_VERIFY_LIMIT` budget remains); consume each published element on the first claim targeting it and never finish its scalar twice; recheck the bucket after opening the claim, and stop publishing and honoring PINs at the first verified claim and at the 30-minute backstop.
  - Publish no WebRTC signaling until the operator enters the receiver's confirmation code, and abandon the locked claim if that does not happen within `CONFIRM_CODE_ENTRY_TIMEOUT_MS`.

**No Backward Compatibility**
- Requests/payloads missing TTL fields are rejected (treated as invalid).
- Shared P2P data-channel completion requires `DONE:<chunkCount>:<byteCount>` followed by receiver `ACK`.
- Multi-QR offer links require `/r#...` (raw hash payload, no `d=` prefix) and first-chunk CRC32 metadata; older URL or chunk formats are rejected.

## Leaked-PIN Exposure (Including After Expiry)

PIN rotation and the NIP-40 `expiration` tag are **liveness controls, not cryptographic erasure**: they stop a PIN from authenticating anything new, but they cannot delete events a relay already received and chose to retain. So "what if a PIN leaks later?" reduces to "what does a known PIN unlock among retained events?" — and with the PAKE the answer is now **nothing at all**:

- **There is no offline crack.** The SPAKE2 elements are password-blinded and the sealed payloads are keyed by a transcript that includes the fresh ephemeral shared point, so retained relay events cannot even *verify* a PIN guess, let alone be decrypted by a known PIN. The old protocol's residual exposure — a PIN-encrypted rendezvous record recoverable by grinding PBKDF2 — no longer exists, because the rendezvous carries no ciphertext and no metadata.
- **File content is never recoverable from a PIN — before or after expiry.** Content and signaling keys are HKDF derivations off the SPAKE2 root, which requires the ephemeral scalars both devices generated and discarded; the PIN alone reconstructs nothing. File bytes travel over WebRTC/DTLS without ever touching a relay.
- **What retained events reveal to *anyone*, PIN or not**: the plaintext rendezvous record — `transferId`, an ephemeral sender pubkey, a blinded group element, a nonce, and relay hints. No file name, size, or type; those traveled only inside the sealed confirm. WebRTC signaling (SDP/ICE, i.e. participant **IP addresses**) is encrypted with the session `signals` key and is not exposed.
- **A recovered PIN grants no access.** After the first verified claim the sender ignores all other claims, so a PIN learned minutes (or years) later can neither join, redirect, nor decrypt the transfer.
- **A PIN leaked *while live* still does not get the file.** This is the case rotation alone never covered — and the one case a PAKE cannot help with either, since the attacker genuinely knows the password. Someone who reads the PIN off the sender's screen can claim the transfer during its window. They then have to supply a confirmation code derived from a PAKE session secret they do not share, over a channel the sender chose. They cannot, and the sender sends nothing.

**Takeaway:** the "PAKE-derived keys + rotating single-transfer PIN + first-claim lockout + metadata after the handshake" design means a PIN leak recovers nothing from retained events, and even a live leak is stopped at the confirmation code.

## Availability Is a Non-Goal

**Confidentiality and authenticity are in scope. Availability is not.** This applies to the whole system, not just to the claim race — most concretely to the Nostr relays, which is where an attacker would aim first.

- **The relays are not ours.** Signaling rides on public Nostr relays this project neither operates, hosts, nor pays for. There is no server here to harden: no account, no rate limiter, no capacity to provision. An operator can rate-limit us, drop our events, or disappear tomorrow, entirely independent of anything an attacker does. Treating relay availability as a security property this app can uphold would be claiming a guarantee the architecture never had.
- **Attacking the relays only blocks the transfer.** A relay that is flooded, censored, or taken offline stops the rendezvous from being found. That is the whole blast radius. It does not reach the participants' devices, does not expose file content (which never touches a relay and rides WebRTC/DTLS under ECDH-derived keys), and does not weaken the PIN or the confirmation code. The failure mode is *no transfer*, never *wrong transfer* — and this is why nothing in the client is designed to fight for relay access.
- **Users always have another path.** Manual Exchange (QR / clipboard offer-answer) reaches the same receiver without touching Nostr at all, and the relay list itself is configurable. A blocked rendezvous costs a retry or a switch of method, not the file.
- **Delivery is already unreliable by construction.** P2P setup is STUN-only with no TURN fallback, so transfers fail routinely for mundane reasons — symmetric NATs, restrictive firewalls, a peer that closes the tab. Users must be able to retry regardless, so a deliberate stall lands on a path the product already has to handle.

The practical consequence is that the client does not attempt anti-DoS measures — no claim-race hardening, no relay reputation, no retry-storm logic — and that this is a decision rather than an omission.

## Security Considerations

1. **Ephemeral Keys**: New Nostr keypair and fresh SPAKE2 ephemeral scalars generated for each transfer (and each rotation); the PAKE gives per-transfer session keys that no long-lived secret — the PIN included — can later reconstruct (a recovered PIN never decrypts content, or anything else retained on relays)
2. **PIN Role — Locate and Authenticate Only**: The Nostr PIN's public locator segment derives the rendezvous lookup hint; the rest of it is the SPAKE2 password. It derives **no** keys on its own — every key is an HKDF derivation off the PAKE root, which requires the discarded ephemeral scalars. It also does not decide *who* receives the file — that is the confirmation code.
3. **No Server Trust for File Content**: Relays see routing tags, a blinded group element, and session-sealed handshake ciphertext; file plaintext (and even file *metadata*) never leaves the device unprotected and content is transferred directly peer-to-peer
4. **PIN Entropy and Windows**: about 46.3 effective bits (8 secret characters from the 55-character alphabet; the 3-character locator is public by construction and the check digit is deterministic). That is deliberately small, because the only guessing channel is online: the PAKE leaves nothing to grind offline, the sender verifies at most `CLAIM_VERIFY_LIMIT` claims per 2-minute generation with no failure feedback, first-claim lockout makes any later recovery worthless, and the confirmation code makes a *live* leak worthless too.
5. **Relay MITM Resistance**: Neither SPAKE2 element can be substituted without the PIN — an attacker cannot unblind or re-blind an element, so any tampering lands the two sides on different roots and every seal fails. The SPAKE2 transcript additionally keys each session to both Nostr identities and the transfer id, and the sealed payloads echo a hash of the full rendezvous record and (in the code KDF) the file metadata — see *Transcript Binding*. The confirmation code is an independent human-level check on the same properties.
6. **Denial-of-Service Posture**: Invalid claims are ignored rather than fatal — transfer tags are public, so failing hard on a bad claim would let any observer kill transfers. The cost is that the attacker gets online guesses, which is why they are metered (`CLAIM_VERIFY_LIMIT`) rather than unlimited; exhausting the budget stalls a generation, which is a nuisance, not a compromise. Note the deliberate scope limit: an attacker who repeatedly wins the first-claim race can stall a transfer. Preventing data theft is in scope; preventing nuisance is not. The same holds for the relays themselves — they are third-party infrastructure, and knocking them over blocks transfers without reaching the participants' devices or their data. See *Availability Is a Non-Goal*.
7. **Transport Security**: All P2P transfers (Nostr, Manual Exchange) use both AES-256-GCM encryption (128KB chunks) and WebRTC DTLS
8. **Manual Authentication Caveat**: Manual ECDH is unauthenticated by itself. An attacker who can substitute the QR/clipboard offer or answer can mount a man-in-the-middle attack. Use a direct visual/local exchange path when active tampering matters.
9. **Shared Chunk Security**: P2P file chunks use the same AES-GCM chunk framing in both modes, including authenticated chunk indices
10. **XSS Protection**: Sensitive cryptographic material (session roots, key derivation outputs) is held as non-extractable CryptoKeys or in closure scope, never on the global `window` object; the entered PIN is reduced to its PAKE scalar and wiped as soon as it validates, and the scalar itself is wiped once the handshake no longer needs it. The SPAKE2 group math necessarily runs in JavaScript memory (@noble/curves) — an accepted trade for secrets that are transfer-scoped and dead within minutes
11. **Front-Running Resistance**: The first valid claim still wins the lock, but winning it yields nothing but the metadata a PIN-knower could always see. The sender withholds every WebRTC signal and all file bytes until a human supplies the receiver's PAKE-derived confirmation code, so observing the PIN — the one attack neither rotation nor the PAKE can address, because the PIN is meant to be read aloud — does not get the file
12. **Resource Cleanup**: All error paths properly clean up timeouts, intervals, and subscriptions to prevent resource leaks
13. **Input Validation**: Cryptographic functions and receive paths validate sizes/counts before expensive operations where possible

## Crypto Parameters

Key tunables like `CLAIM_VERIFY_LIMIT` and `ENCRYPTION_CHUNK_SIZE` live in [src/lib/crypto/constants.ts](../src/lib/crypto/constants.ts) for quick lookup.
