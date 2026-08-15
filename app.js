import { malform } from './lib/malform.js';

const PAGE_SIZE = 50;

const state = {
  jokes: [],
  lastFetched: null,
  filters: {
    search: '',
    sort: 'newest',
    nsfw: 'exclude',
    includeNynorsk: false,
  },
  showOriginal: new Set(),
  shown: PAGE_SIZE,
};

// Each joke renders in its assigned målform — ≈25% Nynorsk for the legacy era,
// ≈5% for jokes ingested after 2026-08-15 (lib/malform.js, stable per joke). If
// the assigned målform isn't translated yet, fall back to the other one, then to
// the English original, so a joke is never hidden merely because its målform is
// still pending translation.
function locOf(j) {
  if (!j.localized) return null;
  const want = malform(j.id, j.firstSeen);
  const other = want === 'nn' ? 'nb' : 'nn';
  const loc = j.localized[want] || j.localized[other];
  if (!loc) return null;
  return { ...loc, lang: j.localized[want] ? want : other };
}

function hasTranslation(j) {
  return !!locOf(j);
}

function viewOf(j) {
  const loc = locOf(j);
  if (loc && !state.showOriginal.has(j.id)) {
    return { title: loc.title, body: loc.body || '', lang: loc.lang };
  }
  return { title: j.title, body: j.body || '', lang: null };
}

const $ = (id) => document.getElementById(id);

async function load() {
  const res = await fetch('./data/jokes.json', { cache: 'no-store' });
  const data = await res.json();
  state.jokes = data.jokes || [];
  state.lastFetched = data.lastFetched;
  renderHeader(data);
  render();
}

function renderHeader(data) {
  $('totalCount').textContent = `${(data.count ?? state.jokes.length).toLocaleString()} jokes`;
  // "updated" must reflect when something new actually became visible here — i.e.
  // the most recent translation — NOT the nightly fetch. The cron rewrites
  // data.lastFetched every run but only adds *untranslated* jokes, which never
  // render on the main list (see applyFilters), so lastFetched over-promises freshness.
  const updated = newestTranslationAt();
  $('lastFetched').textContent = updated
    ? `updated ${timeAgo(updated)}`
    : 'no data yet';
}

// Newest localized-translation timestamp across the archive, any language. This
// is the honest "new on the page" signal: untranslated fetches don't move it,
// manual translation runs do. fetch.js preserves each joke's localized block, so
// this survives nightly refreshes and only advances when translations land.
function newestTranslationAt() {
  let newest = 0;
  for (const j of state.jokes) {
    if (!j.localized) continue;
    for (const loc of Object.values(j.localized)) {
      const t = loc?.at ? Date.parse(loc.at) : NaN;
      if (Number.isFinite(t) && t > newest) newest = t;
    }
  }
  return newest ? new Date(newest) : null;
}

