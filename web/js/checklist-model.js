// Логика редактора чек-листа без DOM: типы критериев, шаблоны, проверка, доли весов, сравнение версий.
// Работает и в браузере, и в node (тесты в server/test/checklist-model.test.js).

/** Тип ответа так, как его видит человек. */
export const KINDS = {
  yesno: { label: 'Да / Нет', hint: '«Да» — требование выполнено, получает весь вес.', icon: '✓' },
  scale: { label: 'Шкала', hint: 'Несколько ступеней с баллами. Модель выбирает одну.', icon: '▤' },
  penalty: { label: 'Штраф', hint: '«Да» — нарушение было, критерий теряет свой вес.', icon: '−' },
  gross: { label: 'Грубая ошибка', hint: 'Отдельный красный флаг. На балл не влияет, попадает в «Тревоги».', icon: '!' },
};

export function kindOf(c) {
  if (c.kind === 'gross') return 'gross';
  if (c.type === 'scale') return 'scale';
  return c.polarity === 'negative' ? 'penalty' : 'yesno';
}

const DEFAULT_LEVELS = [
  { value: 0, description: 'Требование не выполнено.' },
  { value: 5, description: 'Выполнено частично.' },
  { value: 10, description: 'Выполнено полностью.' },
];

/** Меняет тип ответа, сохраняя всё, что можно сохранить. */
export function applyKind(c, kind) {
  const out = { ...c };
  delete out.polarity;
  if (kind === 'scale') {
    out.type = 'scale';
    out.kind = 'normal';
    out.levels = c.levels?.length ? c.levels : structuredClone(DEFAULT_LEVELS);
    if (!out.weight) out.weight = 10;
  } else {
    out.type = 'yesno';
    out.levels = [];
    out.kind = kind === 'gross' ? 'gross' : 'normal';
    if (kind === 'penalty') out.polarity = 'negative';
    if (kind === 'gross') out.weight = 0;
    else if (!out.weight) out.weight = 10;
  }
  return out;
}

export const SCALE_PRESETS = {
  '0 / 5 / 10': [0, 5, 10],
  '0 / 4 / 7 / 10': [0, 4, 7, 10],
  '0–20 шагом 5': [0, 5, 10, 15, 20],
};

export function presetLevels(values, old = []) {
  return values.map((v, i) => ({ value: v, description: old.find((l) => l.value === v)?.description || (i === 0 ? 'Требование не выполнено.' : i === values.length - 1 ? 'Выполнено полностью.' : '') }));
}

/** Следующий свободный id вида c09, c10… */
export function nextId(criteria) {
  const nums = criteria.map((c) => /^c(\d+)$/.exec(c.id)?.[1]).filter(Boolean).map(Number);
  let n = (nums.length ? Math.max(...nums) : 0) + 1;
  const ids = new Set(criteria.map((c) => c.id));
  while (ids.has(`c${String(n).padStart(2, '0')}`)) n++;
  return `c${String(n).padStart(2, '0')}`;
}

export function newCriterion(kind, draft, sectionId) {
  const base = { id: nextId(draft.criteria), section: sectionId || draft.sections[0]?.id, name: '', description: '', na_allowed: false, na_condition: '', weight: 10, kind: 'normal', type: 'yesno', levels: [] };
  return applyKind(base, kind);
}

