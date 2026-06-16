// Fetches jokes from arctic-shift's archive of Reddit.
//
// Two modes (independent, controlled by config):
//
//   backfill — walks a cursor backward through time in fixed-width windows.
//              Each run harvests one window's worth of posts, then moves the
//              cursor back by `chunkDays`. When the cursor reaches `floor`,
//              it loops to (yesterday) so the recent gap gets re-covered.
//              State is persisted in data/backfill.json. This is what keeps
//              the archive growing daily even when nothing new is happening
//              on Reddit today.
//
//   live    — single "last 2d" pull (the same shape as a normal cron refresh).
//              Off by default; enable in config if you want both modes
//              running each day.
//
// Both modes share the dedup-by-id, minScore filter, and translation pipeline.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_PATH = path.join(ROOT, 'data', 'jokes.json');
const BACKFILL_PATH = path.join(ROOT, 'data', 'backfill.json');
const ARCTIC_BASE = 'https://arctic-shift.photon-reddit.com/api/posts/search';
const DAY_MS = 86400 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDay = (d) => d.toISOString().slice(0, 10);

async function loadJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(await readFile(p, 'utf8'));
}

function normalize(post) {
  return {
    id: post.id,
    subreddit: post.subreddit,
    title: post.title,
    body: post.selftext || '',
    score: post.score,
    flair: post.link_flair_text || null,
    nsfw: !!post.over_18,
    author: post.author,
    permalink: `https://www.reddit.com${post.permalink}`,
    createdUtc: post.created_utc,
  };
}

async function arcticGet(url, userAgent) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? Infinity);
  const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0);
  if (Number.isFinite(remaining) && remaining < 5 && reset > 0) {
    console.log(`  rate limit low (${remaining} left); sleeping ${reset}s`);
    await sleep(reset * 1000);
  }
  return res.json();
}

// Paginate posts in [after, before), newest-first. Each page uses the previous
// page's oldest created_utc as the next `before`. Stops on a short page or
// when maxPages is hit. The is_self/!stickied filter is applied client-side.
// Returns { posts, ok }, where `ok` is true iff at least one request actually
// reached the API — letting the caller tell an empty window apart from an outage.
async function fetchPaginated(name, after, before, limit, maxPages, userAgent) {
  const all = [];
  let cursorBefore = before;
  let ok = false;
  for (let page = 1; page <= maxPages; page++) {
    const url =
      `${ARCTIC_BASE}?subreddit=${encodeURIComponent(name)}` +
      `&sort=desc&limit=${limit}` +
      `&after=${encodeURIComponent(after)}` +
      `&before=${encodeURIComponent(cursorBefore)}`;
    let items;
    try {
      const data = await arcticGet(url, userAgent);
      ok = true; // reached the API (even if it returned zero items)
      items = data.data ?? [];
    } catch (err) {
      // Stop paginating on a per-page error but keep what we already have,
      // so one bad page doesn't void the whole sub's window.
      console.error(`\n    page ${page} failed (${err.message}); stopping at ${all.length} posts`);
      break;
    }
    all.push(...items);
    if (items.length < limit) break; // last page
    const oldest = items[items.length - 1].created_utc;
    cursorBefore = new Date(oldest * 1000).toISOString();
    await sleep(1000);
  }
  return { posts: all.filter((p) => !p.stickied && p.is_self), ok };
}

function ingest(posts, byId, fetchedAt, extraFields = {}) {
  let added = 0;
  let updated = 0;
  for (const raw of posts) {
    const j = normalize(raw);
    const existing = byId.get(j.id);
    if (existing) {
      existing.score = j.score;
      existing.flair = j.flair;
      existing.lastSeen = fetchedAt;
      updated++;
    } else {
      byId.set(j.id, { ...j, firstSeen: fetchedAt, lastSeen: fetchedAt, ...extraFields });
      added++;
    }
  }
  return { added, updated };
}

