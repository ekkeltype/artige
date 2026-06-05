// Renders the jokes translate.js has given up on (`filtered`): content-filter
// rejections and ones the model kept omitting as untranslatable. Shown in their
// original (English) form — there's no localized version by definition.
const $ = (id) => document.getElementById(id);

async function load() {
  const res = await fetch('./data/jokes.json', { cache: 'no-store' });
  const data = await res.json();
  const jokes = (data.jokes || []).filter((j) => j.filtered);
  jokes.sort((a, b) => String(b.filteredAt || '').localeCompare(String(a.filteredAt || '')));

  $('count').textContent = `${jokes.length.toLocaleString()} vitser`;
  const host = $('cards');
  host.innerHTML = '';
  if (jokes.length === 0) {
    host.innerHTML = '<p class="muted">Ingenting her ennå.</p>';
    return;
  }
  for (const j of jokes) host.appendChild(card(j));
}

function card(j) {
  const el = document.createElement('article');
  el.className = 'card';

  const pills = document.createElement('div');
  pills.className = 'pills';
  if (j.nsfw) pills.appendChild(pill('NSFW', 'nsfw'));
  pills.appendChild(pill(j.filteredReason === 'content-filter' ? 'filtrert' : 'uoversettelig', 'fallback'));
  el.appendChild(pills);

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = j.title;
  el.appendChild(title);

  if (j.body) {
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = j.body;
    el.appendChild(body);
  }

  const footer = document.createElement('div');
  footer.className = 'footer';
  const meta = document.createElement('span');
  meta.textContent = `▲ ${(j.score ?? 0).toLocaleString()} · u/${j.author}`;
  footer.appendChild(meta);
  const link = document.createElement('a');
  link.href = j.permalink;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'source ↗';
  footer.appendChild(link);
  el.appendChild(footer);
  return el;
}

function pill(text, kind = '') {
  const s = document.createElement('span');
  s.className = `pill ${kind}`.trim();
  s.textContent = text;
  return s;
}

load().catch((err) => {
  console.error(err);
  $('cards').innerHTML = `<p class="muted">Klarte ikke å laste vitsene: ${err.message}</p>`;
});
