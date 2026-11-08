// Перегенерация обучающих данных локальной модели (local-model/data) одной командой.
//   npm run datagen               — 8000 синтетических диалогов + аугментация DEV + проверка
//   npm run datagen -- --n 2000   — меньше диалогов
//   npm run datagen:check         — только проверка уже сгенерированных данных
// Ищет Python 3: на Windows — py -3 / python, на Linux/macOS — python3 / python.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const n = args.includes('--n') ? args[args.indexOf('--n') + 1] : '8000';
const seed = args.includes('--seed') ? args[args.indexOf('--seed') + 1] : '7';
const cwd = path.resolve('local-model/datagen');

const candidates = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
const py = candidates.find(([cmd, pre]) => {
  const r = spawnSync(cmd, [...pre, '-c', 'import sys; assert sys.version_info >= (3, 10)'], { stdio: 'ignore' });
  return r.status === 0;
});
if (!py) {
  console.error('Не найден Python 3.10+. Установите его (python.org) и повторите.');
  process.exit(1);
}
const run = (script, extra) => {
  console.log(`\n> ${py[0]} ${[...py[1], script, ...extra].join(' ')}`);
  const r = spawnSync(py[0], [...py[1], script, ...extra], { cwd, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
};
if (args.includes('--check')) {
  run('check.py', ['--data', '../data']);
  process.exit(0);
}
run('generate.py', ['--n', n, '--seed', seed, '--out', '../data']);
run('augment_dev.py', ['--copies', '6', '--out', '../data']);
run('check.py', ['--data', '../data']);
fs.copyFileSync('local-model/data/SYNTH.json', 'data/SYNTH.json');
// События для обучения локальной модели: те же detectEvents/offsets, что в рантайме
const ev = spawnSync(process.execPath, ['local-model/export_events.mjs'], { stdio: 'inherit' });
if (ev.status !== 0) process.exit(ev.status || 1);
console.log('\nГотово: local-model/data/ обновлена, выборка для UI — data/SYNTH.json (group_id SYNTH).');
