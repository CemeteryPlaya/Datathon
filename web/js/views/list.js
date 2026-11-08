// Список диалогов: фильтры, итог, грубая ошибка, выбор и пакетная оценка.
import { api } from '../api.js';
import { esc, scorePill, fmtDate, channelLabel, filterBar } from '../ui.js';
import { currentGroup, setGroup, datasetRecords, latestByConversation, checklistFor, scores } from '../evalutil.js';

// состояние экрана живёт между перерисовками (фильтры, выбор, задача оценки)
const state = { filters: {}, status: '', q: '', sort: 'id', dir: 1, selected: new Set(), job: null, checklist: '' };

export async function render(container) {
  const group = currentGroup();
  container.innerHTML = '<p class="cqa-muted">Загрузка диалогов…</p>';

  const [dsRes, evaluations, appeals, checklists] = await Promise.all([
    api.dataset(group).then((d) => ({ records: datasetRecords(d) }), (e) => ({ error: e.message, records: [] })),
    api.evaluations().catch(() => []),
    api.appeals().catch(() => []),
    api.checklists().catch(() => []),
  ]);
  const latest = latestByConversation(evaluations.filter((e) => !e.group_id || e.group_id === group));

  // Строки: записи датасета + оценённые диалоги, которых нет в загруженном датасете (если API недоступен)
  const rows = dsRes.records.map((r) => ({
    id: r.conversation_id,
    language: r.language,
    channel: r.channel,
    turns: r.transcript?.length ?? null,
    hasAudio: !!r.audio_url,
  }));
  const known = new Set(rows.map((r) => r.id));
  for (const ev of latest.values()) {
    if (!known.has(ev.conversation_id)) rows.push({ id: ev.conversation_id, language: ev.language, channel: ev.channel, turns: null });
  }
  await Promise.all(
    rows.map(async (row) => {
      const ev = latest.get(row.id);
      if (!ev) return;
      const s = scores(ev, await checklistFor(ev.checklist_id, ev.checklist_version), appeals);
      Object.assign(row, {
        ev,
        operator: ev.operator_name,
        total: s.final?.total ?? null,
        original: s.original?.total ?? null,
        changed: s.changed,
        gross: !!s.final?.gross_error,
        manual: (s.final?.pending_manual || []).length,
        unsure: s.unsure.length,
        openAppeals: s.appeals.filter((a) => a.status === 'open').length,
      });
    }),
  );

  if (!state.checklist && checklists.length) state.checklist = (checklists.find((c) => c.id === 'default') || checklists[0]).id;

  const draw = () => {
    const visible = applyFilters(rows);
    const base = applyFilters(rows, true); // для счётчиков на чипах статуса
    container.innerHTML = `
      <div class="cqa-page-head">
        <h1>Диалоги</h1>
        <form class="cqa-filters" id="cqa-group-form">
          <label>group_id <input class="cqa-input cqa-input-short" name="group" value="${esc(group)}"></label>
          <button class="cqa-btn cqa-btn-small" type="submit">Загрузить</button>
          <button class="cqa-btn cqa-btn-small" type="button" id="cqa-refresh" title="Заново скачать набор из API организаторов">Обновить из API</button>
        </form>
      </div>
      ${dsRes.error ? `<p class="cqa-error">Набор ${esc(group)} не загрузился: ${esc(dsRes.error)}. Показаны только уже оценённые диалоги.</p>` : ''}
      <div class="cqa-card cqa-toolbar">
        <div id="cqa-filterbar"></div>
        <input class="cqa-input" id="cqa-q" placeholder="Поиск по ID или оператору" value="${esc(state.q)}">
        <span class="cqa-spacer"></span>
        <label class="cqa-filters">Чек-лист <select id="cqa-checklist">${checklists
          .map((c) => `<option value="${esc(c.id)}" ${c.id === state.checklist ? 'selected' : ''}>${esc(c.name)} · v${c.version}</option>`)
          .join('')}</select></label>
        <button class="cqa-btn" id="cqa-eval-selected" ${state.selected.size && !state.job ? '' : 'disabled'}>Оценить выбранные (${state.selected.size})</button>
        <button class="cqa-btn cqa-btn-ghost" id="cqa-eval-all" ${state.job || !rows.length ? 'disabled' : ''} title="Оценить весь набор ${esc(group)}">Оценить все</button>
      </div>
      <div id="cqa-job"></div>
      <div class="cqa-card">
        <div class="cqa-chips" role="group" aria-label="Статус">${STATUSES.map(([key, label]) => {
          const n = base.filter((r) => matchStatus(r, key)).length;
          return `<button class="cqa-chip ${state.status === key ? 'cqa-chip-on' : ''} ${key === 'gross' && n ? 'cqa-chip-bad' : ''} ${key === 'unsure' && n ? 'cqa-chip-warn' : ''}"
            data-status="${key}">${label}<span class="cqa-chip-n">${n}</span></button>`;
        }).join('')}</div>
        <p class="cqa-muted">Показано ${visible.length} из ${rows.length}</p>
        ${visible.length ? table(visible) : '<p class="cqa-muted">Нет диалогов под фильтр.</p>'}
      </div>`;

    container.querySelector('#cqa-filterbar').replaceWith(filterBar(state.filters, (f) => { state.filters = f; draw(); }));
    container.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => { state.status = b.dataset.status; draw(); }));
    const q = container.querySelector('#cqa-q');
    q.addEventListener('input', () => {
      state.q = q.value;
      const pos = q.selectionStart;
      draw();
      const nq = container.querySelector('#cqa-q');
      nq.focus();
      nq.setSelectionRange(pos, pos);
    });
    container.querySelector('#cqa-checklist')?.addEventListener('change', (e) => { state.checklist = e.target.value; });

    container.querySelector('#cqa-group-form').addEventListener('submit', (e) => {
      e.preventDefault();
      setGroup(e.target.group.value);
      state.selected.clear();
      render(container);
    });
    container.querySelector('#cqa-refresh').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Загрузка…';
      try {
        await api.dataset(group, true);
      } catch (err) {
        alert(`Не удалось обновить: ${err.message}`);
      }
      render(container);
    });

    container.querySelectorAll('th[data-sort]').forEach((th) =>
      th.addEventListener('click', () => {
        state.dir = state.sort === th.dataset.sort ? -state.dir : 1;
        state.sort = th.dataset.sort;
        draw();
      }),
    );
    container.querySelector('#cqa-check-all')?.addEventListener('change', (e) => {
      for (const r of visible) e.target.checked ? state.selected.add(r.id) : state.selected.delete(r.id);
      draw();
    });
    container.querySelectorAll('input[data-select]').forEach((cb) =>
      cb.addEventListener('change', () => {
        cb.checked ? state.selected.add(cb.dataset.select) : state.selected.delete(cb.dataset.select);
        const btn = container.querySelector('#cqa-eval-selected');
        btn.textContent = `Оценить выбранные (${state.selected.size})`;
        btn.disabled = !state.selected.size || !!state.job;
      }),
    );
    container.querySelector('#cqa-eval-selected').addEventListener('click', () => startEvaluation(container, group, [...state.selected]));
    container.querySelector('#cqa-eval-all').addEventListener('click', () => {
      if (confirm(`Оценить все ${rows.length} диалогов набора ${group}? Это платные вызовы модели.`)) startEvaluation(container, group, 'all');
    });
    if (state.job) drawJob(container);
  };
  draw();
}

