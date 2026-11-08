// Бизнес-аналитика: профиль оператора, тревоги о грубых ошибках, сводка для руководителя.
// Чистые функции: на вход данные из store, на выход агрегаты. Ничего не знают о конкретных критериях.
import { economy, coaching } from './business.js';
import { computeScore, criterionFraction, replaceAnswer } from './scoring.js';

export const UNKNOWN_OPERATOR = 'Не определён';
const round2 = (x) => Math.round(x * 100) / 100;
const avg = (xs) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/**
 * Готовит «эффективные» оценки: последняя оценка каждого диалога (с фильтрами),
 * с учётом решений по апелляциям (изменённые ответы) и ручных имён операторов.
 * @param {object} d { evaluations, appeals, getChecklist(id, version), operatorOverrides }
 * @param {object} f { group_id, checklist_id, language, channel }
 */
export function effectiveEvaluations(d, f = {}) {
  const latest = new Map();
  for (const ev of d.evaluations || []) {
    if (f.group_id && ev.group_id !== f.group_id) continue;
    if (f.checklist_id && ev.checklist_id !== f.checklist_id) continue;
    if (f.language && ev.language !== f.language) continue;
    if (f.channel && ev.channel !== f.channel) continue;
    const prev = latest.get(ev.conversation_id);
    if (!prev || ev.created_at > prev.created_at) latest.set(ev.conversation_id, ev);
  }

  const overrides = d.operatorOverrides || {};
  const out = [];
  for (const ev of latest.values()) {
    const checklist = d.getChecklist(ev.checklist_id, ev.checklist_version);
    if (!checklist) continue;
    const appeals = (d.appeals || []).filter((a) => a.evaluation_id === ev.id);
    let results = ev.results || [];
    for (const a of appeals) {
      if (a.status === 'resolved' && a.decision?.action === 'change') {
        results = replaceAnswer(results, a.criterion_id, a.decision.new_answer);
      }
    }
    out.push({
      ev,
      checklist,
      appeals,
      results,
      score: computeScore(checklist, results),
      operator: overrides[ev.conversation_id] || ev.operator_name || UNKNOWN_OPERATOR,
    });
  }
  return out.sort((a, b) => (a.ev.created_at < b.ev.created_at ? -1 : 1));
}

/** Статистика по критериям: средняя доля выполнения, доля «Нет»/N/A, число оспоренных и изменённых. */
function criteriaStats(items) {
  const stats = new Map();
  for (const it of items) {
    for (const c of it.checklist.criteria) {
      const key = c.id;
      if (!stats.has(key)) {
        stats.set(key, { id: c.id, name: c.name, kind: c.kind, fractions: [], total: 0, na: 0, fail: 0, appealed: 0, changed: 0 });
      }
      const s = stats.get(key);
      s.name = c.name; // последнее имя (критерий могли переименовать)
      const r = it.results.find((x) => x.criterion_id === c.id);
      if (!r) continue;
      s.total++;
      if (r.answer === 'na') s.na++;
      const fr = criterionFraction(c, r.answer);
      if (c.kind === 'gross') {
        if (r.answer === 'yes') s.fail++;
      } else if (fr !== null) {
        s.fractions.push(fr);
        if (fr < 1) s.fail++;
      }
      const aps = it.appeals.filter((a) => a.criterion_id === c.id);
      s.appealed += aps.length;
      s.changed += aps.filter((a) => a.status === 'resolved' && a.decision?.action === 'change').length;
    }
  }
  return [...stats.values()].map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    evaluated: s.total,
    avg_percent: s.fractions.length ? round2((s.fractions.reduce((a, b) => a + b, 0) / s.fractions.length) * 100) : null,
    fail_rate: s.total ? round2((s.fail / s.total) * 100) : 0,
    na_rate: s.total ? round2((s.na / s.total) * 100) : 0,
    appealed: s.appealed,
    changed: s.changed,
  }));
}

function groupAvg(items, keyFn) {
  const g = new Map();
  for (const it of items) {
    const k = keyFn(it) ?? '—';
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(it);
  }
  return [...g.entries()]
    .map(([key, xs]) => ({
      key,
      count: xs.length,
      avg_total: avg(xs.map((x) => x.score.total).filter((t) => t !== null)),
      gross_count: xs.filter((x) => x.score.gross_error).length,
    }))
    .sort((a, b) => b.count - a.count);
}

