// Детерминированная разметка событий диалога до вызова модели.
// Это общая разметка транскрипта, она ничего не знает о критериях чек-листа.

const PATTERNS = [
  { type: 'escalation', label: 'Чат передан оператору', re: [/эскалация на оператора/i, /операторға жіберілді/i, /transferred to an? (agent|operator)/i] },
  { type: 'identity_verified', label: 'Личность клиента подтверждена (системное событие)', re: [/личность клиента подтверждена/i, /жеке басы расталды/i, /identity (was )?verified/i] },
  { type: 'disconnect', label: 'Обрыв: клиент ушёл / соединение прервано', re: [/соединение с клиентом прервано/i, /клиент покинул чат/i, /connection to (the )?customer (was )?lost/i, /customer left the chat/i, /клиент чаттан шықты/i, /байланыс үзілді/i] },
  { type: 'closed', label: 'Чат/звонок закрыт', re: [/оператор закрыл чат/i, /agent closed the chat/i, /клиент завершил разговор/i, /чатты жапты/i, /customer ended/i] },
  { type: 'hold', label: 'Клиент поставлен на удержание', re: [/на удержании/i, /on hold/i, /күту режимінде/i] },
  { type: 'recording_paused', label: 'Запись приостановлена', re: [/запись и транскрибирование приостановлены/i, /recording.*paused/i] },
  { type: 'recording_resumed', label: 'Запись возобновлена', re: [/запись и транскрибирование возобновлены/i, /recording.*resumed/i] },
];

/** Секунды от начала: "MM:SS" / "HH:MM:SS" или ISO 8601. null, если не распознано. */
export function parseTimestamp(ts) {
  if (!ts) return null;
  const s = String(ts).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t / 1000;
}

/** Смещение каждой реплики от первой (секунды) — для плеера и для оценки пауз. */
export function offsets(transcript) {
  const base = transcript.map((r) => parseTimestamp(r.timestamp)).find((x) => x !== null);
  return transcript.map((r) => {
    const t = parseTimestamp(r.timestamp);
    return t === null || base === undefined ? null : Math.round((t - base) * 10) / 10;
  });
}

export function detectEvents(transcript) {
  const events = [];
  const firstOp = transcript.findIndex((r) => r.speaker === 'operator');
  if (firstOp >= 0) events.push({ index: firstOp, type: 'first_operator', label: 'Первая реплика оператора' });
  else events.push({ index: null, type: 'no_operator', label: 'В диалоге нет ни одной реплики оператора' });

  transcript.forEach((r, i) => {
    if (r.speaker === 'operator') return;
    for (const p of PATTERNS) {
      if (p.re.some((re) => re.test(r.text || ''))) {
        events.push({ index: i, type: p.type, label: p.label });
        break;
      }
    }
  });

  const lastOp = transcript.map((r) => r.speaker).lastIndexOf('operator');
  if (lastOp >= 0) events.push({ index: lastOp, type: 'last_operator', label: 'Последняя реплика оператора' });

  // Длинные паузы между репликой клиента и ответом оператора (информативно, порог не оценочный)
  const off = offsets(transcript);
  for (let i = 1; i < transcript.length; i++) {
    if (transcript[i].speaker !== 'operator' || off[i] === null) continue;
    let j = i - 1;
    while (j >= 0 && transcript[j].speaker !== 'client') j--;
    if (j < 0 || off[j] === null) continue;
    const gap = off[i] - off[j];
    if (gap >= 120) events.push({ index: i, type: 'long_wait', label: `Ответ оператора через ${Math.round(gap)} с после реплики клиента [${j}]` });
  }
  return events.sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
}
