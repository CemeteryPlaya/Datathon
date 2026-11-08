// Профиль оператора (бизнес-функция 1).
import { api } from '../api.js';
import { esc, scorePill, fmtScore, bar, trendChart, channelLabel } from '../ui.js';

export async function render(container, { name }) {
  let p;
  try {
    p = await api.operator(name);
  } catch {
    container.innerHTML = `<p class="cqa-muted">Нет оценок для оператора «${esc(name)}». <a href="#/operators">К списку</a></p>`;
    return;
  }
  const diff = p.avg_total !== null && p.team_avg_total !== null ? p.avg_total - p.team_avg_total : null;
  container.innerHTML = `
    <div class="cqa-page-head"><h1><a href="#/operators" class="cqa-back">Операторы</a> / ${esc(p.name)}</h1></div>
    <section class="cqa-tiles">
      <div class="cqa-tile"><div class="cqa-tile-label">Средний балл</div><div class="cqa-tile-value">${fmtScore(p.avg_total)}</div>
        <div class="cqa-tile-sub">команда ${fmtScore(p.team_avg_total)}${diff !== null ? ` · <span class="${diff >= 0 ? 'cqa-up' : 'cqa-down'}">${diff >= 0 ? '+' : ''}${diff.toFixed(1)}</span>` : ''}</div></div>
      <div class="cqa-tile"><div class="cqa-tile-label">Диалогов</div><div class="cqa-tile-value">${p.count}</div></div>
      <div class="cqa-tile ${p.gross_count ? 'cqa-tile-alert' : ''}"><div class="cqa-tile-label">Грубые ошибки</div><div class="cqa-tile-value">${p.gross_count}</div></div>
    </section>

    <div class="cqa-grid2">
      <section class="cqa-card"><h2>Динамика</h2>${trendChart(p.trend)}</section>
      <section class="cqa-card"><h2>Над чем работать</h2>
        ${p.weak_criteria.length ? p.weak_criteria.map((c) => `<div class="cqa-row"><span>${esc(c.name)}</span>${bar(c.avg_percent)}<span class="cqa-num">${fmtScore(c.avg_percent)}%</span></div>`).join('') : '<p class="cqa-muted">Все критерии выполнены полностью.</p>'}
      </section>
    </div>

    <section class="cqa-card" aria-labelledby="coaching-title"><h2 id="coaching-title">Коучинг: план улучшения</h2>
      <p class="cqa-muted">До трёх приоритетов по последним оценкам диалогов с учётом решений по апелляциям. Сначала грубые нарушения, затем потери по весу критерия. План составлен по правилам чек-листа.</p>
      ${p.coaching.length ? p.coaching.map((c,i) => `<article class="cqa-coaching-item">
        <h3>${i+1}. ${esc(c.name)} ${c.gross ? '<span class="cqa-tag cqa-tag-gross">риск</span>' : ''}</h3>
        <p>Случаев для разбора: ${c.failed}. <strong>Практика:</strong> ${esc(c.exercise)}</p>
        <p><strong>Цель:</strong> ${esc(c.target)}</p>
        ${c.examples.map(example => {
          const query = new URLSearchParams({ ev: example.evaluation_id, ...(example.group_id ? {group:example.group_id} : {}), ...(Number.isInteger(example.evidence[0]) ? {msg:example.evidence[0]} : {}) });
          return `<div class="cqa-coaching-example"><a href="#/conv/${encodeURIComponent(example.conversation_id)}?${esc(query)}">Разобрать ${esc(example.conversation_id)} · v${example.checklist_version}</a><p>${esc(example.explanation || 'Откройте оценку для разбора ответа.')}</p><p class="cqa-muted">Правило этой версии: ${esc(example.rule)}</p></div>`;
        }).join('')}
      </article>`).join('') : '<p>Подтверждённых оценкой отклонений нет. Разберите с наставником один успешный диалог; ответы N/A и ручная проверка не считаются ошибками.</p>'}
    </section>

    <section class="cqa-card"><h2>По критериям</h2>
      <p class="cqa-muted">Полоса показывает выполнение критерия оператором, риска — среднее по команде.</p>
      ${p.criteria
        .filter((c) => c.kind !== 'gross')
        .map((c) => `<div class="cqa-row"><span>${esc(c.name)}</span>${bar(c.avg_percent, c.team_avg_percent)}<span class="cqa-num">${c.avg_percent === null ? 'N/A' : fmtScore(c.avg_percent) + '%'}</span></div>`)
        .join('')}
    </section>

    <section class="cqa-card"><h2>Диалоги</h2>
      <table class="cqa-table"><thead><tr><th>Диалог</th><th>Язык</th><th>Канал</th><th>Итог</th><th></th><th>Оператор</th></tr></thead>
      <tbody>${p.conversations
        .map(
          (c) => `<tr><td><a href="#/conv/${encodeURIComponent(c.conversation_id)}">${esc(c.conversation_id)}</a></td><td>${esc(c.language)}</td><td>${channelLabel(c.channel)}</td>
          <td>${scorePill(c.total)}</td><td>${c.gross_error ? '<span class="cqa-tag cqa-tag-gross">грубая ошибка</span>' : ''}</td>
          <td><button class="cqa-btn cqa-btn-small" data-rename="${esc(c.conversation_id)}">Изменить</button></td></tr>`,
        )
        .join('')}</tbody></table>
    </section>`;

  container.querySelectorAll('[data-rename]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const v = prompt('Имя оператора для диалога ' + btn.dataset.rename + ' (пусто — вернуть определённое моделью):', p.name);
      if (v === null) return;
      await api.setOperator(btn.dataset.rename, v);
      const next = v.trim() || name;
      if (next !== name && p.count === 1) location.hash = `#/operators/${encodeURIComponent(next)}`;
      else render(container, { name });
    }),
  );
}
