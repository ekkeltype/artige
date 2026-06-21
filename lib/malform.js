// Stable Bokmål / Nynorsk assignment for a joke.
//
// ~25% of jokes are Nynorsk ('nn'), the rest Bokmål ('nb'). The choice is a pure
// function of the joke id: deterministic, stable for the life of a joke, and
// computed identically in the browser (app.js) and the Node pipeline
// (scripts/manual-translate.js) by importing THIS one module — so the live page
// and the translation backlog can never disagree on which målform a joke is.
//
// Why a hash and not "tag 25% and store it": a hash needs no extra state, never
// drifts as the archive grows, and a given joke keeps its målform forever. The
// share is ~25% by the law of large numbers (≈0.25 ± a few tenths of a % over
// thousands of jokes), not exactly 25%.
//
// ⚠️  Changing NN_SHARE or the hash REASSIGNS jokes. Any joke that flips from nn
// back to nb (or vice-versa) would render its fallback målform until re-translated,
// and existing localized.nn entries for flipped jokes become dead weight. Treat
// both as frozen once Nynorsk content exists.

export const NN_SHARE = 0.25;

// FNV-1a, 32-bit. Namespaced with a prefix so this split is independent of any
// other id-hashing we might add later. Math.imul + >>>0 make it bit-identical
// across JS engines (browser and Node).
export function malformBucket(id) {
  let h = 0x811c9dc5;
  const s = 'nn-split:' + String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 10000; // 0..9999
}

// 'nn' for ~NN_SHARE of ids, 'nb' otherwise.
export function malform(id) {
  return malformBucket(id) < NN_SHARE * 10000 ? 'nn' : 'nb';
}
