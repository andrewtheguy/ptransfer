# pTransfer

pTransfer is a web application for sending encrypted files and folders with PIN-based Nostr signaling. It uses WebRTC for direct P2P connections.

**Demo:** [Launch pTransfer](https://ptransfer.kuvi.dev/)

## Features

- **100% Static - No Backend Required**: The entire app is a static site that can be hosted on any static hosting service (GitHub Pages, Netlify, Vercel, S3, etc.). No server-side code, no database, no backend infrastructure needed.
- **Works offline**: No internet required after page load when using Code Exchange on same local network
- **Flexible signaling**: Nostr (default) or Code Exchange — you hand over the offer (QR/copy-paste) and the receiver hands the response back the same way; the response only enters the sender's page when the sender scans or pastes it. With internet, Code Exchange can connect across different networks when ICE finds a direct route; without internet, it can connect over the same local network.
- **Rotating PIN pairing (Nostr)**: A case-sensitive 12-character PIN (letters and digits only) that rotates every 2 minutes locates the sender and drives a SPAKE2 password-authenticated key exchange; nothing published to relays can be used to guess the PIN offline
- **Confirmation code (Nostr)**: After entering the PIN, the receiver is shown an 8-character code the sender must type in before anything is sent — so someone who spots the PIN over your shoulder cannot quietly take the file
- **File or folder transfer**: Send a file, or a ZIP archive created from multiple files/a folder. Everything is compressed behind the scenes: a single file is deflated during the transfer and restored on receipt, while multi-file/folder ZIP output (whose entries are already deflated) is never recompressed. The 2 GiB limit is checked against the total size of the selected input files before compression — a selection over 2 GiB cannot be sent, even if it would compress smaller. On the direct P2P path, the sender reads selected files lazily without scratch storage and receivers keep payloads up to 100 MiB in memory before spilling to OPFS. The Code Exchange relay fallback instead materializes payloads in memory and is capped at 100 MiB. See [Browser Requirements](#browser-requirements)
- **End-to-end encryption**: All transfers use AES-256-GCM encryption
- **No accounts required**: Ephemeral keypairs generated per transfer
- **PWA Support**: Install as a Progressive Web App for offline access

## Browser Requirements

Receiving a P2P payload over 100 MiB uses the origin-private file system (OPFS). P2P senders never need OPFS: direct files are read lazily from the picker and deflated on the fly, and multi-file/folder ZIP output is compressed and sent on the fly. OPFS requires:

- **A secure context**: the app must be served over HTTPS (or `localhost`) — OPFS and the Web Crypto API are unavailable otherwise
- **`FileSystemFileHandle.createWritable`**: available in Chromium browsers since 86, Firefox since 111 (desktop and Android), Samsung Internet since 21, and Safari/iOS since 26 — see the [support matrix](https://caniuse.com/mdn-api_filesystemfilehandle_createwritable). Note this is a stricter requirement than the general OPFS feature (Baseline since March 2023): Safari had OPFS from 16.4 but only gained `createWritable`, the part this app needs, in 26

Support is feature-detected at runtime; on an unsupported browser, receiving a P2P payload that crosses 100 MiB fails with a clear error rather than degrading. P2P payloads of 100 MiB or less are buffered in memory and do not need OPFS (a secure context is still required for the Web Crypto API). The Nostr relay fallback never uses OPFS because its payload cap is 100 MiB.

## Version Compatibility

Compatibility between different app versions is not guaranteed. Sender and receiver should use
the same app version for transfers. `v0.0.22` renamed the project and all name-bearing protocol
identifiers to pTransfer and is incompatible with earlier releases.

## How It Works

### Sending Files or Folders

1. Select the "Files" or "Folder" tab
2. Drag and drop files or click to select a file/folder. A single file, or the combined input for multiple files or a folder (zipped while sending), can be up to 2 GiB
3. Choose PIN Exchange or Code Exchange
4. For PIN Exchange, click "Start PIN Exchange". The 12-character PIN appears alongside a QR code the receiver can scan to open the receive page with the PIN already filled in; reading the PIN out or copying it works just as well. The PIN rotates automatically every 2 minutes while keeping the immediately previous PIN bucket valid, and the QR follows each rotation; a countdown under the PIN shows when the next one appears. Selecting "Generate a new PIN" replaces it immediately and invalidates all retained older PIN generations.
5. Once someone claims the transfer, ask them for the confirmation code on their screen and enter it. Nothing is sent until it matches, so a stranger who saw the PIN cannot receive the file.
6. For Code Exchange, click "Start Code Exchange" and give the receiver the QR/copy-paste signaling payload, then scan or paste the response they show you.

### Receiving

There is one input for both modes — no mode to choose. The page works out which exchange the sender used from what you give it.

1. Scan the sender's QR code, or paste the PIN or code they sent you, and click "Receive". A PIN QR can also be scanned with the phone's own camera app, which opens this page with the PIN filled in
2. If it was a PIN, read the confirmation code that appears back to the sender — nothing is sent until it matches
3. If it was a connection code, show the sender the response code that appears, for them to scan or paste
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
- **Code Exchange signaling**: QR payloads are time-bucketed obfuscated, not cryptographically confidential; file data is encrypted with an ECDH-derived AES key after the QR/clipboard exchange

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

### Deployment Path Requirement (Multi-QR Code Exchange)

Multi-QR URLs are generated from `window.location.origin` and then append `/r#...`.

- Supported: deployment at the domain root (for example `https://example.com`)
- Not supported: deployment under a subpath (for example `https://example.com/my-app`)

If the app is served from a subpath, scanned Multi-QR links will point to the domain root route and can 404.

## Transport Layer

When WebRTC succeeds, all signaling methods share the same **data-channel transfer protocol**: P2P transfers encrypt content in 128 KiB AES-256-GCM chunks before transmission, with the chunk index authenticated as AES-GCM additional data. The sender then sends `DONE:<chunkCount>:<byteCount>`, and the receiver replies with `ACK` on the WebRTC data channel only after every chunk has authenticated and reassembled to that final length. The P2P protocol has no separate whole-file checksum. Code Exchange's Nostr fallback is different: it uses 48 KiB payload chunks, an encrypted manifest/control channel, and a whole-file SHA-256 check.

**Signaling Methods** (sender chooses):
- **Nostr** (default): Requires internet. Decentralized relay signaling. Devices can be on different networks.
- **Code Exchange**: No internet required. Both the sender's offer and the receiver's response are handed over via QR scan or copy/paste (camera optional); relays never carry signaling in this mode. With internet, STUN assists direct candidate discovery and the devices can connect across different networks when a direct ICE route exists. Without internet, devices must be able to reach each other directly, normally on the same local network.

**Data Transfer**: WebRTC P2P first. STUN may help the peers discover a direct route; TURN relaying is not configured. In **Code Exchange**, when a direct P2P connection cannot be established and the offer named relays, the encrypted file (up to 100 MiB) is relayed through public Nostr relays automatically — the Nostr relay stand-in for TURN. No file data is uploaded ahead of time: the relay path runs only once the direct connection has failed, so a transfer that connects directly never puts file bytes on a storage relay. What matters is only that the offer named proven relays. The fallback is unavailable when the offer named no relays or the file exceeds the 100 MiB cap, and it can still fail if too few storage relays work. In **PIN Exchange** a failed direct connection has no relay fallback and the transfer does not complete. When a transfer cannot complete, the UI suggests transferring offline via animated QR codes with [Secure QR Transfer](https://qrsecure.kuvi.dev/transfer), a separate tool for side-by-side devices. See [Nostr File Relay](./docs/NOSTR_FILE_RELAY.md) for the relay transport.

See [Architecture](./docs/ARCHITECTURE.md) for detailed transfer flows and encryption specifics.

### Receive Input

One input accepts both modes; the page works out which one the sender used from what it is given:
- **PIN Exchange**: the rotating PIN from the sender's screen — typed, pasted, or scanned from the PIN QR. Signaling then runs over Nostr, and a confirmation code appears for the receiver to read back.
- **Code Exchange**: the sender's signaling payload, scanned from their QR codes or pasted as copied text. The response code that appears goes back to the sender the same way; if direct WebRTC later fails, files up to 100 MiB can also use the automatic Nostr relay fallback.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) - Technical architecture and design decisions
- [Code Exchange](./docs/MANUAL_EXCHANGE.md) - User guide for the Code Exchange
- [Nostr File Relay](./docs/NOSTR_FILE_RELAY.md) - Architecture of the Nostr relay data-path fallback for Code Exchange
- [Roadmap](./docs/ROADMAP.md) - Completed and planned features

## License

[MIT](./LICENSE)
