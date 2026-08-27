# Anonymous Signaling

An experimental PIN Exchange option. The sender turns it on; the receiver's
page recognizes it and follows. Both devices then carry the PIN Exchange
handshake to Nostr relays run as onion services, through the browser Tor
client, instead of over clearnet WebSockets.

It does not route file data through Tor, and it does not make the transfer as a
whole anonymous. Web only for now — `ptransfer-cli` speaks the standard PIN
form and nothing here changes that; see *Interoperability* below.

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

The `nostr-tools` event, subscription, publication, signature, SPAKE2, and
encryption logic is untouched. What changes is the socket the relay pool builds
on: `AnonymousSignalingTransport` exposes a class that satisfies the browser
`WebSocket` contract — `open`, `message`, `error`, `close`, `readyState`,
`send`, `close` — while its bytes travel over an onion stream. The WASM side
performs the HTTP upgrade inside that stream, masks client frames, handles
fragmentation and control frames, and caps a Nostr message at 1 MiB. Binary
frames are a protocol error rather than a silent drop: Nostr has no use for
them.

One Tor client is shared by every relay socket in a session, but each socket is
its own rendezvous — a descriptor fetch from an HSDir, an introduction circuit,
and a rendezvous circuit — which is why the pool is kept small.

Two timeouts differ from the clearnet path, both in
`src/lib/nostr/client.ts` and `anonymous-transport.ts`: a relay socket gets 180
seconds to open rather than 10, and the bootstrap itself gets 5 minutes.
`waitForConnection` really connects (`Promise.any` over `ensureRelay`) rather
than giving sockets a fixed head start, because a fixed wait would hand every
publish to a pool with nothing open.

## Reaching Tor is the Tor transfer mode's code

Bootstrapping — the Snowflake bridge choice, the directory seed, the IndexedDB
directory cache, the local-bridge environment overrides — is
`src/lib/tor/client.ts`, unchanged and shared with the Tor onion transfer mode.
[TOR_BROWSER.md](./TOR_BROWSER.md) documents all of it, including why a cached
directory seed can be stale and what a cold start actually costs.

Both sides are offered the same two bridges (`src/components/ptransfer/tor-bridge-choice.tsx`),
independently — they only meet at the relay, inside Tor, so the choices need not
match:

| Bridge | What it is |
| --- | --- |
| Snowflake WebSocket (default) | One fixed bridge endpoint, no broker and no STUN. The faster of the two, and the one to try first. |
| Snowflake WebRTC | A volunteer proxy brokered over HTTPS, using STUN. Harder to block, and worth switching to if the WebSocket bridge cannot be reached. |

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

## No additional backend

pTransfer remains a static site. The application hosts the generated WASM and
JavaScript glue alongside its other assets. Runtime dependencies are the public
Snowflake bridge and broker infrastructure, the Tor directory and onion-service
infrastructure, and the onion relays; pTransfer operates no
anonymous-signaling proxy of its own.

## Interoperability

Anonymous signaling is **not** part of
[INTEROP_PROTOCOL.md](./INTEROP_PROTOCOL.md). That document specifies the
12-character PIN, and an implementation of it must reject a PIN of any other
length rather than guess at what the extra characters mean. `ptransfer-cli`
therefore neither mints nor accepts an anonymous PIN today; the plan is to add
it once the web side has settled.
