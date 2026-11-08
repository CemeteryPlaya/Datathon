import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectEvents, offsets } from '../model/events.js';
import { normalizeCriterion } from '../model/validate.js';
import { compare } from '../model/accuracy.js';
import { computeScore } from '../scoring.js';

const checklist = JSON.parse(fs.readFileSync(new URL('../seed/checklist.default.json', import.meta.url)));
const record = {
  conversation_id: 't-1', channel: 'agent chat', language: 'RU',
  transcript: [
    { timestamp: '00:01', speaker: 'client', text: 'Здравствуйте, оператора' },
    { timestamp: '00:02', speaker: 'bot', text: 'Здравствуйте! Я бот AIM.' },
    { timestamp: '00:03', speaker: 'system', text: 'Эскалация на оператора' },
    { timestamp: '00:30', speaker: 'operator', text: 'Добрый день, меня зовут Айгерим.' },
    { timestamp: '00:40', speaker: 'system', text: 'Личность клиента подтверждена.' },
    { timestamp: '05:00', speaker: 'operator', text: 'Ваш вопрос решён.' },
    { timestamp: '05:10', speaker: 'system', text: 'Клиент покинул чат.' },
  ],
};

test('события: первая реплика оператора, эскалация, идентификация, обрыв, долгий ответ', () => {
  const ev = detectEvents(record.transcript);
  const types = ev.map((e) => `${e.type}@${e.index}`);
  for (const t of ['escalation@2', 'first_operator@3', 'identity_verified@4', 'disconnect@6', 'last_operator@5', 'long_wait@5']) assert.ok(types.includes(t), t);
});

test('смещения для плеера: ISO и MM:SS', () => {
  assert.deepEqual(offsets([{ timestamp: '2026-11-03T13:10:00+00:00' }, { timestamp: '2026-11-03T13:10:05.5+00:00' }]), [0, 5.5]);
  assert.deepEqual(offsets([{ timestamp: '01:00' }, { timestamp: '01:30' }]), [0, 30]);
});

test('проверка ответа: недопустимый N/A, значение вне шкалы, индексы за пределами', () => {
  const byId = Object.fromEntries(checklist.criteria.map((c) => [c.id, c]));
  const n = record.transcript.length;
  assert.equal(normalizeCriterion(byId.c01, { answer: 'na' }, n).ok, false);
  assert.equal(normalizeCriterion(byId.c04, { answer: '12' }, n).ok, false);
  assert.equal(normalizeCriterion(byId.c04, { answer: '15' }, n).result.answer, 15);
  const ok = normalizeCriterion(byId.c03, { answer: 'yes', evidence: [4, 99, -1], checked_range: [0, 50] }, n);
  assert.deepEqual(ok.result.evidence, [4]);
  assert.deepEqual(ok.dropped_evidence, [99, -1]);
  assert.equal(ok.result.checked_range, null);
});

test('сравнение с эталоном', () => {
  const gt = { conversation_id: 't-1', answers: { c01: 'yes', c02: 'na', c04: 15, c08: 'no' } };
  const ev = { results: [{ criterion_id: 'c01', answer: 'yes' }, { criterion_id: 'c02', answer: 'yes' }, { criterion_id: 'c04', answer: 20 }, { criterion_id: 'c08', answer: 'no' }] };
  const r = compare([{ gt, ev, checklist }], computeScore);
  assert.equal(r.overall, 50);
  assert.equal(r.na.recall, 0);
  assert.equal(r.criteria.find((c) => c.id === 'c04').mae, 5);
  assert.equal(r.mismatches.length, 2);
});

test('датасеты: загрузка из API сохраняет снапшот, src аудио из HTML', async () => {
  const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-ds-'));
  process.env.DATA_DIR = dir;
  const ds = await import(`../datasets.js?${Date.now()}`);
  const fakeFetch = async (url) => {
    assert.equal(new URL(url).searchParams.get('group_id'), 'CTRL');
    return { ok: true, json: async () => ({ isSuccess: true, data: { records: [{ conversation_id: 'x', transcript: [] }] } }) };
  };
  const recs = await ds.fetchDataset('CTRL', { fetchImpl: fakeFetch, env: { CQA_API_URL: 'https://example.test/api?sig=secret' } });
  assert.equal(recs.length, 1);
  assert.equal(ds.recordsFor('CTRL')[0].conversation_id, 'x');
  assert.equal(ds.extractAudioSrc('<audio controls><source src="https://a.test/f.mp3?a=1&amp;se=2" type="audio/mpeg"></audio>'), 'https://a.test/f.mp3?a=1&se=2');
  assert.throws(() => ds.recordsFor('../etc'), /group_id/);
  delete process.env.DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});
