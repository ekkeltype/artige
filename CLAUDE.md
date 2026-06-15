# upjoke — project instructions

Static site of Reddit jokes localized to Norwegian Bokmål. `data/jokes.json` is
the archive and the only committed data file; the site reads it directly. A
scheduled task runs `refresh.bat` (git pull → `scripts/fetch.js` scrape/backfill →
commit `data/jokes.json`).

## Manual procedure trigger

Translation is **not** automated — it is run manually, in-session, because the
cron's `claude -p` + haiku path was unreliable (silent hangs/timeouts) and the
quality was too low.

When the user says **"do the thing"**, **"start the procedure"**, or **"translate
the backlog"**: open `ops/translate-backlog.md` and execute it top-to-bottom
exactly, without re-confirming. In short, it selects the backlog, has you
translate it in-session per `prompts/localize.md`, applies the existing
attempts/filter rules via `scripts/manual-translate.js`, then commits and pushes
`data/jokes.json`.

## Key files
- `data/jokes.json` — the archive (5.5k+ jokes; only committed data file).
- `prompts/localize.md` — the translation spec (Bokmål); its body is the system prompt.
- `scripts/manual-translate.js` — `candidates` / `apply` helpers for the manual procedure.
- `ops/translate-backlog.md` — the manual translation runbook.
- `scripts/translate.js` — legacy cron translator (`claude -p`); kept, but no longer run by the scheduled task.
- `scripts/fetch.js` — scraper / arctic-shift backfill.
- `config.json` — `minScore`, `translate.maxAttempts`, model, etc.
- `ufiltrert.html` / `ufiltrert.js` — page for jokes marked `filtered` (untranslatable/blocked).
