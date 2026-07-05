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

## Målform split — Bokmål vs Nynorsk
Each joke is permanently assigned a målform: ≈25% **Nynorsk** (`nn`), the rest
**Bokmål** (`nb`). The assignment is a pure function of the joke id in
`lib/malform.js`, imported by *both* the site (`app.js`) and the pipeline, so they
never disagree. A joke is stored under `localized.nb` **or** `localized.nn`
according to that function; the site renders a joke's assigned målform and falls
back to the other (then the English original) if the assigned one isn't written
yet. You never choose a joke's målform — `malform(id)` does.

## Contract
- **Candidate set** = jokes missing the translation in their **assigned** målform:
  `!localized[malform(id)] && !filtered && score >= minScore`. `manual-translate.js`
  computes this — do **not** hand-roll the filter. Each `_backlog.json` entry carries
  a `lang` field (`nb`/`nn`) telling you which målform to write it in.
- **Give-up / filter rules** are applied by `manual-translate.js apply`: a joke you
  omit gets `translateAttempts++`, and at `maxAttempts` (`config.json`, currently 3)
  it becomes `filtered` / `untranslatable`, drops off the live page, and surfaces on
  `ufiltrert.html`. Do **not** set these fields by hand.
- **Translation spec** depends on the entry's `lang`:
  - `nb` → `prompts/localize.md` (Bokmål).
  - `nn` → `prompts/localize.nn.md` (Nynorsk, with the **locked** house norm — obey
    it exactly so Nynorsk stays consistent across the archive).
  Both share the same rules otherwise: idiomatic, preserve the joke's *effect*, match
  register, **do not bowdlerize**, localize the whole joke, `[merknad: …]` for puns
  with no Norwegian analogue. Per-joke output schema is always `{"id","title","body"}`
  — `apply` routes each id to the right `localized` key via `malform(id)`, so you do
  **not** put `lang` in `_translations.json`.

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
   of them, each into the målform named in its `lang` field (`nb` →
   `prompts/localize.md`, `nn` → `prompts/localize.nn.md`). You are a strong model with no timeout, so
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
   - **Immediate filter (policy exclusions):** to set a joke aside *now* rather than
     waiting for the attempt counter, add `{"id","reason"}` to `data/_filter.json` —
     `apply` marks it `filtered` on the spot. **Reddit self-referential / meta jokes are
     a standing policy exclusion** (see `prompts/localize.md`): don't translate them;
     record them here with `reason: "reddit-meta"` so they drop out for good instead of
     ageing three passes toward auto-filter.

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
   git add data/jokes.json
   git commit -m "chore: manual in-session backlog translation (<N> jokes)"
   git pull --rebase --autostash origin main
   git push
   ```
   `--rebase --autostash` picks up any commit the cron landed while you worked and
   stashes the cron's dirty `data/backfill.json` across the rebase. Commit **only**
   `data/jokes.json` (match refresh.bat's convention; `backfill.json` stays uncommitted).

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
