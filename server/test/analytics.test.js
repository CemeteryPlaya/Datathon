import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as A from '../analytics.js';

const v1 = JSON.parse(fs.readFileSync(new URL('../seed/checklist.default.json', import.meta.url)));
// v2: через месяц добавили новый критерий — аналитика должна подхватить его без правок кода
const v2 = {
  ...v1,
  version: 2,
  criteria: [...v1.criteria, { id: 'c09', section: 's3', name: 'Чихал в трубку', type: 'yesno', polarity: 'negative', na_allowed: false, weight: 5, kind: 'normal' }],
};
const getChecklist = (id, v) => (v === 2 ? v2 : v1);
const res = (m) => Object.entries(m).map(([criterion_id, answer]) => ({ criterion_id, answer, explanation: `exp ${criterion_id}`, evidence: [1] }));
const good = { c01: 'yes', c02: 'yes', c03: 'yes', c04: 20, c05: 'yes', c06: 10, c07: 'yes', c08: 'no' };

const evaluations = [
  { id: 'e1', conversation_id: 'a', checklist_id: 'default', checklist_version: 1, language: 'RU', channel: 'agent chat', operator_name: 'Айгерим', created_at: '2026-11-07T10:00:00Z', cost_usd: 0.01, results: res(good) },
  { id: 'e2', conversation_id: 'b', checklist_id: 'default', checklist_version: 1, language: 'KZ', channel: 'agent chat', operator_name: 'Айгерим', created_at: '2026-11-07T11:00:00Z', cost_usd: 0.01, results: res({ ...good, c01: 'no', c08: 'yes' }) },
  { id: 'e3', conversation_id: 'c', checklist_id: 'default', checklist_version: 2, language: 'EN', channel: 'voice call', operator_name: null, created_at: '2026-11-07T12:00:00Z', cost_usd: 0.02, results: res({ ...good, c09: 'yes' }) },
  // старая оценка того же диалога — должна быть вытеснена e1
  { id: 'e0', conversation_id: 'a', checklist_id: 'default', checklist_version: 1, language: 'RU', channel: 'agent chat', operator_name: 'Айгерим', created_at: '2026-11-06T10:00:00Z', results: res({ ...good, c05: 'no' }) },
];
const appeals = [
  { id: 'p1', evaluation_id: 'e2', criterion_id: 'c01', status: 'resolved', decision: { action: 'change', new_answer: 'yes' } },
];
const d = { evaluations, appeals, getChecklist, operatorOverrides: { c: 'Джон' } };

test('берётся последняя оценка диалога, апелляция применяется, ручное имя оператора учитывается', () => {
  const items = A.effectiveEvaluations(d);
  assert.equal(items.length, 3);
  assert.equal(items.find((x) => x.ev.conversation_id === 'a').ev.id, 'e1');
  assert.equal(items.find((x) => x.ev.id === 'e2').score.total, 100);
  assert.equal(items.find((x) => x.ev.id === 'e3').operator, 'Джон');
});

test('сводка: средний итог, грубые ошибки, апелляции, новый критерий', () => {
  const s = A.summary(d);
  assert.equal(s.count, 3);
  assert.equal(s.gross_count, 1);
  assert.equal(s.appeals.change_rate, 100);
  const c09 = s.criteria.find((c) => c.id === 'c09');
  assert.equal(c09.evaluated, 1);
  assert.equal(c09.avg_percent, 0);
  assert.equal(s.problem_criteria[0].id, 'c09');
  assert.equal(s.cost.total_usd, 0.04);
});

test('профиль оператора и сравнение с командой', () => {
  const p = A.operatorProfile(d, 'Айгерим');
  assert.equal(p.count, 2);
  assert.equal(p.gross_count, 1);
  assert.equal(p.trend.length, 2);
  assert.ok(p.team_avg_total < 100);
  assert.equal(A.operatorProfile(d, 'нет такого'), null);
  assert.deepEqual(A.operators(d).map((o) => o.name).sort(), ['Айгерим', 'Джон']);
});

test('тревоги: только грубые ошибки, с объяснением и доказательством; просмотренные внизу', () => {
  const list = A.alerts(d, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].violations[0].criterion_id, 'c08');
  assert.deepEqual(list[0].violations[0].evidence, [1]);
  assert.ok(A.alerts(d, { e2: { acked_at: 'x' } })[0].acked);
});

test('фильтры по языку и каналу', () => {
  assert.equal(A.summary(d, { language: 'KZ' }).count, 1);
  assert.equal(A.summary(d, { channel: 'voice call' }).count, 1);
});
