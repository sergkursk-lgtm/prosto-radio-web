/*
  Просто Радио — веб-версия.

  Каталог станций лежит рядом файлом и читается один раз: список, поиск и жанры
  работают без сети. Через интернет идут только звук и логотипы.

  Фоновое воспроизведение держится на двух вещах: <audio> в разметке, запущенный
  жестом пользователя, и Media Session API — он даёт управление с экрана блокировки
  и с кнопок наушников. На iOS это работает только у приложения, добавленного на
  экран «Домой», и только пока играет сам элемент <audio>.
*/

/** Сколько строк показываем за раз: весь каталог в DOM держать нельзя. */
const PAGE = 300;

const GENRES = [
  ['Популярное', null],
  ['Новости', 'news'],
  ['Поп', 'pop'],
  ['Рок', 'rock'],
  ['Танцевальная', 'dance'],
  ['Электроника', 'electronic'],
  ['Джаз', 'jazz'],
  ['Классика', 'classical'],
  ['Ретро', 'retro'],
  ['Хип-хоп', 'hip hop'],
  ['Шансон', 'chanson'],
  ['Религия', 'religious'],
  ['Детям', 'children'],
  ['Спорт', 'sport'],
];

const store = {
  get favorites() {
    try { return JSON.parse(localStorage.getItem('favorites') || '[]'); }
    catch { return []; }
  },
  set favorites(v) { localStorage.setItem('favorites', JSON.stringify(v)); },
  get lastPlayed() { return localStorage.getItem('lastPlayed') || ''; },
  set lastPlayed(v) { localStorage.setItem('lastPlayed', v); },
  get volume() { return Number(localStorage.getItem('volume') ?? 1); },
  set volume(v) { localStorage.setItem('volume', String(v)); },
};

const el = (id) => document.getElementById(id);
const audio = el('audio');

let all = [];              // весь вшитый каталог
let list = [];             // то, что показано сейчас
let queue = [];            // по чему листают ⏮ ⏭
let current = null;        // играющая станция
let shown = PAGE;          // сколько строк списка сейчас в документе
let tab = 'search';
let genre = null;
let region = null;

/* ---------- утилиты ---------- */

const hostOf = (u) => {
  try {
    const h = new URL(u).hostname;
    // Голый IP логотипов не отдаёт — как и в Android-версии
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? null : h;
  } catch { return null; }
};

function artworkCandidates(s) {
  const out = [];
  if (s.favicon?.startsWith('http')) out.push(s.favicon);
  const home = hostOf(s.homepage);
  if (home) {
    out.push(`https://${home}/apple-touch-icon.png`);
    out.push(`https://${home}/favicon.ico`);
  }
  const stream = hostOf(s.url_resolved);
  if (stream) out.push(`https://${stream}/favicon.ico`);
  return [...new Set(out)];
}

const subtitleOf = (s) =>
  [s.country, (s.tags || '').split(',')[0]?.trim()].filter(Boolean).join(' · ');

const qualityOf = (s) =>
  [s.codec?.toUpperCase(), s.bitrate ? `${s.bitrate} kbps` : ''].filter(Boolean).join(' · ');

const idOf = (s) => s.stationuuid || s.url_resolved;

/**
 * Адрес потока с учётом того, как открыта страница.
 *
 * Больше половины российских станций вещают по http. Если страница открыта по https,
 * браузер считает такой поток небезопасной вставкой и блокирует его, даже не пытаясь
 * подключиться. Поэтому на защищённой странице пробуем тот же адрес по https — многие
 * вещатели поддерживают оба протокола. На http-странице отдаём адрес как есть.
 */
function streamUrl(s) {
  const raw = s.url_resolved;
  if (location.protocol !== 'https:') return raw;
  return raw.startsWith('http://') ? raw.replace(/^http:/, 'https:') : raw;
}

function matches(s, text, tag) {
  const byTag = !tag || (s.tags || '').toLowerCase().includes(tag.toLowerCase());
  if (!byTag) return false;
  if (!text) return true;
  const t = text.toLowerCase();
  return s.name.toLowerCase().includes(t) || (s.tags || '').toLowerCase().includes(t);
}

