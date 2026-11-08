import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeScore, replaceAnswer } from '../scoring.js';

const checklist = JSON.parse(fs.readFileSync(new URL('../seed/checklist.default.json', import.meta.url)));
const answers = (map) => Object.entries(map).map(([criterion_id, answer]) => ({ criterion_id, answer }));
const allYes = { c01: 'yes', c02: 'yes', c03: 'yes', c04: 20, c05: 'yes', c06: 10, c07: 'yes', c08: 'no' };

test('всё «Да» и максимум шкал = 100', () => {
  const s = computeScore(checklist, answers(allYes));
  assert.equal(s.total, 100);
  assert.equal(s.gross_error, false);
});

test('N/A у c02 и c07 перераспределяет вес', () => {
  const s = computeScore(checklist, answers({ ...allYes, c02: 'na', c07: 'na', c01: 'no' }));
  // применимые веса: 10+20+20+15+15 = 80, набрано 70
  assert.equal(s.total, 87.5);
  assert.equal(s.per_criterion.c02.applicable, false);
  assert.equal(s.per_criterion.c03.weight_eff, 25);
});

test('всё N/A → итог null', () => {
  const only = { ...checklist, criteria: checklist.criteria.filter((c) => c.na_allowed) };
  const s = computeScore(only, answers({ c02: 'na', c03: 'na', c04: 'na', c07: 'na' }));
  assert.equal(s.total, null);
});

test('шкала 15/20 при весе 20 даёт 15 баллов из 20', () => {
  const one = { sections: [], criteria: [checklist.criteria.find((c) => c.id === 'c04')] };
  assert.equal(computeScore(one, answers({ c04: 15 })).total, 75);
});

test('грубая ошибка — флаг, на балл не влияет', () => {
  const s = computeScore(checklist, answers({ ...allYes, c08: 'yes' }));
  assert.equal(s.total, 100);
  assert.equal(s.gross_error, true);
  assert.deepEqual(s.gross_criteria, ['c08']);
});

test('новый штрафной критерий (polarity negative): «Да» = нарушение, теряем его вес', () => {
  const cl = {
    ...checklist,
    criteria: [...checklist.criteria, { id: 'c09', section: 's3', name: 'Чихал в трубку', type: 'yesno', polarity: 'negative', na_allowed: false, weight: 10, kind: 'normal' }],
  };
  assert.equal(computeScore(cl, answers({ ...allYes, c09: 'no' })).total, 100);
  assert.equal(computeScore(cl, answers({ ...allYes, c09: 'yes' })).total, 90.91);
});

test('ручная проверка исключается из расчёта и помечается', () => {
  const s = computeScore(checklist, answers({ ...allYes, c05: 'manual' }));
  assert.equal(s.total, 100);
  assert.deepEqual(s.pending_manual, ['c05']);
});

test('секции: своя нормировка и вклад в итог', () => {
  const s = computeScore(checklist, answers({ ...allYes, c01: 'no' }));
  assert.equal(s.sections.s1.total, 60);
  assert.equal(s.sections.s1.contribution, 15);
  assert.equal(s.sections.s4.total, null);
});

test('replaceAnswer не меняет исходный массив', () => {
  const orig = answers(allYes);
  const next = replaceAnswer(orig, 'c03', 'no');
  assert.equal(orig.find((r) => r.criterion_id === 'c03').answer, 'yes');
  assert.equal(next.find((r) => r.criterion_id === 'c03').answer, 'no');
});
