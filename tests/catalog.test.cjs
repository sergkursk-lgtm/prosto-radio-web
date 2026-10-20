/*
  Тесты чистых правил каталога: node --test tests/
  Зависимостей нет — catalog.js умеет отдавать себя и в браузер, и в Node.

  Первый тест — тот самый баг: метка чипа («Рок») — русская, а теги каталога
  английские («rock»). Сравнение метки с тегом напрямую давало ноль станций.
*/
const test = require('node:test');
const assert = require('node:assert');
const { tagFor, tagForText, matches } = require('../catalog.js');

const stations = [
  { name: 'ROCK FM', tags: 'classic rock,pop rock,rock' },
  { name: 'Наше Радио', tags: 'rock' },
  { name: 'Europa Plus', tags: 'pop,dance' },
  { name: 'Радио Джаз', tags: 'jazz' },
];

test('метка чипа превращается в тег каталога', () => {
  assert.equal(tagFor('Рок'), 'rock');
  assert.equal(tagFor('Новости'), 'news');
  assert.equal(tagFor('Хип-хоп'), 'hip hop');
  assert.equal(tagFor('Популярное'), null);
  assert.equal(tagFor('Все'), null);
});

test('жанр фильтруется по тегу, а не по русской метке', () => {
  const byGenre = (s, label) => matches(s, '', tagFor(label));
  assert.equal(stations.filter((s) => byGenre(s, 'Рок')).length, 2);
  assert.equal(stations.filter((s) => byGenre(s, 'Джаз')).length, 1);
  assert.equal(stations.filter((s) => byGenre(s, 'Все')).length, 4);
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
