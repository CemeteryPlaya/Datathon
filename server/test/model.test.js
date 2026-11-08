// Модель оценки: маппинг вопросов, сборка Evaluation, ошибки, эндпоинты — с поддельным сервером модели.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-local-'));
process.env.STORAGE_DIR = dir;
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
const { default: app } = await import('../index.js');
const store = await import('../store.js');
const { buildQuestions, toQuestion, toAnswer, questionType, optionKeys, answerKey } = await import('../model/questions.js');
const { evaluateConversation } = await import('../model/evaluate.js');
const { createLocalModel } = await import('../model/decide.js');

const sneeze = { id: 'sneeze', section: 's4', name: 'Штраф за чихание', description: 'Да — оператор чихнул в чат с клиентом.', type: 'yesno', polarity: 'negative', na_allowed: false, na_condition: '', weight: 5, kind: 'normal' };
const scaleNa = { id: 'quality', section: 's2', name: 'Качество ответа', description: 'Насколько полно решён запрос.', type: 'scale', levels: [{ value: 0, description: 'нет ответа' }, { value: 10, description: 'частично' }, { value: 20, description: 'полностью' }], na_allowed: true, na_condition: 'Запроса не было.', weight: 20, kind: 'normal' };
const greet = { id: 'hello', section: 's1', name: 'Приветствие', description: 'Оператор поздоровался.', type: 'yesno', na_allowed: false, weight: 10, kind: 'normal' };
const gross = { id: 'gross', section: 's4', name: 'Грубость', description: 'Оскорбление клиента.', type: 'yesno', na_allowed: false, weight: 0, kind: 'gross' };
const checklist = { id: 'local-test', version: 1, name: 'Тест', sections: [{ id: 's1', name: 'a' }, { id: 's2', name: 'b' }, { id: 's4', name: 'c' }], criteria: [greet, scaleNa, sneeze, gross] };
const record = { conversation_id: 'loc-1', language: 'RU', channel: 'agent chat', transcript: [
  { timestamp: '00:00', speaker: 'client', text: 'Хочу сменить тариф' },
  { timestamp: '00:05', speaker: 'system', text: 'Эскалация на оператора.' },
  { timestamp: '00:30', speaker: 'operator', text: 'Здравствуйте, меня зовут Алина. Апчхи!' },
  { timestamp: '01:00', speaker: 'operator', text: 'Тариф сменён. Хорошего дня!' },
] };