/** Сводка для руководителя (функция 4). */
export function summary(d, f = {}, assumptions = {}) {
  const items = effectiveEvaluations(d, f);
  const totals = items.map((x) => x.score.total).filter((t) => t !== null);
  const criteria = criteriaStats(items);
  const appeals = items.flatMap((x) => x.appeals);
  const resolved = appeals.filter((a) => a.status === 'resolved');
  const changed = resolved.filter((a) => a.decision?.action === 'change');
  const cost = items.map(x => x.ev.cost_usd).filter(x => typeof x === 'number' && Number.isFinite(x) && x >= 0);
  const unknownCosts = items.length - cost.length;

  return {
    count: items.length,
    economy: economy(items, d.evaluations || [], assumptions),
    avg_total: avg(totals),
    not_scored: items.length - totals.length,
    gross_count: items.filter((x) => x.score.gross_error).length,
    gross_rate: items.length ? round2((items.filter((x) => x.score.gross_error).length / items.length) * 100) : 0,
    manual_review_count: items.filter((x) => x.score.pending_manual.length).length,
    distribution: bucketize(totals),
    by_language: groupAvg(items, (x) => x.ev.language),
    by_channel: groupAvg(items, (x) => x.ev.channel),
    by_operator: groupAvg(items, (x) => x.operator),
    criteria,
    problem_criteria: criteria
      .filter((c) => c.kind !== 'gross' && c.avg_percent !== null)
      .sort((a, b) => a.avg_percent - b.avg_percent)
      .slice(0, 3),
    appeals: {
      total: appeals.length,
      open: appeals.filter((a) => a.status === 'open').length,
      resolved: resolved.length,
      changed: changed.length,
      change_rate: resolved.length ? round2((changed.length / resolved.length) * 100) : null,
    },
    cost: {
      unknown_count: unknownCosts,
      total_usd: unknownCosts ? null : Math.round(cost.reduce((a, b) => a + b, 0) * 1e4) / 1e4,
      avg_usd: !unknownCosts && cost.length ? Math.round((cost.reduce((a, b) => a + b, 0) / cost.length) * 1e5) / 1e5 : null,
    },
  };
}

function bucketize(totals) {
  const buckets = [
    { label: '0–49', min: 0, max: 50 },
    { label: '50–69', min: 50, max: 70 },
    { label: '70–84', min: 70, max: 85 },
    { label: '85–100', min: 85, max: 100.0001 },
  ];
  return buckets.map((b) => ({ label: b.label, count: totals.filter((t) => t >= b.min && t < b.max).length }));
}

/** Список операторов (функция 1, обзор). */
export function operators(d, f = {}) {
  const items = effectiveEvaluations(d, f);
  return groupAvg(items, (x) => x.operator).map((g) => {
    const mine = items.filter((x) => x.operator === g.key);
    const weak = criteriaStats(mine)
      .filter((c) => c.kind !== 'gross' && c.avg_percent !== null && c.avg_percent < 100)
      .sort((a, b) => a.avg_percent - b.avg_percent)[0];
    return { name: g.key, count: g.count, avg_total: g.avg_total, gross_count: g.gross_count, weakest: weak ? { id: weak.id, name: weak.name, avg_percent: weak.avg_percent } : null };
  });
}

/** Профиль одного оператора (функция 1). */
export function operatorProfile(d, name, f = {}) {
  const all = effectiveEvaluations(d, f);
  const items = all.filter((x) => x.operator === name);
  if (!items.length) return null;
  const teamAvg = avg(all.map((x) => x.score.total).filter((t) => t !== null));
  const criteria = criteriaStats(items);
  const teamCriteria = new Map(criteriaStats(all).map((c) => [c.id, c.avg_percent]));
  return {
    name,
    coaching: coaching(items),
    count: items.length,
    avg_total: avg(items.map((x) => x.score.total).filter((t) => t !== null)),
    team_avg_total: teamAvg,
    gross_count: items.filter((x) => x.score.gross_error).length,
    trend: items.map((x) => ({
      evaluation_id: x.ev.id,
      conversation_id: x.ev.conversation_id,
      created_at: x.ev.created_at,
      total: x.score.total,
      gross_error: x.score.gross_error,
    })),
    criteria: criteria.map((c) => ({ ...c, team_avg_percent: teamCriteria.get(c.id) ?? null })),
    weak_criteria: criteria
      .filter((c) => c.kind !== 'gross' && c.avg_percent !== null && c.avg_percent < 100)
      .sort((a, b) => a.avg_percent - b.avg_percent)
      .slice(0, 3),
    conversations: items.map((x) => ({
      evaluation_id: x.ev.id,
      conversation_id: x.ev.conversation_id,
      language: x.ev.language,
      channel: x.ev.channel,
      total: x.score.total,
      gross_error: x.score.gross_error,
    })),
  };
}

/** Лента тревог о грубых ошибках (функция 3). */
export function alerts(d, acks = {}, f = {}) {
  return effectiveEvaluations(d, f)
    .filter((x) => x.score.gross_error)
    .map((x) => ({
      evaluation_id: x.ev.id,
      conversation_id: x.ev.conversation_id,
      operator: x.operator,
      language: x.ev.language,
      channel: x.ev.channel,
      created_at: x.ev.created_at,
      total: x.score.total,
      violations: x.score.gross_criteria.map((cid) => {
        const c = x.checklist.criteria.find((k) => k.id === cid);
        const r = x.results.find((k) => k.criterion_id === cid) || {};
        return { criterion_id: cid, name: c?.name || cid, explanation: r.explanation || '', evidence: r.evidence || [] };
      }),
      acked: acks[x.ev.id] || null,
    }))
    .sort((a, b) => (!!a.acked - !!b.acked) || (a.created_at < b.created_at ? 1 : -1));
}
