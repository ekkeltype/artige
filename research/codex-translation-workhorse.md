# Codex CLI as a Translation Workhorse for the Joke-Localization Cron

**Research date:** 2026-06-06
**Context:** A Node.js script on Windows currently invokes the Anthropic `claude` CLI headlessly (`claude.exe -p --output-format json --no-session-persistence --system-prompt-file <prompt> --model <model> "<JSON array of jokes>"`) from a nightly Windows Task Scheduler cron, to translate batches (~6) of Reddit jokes into Norwegian Bokmål and receive a JSON array of `{id,title,body}`. The owner is cost/usage-limit conscious and wants to know whether OpenAI's Codex CLI can do this translation step more cheaply or for free.

---

## Executive summary & recommendation

**Yes, Codex CLI is technically a drop-in-capable replacement for `claude -p` — but no, there is no genuinely *free* path that suits an unattended translation cron.** Codex ships a first-class non-interactive subcommand (`codex exec`) with stdin prompt input, newline-delimited JSON output (`--json`), final-message-to-file (`-o`), pinnable models, and headless sandbox/approval controls — everything the pipeline needs (high confidence, all from OpenAI primary docs). For **task fit**, OpenAI's own Model Spec *explicitly lists translation* as a permitted transformation of user-provided content, and there is a transformation exception that covers edgy/NSFW joke text, so the models will not refuse ordinary joke translation (high confidence). **On cost/auth, the picture is unfavorable for "free":** the Codex *Free* plan ($0/mo) is real but framed around quick coding tasks and bounded by shared 5-hour rolling usage windows; the API has **no free tier and no included credits** on the pricing page (per-token billing only). For an unattended Windows Task Scheduler job, **the only robust auth is an OpenAI API key** (`codex login --with-api-key` via stdin) — which OpenAI itself recommends for automation, but which bills standard per-token API rates. ChatGPT-subscription auth *can* be seeded into a cron via a copied `auth.json`, but OpenAI explicitly warns this "does not guarantee the same session lasts forever," needs ~8-day token refresh persistence, and can require manual re-login — making it a fragile basis for a nightly cron.

**Bottom line:** If the goal is *truly free and unattended*, Codex does **not** clearly beat the current Claude setup — the free/subscription routes are coding-framed and auth-fragile for cron. If the goal is *cheap and reliable*, run Codex (or, better, the OpenAI API directly) with an **API key** and a **cheap general-purpose model** (`gpt-5.4-mini` or `gpt-5.4-nano`), **not** the `*-codex` models. Recommended plan: **API key + `gpt-5.4-nano`/`gpt-5.4-mini` for per-token billing.** See cost math in §6.

> **Time-sensitivity warning:** Codex pricing, plans, limits, and auth flows changed repeatedly through 2025–2026. Every figure below is dated. Treat anything older than a few weeks as needing re-confirmation before you commit.

---

## Finding 1 — Headless one-shot execution: fully supported (`codex exec`)

**Confidence: HIGH** (OpenAI primary docs, 3-0 unanimous across multiple claims; corroborated by openai/codex GitHub issues)

Codex provides a dedicated non-interactive subcommand **`codex exec`** (alias `codex e`), described in the official docs as "for scripted or CI-style runs that should finish without human interaction" — directly analogous to `claude -p`. [developers.openai.com/codex/cli/reference; developers.openai.com/codex/noninteractive — fetched 2026-06]

What it supports for this pipeline:

