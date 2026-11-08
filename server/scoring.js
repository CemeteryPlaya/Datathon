// Детерминированная формула оценки. Чистые функции, без модели.

const round2 = (x) => Math.round(x * 100) / 100;

/** Доля выполнения критерия: 0..1, или null, если критерий не учитывается (N/A, нет ответа, ручная проверка). */
export function criterionFraction(criterion, answer) {
  if (answer === undefined || answer === null || answer === 'na' || answer === 'manual') return null;
  if (criterion.type === 'scale') {
    const max = Math.max(...(criterion.levels || []).map((l) => Number(l.value)));
    if (!Number.isFinite(max) || max <= 0) return 0;
    return Number(answer) / max;
  }
  // polarity "negative" — штрафной критерий: «Да» = нарушение было (например, «Оператор чихал в трубку»).
  if (criterion.polarity === 'negative') return answer === 'yes' ? 0 : 1;
  return answer === 'yes' ? 1 : 0;
}

/**
 * Считает итог по чек-листу и ответам.
 * @param {object} checklist  { sections:[{id,name}], criteria:[{id,section,type,levels,weight,kind}] }
 * @param {Array}  results    [{ criterion_id, answer }]
 */
export function computeScore(checklist, results) {
  const byId = new Map((results || []).map((r) => [r.criterion_id, r.answer]));
  const rows = [];
  for (const c of checklist.criteria) {
    const answer = byId.get(c.id);
    const weight = Number(c.weight) || 0;
    const fraction = criterionFraction(c, answer);
    const applicable = c.kind !== 'gross' && weight > 0 && fraction !== null;
    rows.push({ c, answer, weight, fraction, applicable, raw: applicable ? weight * fraction : 0 });
  }

  const W = rows.reduce((s, r) => s + (r.applicable ? r.weight : 0), 0);
  const rawSum = rows.reduce((s, r) => s + r.raw, 0);

  const per_criterion = {};
  for (const r of rows) {
    per_criterion[r.c.id] = {
      answer: r.answer ?? null,
      applicable: r.applicable,
      fraction: r.fraction,
      points: r.applicable && W ? round2((r.raw / W) * 100) : 0,
      weight_eff: r.applicable && W ? round2((r.weight / W) * 100) : 0,
    };
  }

  const sections = {};
  for (const s of checklist.sections || []) {
    const sr = rows.filter((r) => r.c.section === s.id);
    const Ws = sr.reduce((a, r) => a + (r.applicable ? r.weight : 0), 0);
    const raw = sr.reduce((a, r) => a + r.raw, 0);
    sections[s.id] = {
      total: Ws ? round2((raw / Ws) * 100) : null,
      contribution: W ? round2((raw / W) * 100) : 0,
      weight_share: W ? round2((Ws / W) * 100) : 0,
    };
  }

  const gross_criteria = rows.filter((r) => r.c.kind === 'gross' && r.answer === 'yes').map((r) => r.c.id);
  const pending_manual = rows.filter((r) => r.answer === 'manual').map((r) => r.c.id);

  return {
    total: W ? round2((rawSum / W) * 100) : null,
    sections,
    gross_error: gross_criteria.length > 0,
    gross_criteria,
    pending_manual,
    per_criterion,
  };
}

/** Возвращает копию results с заменённым ответом по одному критерию (для решения по апелляции). */
export function replaceAnswer(results, criterionId, newAnswer) {
  let found = false;
  const out = (results || []).map((r) => {
    if (r.criterion_id !== criterionId) return r;
    found = true;
    return { ...r, answer: newAnswer };
  });
  if (!found) out.push({ criterion_id: criterionId, answer: newAnswer });
  return out;
}