/* ---------- логотип с перебором источников ---------- */

/*
 * Логотипы грузятся только когда строка попадает в поле зрения.
 *
 * Атрибут loading="lazy" для этого не годится: он не срабатывает для изображений,
 * созданных до вставки в документ, и список оставался с заглушками. Плюс без такой
 * подгрузки браузер бросился бы качать тысячи логотипов сразу.
 */
const artObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    artObserver.unobserve(entry.target);
    loadArt(entry.target);
  });
}, { rootMargin: '300px' });

function loadArt(box) {
  const station = box._station;
  if (!station) return;
  const candidates = artworkCandidates(station);
  let i = 0;
  const tryNext = () => {
    if (i >= candidates.length) return;      // остаётся эмодзи-заглушка
    const img = new Image();
    img.alt = '';
    img.onload = () => { box.innerHTML = ''; box.appendChild(img); };
    img.onerror = () => { i += 1; tryNext(); };
    img.src = candidates[i];
  };
  tryNext();
}

function paintArt(box, station) {
  box._station = station;
  box.innerHTML = '📻';
  artObserver.observe(box);
}

/* ---------- отрисовка ---------- */

function rowFor(s) {
  const row = document.createElement('div');
  row.className = 'row';

  const art = document.createElement('div');
  art.className = 'art';
  paintArt(art, s);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  const playing = current && idOf(current) === idOf(s) && !audio.paused;
  name.className = 'name' + (playing ? ' now' : '');
  name.textContent = s.name;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = [subtitleOf(s), qualityOf(s)].filter(Boolean).join(' · ');
  meta.append(name, sub);

  const fav = document.createElement('button');
  const isFav = store.favorites.some((f) => f.stationuuid === s.stationuuid);
  fav.className = 'vol neutral' + (isFav ? ' active' : '');
  fav.textContent = isFav ? '★' : '☆';
  fav.setAttribute('aria-label', 'В избранное');
  fav.onclick = (e) => { e.stopPropagation(); toggleFavorite(s); };

  const play = document.createElement('button');
  play.className = 'vol play' + (playing ? '' : ' neutral');
  play.textContent = playing ? '❚❚' : '▶';
  play.setAttribute('aria-label', playing ? 'Пауза' : 'Играть');
  // Нажатие на строку текущей станции переключает паузу, а не перезапускает поток
  play.onclick = (e) => { e.stopPropagation(); tapStation(s); };

  row.append(art, meta, fav, play);
  row.onclick = () => tapStation(s);
  return row;
}

function render() {
  const box = el('list');
  box.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = tab === 'favorites'
      ? 'В избранном пока пусто. Нажмите ★ рядом со станцией.'
      : 'Ничего не найдено. Попробуйте другой жанр или запрос.';
    box.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  list.slice(0, shown).forEach((s) => frag.appendChild(rowFor(s)));
  box.appendChild(frag);

  if (list.length > shown) {
    const more = document.createElement('button');
    more.className = 'more';
    more.textContent = `Показать ещё ${Math.min(PAGE, list.length - shown)} из ${list.length}`;
    more.onclick = () => { shown += PAGE; render(); };
    box.appendChild(more);
  }
}

function renderPlayer() {
  el('pname').textContent = current ? current.name : 'Выберите станцию';
  el('pmeta').textContent = current
    ? [subtitleOf(current), qualityOf(current)].filter(Boolean).join(' · ')
    : '';
  const cover = el('cover');
  if (current) paintArt(cover, current);
  else cover.textContent = '📻';

  const playing = current && !audio.paused;
  el('play').textContent = playing ? '❚❚' : '▶';
  el('play').setAttribute('aria-label', playing ? 'Пауза' : 'Играть');
  el('play').classList.toggle('neutral', !playing);

  const isFav = current && store.favorites.some((f) => f.stationuuid === current.stationuuid);
  const favBtn = el('fav');
  favBtn.textContent = isFav ? '★' : '☆';
  favBtn.classList.toggle('active', !!isFav);

  const canSkip = queue.length > 1;
  el('prev').disabled = !canSkip;
  el('next').disabled = !canSkip;

  el('status').textContent = audio.paused
    ? (current ? 'Пауза' : '')
    : 'В эфире';
  // Зелёный только у состояния эфира — как в Android-версии
  el('status').classList.toggle('live', !audio.paused && !!current);
}