- **Prompt as argument or via stdin.** The prompt can be passed as a single string argument or piped via stdin using the `PROMPT` value `-` ("Use `-` to pipe the prompt from stdin"). [developers.openai.com/codex/cli/reference]
- **Machine-parseable output.** `--json` (also `--experimental-json`) prints "newline-delimited JSON events instead of formatted text"; under `--json`, stdout becomes a JSON Lines stream (event types: `thread.started`, `turn.started/completed/failed`, `item.*`, `error`). [developers.openai.com/codex/cli/reference; developers.openai.com/codex/noninteractive]
- **Final answer to a file.** `--output-last-message, -o <path>` writes "the assistant's final message to a file. Useful for downstream scripting" (and still prints to stdout). This is the cleanest way to grab the translated JSON array. [developers.openai.com/codex/cli/reference; developers.openai.com/codex/noninteractive]
- **Disable tool use / sandbox so it "just answers."** Headless control via `--sandbox read-only | workspace-write | danger-full-access`, `--ask-for-approval untrusted | on-request | never`, and `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`). OpenAI explicitly recommends `--sandbox read-only --ask-for-approval never` for non-interactive/CI runs, which effectively neutralizes command/tool execution. [developers.openai.com/codex/cli/reference; developers.openai.com/codex/agent-approvals-security]

> **Gotcha (flagged, not a blocker):** openai/codex Issue #20919 reports `codex exec` can *hang on a non-TTY pipe with no writer* — exactly the kind of condition a Windows scheduled task can create. Prefer passing the prompt as a string argument (or `-o` for output) and test the wiring under the actual Task Scheduler context, not just an interactive shell.

There is **no separate `-p` or `--quiet` flag** as in Claude; the non-interactive surface *is* the `codex exec` subcommand, and the JSON/sandbox/approval flags listed above all live under it.

---

## Finding 2 — Task fit: translation is explicitly permitted; not coding-locked

**Confidence: HIGH** for "translation is permitted and not coding-locked" (OpenAI Model Spec + Usage Policies, primary). **MEDIUM** for the strongest framing of the transformation exception (one sub-claim was 2-1).

- **Translation is explicitly named as a permitted transformation.** The OpenAI Model Spec (2025-12-18) lists "translating, paraphrasing, summarizing, classifying, encoding, formatting, or improving the grammar" of user-provided text as compliant transformation assistance. [model-spec.openai.com/2025-12-18.html — 3-0]
- **Transformation exception covers edgy/NSFW joke text.** Under the heading "Comply with requests to transform restricted or sensitive content," the spec says the assistant "should comply with limited requests to transform or analyze content that the user has directly provided, even if the resulting output would ordinarily be disallowed as restricted or sensitive content." Because the jokes are passed directly in-prompt and translation is explicitly listed, the pipeline's conditions are met. [model-spec.openai.com/2025-12-18.html — 2-1; the dissent concerned the absolute phrasing "directly covers," not whether translation is covered]
- **Policies are universal harm-prevention principles, not coding restrictions.** OpenAI's Usage Policies (effective 2025-10-29) are framed as "Protect people / Respect privacy / Keep minors safe / Empower people" — general principles about harm, not coding-specific rules. Translation is not listed as a prohibited use. [openai.com/policies/usage-policies — 3-0]

**Content guardrails relevant to NSFW jokes (parity with the Claude pipeline):** The bans that actually matter are **category-specific**, not a blanket adult-content prohibition. Prohibited categories include CSAM (even AI-generated), grooming of minors, and exposing minors to age-inappropriate sexual/violent content. A full-text scan of the Usage Policies found *no* blanket ban on adult/erotic/"NSFW" content; the only general sexual-content ban is narrow ("sexual violence or non-consensual intimate content"). [openai.com/policies/usage-policies — 3-0]

