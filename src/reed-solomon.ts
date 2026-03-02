/**
 * Minimal Reed-Solomon encoder/decoder over GF(2^8) for browser use.
 * Compatible with Python's `reedsolo` library (primitive polynomial 0x11d,
 * generator root = 0, fcr = 0, prim = 2).
 *
 * Supports:
 *   - encode(data, nsym) -> data + parity
 *   - decode(data, nsym, erasePos?) -> corrected message (without parity)
 *   - nsym up to 255 (we use 128 for QIM)
 *
 * This implementation is self-contained with no npm dependencies.
 */

// ---------------------------------------------------------------------------
// GF(2^8) arithmetic with primitive polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1)
// Same as Python reedsolo default.
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512); // anti-log table, doubled for convenience
const GF_LOG = new Uint8Array(256); // log table

function initGaloisTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d; // reduce by primitive polynomial
    }
  }
  // Duplicate for wraparound so we can index up to 510
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

initGaloisTables();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("GF division by zero");
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
}

function gfInverse(x: number): number {
  return GF_EXP[255 - GF_LOG[x]];
}

// ---------------------------------------------------------------------------
// Polynomial operations (coefficients are GF(2^8) elements, index 0 = highest degree)
// ---------------------------------------------------------------------------

function polyMul(p: Uint8Array, q: Uint8Array): Uint8Array {
  const result = new Uint8Array(p.length + q.length - 1);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) {
      result[i + j] ^= gfMul(p[i], q[j]);
    }
  }
  return result;
}

function polyEval(poly: Uint8Array, x: number): number {
  let y = poly[0];
  for (let i = 1; i < poly.length; i++) {
    y = gfMul(y, x) ^ poly[i];
  }
  return y;
}

function polyScale(poly: Uint8Array, x: number): Uint8Array {
  const result = new Uint8Array(poly.length);
  for (let i = 0; i < poly.length; i++) {
    result[i] = gfMul(poly[i], x);
  }
  return result;
}

function polyAdd(p: Uint8Array, q: Uint8Array): Uint8Array {
  const result = new Uint8Array(Math.max(p.length, q.length));
  const pOff = result.length - p.length;
  const qOff = result.length - q.length;
  for (let i = 0; i < p.length; i++) result[i + pOff] ^= p[i];
  for (let i = 0; i < q.length; i++) result[i + qOff] ^= q[i];
  return result;
}

// ---------------------------------------------------------------------------
// Generator polynomial: product of (x - alpha^i) for i = fcr..fcr+nsym-1
// With fcr=0 (matching reedsolo default), roots are alpha^0, alpha^1, ..., alpha^(nsym-1).
// ---------------------------------------------------------------------------

function rsGeneratorPoly(nsym: number): Uint8Array {
  let g = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) {
    g = polyMul(g, new Uint8Array([1, GF_EXP[i]]));
  }
  return g;
}

// Cache generator polynomials by nsym
const generatorCache = new Map<number, Uint8Array>();

