// Блок «Дообучить модель по решениям» на экране апелляций.
// Решения проверяющих по апелляциям на критерий → POST /api/local/finetune → адаптер решающего слоя под этот критерий.
import { api } from './api.js';
import { esc } from './ui.js';

const MIN = 5;

export async function mountLocalTraining(el) {
  if (!el) return;
  let cfg;
  try { cfg = await api.config(); } catch { return; }
  if (cfg?.provider !== 'local') return;
  const resolved = await api.appeals({ status: 'resolved' }).catch(() => []);
  const groups = new Map();
  for (const a of resolved) {
    const ev = await api.evaluation(a.evaluation_id).catch(() => null);
    if (!ev) continue;
    const key = `${ev.checklist_id}::${a.criterion_id}`;
    if (!groups.has(key)) groups.set(key, { checklist_id: ev.checklist_id, criterion_id: a.criterion_id, conversations: new Set() });
    groups.get(key).conversations.add(a.conversation_id);
  }
  const rows = [];
  for (const g of groups.values()) {
    const cl = await api.checklist(g.checklist_id).catch(() => null);
    const c = cl?.criteria.find((x) => x.id === g.criterion_id);
    if (c) rows.push({ ...g, version: cl.version, name: c.name, n: g.conversations.size });
  }
  rows.sort((a, b) => b.n - a.n);
  el.className = 'cqa-card';
  el.innerHTML = `<h2>Дообучение модели</h2>
    <p class="cqa-muted">Модель ${esc(cfg.model || '')} дообучает решающий слой под критерий по решениям проверяющих (нужно ≥ ${MIN} диалогов с решением).
    Новые оценки этого критерия сразу используют дообученный вариант.</p>
    ${rows.length ? `<table class="cqa-table"><thead><tr><th>Критерий</th><th>Диалогов с решением</th><th></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${esc(r.name)}</td><td>${r.n}</td><td><button class="cqa-btn" data-i="${i}" ${r.n < MIN ? 'disabled title="Нужно минимум 5 решений"' : ''}>Дообучить модель по решениям</button></td></tr>`).join('')}
    </tbody></table>` : '<p>Пока нет рассмотренных апелляций.</p>'}
    <p class="cqa-local-train-status" role="status"></p>`;
  const status = el.querySelector('.cqa-local-train-status');
  el.querySelectorAll('button[data-i]').forEach((b) => {
    b.onclick = async () => {
      const r = rows[Number(b.dataset.i)];
      b.disabled = true;
      status.textContent = `Дообучаю «${r.name}» на ${r.n} решениях… (до минуты)`;
      try {
        const out = await api.localFinetune({ checklist_id: r.checklist_id, checklist_version: r.version, criterion_id: r.criterion_id });
        const a = out.adapter || {};
        status.textContent = `Готово: «${r.name}», ${out.examples} примеров, ${a.seconds} с; совпадение с решениями до ${Math.round((a.train_acc_before ?? 0) * 100)}% → после ${Math.round((a.train_acc_after ?? 0) * 100)}%. Переоцените диалоги, чтобы увидеть эффект.`;
      } catch (e) {
        status.textContent = `Ошибка: ${e.message}`;
      } finally {
        b.disabled = false;
      }
    };
  });
}
