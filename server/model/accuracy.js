// Сравнение оценок модели с эталонной разметкой (чистая функция, тестируется).
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

/**
 * @param {Array} pairs [{ gt:{conversation_id, answers}, ev:{results, conversation_id}, checklist }]
 * @param {Function} computeScore
 */
export function compare(pairs, computeScore) {
  const per = new Map();
  let match = 0, total = 0, matchClear = 0, totalClear = 0, naTP = 0, naFP = 0, naFN = 0, grossOk = 0, totalErr = [];
  const mismatches = [];
  const byLang = {};
  for (const { gt, ev, checklist } of pairs) {
    const modelAns = Object.fromEntries(ev.results.map((r) => [r.criterion_id, r]));
    for (const c of checklist.criteria) {
      if (!(c.id in gt.answers)) continue;
      const g = String(gt.answers[c.id]);
      const mr = modelAns[c.id];
      const m = mr ? String(mr.answer) : 'нет';
      if (!per.has(c.id)) per.set(c.id, { id: c.id, n: 0, ok: 0, absErr: [] });
      const s = per.get(c.id);
      const amb = (gt.ambiguous || []).includes(c.id);
      const lang = ev.language || '—';
      byLang[lang] ??= { n: 0, ok: 0 };
      s.n++; total++; byLang[lang].n++;
      if (!amb) totalClear++;
      if (g === m) { s.ok++; match++; byLang[lang].ok++; if (!amb) matchClear++; }
      else mismatches.push({ conversation_id: gt.conversation_id, criterion_id: c.id, gt: g, model: m, confidence: mr?.confidence, ambiguous: amb, explanation: mr?.explanation });
      if (c.type === 'scale' && g !== 'na' && m !== 'na' && !Number.isNaN(Number(m))) s.absErr.push(Math.abs(Number(g) - Number(m)));
      if (g === 'na' && m === 'na') naTP++;
      else if (m === 'na') naFP++;
      else if (g === 'na') naFN++;
    }
    const gtResults = Object.entries(gt.answers).map(([criterion_id, answer]) => ({ criterion_id, answer }));
    const gs = computeScore(checklist, gtResults);
    const ms = computeScore(checklist, ev.results);
    if (gs.gross_error === ms.gross_error) grossOk++;
    if (gs.total !== null && ms.total !== null) totalErr.push(Math.abs(gs.total - ms.total));
  }
  return {
    n: pairs.length,
    overall: pct(match, total),
    overall_clear: pct(matchClear, totalClear), // без критериев, помеченных в эталоне как ambiguous
    by_language: Object.fromEntries(Object.entries(byLang).map(([l, x]) => [l, pct(x.ok, x.n)])),
    total_mae: totalErr.length ? Math.round((totalErr.reduce((a, b) => a + b, 0) / totalErr.length) * 10) / 10 : null,
    gross_match: pct(grossOk, pairs.length),
    na: { precision: pct(naTP, naTP + naFP), recall: pct(naTP, naTP + naFN) },
    criteria: [...per.values()].map((s) => ({ id: s.id, n: s.n, accuracy: pct(s.ok, s.n), mae: s.absErr.length ? Math.round((s.absErr.reduce((a, b) => a + b, 0) / s.absErr.length) * 10) / 10 : null })),
    mismatches,
  };
}