function renderCount() {
  if (tab === 'search') el('count').textContent = `станций: ${list.length}`;
  if (tab === 'region') el('region-count').textContent = `станций: ${list.length}`;
}

/* ---------- вкладки ---------- */

function setTab(next) {
  tab = next;
  document.querySelectorAll('#tabs .vol').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === next);
  });
  el('tab-search').hidden = next !== 'search';
  el('tab-region').hidden = next !== 'region';
  el('tab-favorites').hidden = next !== 'favorites';
  refresh();
}

function refresh() {
  const text = (el('query').value || '').trim();
  shown = PAGE;
  if (tab === 'favorites') {
    list = store.favorites;
  } else if (tab === 'region') {
    // Сравниваем по нормализованному названию, иначе «Moscow (Russia)» и «Moscow»
    // считались бы одним регионом в списке, но разными при фильтрации.
    list = all.filter((s) => normalizeRegion(s.state || '') === region && matches(s, '', genre));
  } else {
    const tag = GENRES.find((g) => g[0] === genre)?.[1] ?? null;
    list = all.filter((s) => matches(s, text, tag));
  }
  renderCount();
  render();
  renderPlayer();
  updateMediaSession();
}

/* ---------- воспроизведение ---------- */

function tapStation(s) {
  if (current && idOf(current) === idOf(s)) {
    togglePlay();
    return;
  }
  playStation(s, list);
}

function playStation(s, newQueue) {
  current = s;
  queue = newQueue && newQueue.length ? newQueue : [s];
  store.lastPlayed = idOf(s);

  audio.src = streamUrl(s);
  audio.volume = store.volume;
  audio.play().catch((err) => {
    // Автовоспроизведение запрещено до первого касания — это нормально для Safari
    el('status').textContent = 'Нажмите ▶, чтобы начать';
    console.warn('play() отклонён:', err?.message);
  });

  render();
  renderPlayer();
  updateMediaSession();
}

function togglePlay() {
  if (!current) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function step(delta) {
  if (!current || queue.length < 2) return;
  const i = queue.findIndex((s) => idOf(s) === idOf(current));
  const next = queue[(i + delta + queue.length) % queue.length];
  playStation(next, queue);
}

function toggleFavorite(s) {
  const favs = store.favorites;
  const i = favs.findIndex((f) => f.stationuuid === s.stationuuid);
  if (i >= 0) favs.splice(i, 1); else favs.push(s);
  store.favorites = favs;
  if (tab === 'favorites') refresh(); else render();
  renderPlayer();
}

/* ---------- экран блокировки и наушники ---------- */

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !current) return;
  const cover = artworkCandidates(current)[0];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: current.name,
    artist: subtitleOf(current) || 'Просто Радио',
    album: 'Просто Радио',
    artwork: cover ? [{ src: cover, sizes: '512x512' }] : [],
  });
  // Без этого iOS не покажет кнопки на экране блокировки
  navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
}

function wireMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (name, fn) => {
    try { navigator.mediaSession.setActionHandler(name, fn); } catch { /* не поддерживается */ }
  };
  set('play', () => audio.play().catch(() => {}));
  set('pause', () => audio.pause());
  set('previoustrack', () => step(-1));
  set('nexttrack', () => step(1));
  set('stop', () => { audio.pause(); audio.removeAttribute('src'); });
}

/* ---------- регион ---------- */

/**
 * Регион из названия часового пояса.
 *
 * Браузер знает зону вида «Europe/Moscow» — этого достаточно, чтобы предложить регион
 * без обращения к сети. Если совпадения нет, останется самый наполненный регион каталога.
 */
function regionFromTimezone(regions) {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const city = zone.split('/').pop().replace(/_/g, ' ').toLowerCase();
    if (!city) return null;
    const hit = regions.find(([name]) => name.toLowerCase().includes(city));
    return hit ? hit[0] : null;
  } catch { return null; }
}

