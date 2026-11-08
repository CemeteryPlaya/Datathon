// CLI: оценить диалоги из локального снапшота моделью и сохранить оценки в хранилище.
//   npm run eval -- --group DEV [--ids p1-ru-001,p1-kz-003] [--limit 5] [--concurrency 5] [--checklist default]
// Нужен запущенный сервис модели: local-model\.venv\Scripts\python.exe local-model\serve.py
import 'dotenv/config';
import fs from 'node:fs';
import { evaluateConversation } from '../server/model/evaluate.js';
import { createLocalModel } from '../server/model/decide.js';
import * as store from '../server/store.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const group = args.group || 'DEV';
const file = args.file || `data/${group}.json`;
if (!fs.existsSync(file)) {
  console.error(`Нет файла ${file}. Положите снапшот датасета (ответ API как есть или массив records).`);
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
let records = raw?.data?.records || raw?.records || raw;
if (args.ids) {
  const ids = new Set(String(args.ids).split(','));
  records = records.filter((r) => ids.has(r.conversation_id));
}
if (args.limit) records = records.slice(0, Number(args.limit));

const checklist = store.getChecklist(args.checklist || 'default');
if (!checklist) {
  console.error(`Чек-лист ${args.checklist} не найден.`);
  process.exit(1);
}
const model = createLocalModel();
const concurrency = Number(args.concurrency || 5);
const started = Date.now();

console.log(`Оцениваю ${records.length} диалогов · модель ${model.model} · чек-лист ${checklist.id} v${checklist.version}`);
let done = 0;
let failed = 0;
const queue = [...records];
async function worker() {
  while (queue.length) {
    const rec = queue.shift();
    try {
      const ev = store.saveEvaluation(await evaluateConversation({ record: rec, checklist, model, group_id: group }));
      const low = ev.results.filter((r) => r.confidence < 0.75).map((r) => r.criterion_id);
      console.log(`[${++done}/${records.length}] ${rec.conversation_id}: итог ${ev.score.total ?? '—'}${ev.score.gross_error ? ' ГРУБАЯ' : ''}${low.length ? ` · проверить: ${low.join(',')}` : ''}`);
    } catch (e) {
      failed++;
      console.error(`[${++done}/${records.length}] ${rec.conversation_id}: ОШИБКА ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker));
console.log(`Готово: ${done - failed} оценено, ${failed} с ошибкой, ${((Date.now() - started) / 1000).toFixed(1)} с.`);
