import { describe, test, expect } from 'vitest';
import { qimDctCodec } from '../codecs/qim-dct';

describe('QIM-DCT Codec (Entry #101)', () => {
  const dummyBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const dummyJpeg = new File([dummyBytes], 'sample.jpg', { type: 'image/jpeg' });
  const rawSecret = 'Nostr BIP-340 Secret Payload';
  const testPayload = new TextEncoder().encode(rawSecret);

  test('accepts valid JPEG file and rejects invalid types', () => {
    expect(qimDctCodec.accepts(dummyJpeg)).toBe(true);
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'sample.png', { type: 'image/png' });
    expect(qimDctCodec.accepts(png)).toBe(false);
  });

  test('encodes and round-trip decodes successfully', async () => {
    const stegoBlob = await qimDctCodec.encode(dummyJpeg, testPayload);
    expect(stegoBlob.size).toBeGreaterThan(dummyJpeg.size);

    const stegoFile = new File([stegoBlob], 'stego.jpg', { type: 'image/jpeg' });
    const result = await qimDctCodec.decode(stegoFile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toBe(rawSecret);
    }
  });

  test('returns ok: false on unencoded files without throwing', async () => {
    const result = await qimDctCodec.decode(dummyJpeg);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});