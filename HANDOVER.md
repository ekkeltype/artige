# Session handover — 2026-06-06

## TL;DR
The nightly joke-translation cron was silently uploading nothing for days. Root cause: **Claude `sonnet` hangs on the real-joke translation workload** (it swallows the API's content-filter `400`s into a dead hang), and the old `translate.js` had no timeout and logged the always-empty stderr, so a "green" run (exit 0) pushed nothing. Fixed: hardened `translate.js`, switched the model, drained the backlog, added a "give up + showcase" path for untranslatable jokes, and moved the cron off the workday. **One open decision: which model to run going forward.**

## What shipped (all pushed to origin/main)
- `50b657c` — `translate.js` resilience: surface claude's **stdout** error (not stderr), 150s per-call **timeout**, **retry** w/ backoff, **atomic incremental saves** after each batch, **circuit breaker** (abort after 4 straight fails).
- `d16eb66` — model **sonnet → opus**, `batchSize 15 → 6`, `timeoutMs 180000` (opus is slower; smaller batches finish under the timeout).
- `881b42c` — `data/jokes.json`: chronological backfill + **653 new translations** from the overnight opus drain ($17.25, finished 04:51, beat the 7 AM cap).
- `b002d17` — **filtered-jokes feature**: after `maxAttempts` (3) failed runs *or* a hard content-filter block, a joke is marked `filtered`, drops out of the candidate set + main view, and shows on a new **`ufiltrert.html`** subpage (original English). Content-filtered batches are re-tried **joke-by-joke** so one offender doesn't strand its 5 batchmates.

## Current state
- **Live page: ~1,633 jokes visible** (was 1,100). translated `nb` ≈ 1,983 / 2,093 total. `filtered` count is still **0** — the feature is shipped but hasn't marked anything yet (needs one healthy-API run to populate `ufiltrert`).
- **Cron: `upjoke daily refresh` moved 9 AM → 3 AM** (Windows Task Scheduler, action `refresh.bat`, next run **06/06 03:00**). The one-time 7 AM killswitch task was used and removed.
- ⚠️ **`config.json` is on `haiku` in the working tree but UNCOMMITTED** (origin still says `opus`). The 3 AM run will use working-tree haiku; it's never committed by `refresh.bat`. **Finalize the model decision and commit it.**
- Working tree also has uncommitted `data/jokes.json` (+a few translations) and `data/backfill.json` (cursor — never committed by convention). The 3 AM run commits `jokes.json` itself.

## Open decision — which model for the cron (3-way)
| option | quality | ~$/1k jokes | notes |
|---|---|---|---|
| opus | best | ~$26 | original pick; **hangs on bad API nights** |
| haiku | good | ~$2.40 | currently set (uncommitted), reliable when API healthy |
| **gpt-5.4-nano (OpenAI API)** | unproven on Bokmål | **~$0.58** | ~45× cheaper than opus; needs `OPENAI_API_KEY` + a new backend path + a quality check |

**Offered next step:** make `translate.js` provider-agnostic and run a **~15-joke A/B** (nano vs haiku vs opus) so the Bokmål quality is eyeballed before committing the cron. Needs an `OPENAI_API_KEY` made readable. Full research: `research/codex-translation-workhorse.md` (verdict: Codex is a cheap workhorse but **not free** for an unattended cron; cheapest robust path = OpenAI API direct + `gpt-5.4-nano` + API key).

## Gotchas / environment notes
- **`claude -p` translation calls intermittently hang/timeout**, worse after heavy usage. Tonight (~00:40–01:00) **both opus AND haiku** timed out at 180s — broad, transient API throttling, not a code bug. The resilience layer handles it (times out → retries → marks nothing wrongly). Verified live: the content-filter isolation path fired correctly (`isolating 6 jokes`, translated 2, left the 4 timeouts as candidates, `filtered: 0`).
- `refresh.bat` = `git pull` → `node scripts/fetch.js` (scrape, arctic-shift backfill) → `node scripts/translate.js` → commit/push **only `data/jokes.json`**. `data/backfill.json` (cursor) is intentionally never committed.
- Page default view = non-NSFW **and** has an `nb` translation, so **untranslated jokes don't show** — translation is the bottleneck for what users see, not scraping.

## Pending verifications
- Confirm `ufiltrert.html` populates correctly after the first healthy-API run marks jokes `filtered`.
- Re-confirm a full clean translate run once the API throttling clears.

## Key files
`scripts/translate.js` · `config.json` (translate.model/batchSize/maxBudgetUsd/timeoutMs/maxAttempts) · `refresh.bat` · `ufiltrert.html` + `ufiltrert.js` · `app.js`/`index.html` (main page; `app.js` excludes `filtered`) · `research/codex-translation-workhorse.md`
