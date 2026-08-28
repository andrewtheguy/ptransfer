# pTransfer

pTransfer is a web application for sending encrypted files and folders with PIN-based Nostr signaling. It uses WebRTC for direct P2P connections, or a Tor onion service published from the browser tab.

**Demo:** [Launch pTransfer](https://ptransfer.kuvi.dev/)

## Features

- **100% Static - No Backend Required**: The entire app is a static site that can be hosted on any static hosting service (GitHub Pages, Netlify, Vercel, S3, etc.). No server-side code, no database, no backend infrastructure needed.
- **Works offline**: No internet required after page load when using Code Exchange on same local network
- **Three transfer modes**: PIN Exchange (default), Code Exchange, or Tor Onion Service — see [Transport Layer](#transport-layer)
- **Tor Onion Service**: The sending tab publishes a v3 onion service of its own and mints a one-time password; the receiver needs only those two strings. No pTransfer or Nostr relay and no direct connection between the two networks; the path is Tor's own — a Snowflake bridge (which uses STUN only on the `webrtc` bridge), Tor relays, and the HSDirs carrying the descriptor. There is no pTransfer rendezvous record, though Tor's descriptor remains retrievable by anyone holding the onion address until it expires. Slower, capped at 100 MiB and best kept far smaller, and interoperable with [ptransfer-cli](https://github.com/andrewtheguy/ptransfer-cli)'s `tor` subcommands. See [Tor Transport](./docs/TOR_TRANSPORT.md)
- **Flexible signaling**: Nostr (default) or Code Exchange — you hand over the offer (QR/copy-paste) and the receiver hands the response back the same way; the response only enters the sender's page when the sender scans or pastes it. With internet, Code Exchange can connect across different networks when ICE finds a direct route; without internet, it can connect over the same local network.
- **Rotating PIN pairing (Nostr)**: A case-sensitive 12-character PIN (letters and digits only) that rotates every 2 minutes locates the sender and drives a SPAKE2 password-authenticated key exchange; nothing published to relays can be used to guess the PIN offline
- **Anonymous signaling (PIN Exchange, experimental)**: An advanced option on the send tab that carries the handshake through Tor, inside the browser, to Nostr relays run as onion services — so no Nostr relay sees either device's IP address. The PIN comes out 16 characters instead of 12, and that length is the whole signal: the receiver's page recognizes it and follows, with nothing to turn on and nothing to agree in advance. It starts slowly and fails more often, and it does not cover the file transfer itself, which is still a direct WebRTC connection. Specified separately from `INTEROP_PROTOCOL.md`, but interoperable with [ptransfer-cli](https://github.com/andrewtheguy/ptransfer-cli). See [Anonymous Signaling](./docs/ANONYMOUS_SIGNALING.md)
- **Anonymous signaling and relay (Code Exchange, experimental)**: A separate advanced option keeps Code Exchange's fallback off the clearnet. The offer and answer are still carried by hand and direct WebRTC is still tried first, but both pages prepare Tor in the background; if the direct route fails, onion-service Nostr relays carry the encrypted control channel and a temporary onion service published by the sender carries the file. Both devices need internet, the fallback remains capped at 100 MiB, and this web-only option is slower and less reliable than the ordinary public-relay fallback. See [Code Exchange](./docs/CODE_EXCHANGE.md#anonymous-signaling-and-relay-experimental)
- **Confirmation code (Nostr)**: After entering the PIN, the receiver is shown an 8-character code the sender must type in before anything is sent — so someone who spots the PIN over your shoulder cannot quietly take the file
- **File or folder transfer**: Send a file, or a ZIP archive created from multiple files/a folder. Everything is compressed behind the scenes: a single file is deflated during the transfer and restored on receipt, while multi-file/folder ZIP output (whose entries are already deflated) is never recompressed. The 2 GiB limit applies both to the selected input and to the encoded wire payload: a selection over 2 GiB is refused up front, while one very close to the limit can still fail during transfer if incompressible deflate output or ZIP headers push the wire payload over it. On the direct P2P path, the sender reads selected files lazily without scratch storage and receivers keep payloads up to 100 MiB in memory before spilling to OPFS. The ordinary Nostr fallback instead materializes payloads in memory. File-relay fallbacks and the Tor file transport are capped at 100 MiB. See [Browser Requirements](#browser-requirements)
- **End-to-end encryption**: All transfers use AES-256-GCM encryption
- **No accounts required**: Ephemeral keypairs generated per transfer
- **PWA Support**: Install as a Progressive Web App for offline access

## Companion CLI

[ptransfer-cli](https://github.com/andrewtheguy/ptransfer-cli) is the command-line
companion: one native executable with no language runtime or package manager, and a full-screen TUI wizard
when run with no arguments. It exists for the places a browser tab does not reach — a
headless server, an SSH session, a machine where you would rather stay in the terminal.

It is not a separate protocol. Either end of a transfer may be a browser tab or the CLI:

| Mode | Web | CLI | Notes |
| --- | --- | --- | --- |
| PIN Exchange | yes | yes | The interoperable default, governed by [docs/INTEROP_PROTOCOL.md](./docs/INTEROP_PROTOCOL.md) |
| Anonymous signaling | yes | yes | PIN Exchange option, not a mode; specified in [docs/ANONYMOUS_SIGNALING.md](./docs/ANONYMOUS_SIGNALING.md) |
| Tor Onion Service | yes | yes | `ptransfer tor send` / `ptransfer tor receive`; specified in [docs/TOR_TRANSPORT.md](./docs/TOR_TRANSPORT.md) |
| Code Exchange | yes | no | Web-only: it is built on QR scanning and clipboard handoff, which the CLI deliberately does not do |
| Nostr relay fallback | yes | no | Web-only, and part of Code Exchange |
| Code Exchange Tor fallback | yes | no | Web-only experimental option, and part of Code Exchange |

Install it with the one-liners that repo publishes:

```bash
# Linux and macOS
curl -sSL https://andrewtheguy.github.io/ptransfer-cli/install.sh | bash
```

```powershell
# Windows
irm https://andrewtheguy.github.io/ptransfer-cli/install.ps1 | iex
```

This repo is the source of truth for everything the two share: PIN Exchange, anonymous
signaling, and the Tor onion transport are specified in `docs/` here, and the CLI
implements against those documents rather than restating them — each one carries a
*Changing this document* section naming exactly what binds another implementation and what
is only rationale. The CLI's own repo documents its internals and nothing else.

Two implementations interoperate when they declare the same **interop protocol version**
(see [Version Compatibility](#version-compatibility) below), whatever their app versions.
Both live interoperability tests run in this repo against a local `ptransfer-cli` build:
`bun run test:live:webrtc` covers PIN Exchange over the public relays and a real data
channel, in both directions and CLI to CLI, and `bun run test:live:tor` covers both
directions of the Tor onion mode; see [docs/TOR_BROWSER.md](./docs/TOR_BROWSER.md).

## Browser Requirements

Receiving a P2P payload over 100 MiB uses the origin-private file system (OPFS). P2P senders never need OPFS: direct files are read lazily from the picker and deflated on the fly, and multi-file/folder ZIP output is compressed and sent on the fly. OPFS requires:

- **A secure context**: the app must be served over HTTPS (or `localhost`) — OPFS and the Web Crypto API are unavailable otherwise
- **`FileSystemFileHandle.createWritable`**: available in Chromium browsers since 86, Firefox since 111 (desktop and Android), Samsung Internet since 21, and Safari/iOS since 26 — see the [support matrix](https://caniuse.com/mdn-api_filesystemfilehandle_createwritable). Note this is a stricter requirement than the general OPFS feature (Baseline since March 2023): Safari had OPFS from 16.4 but only gained `createWritable`, the part this app needs, in 26

Support is feature-detected at runtime; on an unsupported browser, receiving a P2P payload that crosses 100 MiB fails with a clear error rather than degrading. P2P payloads of 100 MiB or less are buffered in memory and do not need OPFS (a secure context is still required for the Web Crypto API). The Nostr and Tor fallback paths never use OPFS because their payload cap is 100 MiB.

## Version Compatibility

Compatibility between different app versions is not guaranteed. Sender and receiver should use
the same app version for transfers.

Transfers with a **non-web implementation** — today [ptransfer-cli](https://github.com/andrewtheguy/ptransfer-cli) —
are governed by a separate, deliberately narrower contract: the **interop protocol version**, declared in
[`src/lib/protocol.ts`](./src/lib/protocol.ts) and specified in [docs/INTEROP_PROTOCOL.md](./docs/INTEROP_PROTOCOL.md).
It covers PIN Exchange and the shared WebRTC data-channel transfer layer only, and moves only when one of those
changes — Code Exchange and the Nostr relay fallback are web-only and stay outside it while they are still
taking shape. Two implementations interoperate when they declare the same interop protocol version, whatever
their app versions.

## How It Works

### Sending Files or Folders

1. Select the "Files" or "Folder" tab
2. Drag and drop files or click to select a file/folder. A single file, or the combined input for multiple files or a folder (zipped while sending), can be up to 2 GiB. The encoded wire payload must also fit within 2 GiB, so a selection extremely close to the limit may fail if compression or ZIP bookkeeping makes it grow
3. Choose PIN Exchange, Code Exchange, or Tor Onion Service
4. For PIN Exchange, click "Start PIN Exchange". The 12-character PIN appears alongside a QR code the receiver can scan to open the receive page with the PIN already filled in; reading the PIN out or copying it works just as well. The PIN rotates automatically every 2 minutes while keeping the immediately previous PIN bucket valid, and the QR follows each rotation; a countdown under the PIN shows when the next one appears. Selecting "Generate a new PIN" replaces it immediately and invalidates all retained older PIN generations.
5. Optionally, open "Advanced options" before starting and turn on **Anonymous signaling**, then pick which Snowflake bridge this tab reaches Tor through. The PIN becomes 16 characters and the handshake runs through Tor to onion-service relays; the recipient's page detects that from the PIN alone. Expect a slow start and more failures, and note that the file itself still travels over a direct connection.
6. Once someone claims the transfer, ask them for the confirmation code on their screen and enter it. Nothing is sent until it matches, so a stranger who saw the PIN cannot receive the file.
7. For Code Exchange, click "Start Code Exchange" and give the receiver the QR/copy-paste signaling payload, then scan or paste the response they show you. Its ordinary fallback uses public Nostr relays; the experimental **Anonymous signaling and relay** advanced option prepares an onion-only fallback instead and requires both devices to have internet.
8. For Tor Onion Service, pick which Snowflake bridge the tab reaches Tor through and click "Publish Onion Service". Bootstrapping Tor and publishing the descriptor takes a while — minutes on a first run — after which the page shows an `.onion` address and a one-time password. Send the receiver both; the service answers only while the tab is open. A selection over 100 MiB cannot be sent this way, and anything over 1 MiB is flagged as slow rather than refused.

### Receiving

There is one input for all three modes — no mode to choose. The page works out which exchange the sender used from what you give it.

1. Scan the sender's QR code, or paste the PIN, onion address, or code they sent you, and click "Receive". A PIN QR can also be scanned with the phone's own camera app, which opens this page with the PIN filled in
2. If that PIN was 16 characters, the sender turned on anonymous signaling: the page says so, asks which Snowflake bridge to reach Tor through, and then takes a while to start. Nothing else about the steps below changes
3. If it was a PIN, read the confirmation code that appears back to the sender — nothing is sent until it matches
4. If it was a connection code, show the sender the response code that appears, for them to scan or paste
5. If it was an onion address, enter the one-time password the sender gave you and choose a bridge, then click "Connect over Tor"
6. Click "Download File" to save

## Security

- **SPAKE2 password-authenticated key exchange (Nostr)**: The PIN drives a balanced PAKE (RFC 9382 over P-256), so every published value — the blinded key-exchange elements and the sealed handshake payloads — is useless for testing PIN guesses offline. The only way to test a guess is a live claim the sender verifies online, and the sender caps those verifications per PIN generation
- **AES-256-GCM** authenticated encryption
- **PAKE-derived content keys (Nostr)**: File content and WebRTC signaling are encrypted with AES keys derived from the SPAKE2 shared secret, which mixes fresh ephemeral keys from both devices — so a PIN recovered after the fact decrypts nothing
- **PIN authenticates, then expires (Nostr)**: The sender mints a fresh 12-character PIN every 2 minutes (16 with anonymous signaling on, of which 12 are secret rather than 8) and honors only PINs published in its current or immediately previous 2-minute bucket. The mutual claim/confirm handshake is sealed with keys only a matching PAKE session holds, defeating relay man-in-the-middle. The first verified claim locks the transfer to that receiver; the PIN itself is never transmitted
- **Split PIN, public locator (Nostr)**: Only the first 3 characters — treated as public — derive the rotating `#h` tag that locates the rendezvous event, so no published value is a commitment to the rest of the PIN. A standard PIN therefore has 8 secret data characters (~46.3 bits), while an anonymous-signaling PIN has 12; either can be tested only by online guesses throttled by the sender against a PIN that is live for 2–4 minutes and worthless once a claim locks
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

Requires [Bun](https://bun.com/) 1.4.0.

```bash
# Install dependencies
bun install

# Start development server
bun run dev

# Build for production
bun run build
```

### Cloudflare Pages

Use `bun install --frozen-lockfile && bun run build` as the build command and
`dist` as the output directory.

### Routing (Required)

The app uses `BrowserRouter` only. Configure hosting to rewrite unknown paths to `index.html`.

### Deployment Path Requirement (Multi-QR Code Exchange)

Multi-QR URLs are generated from `window.location.origin` and then append `/r#...`.

- Supported: deployment at the domain root (for example `https://example.com`)
- Not supported: deployment under a subpath (for example `https://example.com/my-app`)

If the app is served from a subpath, scanned Multi-QR links will point to the domain root route and can 404.

## Transport Layer

When WebRTC succeeds, both WebRTC modes share the same **data-channel transfer protocol**: P2P transfers encrypt content in 128 KiB AES-256-GCM chunks before transmission, with the chunk index authenticated as AES-GCM additional data. The sender then sends `DONE:<chunkCount>:<byteCount>`, and the receiver replies with `ACK` on the WebRTC data channel only after every chunk has authenticated and reassembled to that final length. The P2P protocol has no separate whole-file checksum. Code Exchange's ordinary Nostr fallback is different: it uses 48 KiB payload chunks, an encrypted manifest/control channel, and a whole-file SHA-256 check. The Tor Onion Service mode and Code Exchange's anonymous fallback use the 128 KiB chunk and `DONE`/`ACK` protocol over a Tor framed stream rather than a WebRTC data channel.

**Transfer modes** (sender chooses):
- **PIN Exchange** (default): Requires internet. Decentralized Nostr relay signaling. Devices can be on different networks. An experimental advanced option, **anonymous signaling**, carries that signaling through Tor to onion-service relays instead, so no Nostr relay sees either device's IP address; the sender turns it on, the longer PIN it mints tells the receiving side to follow, and the file transfer itself is unchanged. Specified separately from `INTEROP_PROTOCOL.md` but interoperable with ptransfer-cli — either side may be a browser tab or the CLI. See [Anonymous Signaling](./docs/ANONYMOUS_SIGNALING.md).
- **Tor Onion Service**: Requires internet. The sending tab publishes a v3 onion service and mints a one-time password; the two peers meet at a rendezvous point inside the Tor network, so neither learns the other's address. No pTransfer or Nostr relay is involved and the two networks never connect directly, but the transfer does travel through a Snowflake bridge (STUN-assisted on the `webrtc` bridge), Tor relays, and HSDirs. The same SPAKE2 exchange used by PIN mode authenticates the password, and the file is encrypted again inside the circuit. Slower than the other two and capped at 100 MiB per transfer, with no resume — the page flags anything over 1 MiB as slow without refusing it. Governed by its own interoperability contract and handshake version rather than `INTEROP_PROTOCOL_VERSION`; either side may be a browser tab or ptransfer-cli. See [Tor Transport](./docs/TOR_TRANSPORT.md).
- **Code Exchange**: No internet required for the ordinary mode. Both the sender's offer and the receiver's response are handed over via QR scan or copy/paste (camera optional); relays never carry signaling in this mode. With internet, STUN assists direct candidate discovery and the devices can connect across different networks when a direct ICE route exists. Without internet, devices must be able to reach each other directly, normally on the same local network. Its experimental **Anonymous signaling and relay** option does require internet on both devices because it prepares Tor for the fallback.

**Data Transfer**: WebRTC P2P first. STUN may help the peers discover a direct route; TURN relaying is not configured. In ordinary **Code Exchange**, when a direct P2P connection cannot be established and the offer named relays, the encrypted file (up to 100 MiB) is relayed through public Nostr relays automatically — the Nostr relay stand-in for TURN. No file data is uploaded ahead of time: the relay path runs only once the direct connection has failed, so a transfer that connects directly never puts file bytes on a storage relay. The fallback is unavailable when the offer named no relays or the file exceeds the 100 MiB cap, and it can still fail if too few storage relays work. With **Anonymous signaling and relay** selected, the same failure instead uses onion-service Nostr relays for coordination and a temporary Tor onion service for the file; that path has the same cap and remains best-effort. In **PIN Exchange** a failed direct connection has no relay fallback and the transfer does not complete. When a transfer cannot complete, the UI suggests transferring offline via animated QR codes with [Secure QR Transfer](https://qrsecure.kuvi.dev/transfer), a separate tool for side-by-side devices. See [Nostr File Relay](./docs/NOSTR_FILE_RELAY.md) for the ordinary relay transport and [Code Exchange](./docs/CODE_EXCHANGE.md#anonymous-signaling-and-relay-experimental) for the Tor-backed variant.

See [Architecture](./docs/ARCHITECTURE.md) for detailed transfer flows and encryption specifics.

### Receive Input

One input accepts all three modes; the page works out which one the sender used from what it is given:
- **PIN Exchange**: the rotating PIN from the sender's screen — typed, pasted, or scanned from the PIN QR. Signaling then runs over Nostr, and a confirmation code appears for the receiver to read back.
- **Tor Onion Service**: the `.onion` address from the sender's screen, pasted or scanned. Its checksum is verified locally, and a password field then appears for the one-time password the sender gave you separately — nothing is bootstrapped until both check out.
- **Code Exchange**: the sender's signaling payload, scanned from their QR codes or pasted as copied text. The response code that appears goes back to the sender the same way, carrying a tag derived from the shared key, the exact code it answers, and the response's own contents — the sender checks it automatically and refuses a response belonging to another transfer or altered on the way back, with nothing for either person to read out or type. If direct WebRTC later fails, files up to 100 MiB can also use the selected automatic fallback: public Nostr storage relays ordinarily, or Tor when the sender enabled the experimental anonymous option.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) - Technical architecture and design decisions
- [Interop Protocol](./docs/INTEROP_PROTOCOL.md) - Normative wire contract for non-web implementations (PIN Exchange + the shared data path)
- [Code Exchange](./docs/CODE_EXCHANGE.md) - User guide for Code Exchange
- [Tor Transport](./docs/TOR_TRANSPORT.md) - Normative spec for the onion service transfer mode, shared with ptransfer-cli
- [Tor in the Browser](./docs/TOR_BROWSER.md) - pTransfer's webtor-wasm adapter, directory-cache policy, and testing
- [Anonymous Signaling](./docs/ANONYMOUS_SIGNALING.md) - Normative spec for the experimental PIN Exchange option that carries signaling through Tor to onion-service relays, shared with ptransfer-cli
- [Nostr File Relay](./docs/NOSTR_FILE_RELAY.md) - Architecture of the Nostr relay data-path fallback for Code Exchange
- [Roadmap](./docs/ROADMAP.md) - Planned features and backlog
- [ptransfer-cli](https://github.com/andrewtheguy/ptransfer-cli) - The companion command-line app, and the other implementation of the specs above

## License

[MIT](./LICENSE)
