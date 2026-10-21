/*
  Тест разбора ICY-метаданных: node --test tests/
  Проверяем именно арифметику блока — байт длины в шестнадцатибайтовых словах
  и границы буфера. Ошибка здесь означала бы мусор вместо названия трека.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIcyTitle } from '../worker/stream-proxy.js';

/** Поток: metaint байт аудио, байт длины, блок метаданных, добитый нулями. */
function block(metaint, text, { cut = 0 } = {}) {
  const bytes = Buffer.from(text, 'utf8');
  const words = Math.ceil(bytes.length / 16);
  const audio = Buffer.alloc(metaint, 0x55);
  const meta = Buffer.alloc(words * 16);
  bytes.copy(meta);
  return Buffer.concat([audio, Buffer.from([words]), meta]).subarray(0, metaint + 1 + meta.length - cut);
}

test('вытаскивает StreamTitle из первого блока', () => {
  const buf = block(8192, "StreamTitle='Daft Punk - One More Time';");
  assert.equal(parseIcyTitle(buf, 8192), 'Daft Punk - One More Time');
});

test('понимает кириллицу', () => {
  const buf = block(4096, "StreamTitle='Сплин - Выхода нет';");
  assert.equal(parseIcyTitle(buf, 4096), 'Сплин - Выхода нет');
});

test('пустой блок — трека нет, а не пустая строка', () => {
  const buf = block(8192, '', { cut: 0 });
  assert.equal(parseIcyTitle(buf, 8192), null);
});

test('обрезанный блок не даёт половину названия', () => {
  const buf = block(8192, "StreamTitle='Проверка обрыва';", { cut: 20 });
  assert.equal(parseIcyTitle(buf, 8192), null);
});

test('без поля StreamTitle возвращает null', () => {
  const buf = block(8192, "StreamUrl='http://example.com';");
  assert.equal(parseIcyTitle(buf, 8192), null);
});
