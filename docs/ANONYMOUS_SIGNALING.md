# Anonymous Signaling

An experimental PIN Exchange option. The sender turns it on; the receiving side
recognizes it and follows. Both devices then carry the PIN Exchange handshake to
Nostr relays run as onion services, through a Tor client, instead of over
clearnet WebSockets.

File data goes through Tor only when no direct connection can be made: the
Code Exchange session an anonymous PIN carries asks for that mode's Tor
fallback rather than its clearnet one. A direct connection is still WebRTC, so
the option does not make the transfer as a whole anonymous.

The browser tab and the CLI in `cli/` run it from the same code in `src/lib`,
so either side of a transfer may be a tab or a terminal, and this document is
the specification of what that code does on the wire. Three things here are
what the two sides have to agree on, and a peer that runs a different app
version can only fail closed on them:

- the two PIN lengths and their layouts — a length neither side mints is
  refused by the length-and-checksum test rather than guessed at;
- `ANONYMOUS_SIGNALING_RELAYS`: that pool, and nothing else, for an anonymous
  PIN — a pool that drifts apart costs connections rather than secrecy, since
  the two simply never meet on a relay;
- and the rule that a socket for one may be opened only to
  `ws://<v3 address>.onion`.

There is no version to move here, and none is needed; compare the Tor transfer
mode, whose frames do carry one. Everything else below — how Tor is reached,
the timeouts, the bridge question, the privacy discussion, where the code
lives — is host detail, and the option stays outside
[INTEROP_PROTOCOL.md](./INTEROP_PROTOCOL.md) while the relay pool is
unmonitored and the option is experimental. An anonymous PIN's offer asks for
Code Exchange's Tor fallback or none (that document's §4.8).

## The PIN carries the mode

The two sides have to agree, because they only find each other on a shared
relay and the two relay pools are disjoint. Nothing in the protocol announces
the mode, so the only place to put the signal is the one thing the sender hands
over: the PIN.

| | Length | Layout |
| --- | --- | --- |
| Standard | 12 | 3 locator + 8 secret + checksum |
| Anonymous | 16 | 3 locator + 12 secret + checksum |

Everything else about a PIN is unchanged — same alphabet, same weighted
checksum, same rotation buckets, same locator-keyed rendezvous hint. The
receiver classifies what it was handed (`classifyPin` in
`src/lib/crypto/pin.ts`), and a `pinKind` rides along with the classified input
(`src/lib/receive-input.ts`) to the receive tab. There is no toggle on the
receive side and nothing for the receiver to know in advance.

The four extra characters are secret data rather than locator, so the published
`#h` tag is derived exactly as before and the online-guessing space grows from
55⁸ to 55¹². That is a consequence of the length, not the reason for it; the
bound that actually matters is still `CLAIM_VERIFY_LIMIT`.

Two lengths four apart cannot be confused by a single typo, and the checksum
covers the rest: a mistyped PIN is rejected as invalid rather than silently
reinterpreted as the other kind.

## The relay pool is separate, and it is onion services

