# Code Exchange Mode Guide

This guide is intentionally high-level and user-focused.
For protocol internals, signaling payload format, and implementation details, see [Architecture](ARCHITECTURE.md).

Both implementations ship Code Exchange, and either side of a transfer may be a
browser tab or `ptransfer-cli`. The two carry the same codes; only the *way* a
code is carried differs, because a terminal has no camera — the CLI copies and
pastes text where the browser also offers QR. The wire contract they share is
[CODE_EXCHANGE_PROTOCOL.md](CODE_EXCHANGE_PROTOCOL.md), versioned separately
from [INTEROP_PROTOCOL.md](INTEROP_PROTOCOL.md), so changes to it do not move
the interop protocol version.

Both fallbacks below are implemented by both: the **ordinary relay fallback**
over public Nostr relays, and the **anonymous signaling and relay** option. A
code that names no relays and carries no anonymous flag has neither, and a
failed direct connection ends that transfer.

## What Code Exchange Is

Both WebRTC-based exchange methods start with something you hand to the receiver — in PIN Exchange you carry a short PIN, and relays
use it to coordinate the two devices. Code Exchange is the method where you carry the *whole*
connection code instead, so no relay coordinates anything: **you** move the sender's
connection data across by hand — using a **QR code**, **copy/paste**, or a mix of the two.
The two methods are interchangeable at every step: either side can scan or paste, whichever
is more convenient.

The receiver's response comes back the same way: as a QR code or copied text that the
**sender** scans or pastes. Nothing enters the sender's page unless the sender takes it
in — relays never carry signaling in this mode, so a bystander who saw the sender's code
cannot push a response into the sender's page.

Once the two devices are connected, file bytes are sent directly peer-to-peer over WebRTC
using the shared pTransfer data-channel protocol (encrypted 128 KiB chunks, `DONE:<chunkCount>:<byteCount>`,
then a single receiver `ACK` once `DONE` validates the chunk count and final byte count and all chunks have
authenticated and reassembled).

