import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { kindOf, applyKind, newCriterion, problems, normalize, weightShares, diff, nextId } from '../../web/js/checklist-model.js';
import { checklistError } from '../validation.js';
import { computeScore } from '../scoring.js';

const seed = JSON.parse(fs.readFileSync(new URL('../seed/checklist.default.json', import.meta.url)));
const clone = () => structuredClone(seed);

test('типы критериев из стартового чек-листа', () => {
  const k = Object.fromEntries(seed.criteria.map((c) => [c.id, kindOf(c)]));
  assert.equal(k.c01, 'yesno');
  assert.equal(k.c04, 'scale');
  assert.equal(k.c08, 'gross');
});

test('новый критерий-штраф: id, пустые поля — проблемы, после заполнения сервер принимает', () => {
  const d = clone();
  const c = newCriterion('penalty', d, 's3');
  assert.equal(c.id, nextId(seed.criteria));
  assert.equal(c.polarity, 'negative');
  d.criteria.push(c);
  const p = problems(d);
  assert.ok(p.byIndex[d.criteria.length - 1].length >= 2);
  assert.ok(checklistError(normalize(d)));
  Object.assign(c, { name: 'Чихал в трубку', description: 'Оператор чихнул и не извинился.' });
  assert.equal(problems(d).count, 0);
  assert.equal(checklistError(normalize(d)), null);
  // штраф: «Да» = нарушение → теряет вес
  const answers = d.criteria.map((x) => ({ criterion_id: x.id, answer: x.type === 'scale' ? Math.max(...x.levels.map((l) => l.value)) : x.kind === 'gross' ? 'no' : 'yes' }));
  assert.ok(computeScore(normalize(d), answers).total < 100);
});

test('смена типа: шкала получает ступени, грубая — вес 0, обратно в да/нет без polarity', () => {
  const c = seed.criteria[0];
  const s = applyKind(c, 'scale');
  assert.equal(s.type, 'scale');
  assert.ok(s.levels.length >= 2);
  const g = applyKind(c, 'gross');
  assert.equal(g.weight, 0);
  assert.equal(g.kind, 'gross');
  const y = applyKind(applyKind(c, 'penalty'), 'yesno');
  assert.equal(y.polarity, undefined);
  assert.equal(kindOf(y), 'yesno');
});

test('шкала: повторы, пустые описания и N/A без условия ловятся до отправки', () => {
  const d = clone();
  const i = d.criteria.findIndex((c) => c.type === 'scale');
  d.criteria[i].levels = [{ value: 5, description: 'a' }, { value: 5, description: '' }];
  d.criteria[0].na_allowed = true; d.criteria[0].na_condition = '';
  const p = problems(d);
  assert.ok(p.byIndex[i].some((m) => /повторяться/.test(m)));
  assert.ok(p.byIndex[i].some((m) => /описание/.test(m)));
  assert.ok(p.byIndex[0].some((m) => /N\/A/.test(m)));
});

test('доли весов: сумма 100, грубая ошибка 0', () => {
  const sh = weightShares(seed);
  assert.equal(Math.round(sh.reduce((a, b) => a + b, 0)), 100);
  assert.equal(sh[seed.criteria.findIndex((c) => c.kind === 'gross')], 0);
});

test('сравнение версий: добавлено, удалено, изменено; без правок — пусто', () => {
  assert.ok(diff(seed, normalize(clone())).empty);
  const d = clone();
  d.criteria = d.criteria.filter((c) => c.id !== 'c05');
  d.criteria[0].weight = 12;
  d.criteria.push({ ...newCriterion('yesno', d, 's1'), name: 'Новый', description: 'x' });
  const df = diff(seed, normalize(d));
  assert.deepEqual(df.removed.map((c) => c.id), ['c05']);
  assert.equal(df.added.length, 1);
  assert.deepEqual(df.changed[0].fields, ['вес']);
});