function getGenerator(nsym: number): Uint8Array {
  let g = generatorCache.get(nsym);
  if (!g) {
    g = rsGeneratorPoly(nsym);
    generatorCache.set(nsym, g);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Encode: append nsym parity bytes to data
// ---------------------------------------------------------------------------

/**
 * Reed-Solomon encode: returns a new Uint8Array of length data.length + nsym,
 * with the original data followed by nsym parity bytes.
 */
export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  const gen = getGenerator(nsym);
  // Polynomial long division: data * x^nsym / gen
  const feedback = new Uint8Array(data.length + nsym);
  feedback.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = feedback[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        feedback[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  // Result = original data + remainder (parity)
  const out = new Uint8Array(data.length + nsym);
  out.set(data, 0);
  for (let i = 0; i < nsym; i++) {
    out[data.length + i] = feedback[data.length + i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Syndromes
// ---------------------------------------------------------------------------

function calcSyndromes(msg: Uint8Array, nsym: number): Uint8Array {
  const synd = new Uint8Array(nsym + 1);
  for (let i = 0; i < nsym; i++) {
    synd[i + 1] = polyEval(msg, GF_EXP[i]);
  }
  return synd;
}

function checkSyndromes(synd: Uint8Array): boolean {
  for (let i = 1; i < synd.length; i++) {
    if (synd[i] !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Erasure handling: Forney algorithm with known erasure positions
// ---------------------------------------------------------------------------

function rsCalcErasureLocator(erasePosFromEnd: number[]): Uint8Array {
  // erasePosFromEnd[i] = position from the end of the message
  let eLoc = new Uint8Array([1]);
  for (const pos of erasePosFromEnd) {
    eLoc = polyMul(eLoc, new Uint8Array([1, GF_EXP[pos]]));
  }
  return eLoc;
}

// ---------------------------------------------------------------------------
// Berlekamp-Massey to find the error locator polynomial
// ---------------------------------------------------------------------------

function rsBerlekampMassey(synd: Uint8Array, nsym: number, eraseCount: number): Uint8Array {
  // synd[0] is unused (index 0 placeholder), actual syndromes are synd[1..nsym]
  const N = nsym - eraseCount;
  // Reversed syndromes for BM (BM works with index 0 = S_1)
  const s = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    s[i] = synd[eraseCount + i + 1];
  }

  let errLoc = new Uint8Array([1]);
  let oldLoc = new Uint8Array([1]);

  for (let i = 0; i < N; i++) {
    const K = i + 1;
    let delta = s[i];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], s[i - j]);
    }
    // Shift oldLoc
    const shiftedOld = new Uint8Array(oldLoc.length + 1);
    shiftedOld.set(oldLoc, 0);
    // shiftedOld is oldLoc * x

    if (delta === 0) {
      oldLoc = shiftedOld;
    } else {
      if (2 * (errLoc.length - 1) <= K - 1) {
        // Update: errLoc, oldLoc swap
        const newLoc = polyAdd(errLoc, polyScale(shiftedOld, delta));
        oldLoc = polyScale(errLoc, gfInverse(delta));
        errLoc = newLoc;
      } else {
        errLoc = polyAdd(errLoc, polyScale(shiftedOld, delta));
        oldLoc = shiftedOld;
      }
    }
  }

  // Strip leading zeros
  let start = 0;
  while (start < errLoc.length - 1 && errLoc[start] === 0) start++;
  if (start > 0) errLoc = errLoc.slice(start);

  const errs = errLoc.length - 1;
  if (2 * errs + eraseCount > nsym) {
    throw new Error("Too many errors to correct");
  }

  return errLoc;
}

// ---------------------------------------------------------------------------
// Chien search: find roots of the error locator polynomial
// ---------------------------------------------------------------------------

function rsChienSearch(errLoc: Uint8Array, msgLen: number): number[] {
  const numErrs = errLoc.length - 1;
  const positions: number[] = [];
  for (let i = 0; i < msgLen; i++) {
    if (polyEval(errLoc, GF_EXP[i]) === 0) {
      positions.push(msgLen - 1 - i);
    }
  }
  if (positions.length !== numErrs) {
    throw new Error("Could not find all error positions (Chien search failed)");
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Forney algorithm: compute error magnitudes
// ---------------------------------------------------------------------------

function rsForney(
  synd: Uint8Array,
  combinedLocator: Uint8Array,
  positions: number[],
  msgLen: number,
): Uint8Array {
  // Omega = S(x) * Lambda(x) mod x^nsym
  // Where S(x) = synd[1] + synd[2]*x + ... (reversed)
  const nsym = synd.length - 1;

  // Build syndrome polynomial: S(x) = synd[1]*x^(nsym-1) + ... + synd[nsym]
  // Actually for Forney: Omega = Synd * ErrLoc mod x^(nsym+1)
  // Reverse syndromes for polynomial multiplication
  const syndPoly = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) {
    syndPoly[i] = synd[nsym - i];
  }
  // Omega = syndPoly * combinedLocator, take last nsym terms
  const product = polyMul(syndPoly, combinedLocator);
  const omega = product.slice(product.length - nsym);

  // Formal derivative of locator: keep only odd-power terms
  // Lambda'(x): for Lambda = c0*x^n + c1*x^(n-1) + ... cn, derivative coefficients
  const derivLen = combinedLocator.length - 1;
  const formalDeriv = new Uint8Array(derivLen);
  for (let i = 0; i < combinedLocator.length; i++) {
    const power = combinedLocator.length - 1 - i; // power of this coefficient
    if (power % 2 === 1) {
      // Odd powers survive differentiation (in GF(2))
      formalDeriv[formalDeriv.length - 1 - (power - 1) / 2] = combinedLocator[i];
    }
  }

  const magnitude = new Uint8Array(msgLen);
  for (const pos of positions) {
    const xi = GF_EXP[msgLen - 1 - pos]; // X_i = alpha^(n-1-pos)
    const xiInv = gfInverse(xi);
    const omegaVal = polyEval(omega, xiInv);
    const derivVal = polyEval(formalDeriv, xiInv);
    if (derivVal === 0) throw new Error("Forney: zero derivative");
    magnitude[pos] = gfDiv(omegaVal, derivVal);
  }
  return magnitude;
}

// ---------------------------------------------------------------------------
// Decode: correct errors and erasures, return original data (without parity)
// ---------------------------------------------------------------------------

/**
 * Reed-Solomon decode: given a codeword of length k+nsym, correct errors and
 * erasures and return the original k data bytes.
 *
 * erasePos: optional array of known erasure positions (0-indexed into the
 * codeword, matching Python reedsolo's erase_pos convention where position 0
 * is the first data byte).
 *
 * Throws on uncorrectable errors.
 */
export function rsDecode(
  codeword: Uint8Array,
  nsym: number,
  erasePos?: number[],
): Uint8Array {
  if (codeword.length > 255) {
    throw new Error("Codeword length exceeds GF(2^8) limit of 255");
  }

  const msg = new Uint8Array(codeword);
  const msgLen = msg.length;

  // Calculate syndromes
  const synd = calcSyndromes(msg, nsym);
  if (checkSyndromes(synd)) {
    // No errors
    return msg.slice(0, msgLen - nsym);
  }

  // Erasure positions (convert to positions from end for locator calculation)
  const erasures = erasePos ? erasePos.filter((p) => p >= 0 && p < msgLen) : [];

  // Correct erasures first by converting to error positions
  // For the Forney algorithm, we need positions from end = msgLen - 1 - pos
  const eraseFromEnd = erasures.map((p) => msgLen - 1 - p);

  // Erasure locator polynomial
  let eraseLoc = new Uint8Array([1]);
  if (erasures.length > 0) {
    eraseLoc = rsCalcErasureLocator(eraseFromEnd);

    // Modify syndromes to account for erasures
    // Forney syndromes: S_e = S * eraseLoc
    // This allows BM to find remaining errors
  }

  // Compute Forney syndromes (syndromes modified for erasures)
  // fsynd[i] = sum over erasures of alpha^(pos*i) * synd, modified iteratively
  const fsynd = new Uint8Array(nsym + 1);
  for (let i = 0; i <= nsym; i++) fsynd[i] = synd[i];

  for (const pos of eraseFromEnd) {
    const x = GF_EXP[pos];
    for (let i = nsym; i > 0; i--) {
      fsynd[i] = gfMul(fsynd[i], x) ^ fsynd[i - 1];
    }
  }

  // Find error locator polynomial using BM on modified syndromes
  let errLoc: Uint8Array;
  try {
    errLoc = rsBerlekampMassey(fsynd, nsym, erasures.length);
  } catch {
    throw new Error("Too many errors to correct");
  }

  // Combine erasure and error locator polynomials
  const combinedLoc = erasures.length > 0 ? polyMul(errLoc, eraseLoc) : errLoc;

  // Find all error+erasure positions via Chien search
  let allPositions: number[];
  try {
    allPositions = rsChienSearch(combinedLoc, msgLen);
  } catch {
    throw new Error("Could not locate all errors (Chien search failed)");
  }

  // Compute error magnitudes using Forney algorithm
  const magnitudes = rsForney(synd, combinedLoc, allPositions, msgLen);

  // Apply corrections
  for (const pos of allPositions) {
    msg[pos] ^= magnitudes[pos];
  }

  // Verify syndromes are zero after correction
  const syndCheck = calcSyndromes(msg, nsym);
  if (!checkSyndromes(syndCheck)) {
    throw new Error("Decode failed: residual syndrome after correction");
  }

  return msg.slice(0, msgLen - nsym);
}

// ---------------------------------------------------------------------------
// RSCodec convenience class (mirrors Python reedsolo.RSCodec interface)
// ---------------------------------------------------------------------------

export class RSCodec {
  readonly nsym: number;

  constructor(nsym: number) {
    this.nsym = nsym;
  }

  /** Encode data, returning data + parity bytes. */
  encode(data: Uint8Array): Uint8Array {
    // For messages longer than 255-nsym bytes, split into chunks
    const maxChunkData = 255 - this.nsym;
    if (data.length <= maxChunkData) {
      return rsEncode(data, this.nsym);
    }
    // Chunk encoding for long messages
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < data.length; i += maxChunkData) {
      const chunk = data.slice(i, Math.min(i + maxChunkData, data.length));
      chunks.push(rsEncode(chunk, this.nsym));
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /**
   * Decode codeword, returning the original data (without parity).
   * erasePos: optional known erasure positions.
   */
  decode(codeword: Uint8Array, erasePos?: number[]): Uint8Array {
    const maxChunkCode = 255;
    if (codeword.length <= maxChunkCode) {
      return rsDecode(codeword, this.nsym, erasePos);
    }
    // Chunk decoding
    const maxChunkData = 255 - this.nsym;
    const chunkCodeLen = maxChunkData + this.nsym;
    const chunks: Uint8Array[] = [];
    let eraseOffset = 0;
    for (let i = 0; i < codeword.length; i += chunkCodeLen) {
      const chunk = codeword.slice(i, Math.min(i + chunkCodeLen, codeword.length));
      // Filter erasure positions for this chunk
      let chunkErase: number[] | undefined;
      if (erasePos) {
        chunkErase = [];
        for (const ep of erasePos) {
          if (ep >= eraseOffset && ep < eraseOffset + chunk.length) {
            chunkErase.push(ep - eraseOffset);
          }
        }
        if (chunkErase.length === 0) chunkErase = undefined;
      }
      chunks.push(rsDecode(chunk, this.nsym, chunkErase));
      eraseOffset += chunk.length;
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}
