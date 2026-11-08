// Выгрузка событий диалогов для обучения локальной модели.
// Прогоняет detectEvents и offsets из server/model/events.js — те же функции, что в рантайме (там события присылает Node),
// поэтому Python не переписывает регулярки.
//   node local-model/export_events.mjs            → local-model/data/events.json
// Формат: { "<conversation_id>": { "events": [...], "offsets": [...] } }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectEvents, offsets } from '../server/model/events.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [
  'local-model/data/synth_dialogs.json',
  'local-model/data/aug_dev_dialogs.json',
  'data/DEV.json',
];
const out = path.join(ROOT, 'local-model/data/events.json');

const records = (raw) => raw?.data?.records || raw?.records || (Array.isArray(raw) ? raw : []);
const result = {};
for (const rel of SOURCES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.warn(`пропускаю ${rel}: файла нет (npm run datagen)`);
    continue;
  }
  const recs = records(JSON.parse(fs.readFileSync(file, 'utf8')));
  for (const r of recs) result[r.conversation_id] = { events: detectEvents(r.transcript), offsets: offsets(r.transcript) };
  console.log(`${rel}: ${recs.length} диалогов`);
}
fs.writeFileSync(out, JSON.stringify(result));
console.log(`События: ${Object.keys(result).length} диалогов → ${path.relative(ROOT, out)}`);