/** Убирает уточнения в скобках: «Moscow (Russia)» и «Moscow» — один и тот же регион. */
const normalizeRegion = (name) => name.replace(/\s*\([^)]*\)\s*$/, '').trim();

function buildRegions() {
  const counts = new Map();
  all.forEach((s) => {
    const name = normalizeRegion(s.state || '');
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  });
  const regions = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  const select = el('region-select');
  select.innerHTML = '';
  regions.forEach(([name, n]) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name} — ${n}`;
    select.appendChild(opt);
  });

  const detected = regionFromTimezone(regions);
  region = detected || regions[0]?.[0] || null;
  select.value = region ?? '';
  el('region-name').textContent = region ?? 'Регион не определён';
  el('region-note').textContent = detected
    ? 'определено по часовому поясу'
    : 'выбрано автоматически';

  select.onchange = () => {
    region = select.value;
    el('region-name').textContent = region;
    el('region-note').textContent = 'выбрано вручную';
    if (tab === 'region') refresh();
  };
}

/* ---------- запуск ---------- */

function buildChips() {
  const box = el('chips');
  // Без очистки каждый выбор жанра дописывал ещё один ряд чипов: после нескольких
  // нажатий их становилось десятки, и подсветка выбранного терялась среди копий.
  box.innerHTML = '';
  GENRES.forEach(([label]) => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (genre === label ? ' on' : '');
    chip.textContent = label;
    chip.onclick = () => {
      genre = genre === label ? null : label;
      buildChips();
      refresh();
    };
    box.appendChild(chip);
  });
}

async function boot() {
  buildChips();
  setTab('search');

  try {
    const res = await fetch('stations.json');
    // В каталоге часть названий приходит с лишними пробелами по краям — в списке это
    // выглядит как кривой отступ, а поиск по точному имени не находит станцию.
    all = (await res.json()).map((s) => ({
      ...s,
      name: (s.name || '').trim(),
      tags: (s.tags || '').trim(),
      state: (s.state || '').trim(),
    }));
  } catch (e) {
    el('list').innerHTML = '<div class="empty">Не удалось прочитать каталог станций.</div>';
    return;
  }

  buildRegions();
  refresh();

  // Продолжаем с той станции, на которой закрыли
  const lastId = store.lastPlayed;
  if (lastId) {
    const s = all.find((x) => idOf(x) === lastId);
    if (s) {
      current = s;
      // Очередь — весь каталог, а не одна станция: иначе кнопки ⏮ ⏭ остаются
      // заблокированными до тех пор, пока не выберешь другую станцию.
      queue = all;
      audio.src = streamUrl(s);        // без play(): Safari не даст звук без касания
      el('status').textContent = 'Нажмите ▶, чтобы продолжить';
      renderPlayer();
    }
  }

  wireMediaSession();
}

audio.addEventListener('play', () => { render(); renderPlayer(); updateMediaSession(); });
audio.addEventListener('pause', () => { render(); renderPlayer(); updateMediaSession(); });
audio.addEventListener('waiting', () => { el('status').textContent = 'Подключение…'; });
audio.addEventListener('playing', () => { el('status').textContent = 'В эфире'; });
audio.addEventListener('error', () => {
  el('status').textContent = location.protocol === 'https:'
    ? 'Станция недоступна по защищённому соединению'
    : 'Станция недоступна';
});
// Поток оборвался — пробуем возобновить, как это делает Android-версия
audio.addEventListener('stalled', () => { setTimeout(() => audio.play().catch(() => {}), 1500); });

el('play').onclick = togglePlay;
el('prev').onclick = () => step(-1);
el('next').onclick = () => step(1);
el('fav').onclick = () => current && toggleFavorite(current);
el('volume').value = store.volume;
el('volume').oninput = (e) => { audio.volume = store.volume = Number(e.target.value); };
el('query').oninput = () => { if (tab !== 'search') setTab('search'); else refresh(); };

document.querySelectorAll('#tabs .vol').forEach((b) => {
  b.onclick = () => setTab(b.dataset.tab);
});

// Сервис-воркер: оболочка и каталог кэшируются, приложение открывается без сети
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

boot();
