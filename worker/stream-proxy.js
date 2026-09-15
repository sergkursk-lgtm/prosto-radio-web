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
 * Безопасность: воркер намеренно не является открытым релеем. Он принимает только
 * http-адреса (https-потоки идут напрямую), отказывается ходить в локальную сеть
 * и в служебные диапазоны, и не следует за перенаправлениями на другие адреса.
 */

const ALLOWED_SCHEME = 'http:';
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20000;

/** Приватные и служебные диапазоны: через прокси в них ходить нельзя. */
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
  }

  // IPv6 в скобках
  if (host.startsWith('[')) {
    const inner = host.slice(1, host.indexOf(']'));
    if (inner === '::1' || inner.startsWith('fc') || inner.startsWith('fd') || inner.startsWith('fe80')) return true;
  }
  return false;
}

function bad(message, status = 400) {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) return bad('Укажите адрес потока: ?url=');

    let streamUrl;
    try {
      streamUrl = new URL(target);
    } catch {
      return bad('Некорректный адрес потока');
    }

    // https-потоки в прокси не нуждаются — клиент играет их напрямую
    if (streamUrl.protocol !== ALLOWED_SCHEME) {
      return bad('Прокси принимает только http-адреса');
    }
    if (isPrivateHost(streamUrl.hostname)) {
      return bad('Адрес вне допустимого диапазона', 403);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const upstream = await fetch(streamUrl.toString(), {
        redirect: 'manual',                  // перенаправления проверяем сами
        signal: controller.signal,
        headers: {
          // Метаданные не запрашиваем: они добавили бы в поток посторонние блоки
          'user-agent': 'ProstoRadio/1.0 (+stream-proxy)',
          accept: '*/*',
        },
      });

      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get('location');
        if (!location) return bad('Станция перенаправила в никуда', 502);
        const next = new URL(location, streamUrl);
        if (next.protocol !== ALLOWED_SCHEME || isPrivateHost(next.hostname)) {
          return bad('Перенаправление на недопустимый адрес', 403);
        }
        return Response.redirect(`${url.origin}${url.pathname}?url=${encodeURIComponent(next)}`, 302);
      }

      if (!upstream.ok) return bad(`Станция ответила ${upstream.status}`, 502);

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
      return bad(`Не удалось подключиться к станции: ${error?.name || 'ошибка'}`, 504);
    } finally {
      clearTimeout(timer);
    }
  },
};
