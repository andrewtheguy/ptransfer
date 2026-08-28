# Anonymous Signaling

An experimental PIN Exchange option. The sender turns it on; the receiving side
recognizes it and follows. Both devices then carry the PIN Exchange handshake to
Nostr relays run as onion services, through a Tor client, instead of over
clearnet WebSockets.

It does not route file data through Tor, and it does not make the transfer as a
whole anonymous.

Both implementations ship it, and either side of a transfer may be a browser tab
or `ptransfer-cli`. This document is the shared specification: the PIN lengths,
the relay pool, and the URLs a socket may be opened to are the same on both
sides, and are what make them interoperate. How each side *reaches* Tor is not
shared and does not have to be — the browser uses its bundled Tor integration,
while the CLI reaches Tor through its own implementation — and the two only
ever meet at the relay, inside Tor. It stays outside
[INTEROP_PROTOCOL.md](./INTEROP_PROTOCOL.md); see *Interoperability* below.

## Changing this document

This repository is where this specification lives; the CLI implements against
it rather than keeping a copy, so editing this file is not by itself a change to
the CLI. Three things here bind the two implementations — the same three listed
under *Interoperability* below:

- the two PIN lengths and their layouts,
- `ANONYMOUS_SIGNALING_RELAYS`: that pool, and nothing else, for an anonymous
  PIN,
- and the rule that a socket for one may be opened only to
  `ws://<v3 address>.onion`.

There is no version to move here, and none is needed. Every way the two sides
could drift apart on that list fails closed and says so: a length neither side
mints is refused by the length-and-checksum test rather than guessed at, and a
pool that drifts apart costs connections rather than secrecy — the two simply
never meet on a relay. Compare the Tor transfer mode, whose frames do carry a
version, and PIN Exchange, whose rotation windows and budgets can diverge
silently and so need one.

Everything else below — how each side reaches Tor, the timeouts, the bridge
question, the privacy discussion, where the code lives — is implementation
detail on one side or the other. Rewording it, or following one implementation's
code as it moves, asks nothing of the other.

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

The CLI reaches the same onion relay pool through its own Tor client. Its
internal libraries and layout are deliberately documented in the CLI repository
rather than in this shared specification. The event, subscription, publication,
signature, SPAKE2, and encryption behavior remains the same on both sides.

In the browser, one Tor client is shared by every relay socket in a session, but
each socket is its own rendezvous — a descriptor fetch from an HSDir, an
introduction circuit, and a rendezvous circuit — which is why the pool is kept
small.

Browser timeouts differ from the clearnet path: a relay socket gets 180 seconds
to open, and the wait is for a relay to *really* connect (`Promise.any` over
`ensureRelay`) rather than giving sockets a fixed head start, because a fixed
wait would hand every publish to a pool with nothing open. The browser bootstrap
itself additionally gets 5 minutes. CLI timing remains an implementation detail
documented in its own repository.

## Reusing the browser Tor integration

The web app uses the same `src/lib/tor/client.ts` bootstrap as the Tor onion
transfer mode. Snowflake paths, Tor directory validation, onion lookup, and the
resulting network-observation boundary belong to webtor-rs and are documented
in its [Onion-Service Architecture](https://github.com/andrewtheguy/webtor-rs/blob/main/docs/ONION_SERVICE_ARCHITECTURE.md).
pTransfer's bridge UI, IndexedDB persistence, stricter directory-seed freshness
rule, and local development overrides are documented in
[TOR_BROWSER.md](./TOR_BROWSER.md).

Bridges are a browser concern only; non-browser implementations handle their own
Tor entry and do not take part in this choice. Both *web* sides expose
webtor-rs's two Snowflake choices through
`src/components/ptransfer/tor-bridge-choice.tsx`, independently — every peer
meets every other inside Tor, so the choices need not match.

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

That last pair is the important limit. **File data never goes through Tor.** It
travels over the same direct WebRTC data channel as any other PIN Exchange
transfer, so the peer learns an IP address for this device at the moment the
connection forms, and so may STUN. What the option removes is the relay's view.

Nostr events remain end-to-end protected exactly as in ordinary PIN Exchange.
Tor adds transport-level network privacy; it does not replace SPAKE2, event
signatures, encrypted signaling, or content encryption.

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

The table above is this repository only. `ptransfer-cli` reaches the same three
normative points — PIN classification, the relay pool, and the onion-only socket
rule — through its own implementation, whose internal layout is documented in
its own repository rather than here.

## No additional backend

pTransfer remains a static site. The application hosts the generated WASM and
JavaScript glue alongside its other assets. Runtime dependencies are the public
Snowflake bridge and broker infrastructure, the Tor directory and onion-service
infrastructure, and the onion relays; pTransfer operates no
anonymous-signaling proxy of its own.

## Interoperability

Anonymous signaling is **not** part of
[INTEROP_PROTOCOL.md](./INTEROP_PROTOCOL.md), and this document is where it is
specified instead — the same arrangement the Tor onion transfer mode has in
[TOR_TRANSPORT.md](./TOR_TRANSPORT.md). It stays outside that document, and its
version, while the relay pool is unmonitored and the option is experimental —
not because the two implementations disagree: a browser tab and `ptransfer-cli`
interoperate in both directions today.

What that means for a third implementation: `INTEROP_PROTOCOL.md` specifies the
12-character PIN, and an implementation of that document alone must reject a PIN
of any other length rather than guess at what the extra characters mean.
Implementing this document is what makes the 16-character length meaningful, and
it takes three things and no more — mint and classify a PIN at
`ANONYMOUS_PIN_LENGTH`, use `ANONYMOUS_SIGNALING_RELAYS` for it and nothing
else, and refuse to open a socket for it to anything but
`ws://<v3 address>.onion`. Everything else is the handshake `INTEROP_PROTOCOL.md`
already specifies, unchanged.
