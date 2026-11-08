import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import * as analytics from './analytics.js';
import { checklistError, validAnswer } from './validation.js';
import { recordsFor, hasLocal, fetchDataset, resolveAudio } from './datasets.js';
import crypto from 'node:crypto';
import { evaluateConversation } from './model/evaluate.js';
import { createLocalModel, LOCAL_MODEL } from './model/decide.js';
import { toQuestion, answerKey } from './model/questions.js';
import { detectEvents, offsets } from './model/events.js';
import { computeScore, replaceAnswer } from './scoring.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use(express.json({ limit: '5mb' }));

const filters = (q) => ({
  group_id: q.group_id || undefined,
  checklist_id: q.checklist_id || undefined,
  language: q.language || undefined,
  channel: q.channel || undefined,
});
const data = () => ({
  evaluations: store.listEvaluations(),
  appeals: store.listAppeals(),
  getChecklist: store.getChecklist,
  operatorOverrides: store.getOperatorOverrides(),
});

// ---------- checklists ----------
app.get('/api/checklists', (req, res) => {
  const all = store.listChecklists();
  const latest = new Map();
  for (const c of all) if (!latest.has(c.id) || c.version > latest.get(c.id).version) latest.set(c.id, c);
  res.json(req.query.all ? all : [...latest.values()]);
});
app.get('/api/checklists/:id', (req, res) => {
  const c = store.getChecklist(req.params.id, req.query.version);
  c ? res.json(c) : res.status(404).json({ error: 'not found' });
});
app.post('/api/checklists', (req, res) => {
  const c = req.body;
  const error = checklistError(c);
  if (error) return res.status(400).json({ error });
  res.json(store.saveChecklistVersion(c));
});

