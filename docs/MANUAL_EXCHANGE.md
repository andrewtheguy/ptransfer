# Manual Exchange Mode Guide

This guide is intentionally high-level and user-focused.
For protocol internals, signaling payload format, and implementation details, see `docs/ARCHITECTURE.md`.

## What Manual Exchange Is

Manual Exchange is the hand-carried signaling mode. Instead of a relay coordinating the
two devices, **you** carry the sender's connection data across by hand — using a **QR code**,
**copy/paste**, or a mix of the two. The two methods are interchangeable at every step:
either side can scan or paste, whichever is more convenient.

The receiver's response can come back on its own: when the sender's device can reach
Nostr relays, the offer names a few proven ones and the receiver's answer can travel back
through them, encrypted with a key only the offer holder has. The **receiver chooses**
this explicitly once the offer is in — *send through relays* or *show a code* for the
sender to scan or paste — so both sides know which way the response went. With relays
you carry **one** code, not two. That path needs two things: the receiver must reach at
least one of the relays named in the offer, and the sender's page must stay open and
listening — closing or reloading it drops the subscription, and a response published
afterwards is never picked up. If no relay takes the response, the app falls back to the
two-code exchange with nothing lost.

Once the two devices are connected, file bytes are sent directly peer-to-peer over WebRTC
using the shared pTransfer data-channel protocol (encrypted 128KB chunks, `DONE:<chunkCount>:<byteCount>`,
then a single receiver `ACK` once `DONE` validates the chunk count and final byte count and all chunks have
authenticated and reassembled).

