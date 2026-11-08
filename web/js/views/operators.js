// Список операторов (бизнес-функция 1, обзор).
import { api } from '../api.js';
import { esc, scorePill, filterBar } from '../ui.js';

export async function render(container, params, state = {}) {
  const list = await api.operators(state);
  container.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'cqa-page-head';
  head.innerHTML = '<h1>Операторы</h1>';
  head.append(filterBar(state, (f) => render(container, params, f)));
  container.append(head);
  container.insertAdjacentHTML(
    'beforeend',
    list.length
      ? `<section class="cqa-card"><table class="cqa-table">
      <thead><tr><th>Оператор</th><th>Диалогов</th><th>Средний балл</th><th>Грубые ошибки</th><th>Самый слабый критерий</th></tr></thead>
      <tbody>${list
        .map(
          (o) => `<tr><td><a href="#/operators/${encodeURIComponent(o.name)}">${esc(o.name)}</a></td><td>${o.count}</td><td>${scorePill(o.avg_total)}</td>
          <td>${o.gross_count ? `<span class="cqa-tag cqa-tag-gross">${o.gross_count}</span>` : '0'}</td>
          <td>${o.weakest ? `${esc(o.weakest.name)} <span class="cqa-muted">(${o.weakest.avg_percent}%)</span>` : '—'}</td></tr>`,
        )
        .join('')}</tbody></table>
      <p class="cqa-muted">Имя оператора берётся из его представления в диалоге. Если оператор не представился, диалог попадает в группу «Не определён», а имя можно указать вручную в профиле.</p></section>`
      : '<p class="cqa-muted">Пока нет оценок.</p>',
  );
}