Anonymous signaling never touches `DEFAULT_RELAYS`. It uses
`ANONYMOUS_SIGNALING_RELAYS` in `src/lib/nostr/relays.ts`: Nostr relays reached
as v3 onion services (`ws://<address>.onion`), drawn from
[`0xtrr/onion-service-nostr-relays`](https://github.com/0xtrr/onion-service-nostr-relays)
and kept to the ones that accept writes from a throwaway key — the sender's
kind-4243 rendezvous and both sides' kind-24243 handshakes — and serve the
rendezvous back. That is a stricter bar than answering a `REQ`: most onion
relays that serve reads refuse anonymous writes (paid admission, whitelists),
and some acknowledge them and drop them. The list is community-maintained and
tracks no uptime, so the pool is a set of candidates that passed on a given day,
not a monitored one. Expect this mode to fail more often than ordinary PIN
Exchange.

The two URL validators are mirror images of each other. `normalizeRelayUrl`
accepts only clearnet `wss://`; `normalizeOnionRelayUrl` accepts only `ws://`
to a v3 onion address, refusing `wss://` (an onion circuit is already encrypted
and authenticated end to end by the key the address commits to, so TLS on top
adds nothing the WASM client could verify) and every clearnet host. `NostrClient`
holds whichever one matches its mode and applies it to every relay URL it is
given, at construction and through `addRelays` — so no relay list arriving at
runtime can pull an anonymous session onto a socket that would reveal its IP
address.

## Connection path

In the browser:

```text
pTransfer Nostr client (nostr-tools)
  → AbstractSimplePool with a custom websocketImplementation
  → src/lib/nostr/anonymous-transport.ts
  → src/lib/tor/client.ts (the same bootstrap the Tor transfer mode uses)
  → @andrewtheguy/webtor-wasm
  → Snowflake bridge: a direct WebSocket, or a brokered volunteer WebRTC proxy
  → onion-service rendezvous (HSDir descriptor, introduction point,
    rendezvous point)
  → ws:// Nostr relay WebSocket on the onion service
```

In the browser, what changes is the socket the relay pool builds
on: `AnonymousSignalingTransport` exposes a class that satisfies the browser
`WebSocket` contract — `open`, `message`, `error`, `close`, `readyState`,
`send`, `close` — while its bytes travel over an onion stream. The WASM side
performs the HTTP upgrade inside that stream, masks client frames, handles
fragmentation and control frames, and caps a Nostr message at 1 MiB. Binary
frames are a protocol error rather than a silent drop: Nostr has no use for
them.

In the browser, one Tor client is shared by every relay socket in a session, but
each socket is its own rendezvous — a descriptor fetch from an HSDir, an
introduction circuit, and a rendezvous circuit — which is why the pool is kept
small.

Browser timeouts differ from the clearnet path: a relay socket gets 180 seconds
to open, and the wait is for a relay to *really* connect (`Promise.any` over
`ensureRelay`) rather than giving sockets a fixed head start, because a fixed
wait would hand every publish to a pool with nothing open. The browser bootstrap
itself additionally gets 5 minutes. The CLI runs the same code with the same
timeouts.

## Reusing the browser Tor integration

The web app uses the same `src/lib/tor/client.ts` bootstrap as the Tor onion
transfer mode. Snowflake paths, Tor directory validation, onion lookup, and the
resulting network-observation boundary belong to webtor-rs and are documented
in its [Onion-Service Architecture](https://github.com/andrewtheguy/webtor-rs/blob/main/docs/ONION_SERVICE_ARCHITECTURE.md).
pTransfer's bridge UI, IndexedDB persistence, stricter directory-seed freshness
rule, and local development overrides are documented in
[TOR_BROWSER.md](./TOR_BROWSER.md).

The CLI uses the same webtor-wasm client under Bun, with the websocket bridge;
the webrtc bridge is browser-only for now. A *web* side exposes webtor-rs's two
Snowflake choices through `src/components/ptransfer/tor-bridge-choice.tsx`,
independently of its peer — every peer meets every other inside Tor, so the
choices need not match.

The sender picks it in **Advanced options** on the send tab, next to the switch.
The receiver is asked once its PIN turns out to be an anonymous one, before any
bootstrap starts — spending minutes to discover the fixed endpoint is blocked,
and then spending them again, is worth one question.

Unlike the Tor transfer mode, nothing here proves the client can complete a
rendezvous before it is used: the first relay socket is that proof. A failure
before Tor reports itself up is a bootstrap failure; after that it is a relay
failure, and the two are reported with different messages.

## Privacy boundary

The option hides both devices' IP addresses from the Nostr relays. There is no
automatic or silent fallback to a clearnet socket: if Tor cannot be reached, or
no onion relay answers, PIN Exchange fails.

It does not hide a device's IP address from:

- the host serving the pTransfer application;
- the Snowflake broker, volunteer proxy, and STUN services used for Tor entry;
- the other WebRTC peer, once the direct connection is negotiated; or
- the STUN services used for file-transfer ICE candidate discovery.

That last pair is the important limit. **A direct connection does not go
through Tor.** File data travels over the same direct WebRTC data channel as any
other PIN Exchange transfer whenever one forms, so the peer learns an IP address
for this device at that moment, and so may STUN. What the option removes is the
relays' view.

When no direct connection forms, the file does go through Tor. The offer an
anonymous PIN session carries asks for Code Exchange's Tor fallback
([CODE_EXCHANGE_PROTOCOL.md §5](./CODE_EXCHANGE_PROTOCOL.md#5-the-anonymous-fallback)):
the two devices coordinate over this same onion relay pool and the file
travels through an onion service the sender publishes, on the Tor client the
signaling already bootstrapped. It never asks for the clearnet fallback, which
would hand both devices' addresses to public storage relays, and a receiver
refuses an offer that does (INTEROP_PROTOCOL.md §4.8). A selection over that
fallback's 100 MiB cap gets no fallback at all rather than the clearnet one.

Nostr events remain end-to-end protected exactly as in ordinary PIN Exchange.
Tor adds transport-level network privacy; it does not replace SPAKE2, event
signatures, the sealed codes, or content encryption.

The PIN's length is public in the same sense the PIN is: whoever sees it knows
the mode. Since the PIN is only ever handed to the intended recipient, that
tells nobody anything they could not have learned by watching the transfer.

## Where the code lives

| File | What it does |
| --- | --- |
| `src/lib/crypto/constants.ts` | `ANONYMOUS_PIN_LENGTH`, and why the length is the signal |
| `src/lib/crypto/pin.ts` | `PinKind`, `classifyPin`, `generatePin(kind)` |
| `src/lib/nostr/relays.ts` | `normalizeOnionRelayUrl`, `ANONYMOUS_SIGNALING_RELAYS` |
| `src/lib/nostr/anonymous-transport.ts` | The Tor-backed `WebSocket` implementation |
| `src/lib/nostr/client.ts` | Which pool, which validator, which timeouts |
| `src/hooks/use-pin-send.ts` | `PinSendOptions`; mints the PIN kind that matches the pool |
| `src/hooks/use-pin-receive.ts` | `PinReceiveOptions` |
| `src/components/ptransfer/send-tab.tsx` | The Advanced options switch |
| `src/components/ptransfer/anonymous-receive-form.tsx` | The receiver's bridge question |
| `src/components/ptransfer/tor-bridge-choice.tsx` | The bridge radio group, shared with the Tor mode |

## No additional backend

pTransfer remains a static site. The application hosts the generated WASM and
JavaScript glue alongside its other assets. Runtime dependencies are the public
Snowflake bridge and broker infrastructure, the Tor directory and onion-service
infrastructure, and the onion relays; pTransfer operates no
anonymous-signaling proxy of its own.