If a direct connection **cannot** be made — for example, a restrictive NAT or firewall on
either end — the encrypted file is carried through Nostr relays instead of failing (see
[Relay fallback](#relay-fallback-no-direct-connection)). This is automatic: there is no
switch to find. It needs only that the offer named relays (it usually does) and a file
under 100 MB; how you returned the answer, over relays or by QR, makes no difference. This
guide describes the **direct flow** unless it says otherwise.

## When to Use This

Manual mode is useful when:
- You want to transfer files between two devices on the same local network without internet
  (with no internet, nothing but the two devices is involved — the relay step drops out on its own)
- You prefer not to hand the whole rendezvous to a signaling server: the sender's code
  never touches one, and relays only ever see the receiver's response as ciphertext
- The QR/clipboard offer is only obfuscated, while file data is encrypted after the exchange

## How It Works

The two devices swap two small pieces of connection data:

1. **Offer** — sender → receiver, always carried by you
2. **Answer** — receiver → sender, through Nostr relays or carried by you (the receiver picks)

The relays the offer names for the answer do double duty: if the direct connection then
fails, they carry the encrypted file itself (the [relay fallback](#relay-fallback-no-direct-connection)).

The offer can be transferred **either** as QR code(s) **or** as copied text — the receiver
can scan it or paste it, whichever is easier.

The relay path is offered whenever the sender proved a set of relays while building the
offer. It checks its default relays in the background while the connection data is
prepared, so that part costs no waiting; if some of them are down it looks for replacements
first, and the offer code appears once it knows which relays to name. Once the receiver has
the offer, their page asks how the response should go back: **Send through relays** or
**Show a code to scan or paste**. With relays, the page then says *"Response sent to the
sender"* and there is nothing to carry back. With a code, or when no relays were proven or none accepted the
response, the answer is hand-carried — QR or copy/paste, exactly as below. The choice is
final: the two return paths do not fall back to each other.

> The relay hop moves the answer only. File bytes always travel directly between the two
> devices over WebRTC. Because the answer channel is keyed from the offer, treat the offer as
> the secret for the whole transfer: anyone who obtains it before it expires can answer it.

- **As QR codes:** The sender's offer is larger, so it is split across **multiple QR codes**
  (typically 2-4, each labeled "1 of N"). The receiver's answer, on the fallback path, is
  smaller and fits in a **single QR code**. QR codes are scanned with a phone camera / the
  in-app scanner.
- **As copy/paste:** Each side offers a **Copy Data** button that puts a base64 text blob on
  the clipboard for the other person to paste. If the browser can't access the clipboard
  (insecure context or in-app browser), use **Show text to copy manually** to select the text
  yourself.

The signaling data carries what the two devices need to find and connect to each other. Treat
it as shareable only with your intended recipient. When the offer is reassembled from QR codes,
it is error-checked (a CRC over the offer) before use — this only guards against a misread or
garbled QR code and is **separate** from the file's cryptographic integrity, which is enforced
later over WebRTC by per-chunk AES-GCM authentication. (The relay options get the same CRC
check when their code is reassembled from QR codes, and verify the file itself with per-piece
AES-GCM plus a whole-file checksum.)

## Step-by-Step

### Sender — present the offer

1. Open the app and select your file(s)
2. Under **Transfer mode**, select **Manual Exchange mode**
3. Click **Start Manual Exchange**. If some default relays are unreachable, the page
   says it is looking for others before the code appears — the answer comes back over
   whichever relays it settles on
4. The sender's offer appears as **a grid of QR codes** (typically 2-4, labeled "1 of N"),
   with a **Copy Data** button beneath them
5. Give the offer to the receiver by **either** method:
   - **QR:** tell them to scan any one QR code with their phone camera, then the rest in-app
   - **Copy/paste:** tap **Copy Data** and send the text to them (or **Show text to copy
     manually** if the copy button doesn't work), for them to paste on their device

### Receiver — take the offer, return an answer

1. On the `/receive` page, choose **Manual Exchange mode** and click **Start Receive**
2. Take in the sender's offer by **either** method:
   - **Scan tab:** point the camera at any one of the sender's QR codes, tap the link to open
     the app if needed, then scan the remaining codes one by one (progress shows "Collected 1 of N")
   - **Paste tab:** paste the copied offer text
3. Once the full offer is collected, the app validates it and generates your **answer**
4. If the sender's code named relays, the page asks how to return it: **Send through
   relays** publishes the answer for the sender's page to pick up — it then says
   **Response sent to the sender** and you are done; just keep it open. **Show a code to
   scan or paste** skips the relays entirely. The choice is final — pick relays only if
   you can reach them and the sender's page stays open
5. With a code (chosen, no relays named, or relays refused it) your answer appears as a
   **single QR code** with a **Copy Data** button — send it back to the sender by
   **either** method

### Back to Sender — connect

1. If the receiver sent the response through relays, there is nothing to do: the page
   waits for it and picks it up off the relays by itself
2. If the receiver shows a code instead, open **Scan or paste the receiver's response** and
   take the answer in by **either** method — scan the response QR with the in-app scanner,
   or paste the copied response text
3. The P2P connection establishes and the file transfers directly
4. Both sides show that the transfer completed when done

## Relay Fallback (No Direct Connection)

When the offer/answer exchange succeeds but the two devices still cannot open a direct
WebRTC connection — usually a restrictive NAT or firewall on both ends — the encrypted
file (up to **100 MB**) is carried through public Nostr relays instead of the transfer
failing. This is the Manual Exchange stand-in for TURN. (This page describes the
user-facing behavior; the technical design is in [NOSTR_FILE_RELAY.md](NOSTR_FILE_RELAY.md).)

It is fully automatic — there is no switch, and nothing changes about how you use Manual
Exchange:

1. You run the normal offer/answer exchange above. Both sides then try to connect
   directly, as always.
2. If that direct connection cannot be made, both pages switch to the relay path on their
   own. The sender encrypts the file and uploads it to a set of discovered storage relays
   as **temporary events with a 1-hour NIP-40 expiration** (a deletion request compliant
   relays honor, not guaranteed erasure — the file stays protected by its encryption
   regardless), **one copy each**. The receiver downloads the pieces while the sender is
   still uploading.
3. The two sides coordinate over a small **encrypted side channel** on the same proven
   relays the offer named for the answer — the sender announces which storage relays hold
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
  relays (it does whenever the sender could reach a few when the offer was built).
  Returning the answer by QR / copy-paste instead of over the relays does **not** disable
  it. The file must also be under 100 MB.
- **When it still fails:** the offer named no relays (none were reachable when it was
  built), or the file is over 100 MB. Then the transfer fails as before and the app
  suggests the offline-QR app for side-by-side devices.
- **Both pages must stay open** until it finishes, and everything must complete within 1
  hour of the exchange start; both screens show the remaining time.
- Relays see only encrypted pieces, sizes, timing, and the small encrypted coordination
  messages — never the file name, contents, or the key. Signaling and storage use
  separate relays.

## Tips

- **One code or two — the receiver decides**: With relays reachable, the receiver can send the answer back through them so only the sender's offer is carried by hand, or show a code and have the sender scan or paste it
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
  the [Nostr relay path](#relay-fallback-no-direct-connection) (offer named relays, file under
  100 MB), where the devices only need internet access to the relays, not to each other
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
| Receiver says the response was sent, but the sender is still waiting | Give it a few seconds. If nothing happens, both sides need to start over — the receiver's choice of relay return is final, so there is no code to carry across after it. On the retry, choose **Show a code to scan or paste** for the answer instead. |
| Sender reports a failed connection after the answer arrived | The direct WebRTC route between the devices is blocked (firewall / restrictive NAT). If the offer named relays and the file is under 100 MB, the app relays the file through Nostr automatically instead — no action needed. It only fails outright when no relays were named or the file is over 100 MB; then start over on a network that allows a direct connection. |
| Receiver shows the response code without being asked | No relay took the response (or none were reachable when the offer was made). The hand-carried answer works exactly as before. |
| Transfer fails after the offer is collected (direct flow) | Both devices must have network connectivity to each other (same Wi-Fi, or both on the internet). |
| Sender shows expired error | Generate a new offer by retrying the send flow. |
| Sender times out after sending (direct flow) | Keep the receiver page open until it verifies the file and sends the final data-channel ACK. |
| Relay fallback stalls or times out | Both devices need internet access to the relays, not to each other. Both pages must stay open — a side that goes silent for a few minutes ends the transfer. Everything must finish within 1 hour of the exchange start; after that, start a new one. |
