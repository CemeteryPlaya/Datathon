// Сводка для руководителя (бизнес-функция 4).
import { economyCard } from '../economy.js';
import { api } from '../api.js';
import { esc, scorePill, fmtScore, bar, filterBar, channelLabel } from '../ui.js';

export async function render(container, params, state = {}) {
  const s = await api.summary(state);
  container.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'cqa-page-head';
  head.innerHTML = '<h1>Сводка по качеству</h1>';
  head.append(filterBar(state, (f) => render(container, params, f)));
  container.append(head);

  if (!s.count) {
    container.insertAdjacentHTML('beforeend', '<p class="cqa-muted">Пока нет оценок. Запустите оценку диалогов на экране «Диалоги».</p>');
    return;
  }

  const maxDist = Math.max(1, ...s.distribution.map((b) => b.count));
  container.insertAdjacentHTML(
    'beforeend',
    `
    <section class="cqa-tiles">
      <div class="cqa-tile"><div class="cqa-tile-label">Средний балл</div><div class="cqa-tile-value">${fmtScore(s.avg_total)}</div><div class="cqa-tile-sub">по ${s.count} диалогам${s.not_scored ? `, ${s.not_scored} не рассчитано` : ''}</div></div>
      <a class="cqa-tile ${s.gross_count ? 'cqa-tile-alert' : ''}" href="#/alerts"><div class="cqa-tile-label">Грубые ошибки</div><div class="cqa-tile-value">${s.gross_count}</div><div class="cqa-tile-sub">${s.gross_rate}% диалогов</div></a>
      <a class="cqa-tile" href="#/appeals"><div class="cqa-tile-label">Апелляции</div><div class="cqa-tile-value">${s.appeals.total}</div><div class="cqa-tile-sub">открыто ${s.appeals.open}${s.appeals.change_rate !== null ? ` · удовлетворено ${s.appeals.change_rate}%` : ''}</div></a>
      <div class="cqa-tile"><div class="cqa-tile-label">Требуют ручной проверки</div><div class="cqa-tile-value">${s.manual_review_count}</div><div class="cqa-tile-sub">модель не дала валидный ответ</div></div>
      <div class="cqa-tile"><div class="cqa-tile-label">Стоимость последних оценок</div><div class="cqa-tile-value">${s.cost.total_usd === null ? '—' : '$' + s.cost.total_usd}</div><div class="cqa-tile-sub">${s.cost.unknown_count ? 'часть стоимости неизвестна' : ''}${s.cost.avg_usd !== null ? `≈ $${s.cost.avg_usd} за диалог` : ''}</div></div>
    </section>

    ${economyCard(s.economy)}

    <div class="cqa-grid2">
      <section class="cqa-card">
        <h2>Проблемные критерии</h2>
        <p class="cqa-muted">Где команда теряет больше всего баллов, то есть чему учить в первую очередь.</p>
        ${s.problem_criteria.map((c) => `<div class="cqa-row"><span>${esc(c.name)}</span>${bar(c.avg_percent)}<span class="cqa-num">${fmtScore(c.avg_percent)}%</span></div>`).join('') || '<p class="cqa-muted">Нет данных.</p>'}
      </section>
      <section class="cqa-card">
        <h2>Распределение итогов</h2>
        ${s.distribution.map((b) => `<div class="cqa-row"><span>${b.label}</span><div class="cqa-bar"><div class="cqa-bar-fill cqa-score-neutral" style="width:${(b.count / maxDist) * 100}%"></div></div><span class="cqa-num">${b.count}</span></div>`).join('')}
      </section>
    </div>

    <div class="cqa-grid2">
      ${groupTable('По языкам', s.by_language, (k) => esc(k))}
      ${groupTable('По каналам', s.by_channel, (k) => esc(channelLabel(k)))}
    </div>

    ${groupTable('По операторам', s.by_operator, (k) => `<a href="#/operators/${encodeURIComponent(k)}">${esc(k)}</a>`)}

    <section class="cqa-card">
      <h2>Все критерии</h2>
      <table class="cqa-table">
        <thead><tr><th>Критерий</th><th>Средн. выполнение</th><th>Не выполнен</th><th>N/A</th><th>Оспорено</th><th>Изменено</th></tr></thead>
        <tbody>${s.criteria
          .map(
            (c) => `<tr><td>${esc(c.name)}${c.kind === 'gross' ? ' <span class="cqa-tag cqa-tag-gross">флаг</span>' : ''}</td>
              <td>${c.kind === 'gross' ? '—' : fmtScore(c.avg_percent) + '%'}</td>
              <td>${c.fail_rate}%</td><td>${c.na_rate}%</td><td>${c.appealed}</td><td>${c.changed}</td></tr>`,
          )
          .join('')}</tbody>
      </table>
      <p class="cqa-muted">Колонка «Изменено» показывает, сколько оценок проверяющий исправил по апелляции. Если по критерию их много, его формулировку стоит уточнить в чек-листе.</p>
    </section>`,
  );
  container.querySelector('#economy-assumptions').onsubmit = async e => {
    e.preventDefault();
    const form = e.currentTarget;
    const next = Object.fromEntries(new FormData(form));
    try { await render(container, params, { ...state, ...next }); }
    catch (error) { form.querySelector('[role=alert]').textContent = error.message; }
  };
}

function groupTable(title, rows, keyHtml) {
  return `<section class="cqa-card"><h2>${title}</h2>
    <table class="cqa-table"><thead><tr><th></th><th>Диалогов</th><th>Средний балл</th><th>Грубые ошибки</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${keyHtml(r.key)}</td><td>${r.count}</td><td>${scorePill(r.avg_total)}</td><td>${r.gross_count ? `<span class="cqa-tag cqa-tag-gross">${r.gross_count}</span>` : '0'}</td></tr>`).join('')}</tbody></table></section>`;
}