async function runBackfill(config, byId, fetchedAt) {
  const { chunkDays, maxPagesPerSub, floor, start } = config.backfill;
  const state = await loadJson(BACKFILL_PATH, { cursor: start });
  const cursorDate = new Date(state.cursor);
  const windowBefore = isoDay(cursorDate);
  const windowAfter = isoDay(new Date(cursorDate.getTime() - chunkDays * DAY_MS));
  console.log(`[backfill] window: ${windowAfter} -> ${windowBefore} (${chunkDays}d)`);

  let added = 0;
  let updated = 0;
  let considered = 0;
  let anyReachable = false; // did at least one sub's request actually succeed?
  for (const sub of config.subreddits) {
    try {
      process.stdout.write(`  r/${sub} ...`);
      const { posts, ok } = await fetchPaginated(
        sub, windowAfter, windowBefore,
        config.limitPerSub, maxPagesPerSub, config.userAgent,
      );
      if (ok) anyReachable = true;
      considered += posts.length;
      const r = ingest(posts, byId, fetchedAt, {
        sourceWindow: { after: windowAfter, before: windowBefore },
      });
      added += r.added;
      updated += r.updated;
      console.log(` ${posts.length} fetched, +${r.added}/~${r.updated}`);
      await sleep(1000);
    } catch (err) {
      console.error(`  r/${sub} FAILED: ${err.message}`);
    }
  }

  // If every sub's request failed (e.g. an arctic-shift outage — HTTP 522), we
  // harvested nothing because the source was unreachable, not because the window
  // was empty. Leave the cursor untouched so this window is retried next run
  // instead of being silently skipped — which would punch a permanent hole in
  // the backfill.
  if (!anyReachable) {
    console.error(`[backfill] all subs unreachable; cursor stays at ${windowBefore} (window retried next run)`);
    return { added, updated };
  }

  // advance cursor; loop to "yesterday" when we hit the floor
  const nextDate = new Date(cursorDate.getTime() - chunkDays * DAY_MS);
  const floorDate = new Date(floor);
  let nextCursor;
  if (nextDate < floorDate) {
    nextCursor = isoDay(new Date(Date.now() - DAY_MS));
    console.log(`[backfill] cursor hit floor (${floor}); looping to ${nextCursor}`);
  } else {
    nextCursor = isoDay(nextDate);
  }
  await mkdir(path.dirname(BACKFILL_PATH), { recursive: true });
  await writeFile(BACKFILL_PATH, JSON.stringify({
    cursor: nextCursor,
    lastRun: fetchedAt,
    lastWindow: { after: windowAfter, before: windowBefore },
  }, null, 2));
  console.log(`[backfill] considered ${considered}, +${added}/~${updated}, next cursor -> ${nextCursor}`);
  return { added, updated };
}

async function runLive(config, byId, fetchedAt) {
  const after = config.live.lookback ?? '2d';
  console.log(`[live] window: last ${after}`);
  let added = 0;
  let updated = 0;
  for (const sub of config.subreddits) {
    try {
      process.stdout.write(`  r/${sub} ...`);
      const url =
        `${ARCTIC_BASE}?subreddit=${encodeURIComponent(sub)}` +
        `&sort=desc&limit=${config.limitPerSub}` +
        `&after=${encodeURIComponent(after)}`;
      const data = await arcticGet(url, config.userAgent);
      const posts = (data.data ?? []).filter((p) => !p.stickied && p.is_self);
      const r = ingest(posts, byId, fetchedAt);
      added += r.added;
      updated += r.updated;
      console.log(` ${posts.length} fetched, +${r.added}/~${r.updated}`);
      await sleep(1000);
    } catch (err) {
      console.error(`  r/${sub} FAILED: ${err.message}`);
    }
  }
  console.log(`[live] +${added}/~${updated}`);
  return { added, updated };
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const archive = await loadJson(DATA_PATH, { lastFetched: null, jokes: [] });
  const byId = new Map((archive.jokes ?? []).map((j) => [j.id, j]));
  const fetchedAt = new Date().toISOString();
  let added = 0;
  let updated = 0;

  if (config.backfill?.enabled) {
    const r = await runBackfill(config, byId, fetchedAt);
    added += r.added;
    updated += r.updated;
  }
  if (config.live?.enabled) {
    const r = await runLive(config, byId, fetchedAt);
    added += r.added;
    updated += r.updated;
  }

  const minScore = config.minScore ?? 0;
  const kept = Array.from(byId.values()).filter((j) => (j.score ?? 0) >= minScore);

  const out = { lastFetched: fetchedAt, count: kept.length, jokes: kept };
  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  await writeFile(DATA_PATH, JSON.stringify(out, null, 2));
  console.log(`Added ${added}, updated ${updated}, total ${out.count} (minScore=${minScore})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