// Наборы организаторов: локальный снапшот data/<group>.json; ?refresh=1 или отсутствие файла → загрузка из API.
app.get('/api/datasets/:groupId', async (req, res) => {
  try {
    const g = req.params.groupId;
    const records = req.query.refresh || !hasLocal(g) ? await fetchDataset(g) : recordsFor(g);
    res.json({ group_id: g, total: records.length, records });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/conversations/:id/audio', async (req, res) => {
  try {
    const record = recordsFor(req.query.group_id || 'DEV').find((r) => r.conversation_id === req.params.id);
    if (!record) return res.status(404).json({ error: 'Диалог не найден' });
    if (!record.audio_url) return res.status(404).json({ error: 'У диалога нет аудио' });
    const src = await resolveAudio(record);
    src ? res.json({ src, page: record.audio_url }) : res.status(502).json({ error: 'Не удалось найти ссылку на запись', page: record.audio_url });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/conversations/:id', (req, res) => {
  try {
    const record = recordsFor(req.query.group_id || 'DEV').find(r=>r.conversation_id === req.params.id);
    record ? res.json(record) : res.status(404).json({error:'Диалог не найден'});
  } catch(e) { res.status(400).json({error:e.message}); }
});

// Модель оценки — своя, обученная с нуля (local-model/serve.py). В тестах подменяется через app.locals.localModel.
const getModel = () => app.locals.localModel || createLocalModel();

app.get('/api/config', (req, res) => {
  res.json({ provider: 'local', model: LOCAL_MODEL });
});

/**
 * Дообучение локальной модели по решениям проверяющих: рассмотренные апелляции по критерию (финальный ответ
 * проверяющего; при «подтвердить» — исходный ответ модели) + диалоги → POST /v1/finetune.
 */
app.post('/api/local/finetune', async (req, res) => {
  try {
    const { checklist_id, checklist_version, criterion_id } = req.body || {};
    const checklist = store.getChecklist(checklist_id, checklist_version);
    const criterion = checklist?.criteria.find((c) => c.id === criterion_id);
    if (!criterion) return res.status(400).json({ error: 'Критерий не найден в чек-листе' });
    const evals = new Map(store.listEvaluations().map((e) => [e.id, e]));
    const byConversation = new Map();
    const resolved = store.listAppeals()
      .filter((a) => a.status === 'resolved' && a.criterion_id === criterion_id)
      .sort((a, b) => (a.decision?.decided_at < b.decision?.decided_at ? -1 : 1));
    for (const a of resolved) {
      const ev = evals.get(a.evaluation_id);
      if (!ev || ev.checklist_id !== checklist.id) continue;
      const answer = a.decision.action === 'change' ? a.decision.new_answer : ev.results.find((r) => r.criterion_id === criterion_id)?.answer;
      if (answer === undefined || answer === 'manual' || !validAnswer(criterion, answer)) continue;
      const record = recordsFor(ev.group_id || 'DEV').find((r) => r.conversation_id === ev.conversation_id);
      if (!record) continue;
      byConversation.set(ev.conversation_id, { record, events: detectEvents(record.transcript), offsets: offsets(record.transcript), answer: answerKey(criterion, answer) });
    }
    const examples = [...byConversation.values()];
    if (examples.length < 5) return res.status(400).json({ error: `Нужно минимум 5 рассмотренных апелляций по критерию (разных диалогов), сейчас ${examples.length}`, examples: examples.length });
    const out = await getModel().finetune({ question: toQuestion(criterion), examples });
    res.json({ ...out, examples: examples.length, criterion_id });
  } catch (e) { res.status(e.status === 400 ? 400 : 502).json({ error: e.message }); }
});

// Пакетная оценка: по умолчанию фоновая задача с прогрессом (GET /api/jobs/:id); { wait: true } — синхронно.
const jobs = new Map();
app.post('/api/evaluate', async (req, res) => {
  try {
    const { group_id, conversation_ids, checklist_id, checklist_version, wait } = req.body;
    const checklist = store.getChecklist(checklist_id, checklist_version);
    if (!checklist) return res.status(400).json({ error: 'Чек-лист не найден' });
    const all = recordsFor(group_id);
    if (conversation_ids !== 'all' && (!Array.isArray(conversation_ids) || !conversation_ids.length)) return res.status(400).json({ error: 'Выберите диалоги' });
    const records = conversation_ids === 'all' ? all : all.filter(r=>conversation_ids.includes(r.conversation_id));
    if (!records.length) return res.status(400).json({ error: 'Диалоги не найдены' });
    const model = getModel();
    const job = { id: 'job_' + crypto.randomBytes(5).toString('hex'), status: 'running', group_id, checklist_id: checklist.id, checklist_version: checklist.version,
      total: records.length, done: 0, failed: 0, errors: [], evaluation_ids: [], cost_usd: 0, started_at: new Date().toISOString() };
    jobs.set(job.id, job);
    const evaluations = [];
    const queue = [...records];
    async function worker() {
      while (queue.length) {
        const record = queue.shift();
        try {
          const ev = store.saveEvaluation(await evaluateConversation({ record, checklist, model, group_id }));
          evaluations.push(ev); job.evaluation_ids.push(ev.id); job.cost_usd = Math.round((job.cost_usd + (ev.cost_usd || 0)) * 1e6) / 1e6;
        } catch(e) { job.failed++; job.errors.push({ conversation_id: record.conversation_id, error: e.message }); }
        job.done++;
      }
    }
    const run = Promise.all(Array.from({length: Math.min(Number(process.env.EVAL_CONCURRENCY) || 5, records.length)}, worker)).then(() => {
      job.status = job.failed === job.total ? 'error' : 'done';
      job.finished_at = new Date().toISOString();
    });
    if (wait) { await run; return res.json({ job_id: job.id, evaluations, errors: job.errors }); }
    res.json({ job_id: job.id, total: job.total });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  j ? res.json(j) : res.status(404).json({ error: 'Задача не найдена (сервер перезапускался?)' });
});

// ---------- evaluations ----------
app.get('/api/evaluations', (req, res) => {
  let all = store.listEvaluations();
  if (req.query.conversation_id) all = all.filter((e) => e.conversation_id === req.query.conversation_id);
  res.json(all);
});
app.get('/api/evaluations/:id', (req, res) => {
  const e = store.getEvaluation(req.params.id);
  e ? res.json({ ...e, final_score: finalScore(e) }) : res.status(404).json({ error: 'not found' });
});

function finalScore(ev) {
  let results = ev.results;
  for (const a of store.listAppeals().filter(a=>a.evaluation_id === ev.id && a.status === 'resolved' && a.decision?.action === 'change')) results = replaceAnswer(results, a.criterion_id, a.decision.new_answer);
  return computeScore(store.getChecklist(ev.checklist_id, ev.checklist_version), results);
}

// ---------- appeals ----------
app.get('/api/appeals', (req, res) => {
  let all = store.listAppeals();
  if (req.query.status) all = all.filter((a) => a.status === req.query.status);
  if (req.query.evaluation_id) all = all.filter((a) => a.evaluation_id === req.query.evaluation_id);
  res.json(all);
});
app.post('/api/appeals', (req, res) => {
  const { evaluation_id, criterion_id, comment } = req.body || {};
  const ev = store.getEvaluation(evaluation_id);
  if (!ev) return res.status(404).json({ error: 'evaluation not found' });
  const checklist = store.getChecklist(ev.checklist_id, ev.checklist_version);
  if (!checklist?.criteria.some(c=>c.id === criterion_id) || typeof comment !== 'string' || !comment.trim()) return res.status(400).json({ error: 'Укажите критерий и комментарий' });
  if (store.listAppeals().some(a=>a.evaluation_id === evaluation_id && a.criterion_id === criterion_id && a.status === 'open')) return res.status(409).json({ error: 'По критерию уже есть открытая апелляция' });
  res.json(
    store.saveAppeal({
      id: store.newId('ap'),
      evaluation_id,
      conversation_id: ev.conversation_id,
      criterion_id,
      comment,
      status: 'open',
      created_at: new Date().toISOString(),
    }),
  );
});
app.post('/api/appeals/:id/decision', (req, res) => {
  const ap = store.listAppeals().find((a) => a.id === req.params.id);
  if (!ap) return res.status(404).json({ error: 'not found' });
  if (ap.status !== 'open') return res.status(409).json({ error: 'Решение уже принято' });
  const { action, new_answer, reason } = req.body || {};
  if (!['confirm', 'change'].includes(action) || typeof reason !== 'string' || !reason.trim()) return res.status(400).json({ error: 'action and reason required' });
  const ev = store.getEvaluation(ap.evaluation_id);
  const checklist = store.getChecklist(ev.checklist_id, ev.checklist_version);
  const criterion = checklist.criteria.find(c=>c.id === ap.criterion_id);
  if (action === 'change' && !validAnswer(criterion, new_answer)) return res.status(400).json({ error: 'Ответ не соответствует шкале или правилу N/A' });
  let results = ev.results;
  for (const a of store.listAppeals().filter(a=>a.evaluation_id === ev.id && a.status === 'resolved' && a.decision?.action === 'change')) results = replaceAnswer(results, a.criterion_id, a.decision.new_answer);
  if (action === 'change') results = replaceAnswer(results, ap.criterion_id, new_answer);
  res.json(
    store.saveAppeal({
      ...ap,
      status: 'resolved',
      decision: { action, new_answer: action === 'change' ? new_answer : undefined, reason, decided_at: new Date().toISOString() },
      final_score: computeScore(checklist, results),
    }),
  );
});

// ---------- бизнес-аналитика ----------
app.get('/api/analytics/summary', (req, res) => res.json(analytics.summary(data(), filters(req.query), req.query)));
app.get('/api/analytics/operators', (req, res) => res.json(analytics.operators(data(), filters(req.query))));
app.get('/api/analytics/operators/:name', (req, res) => {
  const p = analytics.operatorProfile(data(), req.params.name, filters(req.query));
  p ? res.json(p) : res.status(404).json({ error: 'not found' });
});
app.put('/api/conversations/:id/operator', (req, res) => {
  store.setOperatorOverride(req.params.id, (req.body?.name || '').trim());
  res.json({ ok: true });
});
app.get('/api/alerts', (req, res) => res.json(analytics.alerts(data(), store.getAlertAcks(), filters(req.query))));
app.post('/api/alerts/:evaluationId/ack', (req, res) => res.json(store.ackAlert(req.params.evaluationId, req.body?.note || '')));

// ---------- статика ----------
// Формула общая для бэка и фронта: карточка пересчитывает финальный итог по всем решениям апелляций.
app.get('/shared/scoring.js', (req, res) => res.type('application/javascript').sendFile(path.join(ROOT, 'server', 'scoring.js')));
app.use(express.static(path.join(ROOT, 'web')));

const port = Number(process.env.PORT) || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => console.log(`CQA: http://localhost:${port}`));
}
export default app;