const STATUSES = [
  ['', 'Все'], ['new', 'Не оценены'], ['gross', 'Грубые ошибки'], ['unsure', 'Проверить'],
  ['manual', 'Ручная проверка'], ['appeal', 'Апелляции'],
];

function matchStatus(r, key) {
  switch (key) {
    case 'new': return !r.ev;
    case 'done': return !!r.ev;
    case 'gross': return r.gross;
    case 'unsure': return r.unsure > 0;
    case 'manual': return r.manual > 0;
    case 'appeal': return r.openAppeals > 0 || r.changed;
    default: return true;
  }
}

function applyFilters(rows, ignoreStatus = false) {
  const q = state.q.trim().toLowerCase();
  const f = state.filters;
  const out = rows.filter((r) => {
    if (f.language && r.language !== f.language) return false;
    if (f.channel && r.channel !== f.channel) return false;
    if (q && !r.id.toLowerCase().includes(q) && !(r.operator || '').toLowerCase().includes(q)) return false;
    return ignoreStatus || matchStatus(r, state.status);
  });
  const key = state.sort;
  const val = (r) => (key === 'total' ? (r.total ?? -1) : key === 'date' ? (r.ev?.created_at || '') : key === 'turns' ? (r.turns ?? -1) : String(r[key] ?? ''));
  return out.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * state.dir);
}

