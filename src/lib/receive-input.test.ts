import { describe, expect, test } from 'vitest';
import { base64urlEncode, buildChunkUrl, chunkPayload } from './chunk-utils';
import {
  generateMutualClipboardData,
  generateMutualOfferBinary,
} from './code-signaling';
import { generatePin, PIN_CHARSET } from './crypto';
import { buildPinUrl } from './pin-link';
import { classifyReceiveText, looksLikePin } from './receive-input';

const ORIGIN = 'https://ptransfer.example';

const mockOffer: RTCSessionDescriptionInit = {
  type: 'offer',
  sdp: 'v=0\r\no=- 123 456 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 1 RTP/AVP 111\r\nc=IN IP4 127.0.0.1',
};
const mockCandidates: RTCIceCandidate[] = [
  {
    candidate: 'candidate:1 1 UDP 123 127.0.0.1 12345 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
  } as RTCIceCandidate,
];

function buildOfferBinary(): Uint8Array {
  const publicKey = new Uint8Array(65).fill(1);
  publicKey[0] = 4; // Uncompressed point prefix
  return generateMutualOfferBinary(mockOffer, mockCandidates, {
    createdAt: Date.now(),
    fileName: 'test.txt',
    fileSize: 1024,
    contentEncoding: 'deflate-raw',
    mimeType: 'text/plain',
    publicKey,
    salt: new Uint8Array(16).fill(2),
  });
}

describe('classifyReceiveText', () => {
  test('recognizes a bare PIN', () => {
    const pin = generatePin();
    expect(classifyReceiveText(pin)).toEqual({
      kind: 'pin',
      pin,
      pinKind: 'standard',
    });
  });

  test('recognizes a PIN link', () => {
    const pin = generatePin();
    expect(classifyReceiveText(buildPinUrl(ORIGIN, pin))).toEqual({
      kind: 'pin',
      pin,
      pinKind: 'standard',
    });
  });

  test('tolerates surrounding whitespace', () => {
    const pin = generatePin();
    expect(classifyReceiveText(`  ${pin}\n`)).toEqual({
      kind: 'pin',
      pin,
      pinKind: 'standard',
    });
  });

  // The whole point of the longer form: nobody tells the receiver which mode
  // the sender chose, so the classification has to carry it.
  test('reports an anonymous-signaling PIN as its own kind', () => {
    const pin = generatePin('anonymous');
    expect(classifyReceiveText(pin)).toEqual({
      kind: 'pin',
      pin,
      pinKind: 'anonymous',
    });
  });

  test('recognizes an anonymous PIN carried in a PIN link', () => {
    const pin = generatePin('anonymous');
    expect(classifyReceiveText(buildPinUrl(ORIGIN, pin))).toEqual({
      kind: 'pin',
      pin,
      pinKind: 'anonymous',
    });
  });

  test('recognizes a copied offer', () => {
    const binary = buildOfferBinary();
    const result = classifyReceiveText(generateMutualClipboardData(binary));
    expect(result?.kind).toBe('offer');
    if (result?.kind !== 'offer') throw new Error('expected an offer');
    expect(Array.from(result.payload)).toEqual(Array.from(binary));
  });

  test('recognizes a chunk URL', () => {
    const chunk = chunkPayload(buildOfferBinary())[0];
    const result = classifyReceiveText(buildChunkUrl(ORIGIN, chunk));
    expect(result).toEqual({
      kind: 'offer-chunk',
      param: base64urlEncode(chunk),
    });
  });

  test('rejects a mistyped PIN rather than guessing', () => {
    const pin = generatePin();
    const swapped =
      PIN_CHARSET[(PIN_CHARSET.indexOf(pin[0]) + 1) % PIN_CHARSET.length] +
      pin.slice(1);
    expect(classifyReceiveText(swapped)).toBeNull();
  });

  test('rejects a truncated offer', () => {
    const encoded = generateMutualClipboardData(buildOfferBinary());
    expect(classifyReceiveText(encoded.slice(0, 4))).toBeNull();
  });

  test('rejects empty and unrelated input', () => {
    expect(classifyReceiveText('')).toBeNull();
    expect(classifyReceiveText('   ')).toBeNull();
    expect(classifyReceiveText('hello there')).toBeNull();
    expect(classifyReceiveText('https://example.com/')).toBeNull();
  });

  test('a PIN never classifies as an offer, and an offer never as a PIN', () => {
    const pin = generatePin();
    expect(classifyReceiveText(pin)?.kind).toBe('pin');
    const encoded = generateMutualClipboardData(buildOfferBinary());
    expect(classifyReceiveText(encoded)?.kind).toBe('offer');
    expect(looksLikePin(encoded)).toBe(false);
  });
});

describe('looksLikePin', () => {
  test('accepts PIN-shaped text regardless of checksum', () => {
    const pin = generatePin();
    expect(looksLikePin(pin)).toBe(true);
    expect(looksLikePin(`x${pin.slice(1)}`)).toBe(true);
    expect(looksLikePin(` ${pin} `)).toBe(true);
  });

  test('rejects wrong lengths and out-of-charset characters', () => {
    const pin = generatePin();
    expect(looksLikePin(pin.slice(0, 11))).toBe(false);
    expect(looksLikePin(`${pin}A`)).toBe(false);
    expect(looksLikePin(`0${pin.slice(1)}`)).toBe(false);
  });
});
