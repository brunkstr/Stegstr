/**
 * Fast 2-D DCT-II / DCT-III for the canonical steganography grid.
 *
 * The robust encoder transforms a whole 512x512 plane, not 8x8 blocks, so the
 * O(N^2) direct form used in `dct.ts` is far too slow here: a 512x512 plane
 * costs ~268M multiply-adds per transform, and detection runs several of them.
 * This module builds the DCT on top of a radix-2 FFT instead, which brings the
 * same transform down to a few milliseconds.
 *
 * Both transforms are orthonormal and match SciPy's `dctn(..., norm="ortho")`
 * and `idctn(..., norm="ortho")`, so the TypeScript encoder and the Python
 * research harness in `robust_lab/` agree coefficient for coefficient.
 *
 * Sizes must be powers of two.
 */

// ---------------------------------------------------------------------------
// Radix-2 complex FFT (in-place, decimation in time)
// ---------------------------------------------------------------------------

interface Twiddles {
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}

const twiddleCache = new Map<number, Twiddles>();

function twiddlesFor(n: number): Twiddles {
  const cached = twiddleCache.get(n);
  if (cached) return cached;

  if ((n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`);

  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }

  // Bit-reversal permutation table.
  const rev = new Uint32Array(n);
  let bits = 0;
  while (1 << bits < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) {
      if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    }
    rev[i] = r;
  }

  const t = { cos, sin, rev };
  twiddleCache.set(n, t);
  return t;
}

/** In-place forward FFT of the complex signal held in `re` / `im`. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  const { cos, sin, rev } = twiddlesFor(n);

  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const l = i + j;
        const r = l + half;
        const wr = cos[k];
        const wi = sin[k];
        const tr = re[r] * wr - im[r] * wi;
        const ti = re[r] * wi + im[r] * wr;
        re[r] = re[l] - tr;
        im[r] = im[l] - ti;
        re[l] += tr;
        im[l] += ti;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1-D DCT-II / DCT-III via FFT
// ---------------------------------------------------------------------------

interface DctTables {
  cosHalf: Float64Array;
  sinHalf: Float64Array;
  scale0: number;
  scaleK: number;
}

const dctCache = new Map<number, DctTables>();

function dctTables(n: number): DctTables {
  const cached = dctCache.get(n);
  if (cached) return cached;
  const cosHalf = new Float64Array(n);
  const sinHalf = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    cosHalf[k] = Math.cos((-Math.PI * k) / (2 * n));
    sinHalf[k] = Math.sin((-Math.PI * k) / (2 * n));
  }
  const t = {
    cosHalf,
    sinHalf,
    scale0: Math.sqrt(1 / (4 * n)) * 2,
    scaleK: Math.sqrt(1 / (2 * n)) * 2,
  };
  dctCache.set(n, t);
  return t;
}

/**
 * Orthonormal DCT-II of `x` into `out` (may alias `x`).
 *
 * Uses the standard even/odd reordering: interleaving the sequence so that the
 * even samples run forwards and the odd samples run backwards turns the DCT
 * into the real part of a single complex FFT.
 */
export function dct1d(x: Float64Array, out: Float64Array): void {
  const n = x.length;
  const { cosHalf, sinHalf, scale0, scaleK } = dctTables(n);

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const half = n >> 1;
  for (let i = 0; i < half; i++) {
    re[i] = x[2 * i];
    re[n - 1 - i] = x[2 * i + 1];
  }
  if (n & 1) re[half] = x[n - 1];

  fft(re, im);

  for (let k = 0; k < n; k++) {
    const v = re[k] * cosHalf[k] - im[k] * sinHalf[k];
    out[k] = v * (k === 0 ? scale0 : scaleK);
  }
}

/**
 * Orthonormal DCT-III (the exact inverse of `dct1d`) of `x` into `out`.
 *
 * Written as a single length-2N transform:
 *
 *   x[n] = Re{ sum_k c[k] * exp(i*pi*k*(2n+1) / (2N)) },  c[k] = 2*f(k)*X[k]
 *
 * Padding c to length 2N turns the exponent into exp(i*2*pi*k*n / (2N)), which
 * is precisely an inverse DFT of that length. It costs about twice a length-N
 * transform and is still far cheaper than the direct form — and unlike the
 * half-length de-interleaving tricks, the derivation has nowhere to hide a
 * sign error.
 */
export function idct1d(x: Float64Array, out: Float64Array): void {
  const n = x.length;
  const m = 2 * n;
  const { cosHalf, sinHalf, scale0, scaleK } = dctTables(n);

  const re = new Float64Array(m);
  const im = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    const c = x[k] * (k === 0 ? scale0 : scaleK);
    // exp(+i*pi*k/(2N)); the cached tables hold the negative angle.
    re[k] = c * cosHalf[k];
    im[k] = -c * sinHalf[k];
  }

  // Inverse DFT via conjugation of the forward transform.
  for (let k = 0; k < m; k++) im[k] = -im[k];
  fft(re, im);

  for (let i = 0; i < n; i++) out[i] = re[i];
}

// ---------------------------------------------------------------------------
// 2-D transforms
// ---------------------------------------------------------------------------

function transpose(a: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const t = a[i * n + j];
      a[i * n + j] = a[j * n + i];
      a[j * n + i] = t;
    }
  }
}

function applyRows(a: Float64Array, n: number, fn: (x: Float64Array, o: Float64Array) => void): void {
  const row = new Float64Array(n);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    row.set(a.subarray(i * n, i * n + n));
    fn(row, out);
    a.set(out, i * n);
  }
}

/** Orthonormal 2-D DCT-II of an n x n plane, in place. */
export function dct2d(plane: Float64Array, n: number): void {
  applyRows(plane, n, dct1d);
  transpose(plane, n);
  applyRows(plane, n, dct1d);
  transpose(plane, n);
}

/** Orthonormal 2-D DCT-III (inverse of `dct2d`) of an n x n plane, in place. */
export function idct2d(plane: Float64Array, n: number): void {
  applyRows(plane, n, idct1d);
  transpose(plane, n);
  applyRows(plane, n, idct1d);
  transpose(plane, n);
}
