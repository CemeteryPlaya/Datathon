import { criterionFraction } from './scoring.js';

const round = (x) => Math.round(x * 1e6) / 1e6;
export const ECONOMY_DEFAULTS = { human_minutes: 10, review_minutes: 2, hourly_usd: 12 };

/** Scenario estimate, not measured productivity. Charge every saved attempt for selected conversations. */
export function economy(items, evaluations, options = {}) {
  const assumptions = Object.fromEntries(Object.entries(ECONOMY_DEFAULTS).map(([key, fallback]) => {
    const n = Number(options[key]);
    return [key, options[key] !== undefined && options[key] !== '' && Number.isFinite(n) && n >= 0 && n <= 1e6 ? n : fallback];
  }));
  const selected = new Set(items.map(x => `${x.ev.group_id || ''}\0${x.ev.conversation_id}`));
  const attempts = evaluations.filter(e => selected.has(`${e.group_id || ''}\0${e.conversation_id}`));
  const known = attempts.filter(e => typeof e.cost_usd === 'number' && Number.isFinite(e.cost_usd) && e.cost_usd >= 0);
  const knownCost = known.reduce((sum, e) => sum + e.cost_usd, 0);
  const unknown = attempts.length - known.length;
  const review = items.filter(x => x.score.gross_error || x.score.pending_manual.length || x.appeals.length);
  const humanHours = items.length * assumptions.human_minutes / 60;
  const reviewHours = review.length * assumptions.review_minutes / 60;
  const humanCost = humanHours * assumptions.hourly_usd;
  const assistedCost = unknown ? null : knownCost + reviewHours * assumptions.hourly_usd;
  return {
    assumptions, conversations: items.length, attempts: attempts.length,
    human_hours: round(humanHours), review_hours: round(reviewHours),
    saved_hours: round(humanHours - reviewHours), review_conversations: review.length,
    human_cost_usd: round(humanCost), ai_cost_usd: unknown ? null : round(knownCost),
    known_ai_cost_usd: round(knownCost), unknown_cost_attempts: unknown,
    assisted_cost_usd: assistedCost === null ? null : round(assistedCost),
    saved_usd: assistedCost === null ? null : round(humanCost - assistedCost),
    risk_conversations: items.filter(x => x.score.gross_error).length,
    risk_findings: items.reduce((sum, x) => sum + x.score.gross_criteria.length, 0),
  };
}

/** Rule-based coaching tied to effective answers, including appeal decisions, with versioned evidence. */
export function coaching(items) {
  const groups = new Map();
  for (const item of items) {
    for (const c of item.checklist.criteria) {
      const r = item.results.find(r => r.criterion_id === c.id);
      const fraction = criterionFraction(c, r?.answer);
      const failed = c.kind === 'gross' ? r?.answer === 'yes' : fraction !== null && fraction < 1;
      if (!failed) continue;
      if (!groups.has(c.id)) groups.set(c.id, { criterion_id: c.id, name: c.name, gross: c.kind === 'gross', failed: 0, lost_weight: 0, examples: [] });
      const plan = groups.get(c.id);
      plan.name = c.name;
      plan.failed++;
      plan.lost_weight += c.kind === 'gross' ? 0 : (Number(c.weight) || 0) * (1 - fraction);
      const decision = item.appeals.filter(a => a.status === 'resolved' && a.criterion_id === c.id && a.decision?.action === 'change').at(-1);
      plan.examples.unshift({
        conversation_id: item.ev.conversation_id, evaluation_id: item.ev.id, group_id: item.ev.group_id,
        checklist_version: item.ev.checklist_version, answer: r.answer,
        explanation: decision ? decision.decision.reason : r.explanation || '',
        evidence: decision ? [] : r.evidence || [], rule: c.description || c.name,
      });
    }
  }
  return [...groups.values()]
    .sort((a, b) => Number(b.gross) - Number(a.gross) || b.lost_weight - a.lost_weight || b.failed - a.failed)
    .slice(0, 3)
    .map(plan => ({ ...plan, lost_weight: round(plan.lost_weight), examples: plan.examples.slice(0, 2),
      exercise: plan.gross
        ? 'С проверяющим разберите отмеченный эпизод, сформулируйте безопасный вариант ответа и отрепетируйте его в ролевом диалоге.'
        : 'Разберите пример, перепишите ответ по правилу критерия и отрепетируйте его с наставником. Перед отправкой следующего ответа проверьте выполнение правила.',
      target: plan.gross ? 'Ни одного нарушения в следующих 5 применимых диалогах; проверяющий подтверждает результат.' : 'Полное выполнение критерия в следующих 5 применимых диалогах; N/A не засчитывается как успех.',
    }));
}
