// Редактор чек-листа: компактный список критериев, один раскрытый редактор, шаблоны,
// ошибки рядом с полем, предпросмотр изменений и переоценка диалогов по новой версии.
import { api } from '../api.js';
import { esc, fmtDate } from '../ui.js';
import { currentGroup } from '../evalutil.js';
import { KINDS, kindOf, applyKind, newCriterion, problems, normalize, weightShares, diff, SCALE_PRESETS, presetLevels } from '../checklist-model.js';

// Состояние живёт в модуле: черновик не теряется при переходе на другой экран и обратно.
const S = { versions: [], base: null, draft: null, open: null, picker: false, review: false, saved: null, job: null, error: '', touched: new Set() };
const COLORS = ['#2f6fde', '#1f9d5b', '#d99a1c', '#8a5cd6', '#e0607e', '#1aa3a3', '#c4793a', '#5b7290', '#6aa84f', '#b04fbf'];

const key = (c) => `${c.id}@${c.version}`;
const dirty = () => S.draft && S.base && !diff(S.base, normalize(S.draft)).empty;

export async function render(root) {
  const versions = await api.checklistsAll().catch(() => api.checklists(true));
  S.versions = versions.sort((a, b) => (a.id === b.id ? a.version - b.version : a.id < b.id ? -1 : 1));
  const latest = S.versions.filter((v) => v.id === (S.base?.id || 'default')).at(-1) || S.versions.at(-1);
  if (!S.base || !S.versions.some((v) => key(v) === key(S.base))) load(latest);
  draw(root);
}

function load(version) {
  S.base = structuredClone(version);
  S.draft = structuredClone(version);
  S.open = null; S.picker = false; S.review = false; S.error = ''; S.touched = new Set();
}

function draw(root) {
  const d = S.draft;
  const pr = problems(d);
  const shares = weightShares(d);
  const latestOfId = S.versions.filter((v) => v.id === d.id).at(-1);
  const isOld = latestOfId && latestOfId.version !== S.base.version;
  const changed = dirty();

  root.innerHTML = `
  <div class="cqa-page-head">
    <h1>Чек-лист</h1>
    <div class="cqa-cl-actions">
      <label class="cqa-muted">Версия
        <select class="cqa-input" id="cl-version">${S.versions.map((v) => `<option value="${esc(key(v))}" ${key(v) === key(S.base) ? 'selected' : ''}>${esc(v.name)} · v${v.version}${v.created_at ? ' · ' + esc(fmtDate(v.created_at)) : ''}</option>`).join('')}</select>
      </label>
      ${changed ? '<button class="cqa-btn cqa-btn-small" id="cl-reset" type="button">Отменить изменения</button>' : ''}
      <button class="cqa-btn" id="cl-save" type="button" ${!changed || pr.count ? 'disabled' : ''}>Сохранить как v${(latestOfId?.version || 0) + 1}</button>
    </div>
  </div>

  ${S.saved ? savedPanel() : ''}
  ${isOld ? `<div class="cqa-cl-note">Вы смотрите старую версию v${S.base.version}. При сохранении она станет новой версией v${latestOfId.version + 1}.</div>` : ''}
  ${changed && pr.count ? `<div class="cqa-cl-note cqa-cl-note-bad">Чтобы сохранить, исправьте: ${pr.count} ${plural(pr.count, 'проблему', 'проблемы', 'проблем')}. ${pr.global.map(esc).join(' ')} ${Object.keys(pr.byIndex).length ? 'Критерии с проблемами отмечены красной точкой.' : ''}</div>` : ''}
  ${changed && !pr.count ? '<div class="cqa-cl-note">Есть несохранённые изменения. Нажмите «Сохранить» — откроется сравнение с текущей версией.</div>' : ''}

  <section class="cqa-card">
    <label class="cqa-cl-title">Название чек-листа <input class="cqa-input" id="cl-name" value="${esc(d.name)}"></label>
    <div class="cqa-cl-weights" title="Сколько процентов итога даёт каждый критерий, если все применимы">
      ${d.criteria.map((c, i) => (shares[i] ? `<span style="flex:${shares[i]};background:${COLORS[i % COLORS.length]}" title="${esc(c.name || 'без названия')}: ${shares[i]}%"></span>` : '')).join('')}
    </div>
    <div class="cqa-muted">Полоса — вклад критериев в итог (100%). Если критерий получил N/A, его вес делится между остальными.</div>
  </section>

  ${S.review ? reviewPanel() : ''}

  ${d.sections.map((s) => sectionBlock(s, pr, shares)).join('')}

  <div class="cqa-cl-bottom">
    <button class="cqa-btn" id="cl-add" type="button">+ Добавить критерий</button>
    <button class="cqa-btn cqa-btn-small" id="cl-add-section" type="button">+ Секция</button>
  </div>
  ${S.picker ? pickerPanel() : ''}`;

  bind(root);
}

