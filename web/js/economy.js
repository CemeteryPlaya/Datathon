import { esc } from './ui.js';
const num = n => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const money = n => n === null ? 'не рассчитана' : `$${Number(n).toLocaleString('ru-RU', { maximumFractionDigits: Math.abs(n) > 0 && Math.abs(n) < 0.01 ? 6 : 2 })}`;
export function economyCard(e) {
  return `<section class="cqa-card cqa-economy" aria-labelledby="economy-title">
    <div class="cqa-page-head"><h2 id="economy-title">Экономия</h2><span class="cqa-tag">Расчётный сценарий</span></div>
    <div class="cqa-tiles">
      <div class="cqa-tile"><div class="cqa-tile-label">Часы контролёров: экономия</div><div class="cqa-tile-value" id="saved-hours">${num(e.saved_hours)} ч</div><div class="cqa-tile-sub">вручную ${num(e.human_hours)} ч → с ИИ ${num(e.review_hours)} ч</div></div>
      <div class="cqa-tile"><div class="cqa-tile-label">Человек</div><div class="cqa-tile-value">${money(e.human_cost_usd)}</div><div class="cqa-tile-sub">проверка ${e.conversations} диалогов вручную</div></div>
      <div class="cqa-tile"><div class="cqa-tile-label">ИИ + проверяющий</div><div class="cqa-tile-value" id="assisted-cost">${money(e.assisted_cost_usd)}</div><div class="cqa-tile-sub">ИИ: ${money(e.ai_cost_usd)} · ${e.attempts} оценок с повторами</div></div>
      <a class="cqa-tile ${e.risk_conversations ? 'cqa-tile-alert' : ''}" href="#/alerts"><div class="cqa-tile-label">Найденные риски</div><div class="cqa-tile-value">${e.risk_conversations}</div><div class="cqa-tile-sub">диалогов с грубыми ошибками · ${e.risk_findings} флагов после решений</div></a>
    </div>
    <p>Расчётная экономия затрат: <strong id="saved-cost">${money(e.saved_usd)}</strong>. На проверку с ИИ заложено ${e.review_conversations} диалогов: грубые ошибки, ручная проверка или апелляция; каждый учитывается один раз.</p>
    ${e.unknown_cost_attempts ? `<p class="cqa-muted">Стоимость не указана для ${e.unknown_cost_attempts} оценок. Известная часть расходов ИИ: ${money(e.known_ai_cost_usd)}. Денежная экономия появится, когда стоимость всех оценок будет известна.</p>` : ''}
    <details><summary>Допущения и формула расчёта</summary>
      <form id="economy-assumptions" class="cqa-form-grid">
        <label>Минут на диалог вручную <input class="cqa-input" name="human_minutes" type="number" min="0" max="1000000" step="any" required value="${esc(e.assumptions.human_minutes)}"></label>
        <label>Минут на проверку с ИИ <input class="cqa-input" name="review_minutes" type="number" min="0" max="1000000" step="any" required value="${esc(e.assumptions.review_minutes)}"></label>
        <label>Стоимость часа контролёра, USD <input class="cqa-input" name="hourly_usd" type="number" min="0" max="1000000" step="any" required value="${esc(e.assumptions.hourly_usd)}"></label>
        <button class="cqa-btn" type="submit">Пересчитать экономию</button><p role="alert" class="cqa-error"></p>
      </form>
      <p class="cqa-muted">Часы = число диалогов × минуты / 60. Затраты с ИИ = стоимость всех сохранённых оценок этих диалогов + часы проверки × ставка. Это оценка потенциального эффекта при заданных допущениях; время работы не замеряется. Инфраструктура и неподсчитанные неудачные вызовы не включены. Риски — флаги модели с учётом решений, денежный ущерб не оценён. Суммы в USD.</p>
    </details>
  </section>`;
}
