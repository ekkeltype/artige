const PAGE_SIZE = 50;

const state = {
  jokes: [],
  lastFetched: null,
  filters: {
    search: '',
    sort: 'score',
    subs: new Set(),
    flair: '',
    nsfw: false,
    language: '',
  },
  shown: PAGE_SIZE,
};

function langDisplayName(code) {
  if (!code) return 'Original (English)';
  try {
    const dn = new Intl.DisplayNames([code], { type: 'language' });
    const name = dn.of(code);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

function viewOf(j) {
  const lang = state.filters.language;
  if (lang && j.localized?.[lang]) {
    const loc = j.localized[lang];
    return { title: loc.title, body: loc.body || '', isFallback: false };
  }
  return { title: j.title, body: j.body || '', isFallback: !!lang };
}

const $ = (id) => document.getElementById(id);

async function load() {
  const res = await fetch('./data/jokes.json', { cache: 'no-store' });
  const data = await res.json();
  state.jokes = data.jokes || [];
  state.lastFetched = data.lastFetched;
  state.filters.subs = new Set(uniq(state.jokes.map((j) => j.subreddit)));
  renderHeader(data);
  renderSubFilters();
  renderFlairOptions();
  renderLanguageOptions();
  render();
}

function availableLanguages() {
  const set = new Set();
  for (const j of state.jokes) {
    if (j.localized) for (const k of Object.keys(j.localized)) set.add(k);
  }
  return Array.from(set).sort();
}

function renderLanguageOptions() {
  const langs = availableLanguages();
  const sel = $('language');
  sel.innerHTML = '';
  const optOrig = document.createElement('option');
  optOrig.value = '';
  optOrig.textContent = langDisplayName('');
  sel.appendChild(optOrig);
  for (const code of langs) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = langDisplayName(code);
    sel.appendChild(opt);
  }
  if (langs.length > 0) {
    state.filters.language = langs[0];
    sel.value = langs[0];
  }
}

function uniq(arr) {
  return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b));
}

function renderHeader(data) {
  $('totalCount').textContent = `${(data.count ?? state.jokes.length).toLocaleString()} jokes`;
  $('lastFetched').textContent = state.lastFetched
    ? `updated ${timeAgo(new Date(state.lastFetched))}`
    : 'no data yet';
}

function renderSubFilters() {
  const subs = uniq(state.jokes.map((j) => j.subreddit));
  const host = $('subFilters');
  host.innerHTML = '';
  for (const s of subs) {
    const id = `sub-${s}`;
    const wrap = document.createElement('label');
    wrap.innerHTML = `<input type="checkbox" id="${id}" checked> <span>r/${escapeHtml(s)}</span>`;
    host.appendChild(wrap);
    wrap.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) state.filters.subs.add(s);
      else state.filters.subs.delete(s);
      state.shown = PAGE_SIZE;
      render();
    });
  }
}

function renderFlairOptions() {
  const flairs = uniq(state.jokes.map((j) => j.flair).filter(Boolean));
  const sel = $('flair');
  for (const f of flairs) {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    sel.appendChild(opt);
  }
}

function applyFilters() {
  const { search, sort, subs, flair, nsfw } = state.filters;
  const q = search.trim().toLowerCase();
  let out = state.jokes.filter((j) => {
    if (!subs.has(j.subreddit)) return false;
    if (!nsfw && j.nsfw) return false;
    if (flair && j.flair !== flair) return false;
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

  const pills = document.createElement('div');
  pills.className = 'pills';
  pills.appendChild(pill(`r/${j.subreddit}`, 'sub'));
  if (j.flair) pills.appendChild(pill(j.flair, 'flair'));
  if (j.nsfw) pills.appendChild(pill('NSFW', 'nsfw'));
  if (v.isFallback) pills.appendChild(pill('original', 'fallback'));
  el.appendChild(pills);

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
  footer.innerHTML = `
    <span>▲ ${j.score.toLocaleString()} · u/${escapeHtml(j.author)}</span>
    <a href="${j.permalink}" target="_blank" rel="noopener">source ↗</a>
  `;
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
$('flair').addEventListener('change', (e) => {
  state.filters.flair = e.target.value;
  state.shown = PAGE_SIZE;
  render();
});
$('nsfw').addEventListener('change', (e) => {
  state.filters.nsfw = e.target.checked;
  state.shown = PAGE_SIZE;
  render();
});
$('language').addEventListener('change', (e) => {
  state.filters.language = e.target.value;
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