function sectionBlock(s, pr, shares) {
  const d = S.draft;
  const items = d.criteria.map((c, i) => [c, i]).filter(([c]) => c.section === s.id);
  const sectionShare = items.reduce((a, [, i]) => a + shares[i], 0);
  return `<section class="cqa-card cqa-cl-section">
    <div class="cqa-cl-section-head">
      <input class="cqa-cl-section-name" data-section="${esc(s.id)}" value="${esc(s.name)}" aria-label="Название секции">
      <span class="cqa-muted">${items.length} ${plural(items.length, 'критерий', 'критерия', 'критериев')} · ${Math.round(sectionShare)}% итога</span>
      ${items.length ? '' : `<button class="cqa-btn cqa-btn-small" data-del-section="${esc(s.id)}" type="button">Удалить секцию</button>`}
    </div>
    ${items.length ? items.map(([c, i]) => row(c, i, pr, shares)).join('') : '<p class="cqa-muted">Пустая секция. Добавьте критерий и выберите эту секцию.</p>'}
  </section>`;
}

function row(c, i, pr, shares) {
  const k = kindOf(c);
  const bad = pr.byIndex[i];
  const isNew = !S.base.criteria.some((b) => b.id === c.id);
  const open = S.open === i;
  return `<div class="cqa-cl-item ${open ? 'cqa-cl-open' : ''}">
    <button class="cqa-cl-row" data-toggle="${i}" type="button" aria-expanded="${open}">
      <span class="cqa-cl-dot" style="background:${COLORS[i % COLORS.length]}"></span>
      <span class="cqa-cl-name">${esc(c.name || 'Новый критерий')}${isNew ? ' <span class="cqa-tag cqa-tag-new">новый</span>' : ''}${bad ? ' <span class="cqa-cl-bad" title="Есть незаполненные поля">●</span>' : ''}</span>
      <span class="cqa-tag cqa-cl-kind-${k}">${KINDS[k].icon} ${KINDS[k].label}</span>
      ${c.na_allowed ? '<span class="cqa-tag">может быть N/A</span>' : '<span></span>'}
      <span class="cqa-cl-share">${k === 'gross' ? 'флаг' : `${shares[i]}%`}</span>
      <span class="cqa-cl-chevron">${open ? '▴' : '▾'}</span>
    </button>
    ${open ? editor(c, i, bad) : ''}
  </div>`;
}

