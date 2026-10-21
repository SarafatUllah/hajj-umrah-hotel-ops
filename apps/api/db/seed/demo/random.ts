/** mulberry32: a tiny seeded PRNG. Same seed, same sequence, on every machine. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Stable string -> 32-bit seed (FNV-1a), so each hotel/period gets its own independent, reproducible stream. */
export function seedFromString(s: string): number {
  let h = 0x811C9DC5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Deterministic Fisher-Yates; returns a new array (the input is never mutated). */
export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/** The stable stream for one purpose of one hotel (e.g. `MKK-GRAND|renovations`). */
export function streamFor(hotelCode: string, purpose: string): () => number {
  return mulberry32(seedFromString(`${hotelCode}|${purpose}`))
}
