// Точность оценок против своей ручной разметки.
//   npm run accuracy [-- --gt data/gt --checklist default --verbose 1]
// Формат разметки: data/gt/<conversation_id>.json
//   { "conversation_id": "p1-ru-001", "answers": { "c01": "yes", "c02": "na", "c04": 15, ... }, "note": "..." }
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../server/store.js';
import { computeScore } from '../server/scoring.js';
import { compare } from '../server/model/accuracy.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const dir = args.gt || 'data/gt';
if (!fs.existsSync(dir)) {
  console.error(`Нет папки ${dir} с разметкой.`);
  process.exit(1);
}
const gts = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const checklistId = args.checklist || 'default';
const evals = store.listEvaluations().filter((e) => e.checklist_id === checklistId);
const latest = new Map();
for (const e of evals) if (!latest.has(e.conversation_id) || e.created_at > latest.get(e.conversation_id).created_at) latest.set(e.conversation_id, e);

const pairs = [];
for (const gt of gts) {
  const ev = latest.get(gt.conversation_id);
  if (!ev) {
    console.warn(`нет оценки для ${gt.conversation_id}`);
    continue;
  }
  pairs.push({ gt, ev, checklist: store.getChecklist(ev.checklist_id, ev.checklist_version) });
}
const r = compare(pairs, computeScore);
console.log(`Диалогов: ${r.n}`);
console.log(`Совпадение ответов (все критерии): ${r.overall}%  ·  без спорных: ${r.overall_clear}%`);
console.log(`По языкам: ${Object.entries(r.by_language).map(([l, v]) => `${l} ${v}%`).join(' · ')}`);
console.log(`Средняя ошибка итога: ${r.total_mae} п.  ·  флаг грубой ошибки совпал: ${r.gross_match}%`);
console.log(`N/A: точность ${r.na.precision ?? '—'}%, полнота ${r.na.recall ?? '—'}%`);
console.log('\nПо критериям:');
for (const c of r.criteria) console.log(`  ${c.id.padEnd(6)} ${String(c.accuracy).padStart(6)}%  (${c.n})${c.mae !== null ? `  ошибка шкалы ${c.mae}` : ''}`);
if (r.mismatches.length) {
  console.log('\nРасхождения:');
  for (const m of r.mismatches) console.log(`  ${m.conversation_id} ${m.criterion_id}: эталон ${m.gt}, модель ${m.model}${m.confidence !== undefined ? ` (уверенность ${m.confidence})` : ''}${m.ambiguous ? ' [спорный]' : ''}${args.verbose && m.explanation ? `\n      ${m.explanation}` : ''}`);
}
