/*
 * Прокси потоков для https-хостинга.
 *
 * Зачем: 57% станций в каталоге вещают по http. Браузер блокирует http-аудио на
 * https-странице, поэтому на GitHub Pages такие станции молчат. Воркер принимает
 * запрос от клиента, сам идёт за http-потоком и отдаёт его обратно уже по https.
 *
 * Развёртывание (бесплатного тарифа Cloudflare хватает с запасом):
 *   1. https://dash.cloudflare.com → Workers & Pages → Create → Worker
 *   2. вставить этот файл целиком, сохранить и развернуть
 *   3. скопировать адрес вида https://имя.пользователь.workers.dev
 *   4. в app.js заменить функцию streamUrl на вариант из README
 *
 * Безопасность: воркер намеренно не является открытым релеем. Он отказывается
 * ходить в локальную сеть и в служебные диапазоны и сам проверяет каждое
 * перенаправление, прежде чем за ним идти.
 *
 * Ещё он умеет отдавать «что играет»: запрос с ?meta=1&url=… читает первый
 * непустой блок ICY-метаданных и возвращает {"title":"Исполнитель - Трек"}.
 * Браузерный <audio> эти метаданные не показывает, поэтому их читает воркер.
 */

/*
  Принимаем и http, и https.

  Изначально здесь стоял только http — считалось, что https-потоки клиент играет
  напрямую. Это неверно: часть станций вещает по https на нестандартных портах
  («Маруся ФМ» — 8000 и 9433), а мобильные операторы такие порты режут. Смысл
  прокси не в смене схемы, а в смене маршрута: клиент идёт на workers.dev по 443,
  а за потоком воркер отправляется со своей стороны.
*/
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const MAX_REDIRECTS = 3;

/*
  Воркер отдаёт любой публичный поток, поэтому чужие сайты могли бы гонять через
  него свой трафик и выжигать квоту Workers. Пускаем только свои страницы:
  github.io (в том числе форки) и локальный запуск.
  shortcut: запрос совсем без Origin и Referer пропускается, иначе часть плееров
  и приложений на iOS останется без звука; если квоту начнут выжигать — менять на
  токен в query. Свой домен вместо github.io сюда же.
*/
const ALLOWED_ORIGIN = /^https:\/\/[a-z0-9-]+\.github\.io$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function originAllowed(request) {
  const source = request.headers.get('origin') || request.headers.get('referer');
  if (!source) return true;
  try {
    return ALLOWED_ORIGIN.test(new URL(source).origin);
  } catch {
    return false;
  }
}

/*
  Вещатели раскидывают слушателей по пулу узлов (listen8, listen9, listen13…),
  и часть узлов не отвечает: у «Маруси ФМ» отвечает примерно одна попытка из трёх.
  Одна попытка на запрос означала бы, что клиент ждёт впустую и уходит на другой
  адрес, хотя рядом рабочий узел. Поэтому пробуем несколько раз, но быстро:
  общий бюджет запроса ограничен, чтобы клиент не ждал дольше своего таймаута.
*/
const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 3000;   // на одну попытку
const TOTAL_BUDGET_MS = 9000;      // на весь запрос целиком

/** Приватные и служебные диапазоны: через прокси в них ходить нельзя. */
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c] = ipv4.slice(1).map(Number);
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT операторов
    if (a === 192 && b === 0 && c === 0) return true;    // зарезервировано протоколами
    if (a === 198 && (b === 18 || b === 19)) return true; // тестовые стенды
    if (a >= 224) return true;                          // multicast, служебное, broadcast
  }

  // IPv6 в скобках
  if (host.startsWith('[')) {
    const inner = host.slice(1, host.indexOf(']'));
    /*
      ::ffff:127.0.0.1 — тот же localhost, записанный по-другому. URL-парсер
      нормализует его в hex (::ffff:7f00:1), поэтому понимаем обе записи.
    */
    const dotted = inner.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) return isPrivateHost(dotted[1]);
    const hex = inner.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return isPrivateHost([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    if (inner === '::' || inner === '::1') return true;
    if (inner.startsWith('fc') || inner.startsWith('fd') || inner.startsWith('fe80') || inner.startsWith('ff')) return true;
  }
  return false;
}

function bad(message, status = 400) {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

/*
  Разбор блока ICY-метаданных. В потоке после каждых metaint байт аудио идёт
  один байт длины (в шестнадцатибайтовых словах) и сам блок:
  StreamTitle='Исполнитель - Трек';ДругиеПоля=...
*/
export function parseIcyTitle(buf, metaint) {
  if (!buf || !Number.isFinite(metaint) || metaint <= 0) return null;
  if (buf.length < metaint + 1) return null;
  const length = buf[metaint] * 16;
  if (!length || buf.length < metaint + 1 + length) return null;
  const text = new TextDecoder('utf-8').decode(buf.subarray(metaint + 1, metaint + 1 + length));
  const match = text.match(/StreamTitle='([^']*)'/);
  const title = match ? match[1].trim() : '';
  return title || null;
}

