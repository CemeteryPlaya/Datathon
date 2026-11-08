// Выгрузка результатов в формате организаторов «Результаты оценки • Формат JSON 1.0».
//   node scripts/export-results.mjs --group DEV     --out results/dev/results.json
//   node scripts/export-results.mjs --group FBroker --out results/prod/results.json
// Опции: --checklist default (id чек-листа), --version N (версия; по умолчанию последняя оценка любой версии),
//        --team "Название команды".
// Берётся последняя оценка каждого диалога. Диалог без оценки или с неполной оценкой выгружается со status "error".
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../server/store.js';
import { recordsFor } from '../server/datasets.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const group = args.group || 'DEV';
const checklistId = args.checklist || 'default';
const out = args.out || `results/${group === 'DEV' ? 'dev' : 'prod'}/results.json`;
const team = args.team || 'doomsday';

// Коды критериев организаторов ↔ id критериев нашего стартового чек-листа (server/seed/checklist.default.json).
// Если критерий в чек-листе заменили, поправьте соответствие здесь.
const CODES = [
  ['contact', 'c01'],
  ['discovery', 'c02'],
  ['identification', 'c03'],
  ['consultation', 'c04'],
  ['empathy', 'c05'],
  ['dialogue', 'c06'],
  ['closure', 'c07'],
  ['critical', 'c08'],
];

const records = recordsFor(group);
const evals = store.listEvaluations().filter((e) => e.group_id === group && e.checklist_id === checklistId && (args.version ? e.checklist_version === Number(args.version) : true));
const latest = new Map();
for (const e of evals) if (!latest.has(e.conversation_id) || e.created_at > latest.get(e.conversation_id).created_at) latest.set(e.conversation_id, e);

// ответ модели → value: true = «Да», false = «Нет», null = N/A, число — ступень шкалы
function toValue(c, answer) {
  if (answer === 'na') return null;
  if (c.type === 'scale') return Number(answer);
  return answer === 'yes';
}
// индексы реплик в объяснении: у нас с 0, в формате организаторов — с 1
const oneBased = (text) => String(text || '')
  .replace(/\[(\d+)–(\d+)\]/g, (_, a, b) => `[${Number(a) + 1}–${Number(b) + 1}]`)
  .replace(/\[(\d+)\]/g, (_, a) => `[${Number(a) + 1}]`);

const error = (id, reason) => ({ conversation_id: id, status: 'error', criteria: [], score: null, error: reason });

const results = records.map((rec) => {
  const ev = latest.get(rec.conversation_id);
  if (!ev) return error(rec.conversation_id, 'Диалог не оценён.');
  const cl = store.getChecklist(ev.checklist_id, ev.checklist_version);
  const criteria = [];
  for (const [code, id] of CODES) {
    const c = cl?.criteria.find((x) => x.id === id);
    const r = ev.results.find((x) => x.criterion_id === id);
    if (!c || !r) return error(rec.conversation_id, `В оценке нет критерия ${code} (${id}).`);
    if (r.answer === 'manual') return error(rec.conversation_id, `Модель не дала допустимого ответа по критерию ${code}.`);
    let turns = (r.evidence || []).map((i) => i + 1);
    if (!turns.length && Array.isArray(r.checked_range)) turns = [...new Set(r.checked_range)].map((i) => i + 1);
    criteria.push({ criterion_id: code, value: toValue(c, r.answer), rationale: oneBased(r.explanation), evidence_turns: turns });
  }
  const critical = criteria.find((x) => x.criterion_id === 'critical').value;
  return {
    conversation_id: rec.conversation_id,
    status: 'ok',
    criteria,
    score: { final_score: ev.score.total === null ? null : Math.round(ev.score.total * 100) / 100, critical_flag: critical },
  };
});

// ---------- проверка по правилам из приложения ----------
const VALUES = {
  contact: [true, false], discovery: [true, false, null], identification: [true, false, null],
  consultation: [0, 5, 10, 15, 20, null], empathy: [true, false], dialogue: [0, 4, 7, 10],
  closure: [true, false, null], critical: [true, false],
};
const problems = [];
const ids = results.map((r) => r.conversation_id);
if (new Set(ids).size !== ids.length) problems.push('повторяющиеся conversation_id');
for (const r of results) {
  if (r.status !== 'ok') continue;
  const codes = r.criteria.map((c) => c.criterion_id);
  if (codes.length !== 8 || new Set(codes).size !== 8) problems.push(`${r.conversation_id}: нужно ровно 8 разных критериев`);
  for (const c of r.criteria) {
    if (!VALUES[c.criterion_id]?.includes(c.value)) problems.push(`${r.conversation_id}: ${c.criterion_id} = ${JSON.stringify(c.value)} не из допустимых`);
    if (c.evidence_turns.some((t) => !Number.isInteger(t) || t < 1 || t > records.find((x) => x.conversation_id === r.conversation_id).transcript.length)) problems.push(`${r.conversation_id}: ${c.criterion_id} — номер реплики вне транскрипта`);
  }
  const fs_ = r.score.final_score;
  if (fs_ !== null && (fs_ < 0 || fs_ > 100)) problems.push(`${r.conversation_id}: final_score вне 0..100`);
  if (r.score.critical_flag !== r.criteria.find((c) => c.criterion_id === 'critical').value) problems.push(`${r.conversation_id}: critical_flag не совпадает с critical`);
}
if (problems.length) {
  console.error('Файл не прошёл проверку:\n  ' + problems.join('\n  '));
  process.exit(1);
}

const doc = { schema_version: '1.0', team_name: team, model: { mode: 'local', name: 'cqa-local-v1' }, results };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
const errors = results.filter((r) => r.status === 'error');
console.log(`${out}: ${results.length} диалогов (ok ${results.length - errors.length}, error ${errors.length}), проверка пройдена`);
for (const r of errors) console.log(`  ОШИБКА ${r.conversation_id}: ${r.error}`);
