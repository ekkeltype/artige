# Runbook: translate the backlog (in-session)

**Triggers:** "do the thing", "start the procedure", "translate the backlog".
When the user says any of these in this repo, execute this runbook top-to-bottom
**without asking for re-confirmation**. The early steps are non-destructive (they
only read data and write a backup), so an accidental trigger is safe to abort.

## Why this exists
The nightly cron used to translate via `claude -p` + haiku. That path hangs
silently, times out, and produces mediocre Norwegian. Translation is now done
**manually, in-session** — *you, the model, are the translator*: no `claude -p`,
no timeout, better quality. The scheduled task (`refresh.bat`) only downloads
now; this runbook is the translation half.

## Contract — match the cron exactly
- **Candidate set** = the same jokes `scripts/translate.js` would pick:
  `!localized.<lang> && !filtered && score >= minScore`. `manual-translate.js`
  computes this — do **not** hand-roll the filter.
- **Give-up / filter rules** are applied by `manual-translate.js apply`, identical
  to translate.js: a joke you omit gets `translateAttempts++`, and at `maxAttempts`
  (`config.json`, currently 3) it becomes `filtered` / `untranslatable`, drops off
  the live page, and surfaces on `ufiltrert.html`. Do **not** set these fields by
  hand.
- **Translation spec** = `prompts/localize.md` (its body). Obey it as your system
  prompt: idiomatic Bokmål, preserve the joke's *effect*, match register, **do not
  bowdlerize**, `[merknad: …]` for puns with no Norwegian analogue. Per-joke output
  schema: `{"id","title","body"}`.

## Steps

1. **Select candidates.**
   ```
   node scripts/manual-translate.js candidates
   ```
   Writes `data/_backlog.json` (`[{id,title,body}]`) and prints the count plus how
   many are one omission from auto-filter. It also takes `data/.manual-lock` so the
   nightly cron defers while you work (auto-expires after 8h). **If the count is 0,
   report "backlog empty" and stop.**

2. **Translate every candidate.** Read `data/_backlog.json` and translate **all**
   of them per `prompts/localize.md`. You are a strong model with no timeout, so
   the default is to *land every joke* — the omit path is only for a joke that is
   genuinely impossible (a pun resting entirely on English phonetics with no
   Norwegian analogue). Prefer literal + `[merknad: …]` over omitting.
   - Write your results to `data/_translations.json` — a single JSON array of
     `{"id","title","body"}`. For large backlogs, work in batches (~25) and write
     the **cumulative** array as you go, so an interruption never loses finished
     work.
   - Include only jokes you actually translated. Leave out the ones you're
     deliberately giving up on — `apply` counts those as omissions and ages them
     toward `filtered`, per the contract.
   - **Optional immediate filter:** to set a joke aside *now* (e.g. you won't
     translate it on policy grounds) rather than waiting for the attempt counter,
     add `{"id","reason"}` to `data/_filter.json`.

3. **Apply.**
   ```
   node scripts/manual-translate.js apply --model opus-4.8-manual
   ```
   Set `--model` to a tag matching whatever model is running if it isn't Opus 4.8.
   This backs up `data/jokes.json` → `data/jokes.json.bak_manual_<ts>`, merges your
   translations, applies the attempts/filter bookkeeping, writes atomically, and
   prints a summary.

4. **Commit + push** (the live site updates from `main`):
   ```
   git pull --ff-only
   git add data/jokes.json
   git commit -m "chore: manual in-session backlog translation (<N> jokes)"
   git push
   ```
   `git pull --ff-only` first picks up any commit the cron landed while you worked.
   Commit **only** `data/jokes.json` (match refresh.bat's convention).

5. **Clean up**: release the lock and delete the scratch files so a later run
   starts fresh and can't double-apply:
   ```
   node scripts/manual-translate.js release
   ```
   then remove `data/_backlog.json`, `data/_translations.json`, `data/_filter.json`.

6. **Report** to the user: N translated, M omitted (K newly filtered), the commit
   hash, and the backup filename.

## Notes
- Re-running is safe: `apply` skips jokes already translated/filtered.
- Scratch files (`data/_*.json`) and `data/.manual-lock` are gitignored; only
  `data/jokes.json` is ever committed.
- The cron (`refresh.bat`) skips its run while `data/.manual-lock` is held, so it
  won't race you on `jokes.json`/git. The lock auto-expires after 8h; if a run
  crashed, `node scripts/manual-translate.js release` clears it immediately.
- Nothing is written to `jokes.json` until step 3 — if translation is interrupted,
  just re-run from step 1.