/*
  Дочитываем поток до первого непустого блока метаданных. Пустой первый блок —
  обычное дело: станция отдаёт StreamTitle='' при подключении, а название
  приходит следующим блоком. Обычно metaint — 8–32 КБ, то есть 0.5–2 секунды
  эфира; больше 200 КБ не читаем, чтобы не тянуть мегабайты.
*/
async function readIcyTitle(upstream, signal) {
  const metaint = Number(upstream.headers.get('icy-metaint'));
  if (!upstream.body || !Number.isFinite(metaint) || metaint <= 0 || metaint > 65536) return null;

  const reader = upstream.body.getReader();
  const chunks = [];
  let size = 0;
  const readMore = async () => {
    if (signal?.aborted) return false;
    const { value, done } = await reader.read();
    if (done) return false;
    chunks.push(value);
    size += value.length;
    return true;
  };
  const join = () => {
    const buf = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { buf.set(chunk, at); at += chunk.length; }
    return buf;
  };

  try {
    let offset = 0;
    for (let block = 0; block < 4; block += 1) {
      while (size < offset + metaint + 1) {
        if (!(await readMore())) return null;
      }
      const length = join()[offset + metaint] * 16;
      const end = offset + metaint + 1 + length;
      while (size < end) {
        if (!(await readMore())) break;
      }
      const buf = join();
      if (buf.length < end) return null;

      const title = parseIcyTitle(buf.subarray(offset), metaint);
      if (title) return title;

      offset = end;
      if (offset > 200000) break;
    }
    return null;
  } finally {
    reader.cancel().catch(() => {});
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    const wantsMeta = url.searchParams.get('meta') === '1';

    if (!target) return bad('Укажите адрес потока: ?url=');
    if (!originAllowed(request)) return bad('Запрос с чужого сайта', 403);

    let streamUrl;
    try {
      streamUrl = new URL(target);
    } catch {
      return bad('Некорректный адрес потока');
    }

    if (!ALLOWED_SCHEMES.has(streamUrl.protocol)) {
      return bad('Прокси принимает только http и https');
    }
    if (isPrivateHost(streamUrl.hostname)) {
      return bad('Адрес вне допустимого диапазона', 403);
    }

    let lastError = 'узел не ответил';
    /*
      Для трека ждём дольше: блок метаданных идёт после 8–32 КБ эфира, это
      1–2 секунды, а на медленном узле и больше. Плееру это ждать не страшно —
      запрос трека не блокирует звук.
    */
    const attemptMs = wantsMeta ? 8000 : ATTEMPT_TIMEOUT_MS;
    const deadline = Date.now() + (wantsMeta ? 15000 : TOTAL_BUDGET_MS);

    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      if (Date.now() >= deadline) break;
      let current = streamUrl;
      lastError = 'слишком много перенаправлений';

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const left = deadline - Date.now();
        if (left <= 0) break;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(attemptMs, left));

        try {
          const upstream = await fetch(current.toString(), {
            redirect: 'manual',            // перенаправления проверяем сами
            signal: controller.signal,
            headers: {
              // Обычному прокси метаданные не нужны: блоки ICY ломают поток.
              // Для ?meta=1, наоборот, просим их — иначе название трека не узнать.
              'user-agent': 'ProstoRadio/1.0 (+stream-proxy)',
              accept: '*/*',
              ...(wantsMeta ? { 'icy-metadata': '1' } : {}),
            },
          });

          /*
            Перенаправление проходим здесь же. Раньше воркер возвращал 302 клиенту,
            и тот шёл за следующей нодой сам — лишняя поездка до клиента и обратно
            на каждом шаге цепочки. Теперь клиент получает один готовый ответ.
          */
          if (upstream.status >= 300 && upstream.status < 400) {
            const location = upstream.headers.get('location');
            if (!location) { lastError = 'перенаправление без адреса'; break; }
            const next = new URL(location, current);
            if (!ALLOWED_SCHEMES.has(next.protocol) || isPrivateHost(next.hostname)) {
              return bad('Перенаправление на недопустимый адрес', 403);
            }
            current = next;
            continue;
          }

          if (!upstream.ok) { lastError = `станция ответила ${upstream.status}`; break; }

          // Режим «что играет»: отдаём не поток, а первый блок ICY-метаданных
          if (wantsMeta) {
            return json({ title: await readIcyTitle(upstream, controller.signal) });
          }

          // Отдаём поток как есть. CORS нужен, чтобы клиент мог читать ответ со своего домена.
          const headers = new Headers();
          for (const name of ['content-type', 'icy-name', 'icy-genre', 'icy-br']) {
            const value = upstream.headers.get(name);
            if (value) headers.set(name, value);
          }
          headers.set('access-control-allow-origin', '*');
          headers.set('cache-control', 'no-store');

          return new Response(upstream.body, { status: 200, headers });
        } catch (error) {
          lastError = error?.name === 'AbortError'
            ? 'узел не ответил вовремя'
            : `ошибка связи (${error?.name || 'unknown'})`;
          break;
        } finally {
          clearTimeout(timer);
        }
      }
    }

    return bad(`Станция недоступна: ${lastError}`, 504);
  },
};
