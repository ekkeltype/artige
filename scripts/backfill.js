import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_PATH = path.join(ROOT, 'data', 'jokes.json');

const TIMEFRAME = process.env.BACKFILL_TIMEFRAME || 'year';
const LIMIT = Number(process.env.BACKFILL_LIMIT || '10');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchSub(name, sort, timeframe, limit, userAgent) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(name)}/${sort}.json?t=${timeframe}&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.data.children
    .map((c) => c.data)
    .filter((p) => !p.stickied && p.is_self);
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

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const archive = existsSync(DATA_PATH)
    ? JSON.parse(await readFile(DATA_PATH, 'utf8'))
    : { lastFetched: null, jokes: [] };
  const byId = new Map(archive.jokes.map((j) => [j.id, j]));
  const fetchedAt = new Date().toISOString();
  let added = 0;
  let updated = 0;

  console.log(`Backfilling top of ${TIMEFRAME}, limit ${LIMIT} per sub.`);

  for (const sub of config.subreddits) {
    try {
      console.log(`Fetching r/${sub}...`);
      const posts = await fetchSub(sub, config.sort, TIMEFRAME, LIMIT, config.userAgent);
      for (const raw of posts) {
        const j = normalize(raw);
        const existing = byId.get(j.id);
        if (existing) {
          existing.score = Math.max(existing.score ?? 0, j.score ?? 0);
          existing.lastSeen = fetchedAt;
          updated++;
        } else {
          byId.set(j.id, { ...j, firstSeen: fetchedAt, lastSeen: fetchedAt });
          added++;
        }
      }
      await sleep(1000);
    } catch (err) {
      console.error(`Failed r/${sub}: ${err.message}`);
    }
  }

  const minScore = config.minScore ?? 0;
  // Same guard as fetch.js: never purge translated/filtered jokes on a minScore raise.
  const kept = Array.from(byId.values()).filter((j) => (j.score ?? 0) >= minScore || j.localized || j.filtered);

  const out = {
    lastFetched: archive.lastFetched,
    count: kept.length,
    jokes: kept,
  };

  await writeFile(DATA_PATH, JSON.stringify(out, null, 2));
  console.log(`Added ${added} new, updated ${updated} existing, total ${kept.length}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
