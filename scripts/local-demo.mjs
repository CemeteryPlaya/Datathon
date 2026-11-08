// Сценарий защиты для локальной модели (через тот же REST, что использует UI):
//  1) в чек-лист добавляется «Штраф за чихание» → оценка SYNTH и DEV, ответы и доказательства;
//  2) добавляется критерий, которого модель не видела («Оператор обещал перезвонить») → уверенность, «Проверить»;
//  3) 8 апелляций с решением проверяющего → «Дообучить модель» → переоценка и сравнение до/после.
// Нужно: запущенные сервис модели (local-model\serve.py) и сервер (npm start). Ничего не удаляет; создаёт версии
// чек-листа «local-demo-<время>» (свой на каждый прогон) и оценки в хранилище.
//   node scripts/local-demo.mjs [--base http://localhost:3000] [--appeals 10] [--test 300]
// Правильные ответы для апелляций и метрик — разметка генератора (local-model/data/synth_labels.jsonl): в демо её
// роль играет проверяющий. Апелляции — на диалогах SYNTH не из test-split; метрики — на группе SYNTHTEST
// (первые --test синтетических test-диалогов, их не было в обучении; файл data/SYNTHTEST.json создаётся при первом запуске).
import fs from 'node:fs';
import readline from 'node:readline';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const BASE = (args.base || 'http://localhost:3000').replace(/\/$/, '') + '/api';
const N_APPEALS = Number(args.appeals || 10);
const N_TEST = Number(args.test || 300);

