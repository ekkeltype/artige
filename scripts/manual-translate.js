// Manual, in-session backlog translation helper.
//
// The nightly cron's `claude -p` + haiku path is unreliable (silent hangs,
// timeouts) and the Bokmål quality is too low, so translation is now done
// MANUALLY in a Claude Code session (see ops/translate-backlog.md). This script
// is the deterministic half of that procedure: it selects the *same* candidate
// set scripts/translate.js would, and applies the *same* give-up/filter
// bookkeeping. The session (the model) supplies the translations in between, via
// data/_translations.json.
//
//   node scripts/manual-translate.js candidates   -> write data/_backlog.json
//   node scripts/manual-translate.js apply         -> merge data/_translations.json into jokes.json
//
// apply flags (optional):
//   --model <tag>   provenance stamped on localized.<lang>.model (default: opus-4.8-manual)

import { readFile, writeFile, rename, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { malform } from '../lib/malform.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_PATH = path.join(ROOT, 'data', 'jokes.json');
const BACKLOG_PATH = path.join(ROOT, 'data', '_backlog.json');
const TRANSLATIONS_PATH = path.join(ROOT, 'data', '_translations.json');
const FILTER_PATH = path.join(ROOT, 'data', '_filter.json');
const LOCK_PATH = path.join(ROOT, 'data', '.manual-lock');
const LOCK_TTL_MS = 8 * 60 * 60 * 1000; // a manual lock older than this = a crashed/stale run

// Mirror of translate.js: lift language/languageName off the localize prompt's
// frontmatter so we target the same `localized.<lang>` key.
function parsePrompt(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.+?)\s*$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: m[2] };
}

async function loadContext() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const t = config.translate || {};
  const promptText = await readFile(path.join(ROOT, t.promptFile), 'utf8');
  const { meta } = parsePrompt(promptText);
  const lang = meta.language;
  if (!lang) throw new Error('prompt file missing "language" in frontmatter');
  return {
    lang,
    langName: meta.languageName || lang,
    minScore: config.minScore ?? t.minScore ?? 0,
    maxAttempts: t.maxAttempts ?? 3,
  };
}

// A joke is a candidate when it lacks the translation in its ASSIGNED målform.
// lib/malform.js routes ~25% of jokes to Nynorsk ('nn') and the rest to Bokmål
// ('nb'), keyed by id. We only ever fill a joke's assigned målform; an existing
// translation in the other målform (e.g. an old nb on an nn-assigned joke) is
// left in place as a fallback and does not make the joke "done".
function isCandidate(j, minScore) {
  return !j.localized?.[malform(j.id, j.firstSeen)] && !j.filtered && (j.score ?? 0) >= minScore;
}

