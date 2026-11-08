// Оценка одного диалога локальной моделью (local-model/serve.py): один проход, вероятности по вариантам ответа.
import { detectEvents, offsets } from './events.js';
import { normalizeCriterion } from './validate.js';
import { buildQuestions, toAnswer, isNegative } from './questions.js';
import { computeScore } from '../scoring.js';

const pct = (p) => `${Math.round(Number(p) * 100)}%`;
const quote = (record, i) => {
  const r = record.transcript[i];
  if (!r) return '';
  const t = String(r.text ?? '').replace(/\s+/g, ' ').trim();
  return `[${i}] ${r.speaker}: «${t.length > 140 ? `${t.slice(0, 137)}…` : t}»`;
};

/** Объяснение по шаблону: ответ, вероятность, цитата реплики-доказательства; для «Нет» — проверенный участок, для N/A — условие. */
export function localExplanation(c, answer, a, record, evidence, checked) {
  const parts = [];
  const negative = isNegative(c);
  const range = checked ? `[${checked[0]}–${checked[1]}]` : 'весь диалог';
  if (answer === 'na') {
    parts.push(`Условие N/A выполнено (вероятность ${pct(a.confidence)}): ${String(c.na_condition || 'критерий неприменим').trim()}`);
    if (evidence.length) parts.push(`Основание: ${quote(record, evidence[0])}`);
  } else if (c.type === 'scale') {
    const max = Math.max(...(c.levels || []).map((l) => Number(l.value)));
    const lvl = (c.levels || []).find((l) => Number(l.value) === Number(answer));
    parts.push(`${answer} из ${max} (вероятность ${pct(a.confidence)}${typeof a.score === 'number' ? `, ожидаемое значение ${a.score}` : ''}): ${String(lvl?.description || '').trim()}`);
    if (evidence.length) parts.push(`Ключевая реплика: ${quote(record, evidence[0])}`);
    parts.push(`Проверены реплики ${range}.`);
  } else if (answer === 'yes') {
    parts.push(negative ? `Да — нарушение (вероятность ${pct(a.confidence)}).` : `Да (вероятность ${pct(a.confidence)}).`);
    if (evidence.length) parts.push(`${negative ? 'Нарушение' : 'Доказательство'}: ${quote(record, evidence[0])}`);
  } else {
    parts.push(negative ? `Нет — нарушение не найдено (вероятность ${pct(a.confidence)}).` : `Нет (вероятность ${pct(a.confidence)}).`);
    parts.push(`Проверены реплики ${range}.`);
    if (evidence.length && !negative) parts.push(`Где ожидалось: ${quote(record, evidence[0])}`);
  }
  if (Number(a.confidence) < 0.75) parts.push('Модель не уверена — проверьте вручную.');
  return parts.join(' ');
}

/**
 * Оценка диалога: Evaluation с model "cqa-local-v1", cost_usd 0, runs 1, у критериев probabilities.
 * @param {object} p { record, checklist, model (createLocalModel()), group_id }
 */
export async function evaluateConversation({ record, checklist, model, group_id = null }) {
  const events = detectEvents(record.transcript);
  const started = Date.now();
  const resp = await model.decide({ record, events, offsets: offsets(record.transcript), questions: buildQuestions(checklist) });
  const n = record.transcript.length;
  const results = checklist.criteria.map((c) => {
    const a = resp?.answers?.[c.id];
    const answer = a ? toAnswer(c, a.choice) : null;
    const norm = answer === null ? { ok: false } : normalizeCriterion(c, { answer, evidence: a.evidence, checked_range: a.checked_range }, n);
    if (!norm.ok) {
      return { criterion_id: c.id, answer: 'manual', explanation: 'Модель не дала допустимого ответа — требуется ручная проверка.', evidence: [], checked_range: null, confidence: 0 };
    }
    const r = norm.result;
    const probabilities = Object.fromEntries(Object.entries(a.probabilities || {}).map(([k, p]) => [k, Math.round(Number(p) * 10000) / 10000]));
    return {
      criterion_id: c.id,
      answer: r.answer,
      explanation: localExplanation(c, r.answer, a, record, r.evidence, r.checked_range),
      evidence: r.evidence,
      checked_range: r.checked_range,
      confidence: Math.round(Number(a.confidence) * 1000) / 1000,
      probabilities,
      ...(typeof a.score === 'number' ? { expected_value: a.score } : {}),
    };
  });
  return {
    conversation_id: record.conversation_id,
    group_id,
    language: record.language,
    channel: record.channel,
    operator_name: resp?.operator_name || null,
    checklist_id: checklist.id,
    checklist_version: checklist.version,
    model: resp?.model || model.model,
    provider: 'local',
    runs: 1,
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    cost_usd: 0,
    duration_ms: Date.now() - started,
    model_duration_ms: resp?.duration_ms ?? null,
    events,
    results,
    score: computeScore(checklist, results),
  };
}