If a direct connection **cannot** be made — for example, a restrictive NAT or firewall on
either end — an eligible transfer automatically attempts its selected fallback. The
ordinary path uses public Nostr control and storage relays (see
[Relay fallback](#relay-fallback-no-direct-connection)); the experimental **Anonymous
signaling and relay** option uses onion-service Nostr relays for control and a temporary
Tor onion service for the file. The fallback is capped at 100 MiB and remains
best-effort. Once the sender has selected ordinary or anonymous Code Exchange there is
no second switch to activate the fallback: it runs automatically after the direct route
fails. This guide describes the **direct flow** unless it says otherwise.

## When to Use This

Code Exchange is useful when:
- You want to transfer files between two devices on the same local network without internet
  (with no internet, nothing but the two devices is involved — the relay step drops out on its own)
- You prefer not to hand the rendezvous to a signaling server: neither the offer nor the
  answer ever touches one. If direct WebRTC fails, the selected fallback may expose
  encrypted coordination or file traffic to public Nostr relays or Tor infrastructure
- The QR/clipboard offer is only obfuscated, while file data is encrypted after the exchange

## How It Works

The two devices swap two small pieces of connection data:

1. **Offer** — sender → receiver, carried by you
2. **Answer** — receiver → sender, carried by you

Both can be transferred **either** as QR code(s) **or** as copied text — the other side
can scan or paste, whichever is easier.

An ordinary offer also names a few Nostr relays the sender proved while building it. They
are not used for signaling: they become the encrypted control channel only if the direct
connection fails, with separate discovered storage relays carrying the file pieces (the
[relay fallback](#relay-fallback-no-direct-connection)). The sender checks its default
relays in the background while the connection data is prepared, so that part costs no
waiting; if some of them are down it looks for replacements first, and the offer code
appears once it knows which relays to name. An anonymous offer names no clearnet relays;
it carries an `anon` flag and both pages use the same fixed onion-relay pool instead.

> Because the relay fallback is keyed from the Code Exchange secret, treat the offer as
> the secret for the whole transfer: anyone who obtains it before it expires can answer it
> and derive the transfer keys — but their answer still only counts if the sender scans or
> pastes it. The response check described in
> [Responses are checked against your code](#the-returned-response-confirms-the-receiver-and-is-checked-against-your-code)
> does not change this.

- **As QR codes:** The sender's offer is larger, so it is split across **multiple QR codes**
  (typically 2-4, each labeled "1 of N"). The receiver's answer is smaller and fits in a
  **single QR code**. QR codes are scanned with a phone camera / the
  in-app scanner.
- **As copy/paste:** Each side offers a **Copy Data** button that puts a base64 text blob on
  the clipboard for the other person to paste. If the browser can't access the clipboard
  (insecure context or in-app browser), use **Show text to copy manually** to select the text
  yourself.

The signaling data carries what the two devices need to find and connect to each other. Treat
it as shareable only with your intended recipient. When the offer is reassembled from QR codes,
it is error-checked (a CRC over the offer) before use — this only guards against a misread or
garbled QR code and is **separate** from the file's cryptographic integrity, which is enforced
on the direct path by per-chunk AES-GCM authentication. The ordinary Nostr data fallback
uses per-piece AES-GCM plus a whole-file SHA-256 check instead; the anonymous fallback
uses the Tor transport's authenticated 128 KiB chunks and completion checks.

## Step-by-Step

### Sender — present the offer

1. Open the app and select your file(s)
2. Under **Transfer mode**, select **Code Exchange**
3. Click **Start Code Exchange**. In ordinary mode, if some default relays are
   unreachable, the page says it is looking for others before the code appears — the
   offer names whichever relays it settles on for the fallback. With **Anonymous
   signaling and relay** selected under Advanced options, the page starts Tor in the
   background instead
4. The sender's offer appears as **a grid of QR codes** (typically 2-4, labeled "1 of N"),
   with a **Copy Data** button beneath them
5. Give the offer to the receiver by **either** method:
   - **QR:** tell them to scan any one QR code with their phone camera, then the rest in-app
   - **Copy/paste:** tap **Copy Data** and send the text to them (or **Show text to copy
     manually** if the copy button doesn't work), for them to paste on their device

### Receiver — take the offer, return an answer

1. Open the `/receive` page. There is no mode to choose — the page takes whatever the
   sender handed you and works out which exchange it belongs to
2. Take in the sender's offer by **either** method:
   - **Scan tab:** tap to start the camera, point it at any one of the sender's QR codes,
     tap the link to open the app if needed, then scan the remaining codes one by one
     (progress shows "Collected 1 of N")
   - **Paste tab:** paste the copied offer text — it is recognized as the sender's code
     as you paste — then press **Receive**
3. Once the full offer is collected, the app validates it and generates your **answer**
4. Your answer appears as a **single QR code** with a **Copy Data** button — send it back
   to the sender by **either** method

### Back to Sender — connect

1. Under **Scan or paste receiver's response**, take the answer in by **either** method —
   scan the response QR with the in-app scanner, or paste the copied response text
2. Returning the receiver's response is Code Exchange's confirmation step. The sender
   checks that it actually answers the code being shown (see
   [The returned response confirms the receiver and is checked against your code](#the-returned-response-confirms-the-receiver-and-is-checked-against-your-code)).
   A response from a different transfer is simply refused
3. The P2P connection establishes and the file transfers directly
4. Both sides show that the transfer completed when done

### The returned response confirms the receiver and is checked against your code

The receiver's response carries a short tag it derives from three things: the shared key,
the exact code it read, and the contents of the response itself. Before the sender acts on
a response — before it connects and before any file data moves — it recomputes that tag
from the code it is showing and the response it was handed, and refuses anything that does
not match, with "Response does not match this transfer."

Unlike PIN Exchange, no additional short code appears for someone to read aloud. Scanning
or pasting the full response back into the sender's page is the confirmation handoff. A
response belonging to a **different** transfer, an old response pasted again, or a response
altered on the way back is rejected straight away instead of turning into a connection
that never completes — handy if you have two transfers open and paste the wrong one.

Anyone who photographed or copied your offer can produce a matching response, just as
someone holding the matching PIN Exchange session can produce its short confirmation code.
In both modes, the sender confirms the intended receiver by accepting the value that person
returns. PIN Exchange has the sender type a short code; Code Exchange lets the sender scan
or paste the full response instead.

## Relay Fallback (No Direct Connection)

When the offer/answer exchange succeeds but the two devices still cannot open a direct
WebRTC connection — usually a restrictive NAT or firewall on both ends — the pages try to
carry an eligible encrypted file (up to **100 MiB**) through public Nostr relays. This is
the Code Exchange stand-in for TURN, but it can still fail if storage relays are
insufficient or do not deliver the pieces. (This page describes the user-facing behavior;
the technical design is in [NOSTR_FILE_RELAY.md](NOSTR_FILE_RELAY.md).) An advanced
option moves this whole fallback into Tor instead — see
[Anonymous Signaling and Relay](#anonymous-signaling-and-relay-experimental); the rest
of this section describes the default.

Once ordinary Code Exchange is selected, fallback activation is fully automatic and
nothing changes about how you use the exchange:

1. You run the normal offer/answer exchange above. Both sides then try to connect
   directly, as always.
2. If that direct connection cannot be made, both pages switch to the relay path on their
   own. The receiver usually notices first; as soon as it checks in over the relays, the
   sender stops waiting on the direct attempt too. The sender encrypts the file and uploads it to a set of discovered storage relays
   as **temporary events with a 1-hour NIP-40 expiration** (a deletion request compliant
   relays honor, not guaranteed erasure — the file stays protected by its encryption
   regardless), **one copy each**. The receiver downloads the pieces while the sender is
   still uploading.
3. The two sides coordinate over a small **encrypted side channel** on the proven relays
   the offer named — the sender announces which storage relays hold
   which pieces, the receiver names any it could not fetch, and **only those are sent
   again**. Both pages complete on their own once the receiver has the verified file.

Nothing is uploaded ahead of time: the file goes to relays **only** after the direct
connection fails, so a transfer that would have connected directly never puts a byte of it
on a storage relay. What does run ahead of time is a background check of which public
relays are working (a small throwaway probe per relay, no file data), so the relay path is
ready the moment it is needed and every later transfer starts from a warmer relay cache.

Key points:

- **No new key to share.** Unlike the file itself, the decryption key is never carried in
  a code — both sides derive it from the same secret the offer/answer exchange already
  established. Whoever could authentically deliver the offer can already decrypt.
- **What decides whether the fallback is available:** only whether the offer named proven
  relays (it does whenever the sender could reach a few when the offer was built). The
  file must also be at or below 100 MiB.
- **When it still fails:** the offer named no relays (none were reachable when it was
  built), the file is over 100 MiB, or too few storage relays work. Then the transfer
  fails and the app suggests the offline-QR app for side-by-side devices.
- **Forcing it for a test:** the receiver's response page has an **Advanced options >
  Simulate no direct connection** button, offered only where the relay path could
  actually carry the file — the selected fallback is available and the file is at or
  below the 100 MiB cap. It drops the receiver's direct connection and builds the response
  again with none of its network routes in it, so the sender has nothing to connect to
  and the file uses the selected fallback — the situation a device behind a hostile NAT
  is in anyway. Nothing starts until the sender takes the response in, and **Go back to
  a direct connection** undoes it. Either way the connection is rebuilt from scratch —
  new key material and all, so that the `hello` the simulation left on the control
  relays cannot pull the sender off the fresh direct route — and the code changes, so
  hand the sender the one on screen.
- **When it starts:** only a failed attempt to establish the WebRTC data channel triggers
  this path. A P2P transfer that already opened its channel and later stalls fails rather
  than changing transports mid-file.
- **Both pages must stay open** until it finishes, and everything must complete within 1
  hour of the exchange start.
- Relays see only encrypted pieces, sizes, timing, and the small encrypted coordination
  messages — never the file name, contents, or the key. Signaling and storage use
  separate relays.

## Anonymous Signaling and Relay (experimental)

An **Advanced options** switch on the send tab, offered for Code Exchange only. It
changes nothing about the exchange itself — the offer and the response are carried by
hand either way, and no relay has ever carried them. What it moves is the
[relay fallback](#relay-fallback-no-direct-connection), off the clearnet and into Tor:

- The two pages coordinate over Nostr relays run as **onion services**, reached
  through a Tor client inside the browser, rather than public clearnet relays. Same
  pool and same rules as PIN Exchange's
  [anonymous signaling](ANONYMOUS_SIGNALING.md).
- The file itself travels through a **Tor onion service the sending tab publishes**,
  over the transport specified in [TOR_TRANSPORT.md](TOR_TRANSPORT.md), rather than as
  encrypted pieces on public Nostr storage relays.

The sender turns it on and the offer says so, so the receiving page has nothing to
turn on and nothing to agree in advance: it recognizes the flag in the code it was
handed and asks one question of its own, which Snowflake bridge this device reaches
Tor through. Answering it is what starts the bootstrap, and that happens as the code
is taken in rather than once the direct route is known to be dead, because a
bootstrap is the slow part and by then the sender is already waiting. The sending
page does the same from the moment it shows the code, in the time the ordinary
fallback spends probing relays — so **both devices reach the Tor network as soon as
the exchange starts**, including on a transfer that then connects directly and never
needs it. Bootstrapping publishes nothing: the onion service is established only
after a response has been accepted. Each page picks its own bridge — the sender's
under **Advanced options**, the receiver's as it takes the code in — and the two do
not have to match, since they only ever meet inside the Tor network.

**Both devices need internet for this option.** Ordinary Code Exchange connects two
devices on the same network with no internet at all; this cannot, because Tor is
reached over the network. A direct WebRTC connection is still attempted first,
exactly as always, and it is still a direct connection — each peer sees the other's
address, and STUN sees what it always sees. Tor covers only what happens when that
route does not exist.

Expect it to be slower than the ordinary fallback and to fail more often: it depends
on a Tor bootstrap on both devices, on a small unmonitored pool of onion relays, and
on an onion service surviving long enough to hand the file over. The 100 MiB cap is
the same one the ordinary fallback has.

### Nothing about the onion service is handed over

The [Tor Onion Service](TOR_TRANSPORT.md) transfer mode shows its operator an
`.onion` address and a one-time password to pass to the receiver. **Here neither is
ever shown, typed, or carried in a code.**

The password is not transmitted at all — it is derived on both devices from the same
ECDH secret the offer/answer exchange already established, the secret the ordinary
relay fallback keys its session from. It is derived key material rather than eleven
typed characters, so the online-guessing bounds a human-length password needs do not
apply to it. The onion address is the one thing that cannot be derived — an ephemeral
service identity is minted by the Tor client — so it is announced to the receiver over
the **encrypted control channel**, sealed under a key both sides derive from that same
secret. Relays carry that message; they can neither read it nor act on it.

That is also what preserves the property Code Exchange has and the Tor mode does not
have to: **the service is unreachable until the sender takes the response in.** The
sender cannot derive the shared secret before then — it needs the receiver's public
key, which exists only inside the response — so up to that moment there is no address
to announce and no password that would open the handshake. Someone who photographed
the offer can still produce a response of their own, but it is a response built on
their own key, and the sender only ever publishes to the response it accepted and
checked (see
[Responses are checked against your code](#the-returned-response-confirms-the-receiver-and-is-checked-against-your-code)).
As everywhere else in Code Exchange, the offer remains the secret for the whole
transfer, and the sender's own scan or paste remains the gate.

## Tips

- **QR and copy/paste are interchangeable**: Pick whichever is easier at each step; you can mix them. `ptransfer-cli` has copy/paste only, and that half is enough to transfer with a browser on the other end
- **Order doesn't matter (QR)**: Multi-QR offer codes can be scanned in any order
- **Duplicates are fine (QR)**: Scanning the same QR code twice won't cause issues
- **Copy/paste fallback**: If cameras aren't available, use **Copy Data** on the sending side and
  the **Paste** tab on the receiving side. If the clipboard is blocked, use **Show text to copy
  manually** to select the text by hand
- **Single QR**: Very small offers may produce just one QR code — the flow still works the same way
- **A direct route is required (direct flow only)**: Without internet, both devices normally need
  to be on the same Wi-Fi or local network. With internet, STUN can help discover direct routes
  across different networks, but restrictive NAT or firewall rules can still prevent a connection.
  TURN relaying is not supported. When a direct route cannot be found, a file at or below
  100 MiB can use the selected fallback: the [Nostr relay path](#relay-fallback-no-direct-connection)
  when the ordinary offer named relays, or the Tor path when the experimental anonymous
  option is selected. Both devices need internet for either fallback
- **Deployment path**: Host at domain root (for example `https://example.com`). Subpath
  deployments (for example `https://example.com/my-app`) can break scanned QR links

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Phone camera doesn't show a link | Make sure the QR code is well-lit and in focus. The QR contains a URL that your phone should recognize. |
| App doesn't open from the link | Confirm the app is deployed at domain root (no subpath). Then retry scanning and open the link again. |
| "Camera access denied" in-app | Allow camera permissions in your browser settings and reload the page. Or switch to the **Paste** tab and use copy/paste instead. |
| Copy button does nothing | Some browsers block clipboard access. Use **Show text to copy manually** and select the text by hand. |
| Pasted data is rejected | Make sure you copied the entire blob and pasted the matching piece (offer to the receiver, answer to the sender). |
| Sender reports a failed connection after the answer arrived | The direct WebRTC route is blocked and the selected fallback was unavailable or also failed. In ordinary mode this can mean the offer named no relays or too few storage relays worked; in anonymous mode Tor or the onion relays may have failed. A file over 100 MiB cannot use either fallback. Start over on a network that allows a direct connection, or use the suggested offline-QR app. |
| Transfer fails after the offer is collected (direct flow) | Both devices must have network connectivity to each other (same Wi-Fi, or both on the internet). |
| Sender shows expired error | Generate a new offer by retrying the send flow. |
| Sender times out after sending (direct flow) | Keep the receiver page open until it verifies the file and sends the final data-channel ACK. |
| Relay fallback stalls or times out | Both devices need internet access to the selected Nostr or Tor infrastructure, not to each other. Both pages must stay open — a side that goes silent for a few minutes ends the transfer. Everything must finish within 1 hour of the exchange start; after that, start a new one. |