function editor(c, i, bad) {
  const k = kindOf(c);
  const d = S.draft;
  const violation = k === 'penalty' || k === 'gross';
  return `<div class="cqa-cl-editor" data-index="${i}">
    ${bad ? `<ul class="cqa-cl-problems">${bad.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
    <label class="cqa-cl-field">Что проверяем
      <input class="cqa-input" data-f="name" value="${esc(c.name)}" placeholder="Например: Оператор не чихал в трубку">
    </label>
    <label class="cqa-cl-field">${violation ? 'Что считается нарушением' : 'Как понять, что требование выполнено'}
      <textarea class="cqa-input" data-f="description" rows="3" placeholder="${violation ? 'Опишите поведение, которое считается нарушением. Модель читает этот текст.' : 'Опишите, что должен сделать оператор. Модель читает этот текст.'}">${esc(c.description)}</textarea>
      <span class="cqa-muted">Пишите так, как объясняли бы новому контролёру: модель оценивает именно по этому тексту.</span>
    </label>

    <div class="cqa-cl-field">Тип ответа
      <div class="cqa-cl-kinds">${Object.entries(KINDS).map(([id, x]) => `<button type="button" class="cqa-cl-kind ${id === k ? 'cqa-cl-kind-on' : ''}" data-kind="${id}"><b>${x.icon} ${x.label}</b><span>${x.hint}</span></button>`).join('')}</div>
    </div>

    ${c.type === 'scale' ? levelsEditor(c) : ''}

    <div class="cqa-cl-grid">
      ${k === 'gross' ? '<div class="cqa-cl-field"><span>Вес</span><span class="cqa-muted">Грубая ошибка не влияет на балл: это отдельный флаг.</span></div>' : `<label class="cqa-cl-field">Вес <input class="cqa-input" data-f="weight" type="number" min="0" step="1" value="${esc(c.weight)}"><span class="cqa-muted">≈ ${weightShares(d)[i]}% итога</span></label>`}
      <label class="cqa-cl-field">Секция <select class="cqa-input" data-f="section">${d.sections.map((s) => `<option value="${esc(s.id)}" ${s.id === c.section ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    </div>

    <label class="cqa-cl-switch"><input type="checkbox" data-f="na_allowed" ${c.na_allowed ? 'checked' : ''}> Критерий может не подходить к диалогу (N/A)</label>
    ${c.na_allowed ? `<label class="cqa-cl-field">Когда критерий не подходит
      <input class="cqa-input" data-f="na_condition" value="${esc(c.na_condition)}" placeholder="Например: клиент ушёл до ответа оператора"></label>` : ''}

    <div class="cqa-cl-editor-foot">
      <span class="cqa-muted">ID: ${esc(c.id)}</span>
      <button type="button" class="cqa-btn cqa-btn-small" data-dup="${i}">Дублировать</button>
      <button type="button" class="cqa-btn cqa-btn-small cqa-btn-danger" data-del="${i}">Удалить критерий</button>
      <button type="button" class="cqa-btn cqa-btn-small" data-toggle="${i}">Свернуть</button>
    </div>
  </div>`;
}

function levelsEditor(c) {
  return `<div class="cqa-cl-field">Ступени шкалы
    <table class="cqa-cl-levels"><thead><tr><th>Балл</th><th>Когда ставить</th><th></th></tr></thead><tbody>
    ${c.levels.map((l, j) => `<tr><td><input class="cqa-input" type="number" min="0" data-level="${j}" data-lf="value" value="${esc(l.value)}"></td>
      <td><input class="cqa-input" data-level="${j}" data-lf="description" value="${esc(l.description)}" placeholder="Описание ступени"></td>
      <td><button type="button" class="cqa-btn cqa-btn-small" data-level-del="${j}" ${c.levels.length <= 2 ? 'disabled' : ''} title="Удалить ступень">✕</button></td></tr>`).join('')}
    </tbody></table>
    <div class="cqa-cl-presets"><button type="button" class="cqa-btn cqa-btn-small" data-level-add>+ ступень</button>
      <span class="cqa-muted">Готовые:</span>${Object.keys(SCALE_PRESETS).map((p) => `<button type="button" class="cqa-btn cqa-btn-small" data-preset="${esc(p)}">${esc(p)}</button>`).join('')}</div>
    <span class="cqa-muted">Балл критерия = ступень ÷ максимальная ступень × вес.</span>
  </div>`;
}

function pickerPanel() {
  return `<div class="cqa-card cqa-cl-picker"><h2>Какой критерий добавить?</h2>
    <div class="cqa-cl-kinds">${Object.entries(KINDS).map(([id, x]) => `<button type="button" class="cqa-cl-kind" data-new="${id}"><b>${x.icon} ${x.label}</b><span>${x.hint}</span></button>`).join('')}</div>
    <button type="button" class="cqa-btn cqa-btn-small" id="cl-picker-close">Отмена</button></div>`;
}

function reviewPanel() {
  const df = diff(S.base, normalize(S.draft));
  const li = (c) => `<li>${esc(c.name)}</li>`;
  return `<section class="cqa-card cqa-cl-review"><h2>Что изменится в новой версии</h2>
    ${df.renamed ? `<p>Название: «${esc(S.base.name)}» → «${esc(S.draft.name)}»</p>` : ''}
    ${df.added.length ? `<p class="cqa-up">Добавлено:</p><ul>${df.added.map(li).join('')}</ul>` : ''}
    ${df.removed.length ? `<p class="cqa-down">Удалено:</p><ul>${df.removed.map(li).join('')}</ul>` : ''}
    ${df.changed.length ? `<p>Изменено:</p><ul>${df.changed.map((x) => `<li>${esc(x.criterion.name)} <span class="cqa-muted">(${x.fields.join(', ')})</span></li>`).join('')}</ul>` : ''}
    ${df.sections ? '<p>Изменены секции.</p>' : ''}
    <p class="cqa-muted">Старые оценки останутся на прежней версии. Чтобы увидеть новый чек-лист в оценках, после сохранения переоцените диалоги.</p>
    ${S.error ? `<p class="cqa-error">${esc(S.error)}</p>` : ''}
    <div class="cqa-cl-bottom"><button class="cqa-btn" id="cl-confirm" type="button">Сохранить</button><button class="cqa-btn cqa-btn-small" id="cl-review-close" type="button">Вернуться к редактированию</button></div>
  </section>`;
}

function savedPanel() {
  const v = S.saved;
  const j = S.job;
  let body;
  if (!j) {
    body = `<div class="cqa-cl-bottom">
      <button class="cqa-btn" data-reeval="evaluated" type="button">Переоценить уже оценённые диалоги по v${v.version}</button>
      <button class="cqa-btn cqa-btn-small" data-reeval="all" type="button">Переоценить весь набор ${esc(currentGroup())}</button>
      <a class="cqa-btn cqa-btn-small" href="#/list">Открыть диалоги</a>
      <button class="cqa-btn cqa-btn-small" id="cl-saved-close" type="button">Закрыть</button></div>`;
  } else if (j.status === 'running' || j.status === 'starting') {
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    body = `<div>Переоценка: ${j.done || 0} из ${j.total || '…'}${j.failed ? ` · ошибок ${j.failed}` : ''}</div><div class="cqa-bar"><div class="cqa-bar-fill cqa-score-good" style="width:${pct}%"></div></div>`;
  } else if (j.status === 'error' && !j.total) {
    body = `<p class="cqa-error">Не удалось запустить переоценку: ${esc(j.error || '')}</p><button class="cqa-btn cqa-btn-small" id="cl-saved-close" type="button">Закрыть</button>`;
  } else {
    body = `<p>Готово: переоценено ${j.done - (j.failed || 0)} из ${j.total}${j.failed ? `, ошибок ${j.failed}` : ''}. <a href="#/list">Открыть диалоги</a></p><button class="cqa-btn cqa-btn-small" id="cl-saved-close" type="button">Закрыть</button>`;
  }
  return `<section class="cqa-card cqa-cl-saved"><h2>Сохранена версия v${v.version}</h2>${body}</section>`;
}

// ---------- события ----------
function bind(root) {
  const d = S.draft;
  const redraw = () => draw(root);
  const $ = (s) => root.querySelector(s);

  $('#cl-version').onchange = (e) => {
    if (dirty() && !confirm('Несохранённые изменения пропадут. Переключить версию?')) { e.target.value = key(S.base); return; }
    load(S.versions.find((v) => key(v) === e.target.value)); S.saved = null; redraw();
  };
  $('#cl-reset') && ($('#cl-reset').onclick = () => { if (confirm('Отменить все несохранённые изменения?')) { load(S.base); redraw(); } });
  $('#cl-name').oninput = (e) => { d.name = e.target.value; refreshHeader(root); };
  $('#cl-save').onclick = () => { S.review = true; S.open = null; S.error = ''; redraw(); root.querySelector('.cqa-cl-review')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $('#cl-review-close') && ($('#cl-review-close').onclick = () => { S.review = false; redraw(); });
  $('#cl-confirm') && ($('#cl-confirm').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const saved = await api.saveChecklist(normalize(d));
      S.versions.push(saved); load(saved); S.saved = saved; S.job = null; redraw();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) { S.error = err.message; e.target.disabled = false; redraw(); }
  });
  $('#cl-add').onclick = () => { S.picker = true; redraw(); root.querySelector('.cqa-cl-picker')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $('#cl-picker-close') && ($('#cl-picker-close').onclick = () => { S.picker = false; redraw(); });
  $('#cl-add-section').onclick = () => {
    const name = prompt('Название новой секции');
    if (!name?.trim()) return;
    let n = d.sections.length + 1; while (d.sections.some((s) => s.id === `s${n}`)) n++;
    d.sections.push({ id: `s${n}`, name: name.trim() }); redraw();
  };
  $('#cl-saved-close') && ($('#cl-saved-close').onclick = () => { S.saved = null; S.job = null; redraw(); });
  root.querySelectorAll('[data-reeval]').forEach((b) => (b.onclick = () => reevaluate(root, b.dataset.reeval)));

  root.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => {
    const c = newCriterion(b.dataset.new, d);
    d.criteria.push(c); S.picker = false; S.open = d.criteria.length - 1; redraw();
    const input = root.querySelector('.cqa-cl-editor [data-f="name"]');
    input?.scrollIntoView({ behavior: 'smooth', block: 'center' }); input?.focus();
  }));
  root.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = () => { const i = Number(b.dataset.toggle); S.open = S.open === i ? null : i; redraw(); }));
  root.querySelectorAll('.cqa-cl-section-name').forEach((inp) => (inp.oninput = () => { d.sections.find((s) => s.id === inp.dataset.section).name = inp.value; refreshHeader(root); }));
  root.querySelectorAll('[data-del-section]').forEach((b) => (b.onclick = () => { d.sections = d.sections.filter((s) => s.id !== b.dataset.delSection); redraw(); }));

  const ed = root.querySelector('.cqa-cl-editor');
  if (!ed) return;
  const i = Number(ed.dataset.index);
  const c = () => d.criteria[i];
  ed.querySelectorAll('[data-f]').forEach((el) => {
    const f = el.dataset.f;
    const rerenderOn = ['section', 'na_allowed'].includes(f);
    el[el.tagName === 'SELECT' || el.type === 'checkbox' ? 'onchange' : 'oninput'] = () => {
      c()[f] = el.type === 'checkbox' ? el.checked : f === 'weight' ? (el.value === '' ? '' : Number(el.value)) : el.value;
      if (rerenderOn) { if (f === 'section') S.open = i; redraw(); } else refreshHeader(root);
    };
  });
  ed.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => { d.criteria[i] = applyKind(c(), b.dataset.kind); redraw(); }));
  ed.querySelectorAll('[data-level]').forEach((el) => (el.oninput = () => {
    c().levels[Number(el.dataset.level)][el.dataset.lf] = el.dataset.lf === 'value' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    refreshHeader(root);
  }));
  ed.querySelectorAll('[data-level-del]').forEach((b) => (b.onclick = () => { c().levels.splice(Number(b.dataset.levelDel), 1); redraw(); }));
  ed.querySelector('[data-level-add]') && (ed.querySelector('[data-level-add]').onclick = () => {
    const max = Math.max(0, ...c().levels.map((l) => Number(l.value) || 0));
    c().levels.push({ value: max + 5, description: '' }); redraw();
  });
  ed.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => { c().levels = presetLevels(SCALE_PRESETS[b.dataset.preset], c().levels); redraw(); }));
  ed.querySelector('[data-dup]').onclick = () => {
    const copy = { ...structuredClone(c()), id: newCriterion('yesno', d).id, name: `${c().name} (копия)` };
    d.criteria.splice(i + 1, 0, copy); S.open = i + 1; redraw();
  };
  ed.querySelector('[data-del]').onclick = () => {
    if (!confirm(`Удалить критерий «${c().name || 'без названия'}»? Он исчезнет только в новой версии, старые оценки не изменятся.`)) return;
    d.criteria.splice(i, 1); S.open = null; redraw();
  };
}

