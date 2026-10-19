/*
  Чистые правила каталога: жанры, регионы, поиск.

  Вынесены из app.js, потому что именно здесь был баг «в регионе жанр искался
  русской меткой в английских тегах», и потому что это единственная логика
  приложения, которую можно проверить без браузера (tests/catalog.test.cjs).
  Файл — обычный скрипт: в браузере функции становятся глобальными, в Node
  экспортируются через module.exports в конце.
*/

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

/** Тег каталога для метки чипа: 'Рок' → 'rock'. Одна точка правды для всех фильтров. */
function tagFor(label) {
  const hit = GENRES.find(([name]) => name === label);
  return hit ? hit[1] : null;
}

/** Жанр, набранный в поиске словом: «рок», «rock», «jazz» → тег. Иначе null. */
function tagForText(text) {
  const t = (text || '').trim().toLowerCase();
  if (!t) return null;
  const hit = GENRES.find(([name, tag]) => tag && (name.toLowerCase() === t || tag === t));
  return hit ? hit[1] : null;
}

/** Убирает уточнения в скобках: «Moscow (Russia)» и «Moscow» — один и тот же регион. */
function normalizeRegion(name) {
  return (name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function matches(s, text, tag) {
  const byTag = !tag || (s.tags || '').toLowerCase().includes(tag.toLowerCase());
  if (!byTag) return false;
  if (!text) return true;
  const t = text.toLowerCase();
  return s.name.toLowerCase().includes(t) || (s.tags || '').toLowerCase().includes(t);
}

if (typeof module !== 'undefined') {
  module.exports = { GENRES, tagFor, tagForText, normalizeRegion, matches };
}