// Atomic write (temp + rename), same as translate.js's saveArchive.
async function saveArchive(archive) {
  const tmp = `${DATA_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(archive, null, 2));
  await rename(tmp, DATA_PATH);
}

function parseArg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function cmdCandidates() {
  const { minScore, maxAttempts } = await loadContext();
  const archive = JSON.parse(await readFile(DATA_PATH, 'utf8'));
  const candidates = archive.jokes.filter((j) => isCandidate(j, minScore));

  // Each entry carries the målform the model must write it in (nb or nn).
  const payload = candidates.map((j) => ({ id: j.id, title: j.title, body: j.body || '', lang: malform(j.id, j.firstSeen) }));
  await writeFile(BACKLOG_PATH, JSON.stringify(payload, null, 2));
  // Take a lock so the nightly cron (refresh.bat) defers while this run is active.
  if (candidates.length > 0) await writeFile(LOCK_PATH, new Date().toISOString());

  const nn = payload.filter((p) => p.lang === 'nn').length;
  const nsfw = candidates.filter((j) => j.nsfw).length;
  const att = {};
  for (const j of candidates) {
    const a = j.translateAttempts || 0;
    att[a] = (att[a] || 0) + 1;
  }
  const nearCliff = candidates.filter((j) => (j.translateAttempts || 0) >= maxAttempts - 1).length;
  console.log(`Candidates: ${candidates.length}  (nb ${candidates.length - nn}, nn ${nn})`);
  console.log(`  clean ${candidates.length - nsfw}, nsfw ${nsfw}`);
  console.log(`  by prior translateAttempts: ${JSON.stringify(att)}`);
  console.log(`  ${nearCliff} one omission from auto-filter (maxAttempts=${maxAttempts})`);
  console.log(`  -> wrote ${path.relative(ROOT, BACKLOG_PATH)} — translate each entry into its "lang" (nb → prompts/localize.md, nn → prompts/localize.nn.md)`);
  if (candidates.length === 0) console.log('Nothing to translate.');
}

async function cmdApply() {
  const { minScore, maxAttempts } = await loadContext();
  const model = parseArg('--model', 'opus-4.8-manual');

  if (!existsSync(BACKLOG_PATH)) throw new Error(`missing ${path.relative(ROOT, BACKLOG_PATH)} — run "candidates" first`);
  if (!existsSync(TRANSLATIONS_PATH)) throw new Error(`missing ${path.relative(ROOT, TRANSLATIONS_PATH)} — write your translations there first`);

  const archive = JSON.parse(await readFile(DATA_PATH, 'utf8'));
  const backlog = JSON.parse(await readFile(BACKLOG_PATH, 'utf8'));
  const translations = JSON.parse(await readFile(TRANSLATIONS_PATH, 'utf8'));
  const immediateFilter = existsSync(FILTER_PATH) ? JSON.parse(await readFile(FILTER_PATH, 'utf8')) : [];
  if (!Array.isArray(backlog) || !Array.isArray(translations)) throw new Error('_backlog.json and _translations.json must be JSON arrays');

  const at = new Date().toISOString();
  const byId = new Map(translations.map((r) => [r.id, r]));
  const filterById = new Map(immediateFilter.map((f) => [f.id, f.reason || 'content-filter']));
  const jokeById = new Map(archive.jokes.map((j) => [j.id, j]));
  // This run's candidate set is authoritative for omission counting: only jokes
  // we actually put in front of the model can be "omitted".
  const consideredIds = new Set(backlog.map((b) => b.id));

  // Safety backup before any mutation (matches the existing .bak_* convention).
  const stamp = at.replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const backupPath = `${DATA_PATH}.bak_manual_${stamp}`;
  await copyFile(DATA_PATH, backupPath);

  let translated = 0, omitted = 0, newlyFiltered = 0, immediate = 0, skipped = 0, stale = 0, nnTranslated = 0;

  for (const id of consideredIds) {
    const j = jokeById.get(id);
    if (!j) { stale++; continue; }
    // Re-check candidacy — guards against an accidental double-apply.
    if (!isCandidate(j, minScore)) { skipped++; continue; }

    if (filterById.has(id)) {
      j.filtered = true;
      j.filteredReason = filterById.get(id);
      j.filteredAt = at;
      immediate++;
      continue;
    }

    const lang = malform(id, j.firstSeen); // the joke's assigned målform — where the translation lands
    const r = byId.get(id);
    if (r && typeof r.title === 'string') {
      j.localized = j.localized || {};
      j.localized[lang] = { title: r.title, body: typeof r.body === 'string' ? r.body : '', at, model };
      translated++;
      if (lang === 'nn') nnTranslated++;
    } else {
      // Omission == untranslatable this pass; identical give-up rule to translate.js.
      j.translateAttempts = (j.translateAttempts || 0) + 1;
      omitted++;
      if (j.translateAttempts >= maxAttempts) {
        j.filtered = true;
        j.filteredReason = 'untranslatable';
        j.filteredAt = at;
        newlyFiltered++;
      }
    }
  }

  const extra = translations.filter((r) => !consideredIds.has(r.id)).map((r) => r.id);

  await saveArchive(archive);

  console.log(`Applied translations [model=${model}]:`);
  console.log(`  translated     ${translated} (nn ${nnTranslated}, nb ${translated - nnTranslated})`);
  console.log(`  omitted        ${omitted} (attempts bumped; ${newlyFiltered} hit maxAttempts -> filtered)`);
  if (immediate) console.log(`  hard-filtered  ${immediate} (from _filter.json)`);
  if (skipped) console.log(`  skipped        ${skipped} (already translated/filtered)`);
  if (stale) console.log(`  stale ids      ${stale} (no longer in archive)`);
  if (extra.length) console.log(`  WARNING: ${extra.length} translation(s) for ids not in this run: ${extra.slice(0, 10).join(', ')}${extra.length > 10 ? ' …' : ''}`);
  console.log(`  backup -> ${path.relative(ROOT, backupPath)}`);
}

// Lock helpers so refresh.bat can defer to an in-progress manual run.
async function cmdLocked() {
  // exit 0 = a FRESH manual lock is held (caller should skip); exit 1 = clear to run
  if (!existsSync(LOCK_PATH)) process.exit(1);
  let ts = NaN;
  try { ts = new Date((await readFile(LOCK_PATH, 'utf8')).trim()).getTime(); } catch {}
  const age = Date.now() - ts;
  if (Number.isFinite(age) && age >= 0 && age < LOCK_TTL_MS) {
    console.log(`manual translation lock held (age ${Math.round(age / 60000)}m); defer`);
    process.exit(0);
  }
  console.log('no fresh manual lock; clear to run');
  process.exit(1);
}

async function cmdRelease() {
  if (existsSync(LOCK_PATH)) await rm(LOCK_PATH, { force: true });
  console.log('manual lock released');
}

const cmd = process.argv[2];
const run = cmd === 'candidates' ? cmdCandidates
  : cmd === 'apply' ? cmdApply
  : cmd === 'locked' ? cmdLocked
  : cmd === 'release' ? cmdRelease
  : null;
if (!run) {
  console.error('usage: node scripts/manual-translate.js <candidates|apply|locked|release> [--model <tag>]');
  process.exit(2);
}
run().catch((e) => { console.error(e.message || e); process.exit(1); });
