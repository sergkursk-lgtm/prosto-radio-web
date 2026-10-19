/*
  Тесты чистых правил каталога: node --test tests/
  Зависимостей нет — catalog.js умеет отдавать себя и в браузер, и в Node.

  Первый тест — тот самый баг: в «Регионе» жанр искался русской меткой («Рок»)
  в английских тегах каталога («rock»), и станции исчезали.
*/
const test = require('node:test');
const assert = require('node:assert');
const { tagFor, tagForText, normalizeRegion, matches } = require('../catalog.js');

const stations = [
  { name: 'ROCK FM', state: '', tags: 'classic rock,pop rock,rock' },
  { name: 'Наше Радио', state: 'Moscow', tags: 'rock' },
  { name: 'Europa Plus', state: 'Moscow (Russia)', tags: 'pop,dance' },
  { name: 'Радио Джаз', state: 'Moscow', tags: 'jazz' },
];

test('метка чипа превращается в тег каталога', () => {
  assert.equal(tagFor('Рок'), 'rock');
  assert.equal(tagFor('Новости'), 'news');
  assert.equal(tagFor('Хип-хоп'), 'hip hop');
  assert.equal(tagFor('Популярное'), null);
  assert.equal(tagFor('Все'), null);
});

test('регион + жанр фильтруется по тегу, а не по русской метке', () => {
  const inMoscow = (s) => normalizeRegion(s.state) === 'Moscow';
  const byGenre = (s, label) => matches(s, '', tagFor(label));
  assert.equal(stations.filter((s) => inMoscow(s) && byGenre(s, 'Рок')).length, 1);
  assert.equal(stations.filter((s) => inMoscow(s) && byGenre(s, 'Джаз')).length, 1);
  assert.equal(stations.filter((s) => inMoscow(s) && byGenre(s, 'Все')).length, 3);
});

test('«Moscow (Russia)» и «Moscow» — один регион', () => {
  assert.equal(normalizeRegion('Moscow (Russia)'), 'Moscow');
  assert.equal(normalizeRegion('  Moscow  '), 'Moscow');
  assert.equal(normalizeRegion(''), '');
  assert.equal(normalizeRegion(undefined), '');
});

test('жанр словом в поиске работает и на кириллице, и на латинице', () => {
  assert.equal(tagForText('рок'), 'rock');
  assert.equal(tagForText('ROCK'), 'rock');
  assert.equal(tagForText('джаз'), 'jazz');
  assert.equal(tagForText('радио'), null);
  assert.equal(tagForText(''), null);
});

test('поиск по названию и по тегу, регистр не важен', () => {
  assert.ok(matches(stations[2], 'europa', null));
  assert.ok(matches(stations[2], 'dance', null));
  assert.ok(!matches(stations[2], 'рок', null));
  assert.ok(matches(stations[0], '', 'rock'));
  assert.ok(!matches(stations[0], '', 'jazz'));
});
