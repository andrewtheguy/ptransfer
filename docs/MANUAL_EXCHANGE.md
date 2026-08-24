# Manual Exchange Mode Guide

This guide is intentionally high-level and user-focused.
For protocol internals, signaling payload format, and implementation details, see `docs/ARCHITECTURE.md`.

## What Manual Exchange Is

Manual Exchange is the no-server signaling mode. Instead of a relay coordinating the
two devices, **you** carry the connection data between them by hand — using **QR codes**,
**copy/paste**, or a mix of the two. The two methods are interchangeable at every step:
either side can scan or paste, whichever is more convenient.

Once the two devices are connected, file bytes are sent directly peer-to-peer over WebRTC
using the shared pTransfer data-channel protocol (encrypted 128KB chunks, `DONE:<chunkCount>:<byteCount>`,
then a single receiver `ACK` once `DONE` validates the chunk count and final byte count and all chunks have
authenticated and reassembled).

This guide describes that **direct flow** unless it says otherwise. The experimental
[Relay file through Nostr](#experimental-relay-file-through-nostr) option replaces it
entirely: there is no offer/answer, no WebRTC connection between the two devices, and no
direct route between them is needed — see that section for how it differs.

## When to Use This

Manual mode is useful when:
- You want to transfer files between two devices on the same local network without internet
- You prefer not to use any signaling server
- You want no signaling server involved; the QR/clipboard signaling payload is only obfuscated, while file data is encrypted after the exchange

## How It Works

The two devices swap two small pieces of connection data:

1. **Offer** — sender → receiver
2. **Answer** — receiver → sender

Each piece can be transferred **either** as QR code(s) **or** as copied text — the receiver
can scan the offer or paste it, and the sender can scan the answer or paste it. Mixing works
too (e.g. QR one direction, copy/paste the other).

- **As QR codes:** The sender's offer is larger, so it is split across **multiple QR codes**
  (typically 2-4, each labeled "1 of N"). The receiver's answer is smaller and fits in a
  **single QR code**. QR codes are scanned with a phone camera / the in-app scanner.
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
3. Click **Start Manual Exchange**
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
4. Your answer appears as a **single QR code** with a **Copy Data** button
5. Send the answer back to the sender by **either** method — show the QR code, or copy/paste
   the text the same way

### Back to Sender — connect

1. Take in the receiver's answer by **either** method — scan the response QR with the in-app
   scanner, or paste the copied response text
2. The P2P connection establishes and the file transfers directly
3. Both sides show that the transfer completed when done

## Experimental: Relay File Through Nostr

Under **Advanced options** (visible when Manual Exchange is selected on the send tab), the
**Relay file through Nostr** switch replaces the direct connection with encrypted pieces
carried through public Nostr relays, for files up to **100 MB**. (This page describes the
user-facing behavior; the technical design is documented in
[NOSTR_FILE_RELAY.md](NOSTR_FILE_RELAY.md).)

1. The sender's file is encrypted with a random key and uploaded to a set of discovered
   storage relays as **temporary events with a 1-hour NIP-40 expiration** — a deletion
   request that compliant relays honor by pruning the events, not guaranteed erasure; the
   file stays protected by its encryption regardless. The sender gets the exchange code
   (a single QR or copy/paste) after checking the signaling relays. Storage relays are
   normally found in the background while the code is shared; if a default signaling
   relay fails, storage selection runs first so unused healthy relays can fill the
   signaling set. The sender keeps the page open while the encrypted pieces upload in
   the background, **one copy
   each**, so the upload costs about the file size in bandwidth
2. The receiver pastes/scans the code in the normal Manual Exchange receive flow — it is
   detected automatically — and starts downloading the pieces while the sender is still
   uploading. The two sides coordinate over a small **encrypted side channel on a few
   dedicated signaling relays** named in the code (keyed from the code, so only the two
   of you can read it): the sender announces which storage relays hold which pieces, the
   receiver acknowledges and names any piece it could not fetch, and **only those pieces
   are sent again**, to another relay — nothing is duplicated up front
3. The sender's page completes on its own once the receiver has verified the whole file

Differences from normal Manual Exchange:

- **No answer step**: the receiver never sends a code back. The sender's page shows the
  receiver's progress and completes when the receiver has the verified file
- **Connectivity**: no WebRTC connection is made — the peers never connect to each other,
  and both only need internet access to the relays. Both pages must stay open until the
  transfer completes (a side that goes silent for a few minutes ends it)
- **Time limit**: everything must finish within 1 hour of the transfer *start* — the app
  enforces this deadline, and expired pieces are pruned by compliant relays (deletion is
  requested via NIP-40, not cryptographically guaranteed); both screens show the
  remaining time
- **The code IS the key**: unlike signaling payloads, this code contains the decryption key.
  Anyone who obtains it before expiry can download and decrypt the file — share it only over
  a trusted channel (in person, or an end-to-end encrypted messenger)
- Relays see only encrypted pieces, sizes, timing, and the small encrypted coordination
  messages — never the file name, contents, or the decryption key. Signaling and storage
  use separate relays: the coordination channel rides a few proven signaling relays,
  while the pieces go to relays that passed a full-size health check — never the same
  relay for both

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
  TURN relaying is not supported. This does not apply to the Nostr relay options — the devices
  never connect to each other, so each only needs internet access to the relays
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
| Transfer fails after the offer is collected (direct flow) | Both devices must have network connectivity to each other (same Wi-Fi, or both on the internet). |
| Sender shows expired error | Generate a new offer by retrying the send flow. |
| Sender times out after sending (direct flow) | Keep the receiver page open until it verifies the file and sends the final data-channel ACK. |
| Relay transfer stalls or times out (Nostr relay options) | Both devices need internet access to the relays, not to each other. With *Live*, both pages must stay open — a side that goes silent for a few minutes ends the transfer. Everything must also finish within 1 hour of the transfer start; after that, start a new one. |