/** Проблемы черновика. Повторяет правила сервера (server/validation.js), но с понятными текстами. */
export function problems(draft) {
  const byIndex = {};
  const global = [];
  const add = (i, msg) => (byIndex[i] ||= []).push(msg);
  if (!draft.name?.trim()) global.push('Укажите название чек-листа.');
  if (!draft.criteria.length) global.push('Добавьте хотя бы один критерий.');
  const sections = new Set(draft.sections.map((s) => s.id));
  for (const s of draft.sections) if (!s.name?.trim()) global.push('У секции нет названия.');
  const seen = new Map();
  draft.criteria.forEach((c, i) => {
    if (!c.name?.trim()) add(i, 'Напишите, что проверяем.');
    if (!c.description?.trim()) add(i, kindOf(c) === 'penalty' || kindOf(c) === 'gross' ? 'Опишите, что считается нарушением.' : 'Опишите, как понять, что требование выполнено.');
    if (!sections.has(c.section)) add(i, 'Выберите секцию.');
    if (kindOf(c) !== 'gross' && !(Number(c.weight) > 0)) add(i, 'Вес должен быть больше нуля (или выберите тип «Грубая ошибка»).');
    if (c.na_allowed && !c.na_condition?.trim()) add(i, 'Опишите, когда критерий не подходит (N/A).');
    if (c.type === 'scale') {
      const ls = c.levels || [];
      if (ls.length < 2) add(i, 'У шкалы должно быть минимум две ступени.');
      if (ls.some((l) => !Number.isFinite(Number(l.value)) || l.value === '' || Number(l.value) < 0)) add(i, 'Баллы ступеней — неотрицательные числа.');
      if (new Set(ls.map((l) => Number(l.value))).size !== ls.length) add(i, 'Баллы ступеней не должны повторяться.');
      if (ls.length && Math.max(...ls.map((l) => Number(l.value))) <= 0) add(i, 'Максимальная ступень должна быть больше нуля.');
      if (ls.some((l) => !l.description?.trim())) add(i, 'У каждой ступени нужно описание.');
    }
    if (seen.has(c.id)) add(i, `ID «${c.id}» повторяется.`);
    seen.set(c.id, i);
  });
  const count = global.length + Object.values(byIndex).reduce((s, x) => s + x.length, 0);
  return { byIndex, global, count };
}

/** Приводит черновик к формату API (числа, пустые поля). */
export function normalize(draft) {
  return {
    ...draft,
    name: draft.name.trim(),
    sections: draft.sections.map((s) => ({ ...s, name: s.name.trim() })),
    criteria: draft.criteria.map((c) => {
      const out = { ...c, name: c.name.trim(), description: c.description.trim(), weight: Number(c.weight) || 0, na_condition: c.na_allowed ? c.na_condition.trim() : '' };
      out.levels = c.type === 'scale' ? [...c.levels].map((l) => ({ value: Number(l.value), description: l.description.trim() })).sort((a, b) => a.value - b.value) : [];
      if (out.polarity !== 'negative') delete out.polarity;
      return out;
    }),
  };
}

/** Доля каждого критерия в итоге (%), когда все критерии применимы. */
export function weightShares(draft) {
  const ws = draft.criteria.map((c) => (kindOf(c) === 'gross' ? 0 : Math.max(0, Number(c.weight) || 0)));
  const total = ws.reduce((a, b) => a + b, 0);
  return ws.map((w) => (total ? Math.round((w / total) * 1000) / 10 : 0));
}

const FIELDS = [
  ['name', 'название'], ['description', 'формулировка'], ['section', 'секция'], ['weight', 'вес'],
  ['na_allowed', 'N/A'], ['na_condition', 'условие N/A'], ['levels', 'ступени шкалы'],
];

/** Что изменится относительно сохранённой версии. */
export function diff(prev, next) {
  const out = { renamed: prev.name !== next.name, added: [], removed: [], changed: [] };
  const p = new Map(prev.criteria.map((c) => [c.id, c]));
  const n = new Map(next.criteria.map((c) => [c.id, c]));
  for (const c of next.criteria) if (!p.has(c.id)) out.added.push(c);
  for (const c of prev.criteria) if (!n.has(c.id)) out.removed.push(c);
  for (const c of next.criteria) {
    const o = p.get(c.id);
    if (!o) continue;
    const fields = [];
    if (kindOf(o) !== kindOf(c)) fields.push('тип ответа');
    for (const [k, label] of FIELDS) if (JSON.stringify(o[k] ?? (k === 'levels' ? [] : '')) !== JSON.stringify(c[k] ?? (k === 'levels' ? [] : ''))) fields.push(label);
    if (fields.length) out.changed.push({ criterion: c, fields });
  }
  const sp = JSON.stringify(prev.sections), sn = JSON.stringify(next.sections);
  out.sections = sp !== sn;
  out.empty = !out.renamed && !out.added.length && !out.removed.length && !out.changed.length && !out.sections;
  return out;
}
