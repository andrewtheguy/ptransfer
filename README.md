# Secure Send

A web application for sending encrypted files and folders with PIN-based Nostr signaling. Uses WebRTC for direct P2P connections.

**Demo:** [https://securesend.kuvi.dev/](https://securesend.kuvi.dev/)

## Features

- **100% Static - No Backend Required**: The entire app is a static site that can be hosted on any static hosting service (GitHub Pages, Netlify, Vercel, S3, etc.). No server-side code, no database, no backend infrastructure needed.
- **Works offline**: No internet required after page load when using Manual Exchange on same local network
- **Flexible signaling**: Nostr (default) or Manual Exchange (QR/copy-paste). With internet, Manual Exchange can connect across different networks when ICE finds a direct route; without internet, it can connect over the same local network.
- **Rotating PIN pairing (Nostr)**: A case-sensitive 12-character PIN that rotates every 5 minutes locates the sender and authenticates an ephemeral ECDH key exchange; content keys are never derived from the PIN
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

During `v0.0.x` (as shown in the app footer), compatibility between different app versions is not guaranteed.
Sender and receiver should use the same app version for transfers.

## How It Works

### Sending Files or Folders

1. Select the "Files" or "Folder" tab
2. Drag and drop files or click to select a file/folder. A single file, or the combined input for multiple files or a folder (zipped while sending), can be up to 2GB
3. Choose Auto Exchange mode or Manual Exchange mode
4. For Auto Exchange, click "Start Auto Exchange" and share the displayed 12-character PIN with the receiver. The PIN rotates every 5 minutes; a countdown under the PIN shows when the next one appears, and "New PIN now" replaces it immediately (older PINs stop working)
5. For Manual Exchange, click "Start Manual Exchange" and exchange the QR/copy-paste signaling payloads with the receiver

### Receiving

1. Choose the transfer mode that matches the sender
2. For Auto Exchange mode, enter the PIN currently shown on the sender's screen and click "Receive"
3. For Manual Exchange mode, click "Start Receive", then scan or paste the sender's signaling payload
4. Click "Download File" to save

## Security

- **PBKDF2-SHA256** with 600,000 iterations to stretch the PIN into its root key (browser-compatible)
- **AES-256-GCM** authenticated encryption
- **ECDH content keys (Nostr)**: File content and WebRTC signaling are encrypted with AES keys derived from an ephemeral P-256 ECDH exchange — the PIN derives no content keys, so a PIN recovered after the fact decrypts nothing
- **PIN authenticates, then expires (Nostr)**: The sender mints a fresh 12-character PIN (~67 bits) every 5 minutes and honors only PINs published in its current or immediately previous 5-minute bucket. The PIN locates the rendezvous event (via a one-way rotating hint tag) and seals a mutual claim/confirm challenge-response that binds both sides' ECDH public keys, defeating relay man-in-the-middle. The first verified claim locks the transfer to that receiver; the PIN itself is never transmitted
- **Encrypted rendezvous metadata (Nostr)**: File name, size, and MIME type in the rendezvous payload are encrypted with a PIN-derived key; a local-only "PIN fingerprint" is shown for humans to confirm both sides entered the same PIN
- **Ephemeral identities**: New Nostr keypairs and ECDH key pairs generated per transfer
- **Expiration windows**: Each PIN is honored until the end of the immediately following 5-minute bucket (roughly 5–10 minutes, depending on when it was minted); rendezvous events carry a matching NIP-40 expiration tag for relays that honor it, and the sender stops waiting after 30 minutes (a resource backstop — bucket expiry, not the wait window, bounds PIN exposure)
- **Manual exchange signaling**: QR payloads are time-bucketed obfuscated, not cryptographically confidential; file data is encrypted with an ECDH-derived AES key after the QR/clipboard exchange

## Tech Stack

- React 19 + TypeScript
- Vite
- Tailwind CSS + shadcn/ui
- nostr-tools for Nostr protocol
- Web Crypto API for cryptographic operations

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
- [Roadmap](./docs/ROADMAP.md) - Completed and planned features

## License

[MIT](./LICENSE)