function applyFilters() {
  const { search, sort, nsfw, includeNynorsk } = state.filters;
  const q = search.trim().toLowerCase();
  let out = state.jokes.filter((j) => {
    if (j.filtered) return false; // these live on ufiltrert.html
    if (nsfw === 'exclude' && j.nsfw) return false;
    if (nsfw === 'only' && !j.nsfw) return false;
    const loc = locOf(j);
    if (!loc) return false; // untranslated English originals stay off the main list
    if (!includeNynorsk && loc.lang === 'nn') return false; // Nynorsk is opt-in
    if (q) {
      const v = viewOf(j);
      const hay = `${v.title} ${v.body}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (sort === 'score') out.sort((a, b) => b.score - a.score);
  // "newest" = most recently translated. Fetches run nightly but translation
  // lands in manual batches, so translation date — not lastSeen — is what makes
  // a joke "new on the page" (and matches the header's "updated" timestamp).
  // Everything visible here has a translation (locOf filter above); lastSeen
  // breaks ties within a batch, which shares a single `at`.
  // "oldest" stays on firstSeen so it means "oldest entry in the archive".
  else if (sort === 'newest') {
    const key = (j) => `${locOf(j).at || ''} ${j.lastSeen || j.firstSeen || ''}`;
    out.sort((a, b) => key(b).localeCompare(key(a)));
  }
  else if (sort === 'oldest') out.sort((a, b) => (a.firstSeen || '').localeCompare(b.firstSeen || ''));
  return out;
}

function render() {
  const filtered = applyFilters();
  $('resultCount').textContent = `${filtered.length.toLocaleString()} result${filtered.length === 1 ? '' : 's'}`;

  const slice = filtered.slice(0, state.shown);
  const host = $('cards');
  host.innerHTML = '';
  for (const j of slice) host.appendChild(card(j));

  const more = $('loadMore');
  more.hidden = state.shown >= filtered.length;
}

function card(j) {
  const el = document.createElement('article');
  el.className = 'card';
  const v = viewOf(j);
  const translated = hasTranslation(j);
  const showingOriginal = translated && state.showOriginal.has(j.id);

  const pills = document.createElement('div');
  pills.className = 'pills';
  if (j.nsfw) pills.appendChild(pill('NSFW', 'nsfw'));
  if (v.lang === 'nn') pills.appendChild(pill('nynorsk', 'nn'));
  if (!translated) pills.appendChild(pill('original', 'fallback'));
  // Model tags vary in shape ("opus-4.8-manual", "codex default", "haiku") —
  // show just the family, and only when the translation is what's displayed.
  const modelFamily = translated && !showingOriginal
    ? ((locOf(j).model || '').match(/fable|opus|sonnet|haiku|codex/i) || [null])[0]
    : null;
  if (modelFamily) pills.appendChild(pill(modelFamily.toLowerCase(), 'model'));
  if (pills.children.length > 0) el.appendChild(pills);

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = v.title;
  el.appendChild(title);

  if (v.body) {
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = v.body;
    el.appendChild(body);
  }

  const footer = document.createElement('div');
  footer.className = 'footer';

  const meta = document.createElement('span');
  meta.textContent = `▲ ${j.score.toLocaleString()} · u/${j.author}`;
  footer.appendChild(meta);

  const actions = document.createElement('span');
  actions.className = 'actions';
  if (translated) {
    const toggle = document.createElement('button');
    toggle.className = 'linklike';
    toggle.textContent = showingOriginal ? 'show translation' : 'show original';
    toggle.addEventListener('click', () => {
      if (state.showOriginal.has(j.id)) state.showOriginal.delete(j.id);
      else state.showOriginal.add(j.id);
      render();
    });
    actions.appendChild(toggle);
  }
  const link = document.createElement('a');
  link.href = j.permalink;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'source ↗';
  actions.appendChild(link);
  footer.appendChild(actions);

  el.appendChild(footer);
  return el;
}

function pill(text, kind = '') {
  const s = document.createElement('span');
  s.className = `pill ${kind}`.trim();
  s.textContent = text;
  return s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgo(d) {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

$('search').addEventListener('input', debounce((e) => {
  state.filters.search = e.target.value;
  state.shown = PAGE_SIZE;
  render();
}, 200));
$('sort').addEventListener('change', (e) => {
  state.filters.sort = e.target.value;
  state.shown = PAGE_SIZE;
  render();
});
$('nsfw').addEventListener('change', (e) => {
  state.filters.nsfw = e.target.value;
  state.shown = PAGE_SIZE;
  render();
});
$('includeNynorsk').addEventListener('change', (e) => {
  state.filters.includeNynorsk = e.target.checked;
  state.shown = PAGE_SIZE;
  render();
});
$('loadMore').addEventListener('click', () => {
  state.shown += PAGE_SIZE;
  render();
});

load().catch((err) => {
  console.error(err);
  $('cards').innerHTML = `<p class="muted">Failed to load jokes: ${escapeHtml(err.message)}</p>`;
});
