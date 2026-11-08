// Мелкие общие помощники для экранов.
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmtScore = (x) => (x === null || x === undefined ? '—' : `${Number(x).toFixed(1)}`);

export function scoreClass(x) {
  if (x === null || x === undefined) return 'cqa-score-na';
  if (x >= 85) return 'cqa-score-good';
  if (x >= 70) return 'cqa-score-mid';
  return 'cqa-score-bad';
}

export const scorePill = (x) => `<span class="cqa-pill ${scoreClass(x)}">${fmtScore(x)}</span>`;

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '');

/** Горизонтальная полоса 0..100 (необязательная отметка команды). */
export function bar(value, mark) {
  const v = value ?? 0;
  return `<div class="cqa-bar"><div class="cqa-bar-fill ${scoreClass(value)}" style="width:${Math.max(0, Math.min(100, v))}%"></div>${
    mark !== null && mark !== undefined ? `<div class="cqa-bar-mark" style="left:${mark}%" title="Среднее по команде: ${fmtScore(mark)}"></div>` : ''
  }</div>`;
}

/** Фильтры язык/канал; вызывает onChange(filters). */
export function filterBar(state, onChange) {
  const el = document.createElement('div');
  el.className = 'cqa-filters';
  el.innerHTML = `
    <label>Язык <select name="language"><option value="">все</option><option>RU</option><option>KZ</option><option>EN</option></select></label>
    <label>Канал <select name="channel"><option value="">все</option><option value="agent chat">чат</option><option value="voice call">звонок</option></select></label>`;
  for (const s of el.querySelectorAll('select')) {
    s.value = state[s.name] || '';
    s.addEventListener('change', () => onChange({ ...state, [s.name]: s.value }));
  }
  return el;
}

export const channelLabel = (c) => (c === 'voice call' ? 'звонок' : c === 'agent chat' ? 'чат' : c || '—');

/** Простой SVG-график тренда итогового балла. */
export function trendChart(points) {
  const pts = points.filter((p) => p.total !== null);
  if (pts.length < 2) return '<p class="cqa-muted">Для графика нужно минимум две оценки.</p>';
  const w = 560, h = 160, pad = 28;
  const x = (i) => pad + (i * (w - 2 * pad)) / (pts.length - 1);
  const y = (v) => h - pad - (v / 100) * (h - 2 * pad);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join(' ');
  const dots = pts
    .map((p, i) => `<circle cx="${x(i)}" cy="${y(p.total)}" r="4" class="${p.gross_error ? 'cqa-dot-gross' : 'cqa-dot'}"><title>${esc(p.conversation_id)}: ${fmtScore(p.total)}${p.gross_error ? ' · грубая ошибка' : ''}</title></circle>`)
    .join('');
  const grid = [0, 50, 100].map((v) => `<line x1="${pad}" x2="${w - pad}" y1="${y(v)}" y2="${y(v)}" class="cqa-grid"/><text x="4" y="${y(v) + 4}" class="cqa-axis">${v}</text>`).join('');
  return `<svg class="cqa-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Динамика итогового балла">${grid}<path d="${line}" class="cqa-line"/>${dots}</svg>`;
}
