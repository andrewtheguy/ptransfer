# Code Exchange Mode Guide

This guide is intentionally high-level and user-focused.
For protocol internals, signaling payload format, and implementation details, see [Architecture](ARCHITECTURE.md).

Code Exchange is **web-only**. It is deliberately outside the cross-implementation
contract in [INTEROP_PROTOCOL.md](INTEROP_PROTOCOL.md) while its shape is still
settling, so a non-web implementation is not expected to speak it and changes to
it do not move the interop protocol version.

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
either end — an eligible transfer automatically attempts the Nostr relay fallback (see
[Relay fallback](#relay-fallback-no-direct-connection)). There is no switch to find. The
attempt needs an offer that named relays (it usually does) and a file at or below 100 MiB.
Storage-relay delivery remains best-effort. This guide describes the **direct flow** unless it says
otherwise.

## When to Use This

Code Exchange is useful when:
- You want to transfer files between two devices on the same local network without internet
  (with no internet, nothing but the two devices is involved — the relay step drops out on its own)
- You prefer not to hand the rendezvous to a signaling server: neither the offer nor the
  answer ever touches one. If direct WebRTC fails, relays may see encrypted file pieces
  and encrypted coordination messages
- The QR/clipboard offer is only obfuscated, while file data is encrypted after the exchange

## How It Works

The two devices swap two small pieces of connection data:

1. **Offer** — sender → receiver, carried by you
2. **Answer** — receiver → sender, carried by you

Both can be transferred **either** as QR code(s) **or** as copied text — the other side
can scan or paste, whichever is easier.

The offer also names a few Nostr relays the sender proved while building it. They are not
used for signaling: they become the encrypted control channel only if the direct
connection fails, with separate discovered storage relays carrying the file pieces (the
[relay fallback](#relay-fallback-no-direct-connection)). The sender checks its default
relays in the background while the connection data is prepared, so that part costs no
waiting; if some of them are down it looks for replacements first, and the offer code
appears once it knows which relays to name.

> Because the relay fallback is keyed from the Code Exchange secret, treat the offer as
> the secret for the whole transfer: anyone who obtains it before it expires can answer it
> and derive the transfer keys — but their answer still only counts if the sender scans or
> pastes it. The response check described in
> [Responses are checked against your code](#responses-are-checked-against-your-code)
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
on the direct path by per-chunk AES-GCM authentication. The relay data fallback uses
per-piece AES-GCM plus a whole-file SHA-256 check instead.

## Step-by-Step

### Sender — present the offer

1. Open the app and select your file(s)
2. Under **Transfer mode**, select **Code Exchange**
3. Click **Start Code Exchange**. If some default relays are unreachable, the page
   says it is looking for others before the code appears — the offer names whichever
   relays it settles on for the relay fallback
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
2. The sender checks that the response actually answers the code it is showing (see
   [Responses are checked against your code](#responses-are-checked-against-your-code)).
   Nothing to read out or type — a response from a different transfer is simply refused
3. The P2P connection establishes and the file transfers directly
4. Both sides show that the transfer completed when done

### Responses are checked against your code

The receiver's response carries a short tag it derives from three things: the shared key,
the exact code it read, and the contents of the response itself. Before the sender acts on
a response — before it connects and before any file data moves — it recomputes that tag
from the code it is showing and the response it was handed, and refuses anything that does
not match, with "Response does not match this transfer."

This is automatic and invisible: no confirmation code appears on either screen and neither
person has to read anything aloud. It means a response belonging to a **different**
transfer, an old response pasted again, or a response altered on the way back is rejected
straight away instead of turning into a connection that never completes — handy if you
have two transfers open and paste the wrong one.

It is **not** a defense against someone who photographed or copied your offer code: they
can produce a matching tag as easily as the intended receiver can. The protection there is
still that nothing enters the sender's page except what the sender scans or pastes. If you
need a check that survives a leaked code, use [PIN Exchange](../README.md), where the
receiver displays a confirmation code that the sender's operator must type.

## Relay Fallback (No Direct Connection)

When the offer/answer exchange succeeds but the two devices still cannot open a direct
WebRTC connection — usually a restrictive NAT or firewall on both ends — the pages try to
carry an eligible encrypted file (up to **100 MiB**) through public Nostr relays. This is
the Code Exchange stand-in for TURN, but it can still fail if storage relays are
insufficient or do not deliver the pieces. (This page describes the user-facing behavior;
the technical design is in [NOSTR_FILE_RELAY.md](NOSTR_FILE_RELAY.md).)

It is fully automatic — there is no switch, and nothing changes about how you use Code
Exchange:

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
  actually carry the file — the sender's code named relays and the file is at or below
  the 100 MiB cap. It drops the receiver's direct connection and builds the response
  again with none of its network routes in it, so the sender has nothing to connect to
  and the file comes through the relays — the situation a device behind a hostile NAT
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

## Tips

- **QR and copy/paste are interchangeable**: Pick whichever is easier at each step; you can mix them
- **Order doesn't matter (QR)**: Multi-QR offer codes can be scanned in any order
- **Duplicates are fine (QR)**: Scanning the same QR code twice won't cause issues
- **Copy/paste fallback**: If cameras aren't available, use **Copy Data** on the sending side and
  the **Paste** tab on the receiving side. If the clipboard is blocked, use **Show text to copy
  manually** to select the text by hand
- **Single QR**: Very small offers may produce just one QR code — the flow still works the same way
- **A direct route is required (direct flow only)**: Without internet, both devices normally need
  to be on the same Wi-Fi or local network. With internet, STUN can help discover direct routes
  across different networks, but restrictive NAT or firewall rules can still prevent a connection.
  TURN relaying is not supported. When a direct route cannot be found, the file falls back to
  the [Nostr relay path](#relay-fallback-no-direct-connection) (offer named relays, file at or
  below 100 MiB), where the devices only need internet access to the relays, not to each other
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
| Sender reports a failed connection after the answer arrived | The direct WebRTC route is blocked and the relay fallback was unavailable or also failed. This happens when the offer named no relays, the file exceeds 100 MiB, or too few storage relays work. Start over on a network that allows a direct connection, or use the suggested offline-QR app. |
| Transfer fails after the offer is collected (direct flow) | Both devices must have network connectivity to each other (same Wi-Fi, or both on the internet). |
| Sender shows expired error | Generate a new offer by retrying the send flow. |
| Sender times out after sending (direct flow) | Keep the receiver page open until it verifies the file and sends the final data-channel ACK. |
| Relay fallback stalls or times out | Both devices need internet access to the relays, not to each other. Both pages must stay open — a side that goes silent for a few minutes ends the transfer. Everything must finish within 1 hour of the exchange start; after that, start a new one. |
