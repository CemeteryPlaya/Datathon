// Критерий чек-листа → вопрос локальной модели (формат Jev) и обратно: ответ модели → answer оценки.
// Только из конфига: никаких id критериев. Тексты вопроса/вариантов модель строит из criterion сама
// (local-model/cqa_local/questions.py), options здесь — ключи вариантов и подписи для людей.

const OPTION_LABEL = { yes: 'Да', no: 'Нет' };

export const isNegative = (c) => c.polarity === 'negative' || c.kind === 'gross';

/** noul — да/нет без N/A, choice — да/нет/N/A, score — шкала. */
export function questionType(c) {
  if (c.type === 'scale') return 'score';
  return c.na_allowed ? 'choice' : 'noul';
}

/** Ступень шкалы как ключ варианта: 20 → "20", 7.5 → "7.5". */
export const levelKey = (v) => String(Number(v));

export function optionKeys(c) {
  const base = c.type === 'scale' ? (c.levels || []).map((l) => levelKey(l.value)) : ['yes', 'no'];
  return c.na_allowed ? [...base, 'na'] : base;
}

export function optionText(c, key) {
  if (key === 'na') return `N/A: ${String(c.na_condition || '').trim() || 'неприменимо'}`;
  if (c.type === 'scale') {
    const levels = c.levels || [];
    const max = Math.max(...levels.map((l) => Number(l.value)));
    const l = levels.find((x) => levelKey(x.value) === key);
    return l ? `${key} из ${max}: ${String(l.description || '').trim()}` : key;
  }
  return OPTION_LABEL[key] || key;
}

/** Вопрос для /v1/decide и /v1/finetune. */
export function toQuestion(c) {
  return {
    type: questionType(c),
    criterion: {
      name: c.name || '',
      description: c.description || '',
      type: c.type === 'scale' ? 'scale' : 'yesno',
      levels: c.type === 'scale' ? (c.levels || []).map((l) => ({ value: Number(l.value), description: l.description || '' })) : [],
      polarity: isNegative(c) ? 'negative' : 'positive',
      kind: c.kind || 'normal',
      na_allowed: !!c.na_allowed,
      na_condition: c.na_allowed ? c.na_condition || '' : '',
    },
    options: optionKeys(c).map((key) => ({ key, text: optionText(c, key) })),
  };
}

/** Все критерии чек-листа: ключ вопроса = id критерия. */
export function buildQuestions(checklist) {
  return Object.fromEntries(checklist.criteria.map((c) => [c.id, toQuestion(c)]));
}

/** Ключ варианта → answer оценки ("yes" | "no" | "na" | число ступени); null — недопустимо для критерия. */
export function toAnswer(c, choice) {
  const key = String(choice);
  if (!optionKeys(c).includes(key)) return null;
  if (key === 'na' || c.type !== 'scale') return key;
  return Number(key);
}

/** answer оценки (или решение проверяющего) → ключ варианта для дообучения. */
export const answerKey = (c, answer) => (c.type === 'scale' && answer !== 'na' ? levelKey(answer) : String(answer));
