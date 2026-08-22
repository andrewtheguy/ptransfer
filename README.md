# pTransfer

pTransfer is a web application for sending encrypted files and folders with PIN-based Nostr signaling. It uses WebRTC for direct P2P connections.

**Demo:** [Launch pTransfer](https://ptransfer.kuvi.dev/)

## Features

- **100% Static - No Backend Required**: The entire app is a static site that can be hosted on any static hosting service (GitHub Pages, Netlify, Vercel, S3, etc.). No server-side code, no database, no backend infrastructure needed.
- **Works offline**: No internet required after page load when using Manual Exchange on same local network
- **Flexible signaling**: Nostr (default) or Manual Exchange (QR/copy-paste). With internet, Manual Exchange can connect across different networks when ICE finds a direct route; without internet, it can connect over the same local network.
- **Rotating PIN pairing (Nostr)**: A case-sensitive 12-character PIN (letters and digits only) that rotates every 2 minutes locates the sender and drives a SPAKE2 password-authenticated key exchange; nothing published to relays can be used to guess the PIN offline
- **Confirmation code (Nostr)**: After entering the PIN, the receiver is shown an 8-character code the sender must type in before anything is sent — so someone who spots the PIN over your shoulder cannot quietly take the file
- **File or folder transfer**: Send a file, or a ZIP archive created from multiple files/a folder. The 2GB limit applies to the final transferred payload — the generated ZIP for folders or multi-file selections, not the combined input size — so an archive that exceeds 2GB is not supported and the send fails. The sender reads selected files lazily and streams generated ZIP bytes directly into the encrypted WebRTC transfer without scratch storage; receivers keep payloads up to 100MB in memory and spill larger payloads to OPFS. See [Browser Requirements](#browser-requirements)
- **End-to-end encryption**: All transfers use AES-256-GCM encryption
- **No accounts required**: Ephemeral keypairs generated per transfer
- **PWA Support**: Install as a Progressive Web App for offline access

## Browser Requirements

Receiving a payload over 100MB uses the origin-private file system (OPFS). Senders never need OPFS: direct files are read lazily from the picker, and multi-file/folder ZIP output is packaged and sent on the fly. OPFS requires:

- **A secure context**: the app must be served over HTTPS (or `localhost`) — OPFS and the Web Crypto API are unavailable otherwise
- **`FileSystemFileHandle.createWritable`**: available in Chromium browsers since 86, Firefox since 111 (desktop and Android), Samsung Internet since 21, and Safari/iOS since 26 — see the [support matrix](https://caniuse.com/mdn-api_filesystemfilehandle_createwritable). Note this is a stricter requirement than the general OPFS feature (Baseline since March 2023): Safari had OPFS from 16.4 but only gained `createWritable`, the part this app needs, in 26

Support is feature-detected at runtime; on an unsupported browser, receiving a payload that crosses 100MB fails with a clear error rather than degrading. Payloads of 100MB or less are buffered in memory and do not need OPFS (a secure context is still required for the Web Crypto API).

## Version Compatibility

Compatibility between different app versions is not guaranteed. Sender and receiver should use
the same app version for transfers. `v0.0.22` renamed the project and all name-bearing protocol
identifiers to pTransfer and is incompatible with earlier releases.

## How It Works

### Sending Files or Folders

1. Select the "Files" or "Folder" tab
2. Drag and drop files or click to select a file/folder. A single file, or the combined input for multiple files or a folder (zipped while sending), can be up to 2GB
3. Choose Auto Exchange mode or Manual Exchange mode
4. For Auto Exchange, click "Start Auto Exchange" and share the displayed 12-character PIN with the receiver. The PIN rotates automatically every 2 minutes while keeping the immediately previous PIN bucket valid; a countdown under the PIN shows when the next one appears. Selecting "Generate a new PIN" replaces it immediately and invalidates all retained older PIN generations.
5. Once someone claims the transfer, ask them for the confirmation code on their screen and enter it. Nothing is sent until it matches, so a stranger who saw the PIN cannot receive the file.
6. For Manual Exchange, click "Start Manual Exchange" and exchange the QR/copy-paste signaling payloads with the receiver

### Receiving

1. Choose the transfer mode that matches the sender
2. For Auto Exchange mode, enter the PIN currently shown on the sender's screen and click "Receive", then read the confirmation code that appears back to the sender
3. For Manual Exchange mode, click "Start Receive", then scan or paste the sender's signaling payload
4. Click "Download File" to save

## Security

- **SPAKE2 password-authenticated key exchange (Nostr)**: The PIN drives a balanced PAKE (RFC 9382 over P-256), so every published value — the blinded key-exchange elements and the sealed handshake payloads — is useless for testing PIN guesses offline. The only way to test a guess is a live claim the sender verifies online, and the sender caps those verifications per PIN generation
- **AES-256-GCM** authenticated encryption
- **PAKE-derived content keys (Nostr)**: File content and WebRTC signaling are encrypted with AES keys derived from the SPAKE2 shared secret, which mixes fresh ephemeral keys from both devices — so a PIN recovered after the fact decrypts nothing
- **PIN authenticates, then expires (Nostr)**: The sender mints a fresh 12-character PIN every 2 minutes and honors only PINs published in its current or immediately previous 2-minute bucket. The mutual claim/confirm handshake is sealed with keys only a matching PAKE session holds, defeating relay man-in-the-middle. The first verified claim locks the transfer to that receiver; the PIN itself is never transmitted
- **Split PIN, public locator (Nostr)**: Only the first 3 characters — treated as public — derive the rotating `#h` tag that locates the rendezvous event, so no published value is a commitment to the rest of the PIN. That leaves the 8 secret characters (~46.3 bits) exposed only to online guessing, throttled by the sender against a PIN that is live for 2–4 minutes and worthless once a claim locks
- **Confirmation code stops front-running (Nostr)**: The receiver derives an 8-character code from the SPAKE2 shared secret and shows it once the sender's confirm verifies. The sender publishes no WebRTC signaling and sends no file bytes until its operator types a matching code. The code proves agreement with whichever claimant won the first-claim lock — and anyone who saw the PIN can win that race and compute the code — so the protection comes from where the sender learns it: the intended receiver, over a channel the attacker does not control (in person, a call). If a front-runner holds the lock, the intended receiver got no confirm, has no code to give, and the transfer stalls without sending anything. It doubles as a key-confirmation check, since tampered key-exchange elements would show different codes on the two screens
- **The handshake is bound to what is being sent (Nostr)**: The PAKE transcript keys every session to both parties' Nostr identities and the transfer id, the sealed claim/confirm echo a hash of the whole rendezvous record, and the file metadata delivered in the confirm is hashed into the confirmation code. An attacker who knows a live PIN therefore cannot republish the transfer under its own identity with a rewritten file name or type and still have the two codes match
- **Metadata after the handshake (Nostr)**: File name, size, and MIME type are never published to relays in plaintext — they travel inside the sealed confirm, encrypted under a key only the authenticated peer holds, so relays carry only ciphertext they cannot decrypt
- **Ephemeral identities**: New Nostr keypairs and PAKE scalars generated per transfer
- **Expiration windows**: Each PIN is honored until the end of the immediately following 2-minute bucket (roughly 2–4 minutes, depending on when it was minted); rendezvous events carry a matching NIP-40 expiration tag for relays that honor it, and the sender stops waiting after 30 minutes (a resource backstop — bucket expiry, not the wait window, bounds PIN exposure)
- **Manual exchange signaling**: QR payloads are time-bucketed obfuscated, not cryptographically confidential; file data is encrypted with an ECDH-derived AES key after the QR/clipboard exchange

## Tech Stack

- React 19 + TypeScript
- Vite
- Tailwind CSS + shadcn/ui
- nostr-tools for Nostr protocol
- Web Crypto API for cryptographic operations, plus @noble/curves for the SPAKE2 group math Web Crypto cannot express

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

### Routing (Required)

The app uses `BrowserRouter` only. Configure hosting to rewrite unknown paths to `index.html`.

### Deployment Path Requirement (Multi-QR Manual Mode)

Multi-QR URLs are generated from `window.location.origin` and then append `/r#...`.

- Supported: deployment at the domain root (for example `https://example.com`)
- Not supported: deployment under a subpath (for example `https://example.com/my-app`)

If the app is served from a subpath, scanned Multi-QR links will point to the domain root route and can 404.

## Transport Layer

All signaling methods share the same **data-channel transfer protocol**: P2P transfers encrypt content in 128KB AES-256-GCM chunks before transmission, with the chunk index authenticated as AES-GCM additional data. The sender then sends `DONE:<chunkCount>:<byteCount>`, and the receiver replies with `ACK` on the WebRTC data channel only after every chunk has authenticated and reassembled to that final length. Integrity is enforced per chunk by AES-GCM authentication — there is no separate whole-file checksum, so nothing needs to re-read the assembled file to verify it.

**Signaling Methods** (sender chooses):
- **Nostr** (default): Requires internet. Decentralized relay signaling. Devices can be on different networks.
- **Manual Exchange**: No internet required. Exchange signaling via QR scan or copy/paste (camera optional). With internet, STUN assists direct candidate discovery and the devices can connect across different networks when a direct ICE route exists. Without internet, devices must be able to reach each other directly, normally on the same local network.

**Data Transfer**: WebRTC P2P only. STUN may help the peers discover a direct route, but TURN relaying is not supported. If a direct P2P connection cannot be established, the transfer does not complete — there is no automatic in-app fallback. When this happens, the UI suggests transferring offline via animated QR codes with [Secure QR Transfer](https://qrsecure.kuvi.dev/transfer), a separate tool for side-by-side devices.

See [Architecture](./docs/ARCHITECTURE.md) for detailed transfer flows and encryption specifics.

### Receive Modes

Receivers choose the matching receive mode:
- **Auto Exchange mode**: Nostr signaling with the rotating PIN shown on the sender's screen.
- **Manual Exchange mode**: Direct signaling exchange via QR scan or copy/paste (no relay).

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) - Technical architecture and design decisions
- [Manual Exchange](./docs/MANUAL_EXCHANGE.md) - User guide for the Manual Exchange mode
- [Nostr File Relay](./docs/NOSTR_FILE_RELAY.md) - Architecture of the experimental relay-file-through-Nostr methods (Stored and Live)
- [Roadmap](./docs/ROADMAP.md) - Completed and planned features

## License

[MIT](./LICENSE)
