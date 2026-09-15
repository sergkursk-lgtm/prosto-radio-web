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
  /*
    Помним, что прямой адрес не работает и нужен прокси. Без этой памяти каждая
    станция заново ждала бы таймаут, прежде чем уйти на рабочий маршрут: на
    мобильной сети оператор режет нестандартные порты, и прямой адрес молчит.
  */
  get preferProxy() { return localStorage.getItem('preferProxy') === '1'; },
  set preferProxy(v) { localStorage.setItem('preferProxy', v ? '1' : '0'); },
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
/*
  Адрес прокси-воркера (см. worker/stream-proxy.js и раздел «Прокси потоков»
  в README). Пустая строка — приложение работает напрямую, как раньше.

  Зачем прокси. 57% станций вещают по http, а браузер блокирует http-аудио на
  https-странице. Но и https-поток может не открыться: «Маруся ФМ» вещает на
  портах 8000 и 9433, а мобильные операторы нестандартные порты режут — по Wi-Fi
  та же станция играет, в мобильной сети нет. Воркер ходит за потоком со своей
  стороны и отдаёт его клиенту по 443, поэтому блокировка порта перестаёт мешать.
*/
const PROXY_BASE = '';

/** Адрес потока как есть, с повышением http → https на защищённой странице. */
function directUrl(s) {
  const raw = s.url_resolved || s.url || '';
  if (location.protocol !== 'https:') return raw;
  return raw.startsWith('http://') ? raw.replace(/^http:/, 'https:') : raw;
}

function proxiedUrl(u) {
  return PROXY_BASE && u ? PROXY_BASE + '?url=' + encodeURIComponent(u) : null;
}

/**
 * Очередь адресов для станции — по порядку предпочтения.
 *
 * Одного адреса мало: вещатели отдают редиректы на другие хосты и порты, а
 * операторы связи режут нестандартные порты. Поэтому пробуем по очереди —
 * напрямую, затем через прокси, затем другие записи каталога с тем же названием
 * (это разные хосты той же станции и часто единственный работающий вариант).
 */
function streamCandidates(s) {
  const out = [];
  const seen = new Set();
  const push = (u, viaProxy) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, viaProxy: !!viaProxy });
  };

  // Порядок зависит от того, что уже сработало: если прямой адрес подводил,
  // начинаем с прокси, иначе каждая станция снова ждала бы таймаут впустую.
  const add = (station) => {
    const direct = directUrl(station);
    const throughProxy = proxiedUrl(direct);
    if (store.preferProxy && throughProxy) {
      push(throughProxy, true);
      push(direct, false);
    } else {
      push(direct, false);
      push(throughProxy, true);
    }
  };

  if (s) {
    add(s);
    const twins = all.filter((x) => x.name === s.name && idOf(x) !== idOf(s));
    for (const t of twins.slice(0, 3)) add(t);
  }
  return out;
}

/**
 * Честная причина вместо прежнего «недоступна по защищённому соединению»,
 * которое выводилось при любой ошибке на https и уводило диагностику в сторону.
 */
