// Общие помощники экранов оценки: последняя оценка диалога, финальный итог с учётом апелляций,
// кеш версий чек-листов, текущий group_id, смещения реплик для плеера.
import { api } from './api.js';
import { computeScore, replaceAnswer } from '/shared/scoring.js';

const GROUP_KEY = 'cqa.group_id';
export const currentGroup = () => localStorage.getItem(GROUP_KEY) || 'DEV';
export const setGroup = (g) => localStorage.setItem(GROUP_KEY, String(g || 'DEV').trim() || 'DEV');

/** Записи датасета из ответа бэкенда (терпимо к форме: как есть из API, {records} или массив). */
export function datasetRecords(d) {
  if (Array.isArray(d)) return d;
  return d?.data?.records || d?.records || [];
}

/** Последняя оценка по каждому диалогу: Map conversation_id → evaluation. */
export function latestByConversation(evaluations) {
  const m = new Map();
  for (const ev of evaluations) {
    const prev = m.get(ev.conversation_id);
    if (!prev || ev.created_at > prev.created_at) m.set(ev.conversation_id, ev);
  }
  return m;
}

const checklistCache = new Map();
/** Версия чек-листа, по которой сделана оценка (кешируется на время сессии страницы). */
export function checklistFor(id, version) {
  const key = `${id}@${version}`;
  if (!checklistCache.has(key)) checklistCache.set(key, api.checklist(id, version).catch(() => null));
  return checklistCache.get(key);
}

/** Ответы после всех решённых апелляций с action=change (исходная оценка не меняется). */
export function finalResults(ev, appeals) {
  let results = ev.results || [];
  const resolved = appeals
    .filter((a) => a.evaluation_id === ev.id && a.status === 'resolved' && a.decision?.action === 'change')
    .sort((a, b) => (a.decision.decided_at < b.decision.decided_at ? -1 : 1));
  for (const a of resolved) results = replaceAnswer(results, a.criterion_id, a.decision.new_answer);
  return results;
}

/** { original, final, changed } — исходный и финальный score оценки. */
export function scores(ev, checklist, appeals) {
  const original = ev.score || (checklist ? computeScore(checklist, ev.results) : null);
  const evAppeals = appeals.filter((a) => a.evaluation_id === ev.id);
  const changed = evAppeals.some((a) => a.status === 'resolved' && a.decision?.action === 'change');
  const final = changed && checklist ? computeScore(checklist, finalResults(ev, appeals)) : original;
  // «Проверить»: модель не уверена (confidence < 0.75), а проверяющий по этому критерию ещё не решал
  const decided = new Set(evAppeals.filter((a) => a.status === 'resolved').map((a) => a.criterion_id));
  const inChecklist = (id) => !checklist || checklist.criteria.some((c) => c.id === id);
  const unsure = (ev.results || []).filter((r) => isUnsure(r) && !decided.has(r.criterion_id) && inChecklist(r.criterion_id)).map((r) => r.criterion_id);
  return { original, final, changed, appeals: evAppeals, unsure };
}

/** Секунды от начала: "MM:SS" / "HH:MM:SS" или ISO 8601 (как server/model/events.js). */
export function parseTimestamp(ts) {
  if (!ts) return null;
  const s = String(ts).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t / 1000;
}

/** Смещение реплик от первой реплики, сек: t − t(первой). */
export function offsets(transcript) {
  const base = transcript.map((r) => parseTimestamp(r.timestamp)).find((x) => x !== null);
  return transcript.map((r) => {
    const t = parseTimestamp(r.timestamp);
    return t === null || base === undefined ? null : Math.max(0, Math.round((t - base) * 10) / 10);
  });
}

export const fmtOffset = (sec) => {
  if (sec === null || sec === undefined) return '';
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Человекочитаемый ответ по критерию. */
export function answerLabel(criterion, answer) {
  if (answer === 'manual') return 'Ручная проверка';
  if (answer === 'na') return 'N/A';
  if (answer === undefined || answer === null) return '—';
  if (criterion?.type === 'scale') {
    const max = Math.max(...(criterion.levels || []).map((l) => Number(l.value)));
    return `${answer} из ${Number.isFinite(max) ? max : '?'}`;
  }
  return answer === 'yes' ? 'Да' : answer === 'no' ? 'Нет' : String(answer);
}

/** Класс бейджа ответа: хорошо / плохо / нейтрально (учитывает штрафные и грубые критерии). */
export function answerClass(criterion, answer) {
  if (answer === 'manual') return 'cqa-ans-manual';
  if (answer === 'na' || answer === undefined || answer === null) return 'cqa-ans-na';
  if (criterion?.type === 'scale') {
    const max = Math.max(...(criterion.levels || []).map((l) => Number(l.value)));
    const f = max > 0 ? Number(answer) / max : 0;
    return f >= 0.85 ? 'cqa-ans-good' : f >= 0.5 ? 'cqa-ans-mid' : 'cqa-ans-bad';
  }
  const bad = criterion?.kind === 'gross' || criterion?.polarity === 'negative' ? answer === 'yes' : answer === 'no';
  return bad ? 'cqa-ans-bad' : 'cqa-ans-good';
}

/** Порог «проверить»: уверенность модели (вероятность выбранного ответа) ниже порога. */
export const UNSURE_BELOW = 0.75;
export const isUnsure = (r) =>
  !!r && r.answer !== 'manual' && r.confidence !== undefined && r.confidence !== null && Number(r.confidence) < UNSURE_BELOW;

/** Подсказка с раскладом голосов: «Да: 2, Нет: 1». */
export function votesLabel(criterion, r) {
  if (!r?.votes) return r?.confidence !== undefined && r?.confidence !== null ? `Уверенность ${Math.round(r.confidence * 100)}%` : '';
  return Object.entries(r.votes)
    .map(([k, v]) => `${answerLabel(criterion, criterion?.type === 'scale' && k !== 'na' && k !== 'manual' ? Number(k) : k)}: ${v}`)
    .join(', ');
}

/** Ответ = нарушение (красная метка в таймлайне): «Нет», грубая/штрафная «Да», шкала ниже половины. */
export const isViolation = (criterion, answer) => answerClass(criterion, answer) === 'cqa-ans-bad';

/**
 * Полоска вероятностей локальной модели («да 82% · нет 15% · N/A 3%»), если у результата есть probabilities.
 * Ключи вариантов: yes / no / na / значение ступени шкалы строкой.
 */
export function probBar(criterion, r) {
  const probs = r?.probabilities;
  if (!probs || typeof probs !== 'object' || !Object.keys(probs).length) return '';
  const toAnswer = (k) => (criterion?.type === 'scale' && k !== 'na' ? Number(k) : k);
  const items = Object.entries(probs)
    .map(([k, p]) => ({ k, p: Number(p) || 0, label: answerLabel(criterion, toAnswer(k)), cls: answerClass(criterion, toAnswer(k)) }))
    .sort((a, b) => b.p - a.p);
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const text = items.map((i) => `${esc(i.label === 'N/A' ? i.label : i.label.toLowerCase())} ${Math.round(i.p * 100)}%`).join(' · ');
  const segs = items.filter((i) => i.p >= 0.005).map((i) => `<span class="cqa-prob-seg ${i.cls}" style="width:${(i.p * 100).toFixed(1)}%" title="${esc(i.label)}: ${(i.p * 100).toFixed(1)}%"></span>`).join('');
  return `<div class="cqa-prob" title="Вероятности вариантов по оценке локальной модели"><div class="cqa-prob-bar">${segs}</div><span class="cqa-prob-text">${text}</span></div>`;
}