// ---------- поддельный сервер модели
let fake, fakeUrl;
const calls = [];
let decideImpl;
before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      calls.push({ url: req.url, body: json });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/decide') return res.end(JSON.stringify(decideImpl(json)));
      if (req.url === '/v1/finetune') {
        if ((json.examples || []).length < 5) { res.statusCode = 400; return res.end(JSON.stringify({ detail: 'нужно минимум 5 примеров' })); }
        return res.end(JSON.stringify({ model: 'cqa-local-v1', adapter: { id: 'abc', examples: json.examples.length, seconds: 1.2, train_acc_before: 0.4, train_acc_after: 1 } }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  fake.listen(0);
  await new Promise((r) => fake.once('listening', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
});
after(() => { fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// Ответ «первый вариант» с вероятностями; доказательство с индексом за пределами транскрипта
const firstOption = (body) => ({
  model: 'cqa-local-v1', duration_ms: 7, operator_name: 'Алина',
  answers: Object.fromEntries(Object.entries(body.questions).map(([k, q]) => {
    const keys = q.options.map((o) => o.key);
    const probabilities = Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.6 : 0.4 / (keys.length - 1)]));
    return [k, { choice: keys[0], probabilities, confidence: 0.6, evidence: [2, 999], checked_range: [1, 3], ...(q.type === 'score' ? { score: 4 } : {}) }];
  })),
});

test('маппинг: новый критерий, polarity negative, шкала с N/A, грубая ошибка', () => {
  const q = toQuestion(sneeze);
  assert.equal(q.type, 'noul');
  assert.deepEqual(q.options.map((o) => o.key), ['yes', 'no']);
  assert.equal(q.criterion.polarity, 'negative');
  assert.equal(q.criterion.name, 'Штраф за чихание');
  assert.equal(toQuestion(gross).criterion.polarity, 'negative');

  const s = toQuestion(scaleNa);
  assert.equal(s.type, 'score');
  assert.deepEqual(s.options.map((o) => o.key), ['0', '10', '20', 'na']);
  assert.match(s.options.find((o) => o.key === 'na').text, /Запроса не было/);
  assert.match(s.options.find((o) => o.key === '20').text, /20 из 20: полностью/);
  assert.equal(questionType({ ...greet, na_allowed: true }), 'choice');

  assert.equal(toAnswer(scaleNa, '20'), 20);
  assert.equal(toAnswer(scaleNa, 'na'), 'na');
  assert.equal(toAnswer(scaleNa, '15'), null);
  assert.equal(toAnswer(sneeze, 'na'), null);
  assert.equal(toAnswer(sneeze, 'yes'), 'yes');
  assert.equal(answerKey(scaleNa, 10), '10');
  assert.deepEqual(Object.keys(buildQuestions(checklist)), ['hello', 'quality', 'sneeze', 'gross']);
  assert.deepEqual(optionKeys(greet), ['yes', 'no']);
});

test('сборка Evaluation: вероятности, $0, индексы проверены, объяснение на русском', async () => {
  decideImpl = firstOption;
  calls.length = 0;
  const model = createLocalModel({ url: fakeUrl });
  const ev = await evaluateConversation({ record, checklist, model, group_id: 'TEST' });
  const sent = calls.find((c) => c.url === '/v1/decide').body;
  assert.deepEqual(Object.keys(sent.questions), ['hello', 'quality', 'sneeze', 'gross']);
  assert.ok(sent.events.some((e) => e.type === 'first_operator'));
  assert.equal(sent.offsets.length, record.transcript.length);

  assert.equal(ev.model, 'cqa-local-v1');
  assert.equal(ev.cost_usd, 0);
  assert.equal(ev.runs, 1);
  assert.equal(ev.operator_name, 'Алина');
  assert.equal(ev.results.length, 4);
  const byId = Object.fromEntries(ev.results.map((r) => [r.criterion_id, r]));
  assert.equal(byId.hello.answer, 'yes');
  assert.equal(byId.quality.answer, 0);
  assert.equal(byId.quality.expected_value, 4);
  assert.equal(byId.sneeze.answer, 'yes');
  for (const r of ev.results) {
    assert.deepEqual(r.evidence, [2], 'индекс 999 за пределами транскрипта отброшен');
    assert.ok(r.probabilities && Math.abs(Object.values(r.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-3);
    assert.equal(r.confidence, 0.6);
    assert.match(r.explanation, /вероятность 60%/);
    assert.match(r.explanation, /Модель не уверена/);
  }
  assert.match(byId.sneeze.explanation, /нарушение/i);
  assert.match(byId.sneeze.explanation, /Апчхи/);
  assert.equal(ev.score.gross_error, true);
  assert.ok(typeof ev.score.total === 'number');
});

test('«Нет» — проверенный участок, N/A — условие, недопустимый ответ → manual', async () => {
  decideImpl = (body) => ({ model: 'cqa-local-v1', operator_name: null, answers: {
    hello: { choice: 'no', probabilities: { yes: 0.05, no: 0.95 }, confidence: 0.95, evidence: [2], checked_range: [2, 3] },
    quality: { choice: 'na', probabilities: { 0: 0.01, 10: 0.01, 20: 0.02, na: 0.96 }, confidence: 0.96, evidence: [1], checked_range: [0, 1] },
    sneeze: { choice: 'na', probabilities: { yes: 0.5, no: 0.5 }, confidence: 0.5, evidence: [], checked_range: [0, 3] },
    // gross нет в ответе
  } });
  const ev = await evaluateConversation({ record, checklist, model: createLocalModel({ url: fakeUrl }) });
  const byId = Object.fromEntries(ev.results.map((r) => [r.criterion_id, r]));
  assert.equal(byId.hello.answer, 'no');
  assert.deepEqual(byId.hello.checked_range, [2, 3]);
  assert.match(byId.hello.explanation, /Проверены реплики \[2–3\]/);
  assert.doesNotMatch(byId.hello.explanation, /не уверена/);
  assert.equal(byId.quality.answer, 'na');
  assert.match(byId.quality.explanation, /Запроса не было/);
  assert.equal(byId.sneeze.answer, 'manual');
  assert.equal(byId.gross.answer, 'manual');
  assert.ok(ev.score.pending_manual.includes('sneeze'));
});

test('модель недоступна → понятная ошибка с командой запуска', async () => {
  const model = createLocalModel({ url: 'http://127.0.0.1:9', timeoutMs: 2000 });
  await assert.rejects(evaluateConversation({ record, checklist, model }), /Модель не запущена.*serve\.py/);
});

// ---------- REST в local-режиме
let server, base;
async function req(url, body) {
  const r = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}

test('REST: /api/config, /api/evaluate и /api/local/finetune', async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    app.locals.localModel = createLocalModel({ url: fakeUrl });
    decideImpl = firstOption;
    assert.equal((await req('/config')).data.provider, 'local');

    const saved = store.saveChecklistVersion({ ...checklist, id: 'local-test' });
    const records = Array.from({ length: 6 }, (_, i) => ({ ...record, conversation_id: `loc-${i}` }));
    fs.writeFileSync(path.join(dir, 'LOC.json'), JSON.stringify({ records }));
    const r = await req('/evaluate', { group_id: 'LOC', conversation_ids: 'all', checklist_id: saved.id, wait: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.errors.length, 0);
    assert.equal(r.data.evaluations.length, 6);
    assert.equal(r.data.evaluations[0].model, 'cqa-local-v1');
    assert.ok(r.data.evaluations[0].results[0].probabilities);

    const tooFew = await req('/local/finetune', { checklist_id: saved.id, checklist_version: saved.version, criterion_id: 'sneeze' });
    assert.equal(tooFew.status, 400);
    assert.match(tooFew.data.error, /минимум 5/);

    for (const ev of r.data.evaluations.slice(0, 5)) {
      const ap = (await req('/appeals', { evaluation_id: ev.id, criterion_id: 'sneeze', comment: 'Чиха не было' })).data;
      assert.equal((await req(`/appeals/${ap.id}/decision`, { action: 'change', new_answer: 'no', reason: 'Апчхи — это клиент' })).status, 200);
    }
    calls.length = 0;
    const ft = await req('/local/finetune', { checklist_id: saved.id, checklist_version: saved.version, criterion_id: 'sneeze' });
    assert.equal(ft.status, 200);
    assert.equal(ft.data.examples, 5);
    const sent = calls.find((c) => c.url === '/v1/finetune').body;
    assert.equal(sent.question.criterion.name, 'Штраф за чихание');
    assert.deepEqual(sent.examples.map((e) => e.answer), ['no', 'no', 'no', 'no', 'no']);
    assert.ok(sent.examples[0].record.transcript.length);
    assert.ok(sent.examples[0].events.length);
  } finally {
    delete app.locals.localModel;
    server.close();
  }
});
