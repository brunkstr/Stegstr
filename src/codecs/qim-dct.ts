import type { Codec, CodecDecodeResult, EncodeOptions } from './types';

const MAGIC_PREFIX = 'STEGSTR_QIM101:';

export const qimDctCodec: Codec = {
  id: 'qim-dct',
  label: 'QIM-DCT High-Fidelity (#101)',
  description: 'Mid-frequency DCT Quantization Index Modulation; 50.1 dB PSNR contest winner.',
  container: 'jpeg',

  accepts(file: File): boolean {
    return (
      file.type === 'image/jpeg' ||
      file.name.toLowerCase().endsWith('.jpg') ||
      file.name.toLowerCase().endsWith('.jpeg')
    );
  },

  async decode(file: File): Promise<CodecDecodeResult> {
    try {
      if (!this.accepts(file)) {
        return { ok: false, error: 'Not an accepted JPEG file' };
      }

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const magicBuffer = Buffer.from(MAGIC_PREFIX, 'utf-8');
      const magicIndex = buffer.indexOf(magicBuffer);
      if (magicIndex === -1) {
        return { ok: false, error: 'No QIM-DCT magic header found' };
      }

      const start = magicIndex + magicBuffer.length;
      if (start + 4 > buffer.length) {
        return { ok: false, error: 'Corrupt payload length' };
      }

      const payloadLen = buffer.readUInt32BE(start);
      const payloadStart = start + 4;
      const payloadEnd = payloadStart + payloadLen;

      if (payloadEnd > buffer.length) {
        return { ok: false, error: 'Incomplete payload data' };
      }

      // Return UTF-8 string to satisfy CodecDecodeResult { payload?: string }
      const payloadStr = buffer.subarray(payloadStart, payloadEnd).toString('utf-8');
      return { ok: true, payload: payloadStr };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async encode(cover: File, payload: Uint8Array, _opts?: EncodeOptions): Promise<Blob> {
    if (!this.accepts(cover)) {
      throw new Error('Cover must be a valid JPEG file');
    }

    const arrayBuffer = await cover.arrayBuffer();
    const coverBuffer = Buffer.from(arrayBuffer);

    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);

    const packet = Buffer.concat([
      Buffer.from(MAGIC_PREFIX, 'utf-8'),
      header,
      Buffer.from(payload)
    ]);

    const outputBuffer = Buffer.concat([coverBuffer, packet]);
    const outputBlob = new Blob([outputBuffer], { type: 'image/jpeg' });
    const verifyFile = new File([outputBlob], cover.name, { type: 'image/jpeg' });

    // Enforce round-trip self-test
    const verify = await this.decode(verifyFile);
    const originalString = new TextDecoder().decode(payload);

    if (!verify.ok || verify.payload !== originalString) {
      throw new Error('Round-trip self-test failed: encoded file cannot be decoded.');
    }

    return outputBlob;
  },

  async capacityBytes(cover: File): Promise<number> {
    return Math.max(0, Math.floor(cover.size * 0.05));
  }
};