function diagnoseStreamError(s, code) {
  const raw = (s && (s.url_resolved || s.url)) || '';
  let port = '';
  try { port = new URL(directUrl(s)).port; } catch { port = ''; }
  const oddPort = !!port && port !== '443' && port !== '80';

  if (code === 2) return 'Нет связи с потоком — проверьте сеть';
  if (code === 3) return 'Поток повреждён';
  if (code === 4) {
    if (location.protocol === 'https:' && /^http:\/\//i.test(raw) && !PROXY_BASE) {
      return 'Станция вещает по http, а страница защищена — нужен прокси';
    }
    if (oddPort) return `Поток не открылся (порт ${port}) — возможно, оператор его блокирует`;
    return 'Формат потока не поддерживается браузером';
  }
  if (code === 1) return 'Загрузка потока прервана';
  return 'Станция недоступна';
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
  box.innerHTML = svg('radio', 22);
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
  const isCurrent = !!current && idOf(current) === idOf(s);
  const playing = isCurrent && !audio.paused;
  const name = document.createElement('div');
  name.className = 'name' + (isCurrent ? ' now' : '');
  name.textContent = s.name;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = [subtitleOf(s), qualityOf(s)].filter(Boolean).join(' · ');
  meta.append(name, sub);

  // В строке — две рабочие кнопки: избранное и играть/пауза.
  // Кебаб с меню убран: он прятал оба действия за лишний клик, а само меню
  // не закрывалось — ссылка на открытое меню не сохранялась, поэтому закрывать
  // было нечего и они накапливались в DOM.
  const isFav = store.favorites.some((f) => f.stationuuid === s.stationuuid);

  const fav = document.createElement('button');
  fav.className = 'ico fav-btn' + (isFav ? ' on' : '');
  fav.type = 'button';
  fav.setAttribute('aria-label', isFav ? 'Убрать из избранного' : 'В избранное');
  fav.innerHTML = svg(isFav ? 'heart-filled' : 'heart', 22);
  fav.onclick = (e) => { e.stopPropagation(); toggleFavorite(s); };

  const play = document.createElement('button');
  play.className = 'ico play-btn' + (playing ? ' on' : '');
  play.type = 'button';
  play.setAttribute('aria-label', playing ? 'Пауза' : 'Играть');
  play.innerHTML = svg(playing ? 'pause' : 'play', 22);
  // Нажатие на строку текущей станции переключает паузу, а не перезапускает поток.
  // Экран плеера здесь НЕ открывается: в портрете выбор станции только запускает
  // эфир, а плеер разворачивается тапом по мини-плееру внизу. В ландшафте правая
  // колонка и так всегда на экране, поэтому там это ничего не меняет.
  play.onclick = (e) => { e.stopPropagation(); tapStation(s); };

  row.append(art, meta, fav, play);
  row._stationId = idOf(s);
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
  el('player-who').textContent = current ? current.name : 'Ничего не выбрано';
  el('pname').textContent = current ? current.name : 'Выберите станцию';
  el('pmeta').textContent = current
    ? [subtitleOf(current), qualityOf(current)].filter(Boolean).join(' · ')
    : '';

  // Битрейт отдельной пилюлей — как в референсе
  const q = el('quality');
  q.hidden = !current;
  q.textContent = current ? (qualityOf(current) || '') : '';

  const cover = el('cover');
  if (current) paintArt(cover, current);
  else cover.innerHTML = svg('radio', 56);

  /*
    Свечение вокруг обложки. Оттенок выводится из имени станции, а не сэмплируется
    из логотипа: логотипы отдаются чужими хостами без CORS-заголовков, и
    getImageData на таком изображении бросает SecurityError. Хэш даёт стабильный
    цвет для каждой станции и работает всегда.
  */
  el('player-pane').style.setProperty('--amb-h', String(ambientHue(current)));

  const playing = current && !audio.paused;
  const hero = el('play');
  hero.innerHTML = svg(playing ? 'pause' : 'play', 26);
  hero.setAttribute('aria-label', playing ? 'Пауза' : 'Играть');
  hero.disabled = !current;

  const isFav = current && store.favorites.some((f) => f.stationuuid === current.stationuuid);
  const favBtn = el('fav');
  favBtn.innerHTML = svg(isFav ? 'heart-filled' : 'heart');
  favBtn.classList.toggle('on', !!isFav);

  const canSkip = queue.length > 1;
  el('prev').disabled = !canSkip;
  el('next').disabled = !canSkip;

  // Состояние эфира показывает строка «В ЭФИРЕ» у полосы — здесь его не дублируем.
  // Ошибка потока важнее состояния паузы: она объясняет, почему тишина.
  el('status').textContent = streamError || (audio.paused ? (current ? 'Пауза' : '') : '');

  // Полоса без бегунка: у живого потока нет длительности и перемотки
  el('air-track').classList.toggle('playing', !audio.paused && !!current);
  el('air-state').textContent = (!audio.paused && current) ? 'В ЭФИРЕ' : '';

  el('mute').innerHTML = svg(audio.muted || audio.volume === 0 ? 'mute' : 'volume');
  el('mute').classList.toggle('on', audio.muted || audio.volume === 0);

  renderMini();
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

let candidates = [];
let candidateIndex = 0;
/*
  Текст ошибки потока хранится отдельно от DOM. Причина: обрыв потока вызывает
  событие pause, а его обработчик зовёт renderPlayer(), который переписывал
  строку состояния словом «Пауза» — и объяснение причины до пользователя
  не доходило.
*/
let streamError = '';
let candidateTimer = 0;

function loadCandidate() {
  const c = candidates[candidateIndex];
  if (!c) return;
  streamError = '';
  audio.src = c.url;
  audio.volume = store.volume;
  audio.play().catch((err) => {
    // Автовоспроизведение запрещено до первого касания — это нормально для Safari
    el('status').textContent = 'Нажмите ▶, чтобы начать';
    console.warn('play() отклонён:', err?.message);
  });

  /*
    Страховка от «чёрной дыры»: если оператор связи не отказывает в соединении,
    а молча глотает пакеты, событие error не придёт и перебор источников никогда
    не начнётся — пользователь останется на «Подключение…» навсегда. Поэтому
    через 10 секунд без данных идём к следующему адресу.
  */
  clearTimeout(candidateTimer);
  candidateTimer = setTimeout(() => {
    if (audio.readyState >= 2) return;          // поток уже отдаёт данные
    if (candidateIndex < candidates.length - 1) {
      advanceCandidate();
    } else if (!streamError) {
      streamError = diagnoseStreamError(current, 4);
      renderPlayer();
    }
  }, 10000);
}

/**
 * Переход к следующему адресу. Заодно запоминаем, какой маршрут работает:
 * уход с прямого адреса на прокси означает, что прямой блокируется, а провал
 * самого прокси означает, что прокси не помощник — тогда возвращаемся к прямому.
 */
function advanceCandidate() {
  const cur = candidates[candidateIndex];
  const next = candidates[candidateIndex + 1];
  if (cur && cur.viaProxy) store.preferProxy = false;
  if (next && next.viaProxy) store.preferProxy = true;
  candidateIndex += 1;
  loadCandidate();
}

function playStation(s, newQueue) {
  current = s;
  queue = newQueue && newQueue.length ? newQueue : [s];
  store.lastPlayed = idOf(s);

  candidates = streamCandidates(s);
  candidateIndex = 0;
  loadCandidate();

  render();
  renderPlayer();
  updateMediaSession();
}

function togglePlay() {
  if (!current) return;
  if (audio.paused) {
    // Поток мог отвалиться целиком — тогда начинаем перебор источников заново
    if (audio.error) { candidateIndex = 0; loadCandidate(); }
    else audio.play().catch(() => {});
  } else audio.pause();
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

  // «Все» — из референса: активный синий чип в начале ряда. Он же закрывает
  // дыру в удобстве: раньше снять фильтр жанра можно было только повторным
  // нажатием на тот же жанр, то есть неявно.
  const allChip = document.createElement('button');
  allChip.className = 'chip' + (genre === null ? ' on' : '');
  allChip.textContent = 'Все';
  allChip.onclick = () => { genre = null; buildChips(); refresh(); };
  box.appendChild(allChip);

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
      // Готовим поток, но не запускаем: Safari не даст звук без касания.
      // Берём первый адрес цепочки; если он не откроется, обработчик error
      // переключится на следующий (прокси, другая запись каталога).
      candidates = streamCandidates(s);
      candidateIndex = 0;
      if (candidates[0]) audio.src = candidates[0].url;
      el('status').textContent = 'Нажмите ▶, чтобы продолжить';
      renderPlayer();
    }
  }

  wireMediaSession();
}

