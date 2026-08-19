// =====================================================================
// seeded-scenario.mjs — deterministic scenario randomness for A/B runs.
//
// WHY: pubsub-churn-suite.mjs draws its scenario (node placement, churn
// victims) from Math.random + crypto.getRandomValues, neither seeded. So a
// "seed-paired" A/B where the only variable is meant to be a code change was
// actually comparing two independent random draws (Aster, council seq 1425).
//
// This module makes the SCENARIO reproducible from a single integer seed
// WITHOUT seeding the kernel's own randomness. The distinction is the whole
// point of a controlled A/B:
//
//   - SCENARIO randomness (which nodes exist, where they land in the keyspace,
//     which nodes churn each round) MUST be identical across both arms so the
//     only difference is the code under test. Driven here by a dedicated PRNG.
//
//   - KERNEL-INTERNAL randomness (writeFlight attemptId, handshake nonce, any
//     routing tie-break) MUST stay real. The two arms run different code, so
//     they legitimately consume it differently the instant behaviour diverges;
//     seeding it globally would only desync the scenario after the first
//     divergent draw. We never touch it.
//
// The seam: node ids come from createNodeIdentity({fast}) → crypto.getRandomValues.
// We install a seeded getRandomValues ONLY for the duration of the identity
// mint (withSeededCrypto), then restore the real one. Kernel publish/auth
// draws — which happen outside the mint — are untouched.
// =====================================================================

// mulberry32 — tiny deterministic PRNG, returns a float in [0,1). Same seed →
// same stream, cross-platform (pure 32-bit integer math).
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;   // avoid the all-zero fixed point
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Run `fn` with crypto.getRandomValues drawing from `rng` instead of the OS
// CSPRNG, then restore the real one — even if fn throws. Scope this as tightly
// as possible (one identity mint) so nothing else in the run is affected.
export async function withSeededCrypto(rng, fn) {
  const g = globalThis.crypto;
  const real = g.getRandomValues.bind(g);
  const seeded = (arr) => {
    const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    for (let i = 0; i < view.length; i++) view[i] = (rng() * 256) & 0xff;
    return arr;
  };
  Object.defineProperty(g, 'getRandomValues', { value: seeded, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(g, 'getRandomValues', { value: real, configurable: true, writable: true });
  }
}

// Deterministic in-place Fisher-Yates using a supplied rng. Returns a shuffled
// COPY (matches the suite's existing shuffle contract) so callers can slice.
export function seededShuffle(rng, arr) {
  const x = arr.slice();
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

// FNV-1a over a string → 8-hex-char fingerprint. Used to condense a scenario
// (sorted node ids ++ per-round victim ids) into one comparable token, so the
// A/B driver can PROVE both arms saw the identical scenario rather than assert it.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
