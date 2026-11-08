// Лента тревог о грубых ошибках (бизнес-функция 3).
import { api } from '../api.js';
import { esc, scorePill, fmtDate, channelLabel } from '../ui.js';
import { refreshAlertBadge } from '../app.js';

export async function render(container) {
  const list = await api.alerts();
  const open = list.filter((a) => !a.acked);
  container.innerHTML = `
    <div class="cqa-page-head"><h1>Тревоги: грубые ошибки</h1>
      <span class="cqa-muted">${open.length ? `${open.length} новых` : 'новых нет'}</span></div>
    ${list.length ? '' : '<p class="cqa-muted">Грубых ошибок не найдено.</p>'}
    ${list
      .map(
        (a) => `
      <article class="cqa-card cqa-alert ${a.acked ? 'cqa-alert-acked' : ''}">
        <div class="cqa-alert-head">
          <strong>${esc(a.operator)}</strong>
          <a href="#/conv/${encodeURIComponent(a.conversation_id)}">${esc(a.conversation_id)}</a>
          <span class="cqa-muted">${esc(a.language)} · ${channelLabel(a.channel)} · ${fmtDate(a.created_at)}</span>
          <span>итог ${scorePill(a.total)}</span>
        </div>
        ${a.violations
          .map(
            (v) => `<div class="cqa-violation"><span class="cqa-tag cqa-tag-gross">${esc(v.name)}</span> ${esc(v.explanation)}
            ${v.evidence.length ? `<div>Доказательство: ${v.evidence.map((i) => `<a href="#/conv/${encodeURIComponent(a.conversation_id)}?msg=${i}">реплика ${i}</a>`).join(', ')}</div>` : ''}</div>`,
          )
          .join('')}
        <div class="cqa-alert-foot">${
          a.acked
            ? `<span class="cqa-muted">Просмотрено ${fmtDate(a.acked.acked_at)}${a.acked.note ? `: ${esc(a.acked.note)}` : ''}</span>`
            : `<input class="cqa-input" placeholder="Что сделано (необязательно)" data-note="${esc(a.evaluation_id)}">
               <button class="cqa-btn" data-ack="${esc(a.evaluation_id)}">Отметить как просмотренное</button>`
        }</div>
      </article>`,
      )
      .join('')}`;

  container.querySelectorAll('[data-ack]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const note = container.querySelector(`[data-note="${btn.dataset.ack}"]`)?.value || '';
      await api.ackAlert(btn.dataset.ack, note);
      await render(container);
      refreshAlertBadge();
    }),
  );
}