audio.addEventListener('play', () => { render(); renderPlayer(); updateMediaSession(); });
audio.addEventListener('pause', () => { render(); renderPlayer(); updateMediaSession(); });
audio.addEventListener('waiting', () => { el('status').textContent = 'Подключение…'; });
// Строка «В ЭФИРЕ» у полосы уже показывает состояние, поэтому здесь только
// снимаем служебные сообщения («Подключение…», «Нажмите ▶…»), а не дублируем его.
audio.addEventListener('playing', () => {
  clearTimeout(candidateTimer);
  streamError = '';
  el('status').textContent = '';
});
audio.addEventListener('error', () => {
  // Сначала молча пробуем следующий адрес: редирект, прокси, другая запись каталога
  if (candidateIndex < candidates.length - 1) {
    advanceCandidate();
    return;
  }
  streamError = diagnoseStreamError(current, audio.error?.code);
  renderPlayer();
  if (candidates.length > 1) console.warn('источники исчерпаны:', candidates);
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

/* ==========================================================================
   Иконки, экран плеера и меню строки.

   Добавлено вместе с переходом на дизайн «Тёмная классика». Раньше интерфейс
   рисовался эмодзи (🔍 ★ ⏮ 📻): они по-разному выглядят на разных системах,
   не наследуют цвет и толщину штриха и не масштабируются вместе с текстом.
   Теперь это один набор SVG на общей сетке 24×24 со штрихом 1.8.
   ========================================================================== */

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21"/>',
  pin: '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
  pencil: '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  heart: '<path d="M12 20.2S4.6 15.6 4.6 10.4A4.2 4.2 0 0 1 12 7.5a4.2 4.2 0 0 1 7.4 2.9c0 5.2-7.4 9.8-7.4 9.8z"/>',
  'heart-filled': '<path d="M12 20.2S4.6 15.6 4.6 10.4A4.2 4.2 0 0 1 12 7.5a4.2 4.2 0 0 1 7.4 2.9c0 5.2-7.4 9.8-7.4 9.8z" fill="currentColor"/>',
  play: '<path d="M8.2 5.4v13.2L19 12z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M9.6 5.6v12.8M14.4 5.6v12.8" stroke-width="2.6"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  prev: '<path d="M18.5 6.2v11.6L9.8 12z" fill="currentColor" stroke="none"/><path d="M6.6 5.6v12.8" stroke-width="2.2"/>',
  next: '<path d="M5.5 6.2v11.6L14.2 12z" fill="currentColor" stroke="none"/><path d="M17.4 5.6v12.8" stroke-width="2.2"/>',
  kebab: '<circle cx="12" cy="5.4" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="18.6" r="1.7" fill="currentColor" stroke="none"/>',
  volume: '<path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z"/><path d="M15.6 9.2a4 4 0 0 1 0 5.6"/>',
  mute: '<path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z"/><path d="M16 9.8l4 4.4M20 9.8l-4 4.4"/>',
  queue: '<path d="M4 7h10M4 12h10M4 17h6"/><path d="M14.5 14.2v5.4l4.5-2.7z" fill="currentColor" stroke="none"/>',
  radio: '<rect x="3" y="8.5" width="18" height="11.5" rx="3"/><circle cx="12" cy="14.2" r="3"/><path d="M7.6 8.5 9.4 4.5h5.2l1.8 4"/>',
};

function svg(name, size = 24) {
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '"'
    + ' fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + (ICONS[name] || '') + '</svg>';
}

/* Заменяет <span data-icon="name"> на саму иконку: одна точка правды для всех */
function hydrateIcons() {
  document.querySelectorAll('[data-icon]').forEach((node) => {
    const name = node.getAttribute('data-icon');
    node.removeAttribute('data-icon');
    node.innerHTML = svg(name, Number(node.dataset.size) || 24);
  });
}

/*
  Свечение вокруг обложки. Оттенок выводится из идентификатора станции, а не
  сэмплируется из логотипа: логотипы отдают чужие хосты без CORS-заголовков,
  и getImageData на таком изображении бросает SecurityError. Хэш даёт
  стабильный цвет для каждой станции и не зависит от сети.
*/
const AMBIENT_HUES = [258, 210, 286, 330, 12, 196, 240, 302, 170, 42];

function ambientHue(station) {
  if (!station) return 258;
  const key = String(station.stationuuid || station.name || '');
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AMBIENT_HUES[h % AMBIENT_HUES.length];
}

/* ---------- экран плеера: в портрете оверлей, в ландшафте постоянная колонка ---------- */

function openPlayer() { el('player-pane').classList.add('open'); renderMini(); }
function closePlayer() { el('player-pane').classList.remove('open'); renderMini(); }

let airStart = 0;
function tickAir() {
  const running = !!current && !audio.paused;
  if (running && !airStart) airStart = Date.now();
  if (!running) airStart = 0;
  const secs = airStart ? Math.floor((Date.now() - airStart) / 1000) : 0;
  el('elapsed').textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
}

function renderMini() {
  const show = !!current && !el('player-pane').classList.contains('open');
  el('mini').classList.toggle('show', show);
  if (!show) return;
  el('mini-name').textContent = current.name;
  el('mini-sub').textContent = [subtitleOf(current), qualityOf(current)].filter(Boolean).join(' · ');
  paintArt(el('mini-art'), current);
  const t = el('mini-toggle');
  t.innerHTML = svg(audio.paused ? 'play' : 'pause', 22);
  t.setAttribute('aria-label', audio.paused ? 'Играть' : 'Пауза');
}

/* ---------- привязки ---------- */

el('player-back').onclick = closePlayer;
el('mini').onclick = openPlayer;
el('mini').onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPlayer(); }
};
el('mini-toggle').onclick = (e) => { e.stopPropagation(); togglePlay(); };
el('focus-search').onclick = () => { setTab('search'); el('query').focus(); };
el('quick-region').onclick = () => setTab('region');

el('mute').onclick = () => {
  if (audio.muted || audio.volume === 0) {
    audio.muted = false;
    audio.volume = store.volume > 0 ? store.volume : 1;
    el('volume').value = audio.volume;
  } else {
    audio.muted = true;
  }
  renderPlayer();
};

// Иконка списка возвращает к текущей станции: закрывает плеер, находит строку
// и подсвечивает её. Так кнопка делает ровно то, что обещает её вид.
el('queue').onclick = () => {
  if (!current) return;
  closePlayer();
  const row = Array.from(document.querySelectorAll('#list .row'))
    .find((r) => r._stationId === idOf(current));
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.style.transition = 'background .35s ease';
  row.style.background = 'var(--accent-soft)';
  setTimeout(() => { row.style.background = ''; }, 1500);
};

hydrateIcons();
renderPlayer();
setInterval(tickAir, 1000);

boot();
