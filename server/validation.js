export function checklistError(c) {
  if (!c || typeof c.name !== 'string' || !c.name.trim() || !Array.isArray(c.criteria) || !c.criteria.length || !Array.isArray(c.sections)) return 'Укажите название, секции и критерии';
  const sections = new Set(c.sections.map(s => s.id));
  const ids = new Set();
  for (const r of c.criteria) {
    if (!r.id || ids.has(r.id)) return 'ID критериев должны быть уникальны';
    ids.add(r.id);
    if (!r.name?.trim() || !r.description?.trim() || !sections.has(r.section)) return 'Укажите название, формулировку и секцию критерия';
    if (!['yesno','scale'].includes(r.type) || !['normal','gross'].includes(r.kind) || (r.polarity && !['positive','negative'].includes(r.polarity))) return 'Недопустимый тип критерия';
    if (typeof r.weight !== 'number' || !Number.isFinite(r.weight) || r.weight < 0) return 'Вес должен быть неотрицательным числом';
    if (typeof r.na_allowed !== 'boolean' || (r.na_allowed && !r.na_condition?.trim())) return 'Укажите условие N/A';
    if (r.type === 'scale') {
      const ls = r.levels;
      if (!Array.isArray(ls) || ls.length < 2 || ls.some(l => typeof l.value !== 'number' || !Number.isFinite(l.value) || l.value < 0 || !l.description?.trim()) || new Set(ls.map(l=>l.value)).size !== ls.length || Math.max(...ls.map(l=>l.value)) <= 0) return 'Шкала: минимум две уникальные неотрицательные ступени с описаниями и положительным максимумом';
    }
  }
  return null;
}
export function validAnswer(c, answer) {
  return (answer === 'na' && c.na_allowed) || (c.type === 'scale' ? c.levels.some(l=>l.value === answer) : ['yes','no'].includes(answer));
}