async function req(url, body) {
  const r = await fetch(BASE + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${url}: ${data.error || r.status}`);
  return data;
}

async function labels() {
  const out = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream('local-model/data/synth_labels.jsonl') });
  for await (const line of rl) {
    const l = JSON.parse(line);
    out.set(l.conversation_id, { split: l.split, facts: l.facts });
  }
  return out;
}

const SNEEZE = { id: 'demo_sneeze', section: 's4', name: 'Штраф за чихание', description: 'Да — оператор чихнул в чат с клиентом (например, «апчхи»). Чих клиента не учитывается.', type: 'yesno', polarity: 'negative', na_allowed: false, na_condition: '', weight: 5, kind: 'normal' };
const CALLBACK = { id: 'demo_callback', section: 's3', name: 'Оператор обещал перезвонить', description: 'Да — оператор пообещал перезвонить клиенту или что с ним свяжутся позже.', type: 'yesno', polarity: 'positive', na_allowed: false, na_condition: '', weight: 0, kind: 'normal' };

function stats(evals, cid, truth) {
  let tp = 0, fp = 0, fn = 0, tn = 0, unsure = 0, n = 0;
  for (const ev of evals) {
    const t = truth(ev.conversation_id);
    if (t === null) continue;
    const r = ev.results.find((x) => x.criterion_id === cid);
    n++;
    if (r.confidence < 0.75) unsure++;
    const yes = r.answer === 'yes';
    if (yes && t) tp++; else if (yes) fp++; else if (t) fn++; else tn++;
  }
  const f = (x) => (x === null ? '—' : `${(100 * x).toFixed(1)}%`);
  return { n, tp, fp, fn, tn, unsure, line: `n=${n} · да: верно ${tp}, ложно ${fp} · пропущено ${fn} · точность ${f(n ? (tp + tn) / n : null)} · полнота «да» ${f(tp + fn ? tp / (tp + fn) : null)} · точность «да» ${f(tp + fp ? tp / (tp + fp) : null)} · «Проверить» ${unsure}` };
}

function show(ev, cid, record) {
  const r = ev.results.find((x) => x.criterion_id === cid);
  console.log(`  ${ev.conversation_id}: ${r.answer} (${Object.entries(r.probabilities || {}).map(([k, p]) => `${k} ${Math.round(p * 100)}%`).join(' · ')})${r.confidence < 0.75 ? ' [Проверить]' : ''}`);
  console.log(`    ${r.explanation}`);
  if (record && r.evidence?.length) console.log(`    доказательство [${r.evidence[0]}] ${record.transcript[r.evidence[0]].speaker}: ${record.transcript[r.evidence[0]].text}`);
}

async function evaluate(group, checklist, ids = 'all') {
  const t = Date.now();
  const r = await req('/evaluate', { group_id: group, conversation_ids: ids, checklist_id: checklist.id, checklist_version: checklist.version, wait: true });
  console.log(`  ${group}: оценено ${r.evaluations.length}, ошибок ${r.errors.length}, ${((Date.now() - t) / 1000).toFixed(1)} с${r.errors.length ? ` — ${r.errors.map((e) => `${e.conversation_id}: ${e.error}`).join('; ')}` : ''}`);
  return r.evaluations;
}

const cfg = await req('/config');
const L = await labels();
const synth = (await req('/datasets/SYNTH')).records;
if (!fs.existsSync('data/SYNTHTEST.json')) {
  const all = JSON.parse(fs.readFileSync('local-model/data/synth_dialogs.json', 'utf8')).data.records;
  const recs = all.filter((r) => L.get(r.conversation_id)?.split === 'test').slice(0, N_TEST);
  fs.writeFileSync('data/SYNTHTEST.json', JSON.stringify({ records: recs }));
}
const stest = (await req('/datasets/SYNTHTEST')).records;
const dev = (await req('/datasets/DEV')).records;
const recById = new Map([...synth, ...dev, ...stest].map((r) => [r.conversation_id, r]));
const testIds = new Set(stest.filter((r) => L.get(r.conversation_id)?.split === 'test').map((r) => r.conversation_id));
const fact = (key) => (id) => (testIds.has(id) ? L.get(id).facts[key]?.v === true : null);
console.log(`SYNTH: ${synth.length} диалогов (для апелляций), SYNTHTEST: ${testIds.size} test-диалогов (для метрик), DEV: ${dev.length}`);

// ---------- 1. Штраф за чихание
const base = await req('/checklists/default');
const demoId = `local-demo-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}`;   // свой чек-лист на прогон: апелляции прошлых прогонов не смешиваются
const v1 = await req('/checklists', { ...base, id: demoId, name: `Демо: локальная модель (${demoId})`, criteria: [...base.criteria, SNEEZE] });
console.log(`\n1) Чек-лист ${v1.id} v${v1.version}: добавлен «${SNEEZE.name}»`);
const s1 = await evaluate('SYNTHTEST', v1);
const d1 = await evaluate('DEV', v1);
console.log(`  SYNTHTEST чихание: ${stats(s1, SNEEZE.id, fact('op_sneezed')).line}`);
const devSneeze = d1.filter((e) => e.results.find((r) => r.criterion_id === SNEEZE.id).answer === 'yes');
console.log(`  DEV: «Да» (чихнул) у ${devSneeze.length} из ${d1.length}`);
for (const ev of s1.filter((e) => testIds.has(e.conversation_id) && e.results.find((r) => r.criterion_id === SNEEZE.id).answer === 'yes').slice(0, 2)) show(ev, SNEEZE.id, recById.get(ev.conversation_id));
for (const ev of devSneeze.slice(0, 2)) show(ev, SNEEZE.id, recById.get(ev.conversation_id));

// ---------- 2. Невиданный критерий
const v2 = await req('/checklists', { ...v1, criteria: [...v1.criteria, CALLBACK] });
console.log(`\n2) Чек-лист ${v2.id} v${v2.version}: добавлен «${CALLBACK.name}» (модель его не видела на обучении)`);
const s2 = await evaluate('SYNTHTEST', v2);
const sa = await evaluate('SYNTH', v2);
const truthCb = fact('op_callback_promise');
const before = stats(s2, CALLBACK.id, truthCb);
console.log(`  до дообучения: ${before.line}`);
for (const ev of s2.filter((e) => truthCb(e.conversation_id)).slice(0, 2)) show(ev, CALLBACK.id, recById.get(ev.conversation_id));

// ---------- 3. Апелляции → дообучение → переоценка
// Проверяющий разбирает спорные и ошибочные ответы: сначала ошибки модели, затем «Проверить», поровну «да» и «нет».
const allTruth = (id) => L.get(id)?.facts.op_callback_promise?.v === true;
const cand = sa.filter((e) => L.get(e.conversation_id)?.split !== 'test');
const pick = [];
const wrongYes = cand.filter((e) => allTruth(e.conversation_id) && e.results.find((r) => r.criterion_id === CALLBACK.id).answer !== 'yes');
const otherNo = cand.filter((e) => !allTruth(e.conversation_id));
pick.push(...wrongYes.slice(0, Math.ceil(N_APPEALS / 2)));
pick.push(...otherNo.slice(0, N_APPEALS - pick.length));
for (const ev of pick) {
  const truth = allTruth(ev.conversation_id) ? 'yes' : 'no';
  const r = ev.results.find((x) => x.criterion_id === CALLBACK.id);
  const ap = await req('/appeals', { evaluation_id: ev.id, criterion_id: CALLBACK.id, comment: 'Проверьте обещание перезвонить' });
  await req(`/appeals/${ap.id}/decision`, truth === r.answer ? { action: 'confirm', reason: 'Ответ верный' } : { action: 'change', new_answer: truth, reason: truth === 'yes' ? 'Оператор обещал, что с клиентом свяжутся' : 'Обещания перезвонить нет' });
}
console.log(`\n3) Апелляций с решением: ${pick.length} (диалоги не из test-split; «да» по разметке: ${pick.filter((e) => allTruth(e.conversation_id)).length})`);
const t0 = Date.now();
const ft = await req('/local/finetune', { checklist_id: v2.id, checklist_version: v2.version, criterion_id: CALLBACK.id });
console.log(`  «Дообучить»: ${ft.examples} примеров, ${((Date.now() - t0) / 1000).toFixed(1)} с; на примерах до ${ft.adapter.train_acc_before} → после ${ft.adapter.train_acc_after}`);
const s3 = await evaluate('SYNTHTEST', v2);
console.log(`  до:    ${before.line}`);
console.log(`  после: ${stats(s3, CALLBACK.id, truthCb).line}`);
for (const ev of s3.filter((e) => truthCb(e.conversation_id)).slice(0, 2)) show(ev, CALLBACK.id, recById.get(ev.conversation_id));
