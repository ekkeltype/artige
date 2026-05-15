const PAGE_SIZE = 50;

const state = {
  jokes: [],
  lastFetched: null,
  filters: {
    search: '',
    sort: 'newest',
    nsfw: 'exclude',
    language: '',
    includeUntranslated: false,
  },
  showOriginal: new Set(),
  shown: PAGE_SIZE,
};

function hasTranslation(j) {
  const lang = state.filters.language;
  return !!(lang && j.localized?.[lang]);
}

function viewOf(j) {
  if (hasTranslation(j) && !state.showOriginal.has(j.id)) {
    const loc = j.localized[state.filters.language];
    return { title: loc.title, body: loc.body || '' };
  }
  return { title: j.title, body: j.body || '' };
}

const $ = (id) => document.getElementById(id);

async function load() {
  const res = await fetch('./data/jokes.json', { cache: 'no-store' });
  const data = await res.json();
  state.jokes = data.jokes || [];
  state.lastFetched = data.lastFetched;
  const langs = availableLanguages();
  if (langs.length > 0) state.filters.language = langs[0];
  renderHeader(data);
  render();
}

function availableLanguages() {
  const set = new Set();
  for (const j of state.jokes) {
    if (j.localized) for (const k of Object.keys(j.localized)) set.add(k);
  }
  return Array.from(set).sort();
}

function renderHeader(data) {
  $('totalCount').textContent = `${(data.count ?? state.jokes.length).toLocaleString()} jokes`;
  $('lastFetched').textContent = state.lastFetched
    ? `updated ${timeAgo(new Date(state.lastFetched))}`
    : 'no data yet';
}

function applyFilters() {
  const { search, sort, nsfw, language, includeUntranslated } = state.filters;
  const q = search.trim().toLowerCase();
  let out = state.jokes.filter((j) => {
    if (nsfw === 'exclude' && j.nsfw) return false;
    if (nsfw === 'only' && !j.nsfw) return false;
    if (language && !includeUntranslated && !hasTranslation(j)) return false;
    if (q) {
      const v = viewOf(j);
      const hay = `${v.title} ${v.body}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (sort === 'score') out.sort((a, b) => b.score - a.score);
  else if (sort === 'newest') out.sort((a, b) => (b.firstSeen || '').localeCompare(a.firstSeen || ''));
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
  const langSelected = !!state.filters.language;
  const showingOriginal = translated && state.showOriginal.has(j.id);

  const pills = document.createElement('div');
  pills.className = 'pills';
  if (j.nsfw) pills.appendChild(pill('NSFW', 'nsfw'));
  if (langSelected && !translated) pills.appendChild(pill('original', 'fallback'));
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
$('includeUntranslated').addEventListener('change', (e) => {
  state.filters.includeUntranslated = e.target.checked;
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
