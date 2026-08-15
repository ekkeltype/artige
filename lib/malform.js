// Stable Bokmål / Nynorsk assignment for a joke.
//
// The choice is a pure function of (joke id, firstSeen): deterministic, stable
// for the life of a joke, and computed identically in the browser (app.js) and
// the Node pipeline (scripts/manual-translate.js) by importing THIS one module —
// so the live page and the translation backlog can never disagree on which
// målform a joke is.
//
// Two eras (2026-08-15 quota change): jokes ingested before NN_CUTOFF keep the
// original ~25% Nynorsk share; jokes ingested after get ~5%. The era is decided
// by `firstSeen` (stamped once at ingest, never rewritten), NOT by the Reddit id
// — the backfill walks backwards in time, so id order says when a joke was
// *posted*, while firstSeen says when it entered OUR archive, which is what
// "new" means for the quota. A missing firstSeen counts as the legacy era.
//
// Why a hash and not "tag N% and store it": a hash needs no extra state, never
// drifts as the archive grows, and a given joke keeps its målform forever. The
// share is approximate (± a few tenths of a % over thousands of jokes).
//
// ⚠️  Changing the shares, the cutoff, or the hash REASSIGNS jokes. Any joke that
// flips from nn back to nb (or vice-versa) would render its fallback målform
// until re-translated, and existing localized.nn entries for flipped jokes
// become dead weight. Treat all three as frozen once content exists for an era.

export const NN_SHARE = 0.25; // legacy era (firstSeen < NN_CUTOFF)
export const NN_SHARE_NEW = 0.05; // current era
export const NN_CUTOFF = '2026-08-15T00:00:00.000Z';

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

// 'nn' for ~NN_SHARE of legacy ids / ~NN_SHARE_NEW of current-era ids, 'nb'
// otherwise. ISO-8601 strings compare correctly as plain strings.
export function malform(id, firstSeen) {
  const share = firstSeen && String(firstSeen) >= NN_CUTOFF ? NN_SHARE_NEW : NN_SHARE;
  return malformBucket(id) < share * 10000 ? 'nn' : 'nb';
}