/** Обновляет шапку, плашки и полосу весов без перерисовки формы (чтобы не терять фокус при вводе). */
function refreshHeader(root) {
  const focused = document.activeElement;
  const sel = focused && focused.closest?.('.cqa-cl-editor, #cl-name, .cqa-cl-section-name') ? selector(focused) : null;
  const start = focused?.selectionStart, end = focused?.selectionEnd;
  draw(root);
  if (sel) {
    const el = root.querySelector(sel);
    if (el) { el.focus(); try { el.setSelectionRange(start, end); } catch { /* number input */ } }
  }
}
function selector(el) {
  if (el.id) return `#${el.id}`;
  if (el.dataset.f) return `.cqa-cl-editor [data-f="${el.dataset.f}"]`;
  if (el.dataset.level) return `.cqa-cl-editor [data-level="${el.dataset.level}"][data-lf="${el.dataset.lf}"]`;
  if (el.dataset.section) return `.cqa-cl-section-name[data-section="${el.dataset.section}"]`;
  return null;
}

async function reevaluate(root, scope) {
  const v = S.saved;
  const group = currentGroup();
  S.job = { status: 'starting', done: 0, total: 0 };
  draw(root);
  try {
    let ids = 'all';
    if (scope === 'evaluated') {
      const evs = await api.evaluations();
      ids = [...new Set(evs.filter((e) => !e.group_id || e.group_id === group).map((e) => e.conversation_id))];
      if (!ids.length) { S.job = { status: 'error', error: 'В текущем наборе ещё нет оценённых диалогов. Выберите «Переоценить весь набор».' }; draw(root); return; }
    }
    const res = await api.evaluate({ conversation_ids: ids, group_id: group, checklist_id: v.id, checklist_version: v.version });
    if (!res.job_id || res.evaluations) { S.job = { status: 'done', total: res.evaluations?.length || 0, done: res.evaluations?.length || 0, failed: res.errors?.length || 0 }; draw(root); return; }
    S.job = { status: 'running', done: 0, total: res.total };
    while (S.job.status === 'running') {
      await new Promise((r) => setTimeout(r, 1000));
      S.job = await api.job(res.job_id);
      if (location.hash.startsWith('#/checklists')) draw(root);
    }
  } catch (e) {
    S.job = { status: 'error', error: e.message };
    draw(root);
  }
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}