function table(rows) {
  const th = (key, label, cls = '') => `<th data-sort="${key}" class="cqa-sortable ${cls}">${label}${state.sort === key ? (state.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  const allChecked = rows.every((r) => state.selected.has(r.id));
  return `<table class="cqa-table cqa-list">
    <thead><tr>
      <th><input type="checkbox" id="cqa-check-all" ${allChecked ? 'checked' : ''} title="Выбрать все показанные"></th>
      ${th('id', 'Диалог')}${th('language', 'Язык')}${th('channel', 'Канал')}${th('turns', 'Реплик', 'cqa-num')}
      ${th('operator', 'Оператор')}${th('total', 'Итог', 'cqa-num')}<th>Флаги</th>${th('date', 'Оценён')}
    </tr></thead>
    <tbody>${rows
      .map((r) => {
        const href = `#/conv/${encodeURIComponent(r.id)}`;
        const flags = [
          r.gross ? '<span class="cqa-tag cqa-tag-gross">грубая ошибка</span>' : '',
          r.unsure ? `<span class="cqa-tag cqa-tag-unsure" title="Критериев, где модель не уверена (< 75%)">проверить: ${r.unsure}</span>` : '',
          r.manual ? `<span class="cqa-tag cqa-tag-manual" title="Критериев без валидного ответа модели">ручная: ${r.manual}</span>` : '',
          r.openAppeals ? `<span class="cqa-tag cqa-tag-appeal">апелляция: ${r.openAppeals}</span>` : '',
          r.changed ? `<span class="cqa-tag cqa-tag-changed" title="Исходный итог ${r.original ?? '—'}">изменён</span>` : '',
        ].join(' ');
        return `<tr class="${r.gross ? 'cqa-row-gross' : ''}">
          <td><input type="checkbox" data-select="${esc(r.id)}" ${state.selected.has(r.id) ? 'checked' : ''}></td>
          <td><a href="${href}">${esc(r.id)}</a>${r.hasAudio ? ' <span title="Есть аудиозапись">🎧</span>' : ''}</td>
          <td>${esc(r.language || '—')}</td>
          <td>${channelLabel(r.channel)}</td>
          <td class="cqa-num">${r.turns ?? '—'}</td>
          <td>${r.ev ? esc(r.operator || 'Не определён') : '<span class="cqa-muted">—</span>'}</td>
          <td class="cqa-num">${r.ev ? scorePill(r.total) : '<span class="cqa-muted">не оценён</span>'}</td>
          <td>${flags}</td>
          <td class="cqa-muted">${r.ev ? `${fmtDate(r.ev.created_at)} · v${r.ev.checklist_version}` : ''}</td>
        </tr>`;
      })
      .join('')}</tbody></table>`;
}

// ---------- пакетная оценка с прогрессом ----------
async function startEvaluation(container, group, ids) {
  state.job = { status: 'starting', done: 0, total: ids === 'all' ? null : ids.length, errors: [] };
  drawJob(container);
  container.querySelectorAll('#cqa-eval-selected, #cqa-eval-all').forEach((b) => (b.disabled = true));
  try {
    const res = await api.evaluate({ conversation_ids: ids, group_id: group, checklist_id: state.checklist });
    const jobId = res.job_id || res.id || res.job?.id;
    if (!jobId) {
      // синхронный ответ без задачи — сразу готово
      state.job = { status: 'done', ...normalizeJob(res) };
      return finish(container);
    }
    state.job = { id: jobId, status: 'running', ...normalizeJob(res.job || res) };
    drawJob(container);
    poll(container, jobId);
  } catch (e) {
    state.job = { status: 'error', error: e.message, done: 0, total: 0, errors: [] };
    drawJob(container);
    setTimeout(() => { state.job = null; render(container); }, 4000);
  }
}

function normalizeJob(j = {}) {
  const p = j.progress || {};
  return {
    done: j.done ?? j.completed ?? p.done ?? 0,
    total: j.total ?? p.total ?? null,
    failed: j.failed ?? p.failed ?? (j.errors || []).length,
    errors: j.errors || [],
    cost: j.cost_usd ?? null,
  };
}

async function poll(container, jobId) {
  if (!state.job || state.job.id !== jobId) return; // опрос идёт и при уходе с экрана
  try {
    const j = await api.job(jobId);
    state.job = { id: jobId, status: j.status || 'running', ...normalizeJob(j) };
    if (['done', 'finished', 'completed', 'error', 'failed'].includes(state.job.status)) return finish(container);
    drawJob(container);
  } catch (e) {
    state.job.warning = e.message;
    drawJob(container);
  }
  setTimeout(() => poll(container, jobId), 1500);
}

function finish(container) {
  const job = state.job;
  state.selected.clear();
  // перерисовать таблицу с новыми оценками, итог задачи оставить видимым
  state.job = null;
  if (!location.hash.startsWith('#/list')) return;
  render(container).then(() => {
    const el = container.querySelector('#cqa-job');
    if (!el) return;
    el.innerHTML = `<div class="cqa-card cqa-job cqa-job-done">Оценка завершена: ${job.done}${job.total ? ` из ${job.total}` : ''}${
      job.failed ? `, с ошибкой ${job.failed}` : ''}${job.cost !== null && job.cost !== undefined ? ` · стоимость $${Number(job.cost).toFixed(4)}` : ''}
      ${errorList(job.errors)}</div>`;
  });
}

const errorList = (errors) =>
  errors?.length
    ? `<details><summary>Ошибки (${errors.length})</summary><ul>${errors
        .map((e) => `<li>${esc(typeof e === 'string' ? e : `${e.conversation_id || ''}: ${e.error || e.message || JSON.stringify(e)}`)}</li>`)
        .join('')}</ul></details>`
    : '';

function drawJob(container) {
  const el = container.querySelector('#cqa-job');
  const j = state.job;
  if (!el || !j) return;
  if (j.status === 'error') {
    el.innerHTML = `<div class="cqa-card cqa-job"><span class="cqa-error">Оценка не запустилась: ${esc(j.error)}</span></div>`;
    return;
  }
  const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
  el.innerHTML = `<div class="cqa-card cqa-job">
    <div>Оценка идёт: ${j.done}${j.total ? ` из ${j.total}` : ''}${j.failed ? ` · ошибок ${j.failed}` : ''}${j.warning ? ` <span class="cqa-muted">(${esc(j.warning)})</span>` : ''}</div>
    <div class="cqa-bar"><div class="cqa-bar-fill cqa-score-good" style="width:${pct}%"></div></div>
    ${errorList(j.errors)}</div>`;
}
