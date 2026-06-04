import { readFile, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA_PATH = path.join(ROOT, 'data', 'jokes.json');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `claude --output-format json` writes its result *and* its errors to stdout
// (stderr is usually empty), so on failure the real reason is in `out`, not `err`.
function describeFailure(out, err) {
  const text = out.trim() || err.trim();
  if (!text) return '(no output)';
  try {
    const j = JSON.parse(text);
    if (j.error) return typeof j.error === 'string' ? j.error : JSON.stringify(j.error);
    if (j.is_error && j.result != null) return String(j.result).slice(0, 500);
    if (j.subtype && j.subtype !== 'success') return `${j.subtype}: ${String(j.result ?? '').slice(0, 300)}`;
    return text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

function runClaude({ systemPromptFile, userPrompt, model, maxBudgetUsd, timeoutMs = 150000 }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--no-session-persistence',
      '--system-prompt-file', systemPromptFile,
    ];
    if (model) args.push('--model', model);
    if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
    args.push(userPrompt);

    const claudeCmd = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const proc = spawn(claudeCmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
      } else if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${describeFailure(out, err)}`));
      } else {
        resolve(out);
      }
    });
  });
}

// Transient failures (API overload/rate-limit, timeouts) are common across a
// long back-to-back run; retry a few times with linear backoff before skipping.
async function runClaudeWithRetry(opts, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await runClaude(opts);
    } catch (e) {
      lastErr = e;
      if (attempt < attempts) {
        const backoffMs = 10000 * attempt;
        console.error(`    attempt ${attempt}/${attempts} failed: ${e.message.slice(0, 160)}; retry in ${backoffMs / 1000}s`);
        await sleep(backoffMs);
      }
    }
  }
  throw lastErr;
}

function findJsonArray(text) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function extractTranslations(rawOutput) {
  let envelope;
  try {
    envelope = JSON.parse(rawOutput);
  } catch {
    envelope = null;
  }
  const resultText = String(envelope?.result ?? rawOutput);
  const arrayText = findJsonArray(resultText);
  if (!arrayText) {
    const preview = resultText.trim().slice(0, 500).replace(/\s+/g, ' ');
    throw new Error(`no JSON array found in result. Preview: ${preview}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(arrayText);
  } catch (e) {
    const preview = arrayText.slice(0, 500).replace(/\s+/g, ' ');
    throw new Error(`JSON parse failed: ${e.message}. Extracted: ${preview}`);
  }
  if (!Array.isArray(parsed)) throw new Error('expected JSON array');
  return { translations: parsed, cost: envelope?.total_cost_usd ?? null };
}

async function saveArchive(archive) {
  // Atomic write (temp + rename) so an interrupted/killed run can never leave a
  // half-written jokes.json behind — important now that we save after each batch.
  const tmp = `${DATA_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(archive, null, 2));
  await rename(tmp, DATA_PATH);
}

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const t = config.translate || {};
  if (!t.enabled) {
    console.log('translate.enabled=false; skipping');
    return;
  }

  const archive = JSON.parse(await readFile(DATA_PATH, 'utf8'));
  const promptText = await readFile(path.join(ROOT, t.promptFile), 'utf8');
  const { meta, body: systemPrompt } = parsePrompt(promptText);
  const lang = meta.language;
  const langName = meta.languageName || lang;
  if (!lang) throw new Error('prompt file missing "language" in frontmatter');

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'artige-translate-'));
  const systemPromptFile = path.join(tmpDir, 'system.txt');
  await writeFile(systemPromptFile, systemPrompt);

  const minScore = config.minScore ?? t.minScore ?? 0;
  const candidates = archive.jokes.filter(
    (j) => !j.localized?.[lang] && (j.score ?? 0) >= minScore,
  );

  if (candidates.length === 0) {
    console.log(`Nothing new to translate to ${langName}.`);
    return;
  }
  console.log(`Translating ${candidates.length} jokes to ${langName} (model=${t.model})...`);

  const batchSize = t.batchSize || 30;
  let translatedCount = 0;
  let totalCost = 0;
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 4;
  const at = new Date().toISOString();

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(candidates.length / batchSize);
    const input = batch.map((j) => ({ id: j.id, title: j.title, body: j.body || '' }));
    const userPrompt = JSON.stringify(input);

    try {
      const raw = await runClaudeWithRetry({
        systemPromptFile,
        userPrompt,
        model: t.model,
        maxBudgetUsd: t.maxBudgetUsd,
        timeoutMs: t.timeoutMs,
      });
      const { translations, cost } = extractTranslations(raw);
      if (cost) totalCost += cost;
      const byId = new Map(translations.map((r) => [r.id, r]));
      let batchTranslated = 0;
      for (const j of batch) {
        const r = byId.get(j.id);
        if (r && typeof r.title === 'string') {
          j.localized = j.localized || {};
          j.localized[lang] = {
            title: r.title,
            body: typeof r.body === 'string' ? r.body : '',
            at,
            model: t.model,
          };
          batchTranslated++;
        }
      }
      translatedCount += batchTranslated;
      consecutiveFailures = 0;
      const costStr = cost != null ? ` ($${cost.toFixed(4)})` : '';
      console.log(`  batch ${batchNum}/${totalBatches}: ${batchTranslated}/${batch.length} translated${costStr}`);
      // Persist after every productive batch so an interrupted run keeps its
      // progress instead of discarding everything at a single final write.
      if (batchTranslated > 0) await saveArchive(archive);
    } catch (e) {
      consecutiveFailures++;
      console.error(`  batch ${batchNum}/${totalBatches} failed: ${e.message}`);
      if (consecutiveFailures >= maxConsecutiveFailures) {
        console.error(`Aborting run after ${consecutiveFailures} consecutive failures (claude/API likely unavailable). Progress saved; remaining jokes retry next run.`);
        break;
      }
    }
  }

  await saveArchive(archive);
  await rm(tmpDir, { recursive: true, force: true });
  const costStr = totalCost > 0 ? ` total $${totalCost.toFixed(4)}` : '';
  console.log(`Done. Translated ${translatedCount}/${candidates.length} jokes to ${langName}.${costStr}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