> **Two caveats for the NSFW angle:**
> 1. A laundering carve-out applies: "Providing disallowed content in disguised form (... in another language ...) should be considered the same as providing the content directly." This restricts *what* you translate (you can't use translation to launder prohibited content), not translation as an activity.
> 2. Model-level behavior (Model Spec) is stricter than the Usage Policies and gates adult erotica behind age verification. Ordinary edgy Reddit jokes are very unlikely to trip this, but the strictest content (e.g., explicit sexual material) could behave differently than under Claude. Expect *broadly* comparable handling of edgy jokes, with the usual provider-to-provider variation at the extreme tail.

---

## Finding 3 — Models & selection: avoid the `*-codex` models; pick a cheap GPT-5 model

**Confidence: HIGH** (OpenAI pricing + model pages, primary, 3-0; multiple independent price aggregators corroborate)

Codex/GPT models are directly callable via the paid API for per-token billing. Relevant 2026 list prices (Standard tier, per 1M tokens) [developers.openai.com/api/docs/pricing — fetched 2026-06-06]:

| Model | Input / 1M | Output / 1M | Notes |
|---|---|---|---|
| `gpt-5.3-codex` | $1.75 | $14.00 | Codex-branded; 400k context, 128k max output. Optimized for coding — overkill and expensive for translation. |
| `gpt-5.4-mini` | $0.75 | $4.50 | General-purpose (text+image, 400K context). |
| `gpt-5.4-nano` | $0.20 | $1.25 | General-purpose; cheapest. |

**For translation, the `*-codex` models are the wrong choice** — they are coding-optimized and ~2–11× more expensive on output than the mini/nano general-purpose models, which are explicitly general-purpose and well-suited to prose translation. (Cached input is ~10× cheaper still — $0.175/$0.075/$0.02 respectively — which matters because a fixed system prompt can be cached across the nightly batch.)

> **Model-selection nuance:** None of the verified sources benchmark *translation quality* per model, so "which is best for Norwegian Bokmål" is not settled here (see Open Questions). The defensible recommendation is to **start with `gpt-5.4-nano` for cost, validate Bokmål quality on a sample, and step up to `gpt-5.4-mini` only if quality is insufficient.** You can pin the model with `codex exec --model <id>` (Finding 1) or pass `model` in a direct API call.

---

## Finding 4 — Free tier & quotas: a real $0 Codex plan exists, but it's coding-framed and window-capped; the API has no free tier

**Confidence: HIGH** for existence of the plans/limits and absence of an API free tier (OpenAI primary, 3-0). **LOW** for any precise "jokes per day on the free plan" number (OpenAI does not publish request/token counts for the Codex Free plan — see below).

- **Codex Free plan is real:** "$0/month — Explore Codex capabilities on quick coding tasks." Paid tiers: Go $8/mo, Plus $20/mo, Pro from $100/mo. [developers.openai.com/codex/pricing — 3-0, corroborated by eesel.ai 2026-06-05, danielvaughan 2026-06-03]
- **Usage is capped in shared 5-hour windows:** "The usage limits for local messages and cloud tasks share a five-hour window. Additional weekly limits may apply." This appears in every plan tier's table and directly bounds how many translation batches a cron could run per window. Secondary sources describe it as a *rolling* window (`limit_window_seconds = 18000` ≈ 5 hours), tied to an April 9, 2026 limits update. [developers.openai.com/codex/pricing — 3-0; knightli.com 2026-04-15; apidog.com; laozhang.ai]
- **The API has no free tier and no included credits.** The official API pricing page makes *no mention* of any free tier, free credits, ChatGPT Plus/Pro plans, or included rate-limit quotas — it is exclusively per-token billing. [developers.openai.com/api/docs/pricing — 3-0]

**Which ChatGPT/Codex plans include Codex usage, and quantified throughput:**

| Plan | Codex included? | Stated limit | Approx. jokes/day (see assumptions) |
|---|---|---|---|
| Codex Free ($0) | Yes, but framed for "quick coding tasks" | Shared 5-hr window; exact request/token count **not published** | **Unknown / unquantifiable from primary sources** — do not assume it is generous enough for a nightly batch job |
| Go $8, Plus $20, Pro $100+ | Yes | Larger 5-hr windows (+ possible weekly caps); exact counts not published per-token | Higher, but still window-bounded; numbers not published in token terms |
| API key (any) | Yes (per-token) | No free tier; pay per token | Effectively unlimited subject to billing + account rate limits |

> **Honesty note on quantification:** The task asked for "approximately how many short jokes per day on each free/included tier." **OpenAI does not publish the Codex plan limits in requests-or-tokens-per-day terms** — they are expressed as opaque "5-hour window" message/task allowances that OpenAI has changed repeatedly (e.g., the April 9, 2026 update). Therefore **a precise jokes/day figure for the Free/Plus/Pro plans cannot be confirmed from primary sources and is not given here.** What *can* be quantified is the **API** route, where throughput is a pure cost question (see §6), not a quota wall. A genuinely free, sustained nightly translation cron on the Codex Free plan is **not** something the published limits support with confidence.

---

## Finding 5 — Auth for unattended cron: API key is the only robust path; ChatGPT-session auth is fragile

**Confidence: HIGH** (OpenAI primary docs across multiple pages, 3-0; corroborated by openai/codex issues and third-party CI/CD guides)

This is the decisive section for a Windows Task Scheduler cron with no logged-in TTY.

**Two sign-in methods exist:** (1) Sign in with ChatGPT (browser OAuth, subscription access) and (2) Sign in with an API key (usage-based). A device-code flow (`codex login --device-auth`) is a headless *variant of the ChatGPT login* (it still needs a human to enter a code on another device once). [developers.openai.com/codex/auth — 3-0]

### Path A — API key (recommended)
- **Non-interactive seeding:** `printenv OPENAI_API_KEY | codex login --with-api-key` reads the key from stdin; `--with-access-token` reads an access token from stdin; credentials are stored in `$CODEX_HOME` (default `~/.codex`, i.e. `$HOME/.codex`). `codex login status` "exit[s] with 0 when logged in" for automation checks. **No interactive browser login is strictly required.** [developers.openai.com/codex/cli/reference; developers.openai.com/codex/auth — 3-0]
- **OpenAI officially recommends this for automation:** "The right way to authenticate automation is with an API key." and "We recommend API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs." [developers.openai.com/codex/auth/ci-cd-auth; developers.openai.com/codex/auth — 3-0]
- **What survives in a no-TTY scheduled task:** an API key stored in `$CODEX_HOME` (or supplied via env each run) survives fine; nothing interactive is needed at run time. This is the path that will not break unattended.

### Path B — ChatGPT subscription session (fragile for cron)
- **Mechanism works but must be seeded from a browser machine:** ChatGPT sign-in "opens a browser window," then "caches your login details and reuses them" — so a cron *cannot perform the initial login itself* but *can run off a cached `auth.json`*. The supported pattern: run `codex login` once on a machine with a browser, set `cli_auth_credentials_store = "file"`, and copy `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) to the runner. [developers.openai.com/codex/auth; developers.openai.com/codex/auth/ci-cd-auth — 3-0]
- **Self-sustains only if you persist the refreshed file:** Codex refreshes the token bundle when `last_refresh` is older than ~8 days (and has a 401 refresh-and-retry path), writing new tokens back to `auth.json`. A seeded copy self-sustains **only if the updated file is persisted back between runs** — otherwise stale single-use refresh tokens cause auth failures (corroborated by openai/codex issues #6036, #9634, #6498 about reused refresh tokens). [developers.openai.com/codex/auth/ci-cd-auth — 3-0]
- **OpenAI explicitly warns it is fragile:** "This flow reduces manual work, but it does not guarantee the same session lasts forever." It can require manual re-login (reseed on 401), and OpenAI labels it "advanced." Third-party reports describe manual re-auth every ~10–30 days. [developers.openai.com/codex/auth/ci-cd-auth — 3-0]

> **Historical bug, now fixed (don't be misled by older write-ups):** Issue #3286 (opened 2025-09-07, v0.30.0) reported that an `OPENAI_API_KEY` env var "cannot be used if ChatGPT subscription login is active." This was **fixed in v0.35.0** ("Login is now always explicit") and the issue closed 2025-09-15. On a *clean* unattended machine using the API key path, this does not apply — but it argues for keeping ChatGPT-session and API-key auth off the same box. [github.com/openai/codex/issues/3286 — 3-0]
>
> **Historical context:** As of 2025-09-17 (Issue #3820), Codex had *no* headless auth for ChatGPT plans at all — only browser OAuth. The device-code flow that partially addresses this shipped later (~v0.116.0, ~March 2026). [github.com/openai/codex/issues/3820 — 3-0]

**Auth verdict for this cron:** Use **Path A (API key)**. Path B is workable but OpenAI itself warns it is not guaranteed to last, requires an ~8-day refresh-persistence dance, and can demand manual re-login — all bad properties for an unattended nightly job.

---

## Finding 6 — Head-to-head vs `claude -p` for this pipeline, and how to wire it

**Confidence: HIGH** on the mechanics and OpenAI-side figures; the cost-per-1k-jokes numbers below are **illustrative arithmetic** from the verified list prices plus the task's stated token assumptions (a few hundred input + a few hundred output tokens per joke; batches of ~6).

### Cost per ~1,000 jokes (API, Standard tier; illustrative)
Assume ~400 input + ~400 output tokens per joke (mid of "a few hundred"). Per 1,000 jokes ≈ 0.4M input + 0.4M output tokens. (System-prompt caching would lower input further; ignored here for a conservative estimate.)

| Model | ≈ Cost / 1,000 jokes | Comment |
|---|---|---|
| `gpt-5.4-nano` | (0.4 × $0.20) + (0.4 × $1.25) ≈ **$0.58** | Cheapest; validate Bokmål quality |
| `gpt-5.4-mini` | (0.4 × $0.75) + (0.4 × $4.50) ≈ **$2.10** | Step-up if nano quality insufficient |
| `gpt-5.3-codex` | (0.4 × $1.75) + (0.4 × $14.00) ≈ **$6.30** | Not recommended for translation |

So at the nano tier, localizing ~1,000 jokes costs well under a dollar in API spend — cheap, but **not free**.

### Scorecard

| Dimension | Codex CLI (this pipeline) | `claude -p` (current) |
|---|---|---|
| Headless one-shot | `codex exec` + stdin/arg + `--json`/`-o` (Finding 1) | `claude -p --output-format json` |
| JSON-output reliability | JSONL event stream via `--json`; final message via `-o`. **You parse the final message, not a single clean JSON blob by default** — slightly more wiring than Claude's `--output-format json` | Native `--output-format json` |
| Free/included quota | Codex Free $0 exists but coding-framed, window-capped, unquantified; **API has no free tier** (Finding 4) | (Owner's current Claude quota — out of scope here) |
| Cheapest paid model | `gpt-5.4-nano` ≈ $0.58/1k jokes (illustrative) | (Compare against current Claude model rates) |
| Rate limits | Shared 5-hr windows on subscription plans; API limited by billing/account RPM | n/a here |
| Auth for cron | **API key (robust)**; ChatGPT-session (fragile, OpenAI-warned) — Finding 5 | Existing Claude auth |
| Content fit (NSFW jokes) | Translation explicitly permitted; category-specific bans only; stricter at the extreme tail (Finding 2) | Comparable, with provider variation |
| Notable gotcha | `codex exec` can hang on a writer-less non-TTY pipe (#20919) | — |

### How to wire Codex into the existing Node pipeline (viable, API-key route)

Conceptually the closest equivalent to the current `claude.exe -p ...` call. Two viable shapes:

**(a) Via Codex CLI (`codex exec`)** — closest analog to the current CLI invocation:

```js
// One-time, out of band (NOT in the cron): seed the API key into $CODEX_HOME.
//   PowerShell:  $env:OPENAI_API_KEY | codex login --with-api-key
// Then in the nightly Node script, replace the claude spawn with:
const { execFileSync } = require("node:child_process");

const out = execFileSync("codex", [
  "exec",
  "--model", "gpt-5.4-nano",          // pin a cheap general-purpose model
  "--sandbox", "read-only",            // neutralize tool/command execution
  "--ask-for-approval", "never",       // fully non-interactive
  "--json",                            // JSONL events on stdout
  "-o", outFile,                       // final message (the translated JSON) to a file
  promptString                          // your system+user prompt incl. the JSON array of jokes
], { input: undefined, encoding: "utf8" });
// Read `outFile` for the assistant's final message, then JSON.parse the array of {id,title,body}.
```

Notes: Codex has no single `--system-prompt-file` flag equivalent to Claude's; fold the system/developer instructions into the prompt text (or a config/AGENTS file). Because `--json` emits an event stream, prefer reading the **final message from `-o <file>`** and `JSON.parse` that, rather than parsing the JSONL.

**(b) Via the OpenAI API directly (recommended for a pure translation step)** — skips the CLI/sandbox machinery entirely, gives you native JSON, and is the simplest robust unattended path:

```js
// POST /v1/chat/completions (or /v1/responses) with model "gpt-5.4-nano",
// a system message = your translation prompt, user message = JSON array of jokes,
// and response_format JSON. Auth = OPENAI_API_KEY env var. No browser, no session, no 5-hr window.
```

For an unattended nightly translation job, **(b) the direct API with an API key is the most robust and cheapest-to-reason-about option**; the Codex CLI (a) is the right choice only if you specifically want Codex's agentic features, which a pure translate-this-array task does not need.

---

## Caveats & source quality

- **Time-sensitivity is the dominant caveat.** Codex pricing, plan names, usage windows, and auth flows changed repeatedly through 2025–2026 (e.g., the April 9, 2026 limits update; device-code auth arriving ~March 2026; the #3286 auth bug fixed in v0.35.0). Every figure here is dated; re-verify before committing.
- **Strong sourcing overall.** 20 of 21 synthesized claims were 3-0 unanimous and rest on **OpenAI primary docs** (developers.openai.com, model-spec.openai.com, openai.com/policies) or **primary GitHub issues** (api.github.com/repos/openai/codex). Only one claim (the transformation exception "directly covers" framing) was 2-1, and the dissent was about phrasing, not substance.
- **The jokes/day quota numbers for Free/Plus/Pro are NOT confirmable.** OpenAI publishes Codex plan limits as opaque "5-hour window" allowances, not requests/tokens per day. Any specific "N jokes/day free" figure would be a guess; this report deliberately does not provide one. The API cost-per-1k-jokes figures in §6 are **illustrative arithmetic** from verified list prices and the task's stated token assumptions, not measured throughput.
- **Content-filtering parity at the extreme tail is uncertain.** Translation of ordinary edgy jokes is explicitly permitted, but model-level handling of the most explicit content is stricter than the written Usage Policies and may differ from Claude's behavior. Not tested here.
- **Weak/secondary sources** (knightli.com, laozhang.ai, apidog.com, eesel.ai, danielvaughan.com) were used only to corroborate the *rolling* nature and timing of the 5-hour window and CI/CD seeding patterns — never as the sole basis for a load-bearing claim.

---

## Open questions

1. **Exact free/included throughput:** How many translation batches (or tokens) per 5-hour window does the **Codex Free** plan actually allow today? OpenAI does not publish this in token/request terms, so a genuinely-free nightly cron's viability is unconfirmed.
2. **Translation quality by model:** Which of `gpt-5.4-nano` vs `gpt-5.4-mini` (vs the current Claude model) produces the best **Norwegian Bokmål** joke localizations? No verified benchmark exists; requires an empirical sample test.
3. **Does Codex CLI / API key route respect plan-style rate limits, or only API account RPM/billing limits?** I.e., does using an API key entirely sidestep the 5-hour window, or are there separate API-side caps that could throttle a large nightly batch?
4. **`codex exec` reliability under Windows Task Scheduler specifically:** Given Issue #20919 (hang on writer-less non-TTY pipe), does the argument/`-o` invocation run cleanly under a real no-TTY scheduled task on Windows, or does it need a stdin workaround?
