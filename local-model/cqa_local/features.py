"""Признаки реплик: роль, позиция, паузы (offsets из events.js), флаги событий (detectEvents), язык, канал, форма текста.

События и смещения в обучении берутся из local-model/data/events.json (выгрузка из Node), в рантайме их присылает Node:
одни и те же функции server/model/events.js, регулярки в Python не дублируются.
"""
from __future__ import annotations

import math
import re
from datetime import datetime

import numpy as np

ROLES = ["client", "operator", "bot", "system"]
EVENT_TYPES = ["escalation", "identity_verified", "disconnect", "closed", "hold", "recording_paused", "recording_resumed",
               "first_operator", "last_operator", "long_wait"]
LANGS = ["RU", "KZ", "EN"]
URL_RE = re.compile(r"https?://|www\.", re.I)
EMOJI_RE = re.compile("[\U0001F300-\U0001FAFF☀-➿]")
N_FEATS = len(ROLES) + 1 + len(EVENT_TYPES) + 11 + len(LANGS) + 1 + 7


def parse_timestamp(ts):
    """Запасной вариант, если Node не прислал offsets (та же логика, что parseTimestamp в events.js)."""
    if not ts:
        return None
    s = str(ts).strip()
    m = re.match(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$", s)
    if m:
        return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) if m[3] is not None else int(m[1]) * 60 + int(m[2])
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def offsets_fallback(transcript):
    ts = [parse_timestamp(r.get("timestamp")) for r in transcript]
    base = next((t for t in ts if t is not None), None)
    return [None if t is None or base is None else round((t - base) * 10) / 10 for t in ts]


def utterance_features(record: dict, events: list, offsets: list | None) -> np.ndarray:
    tr = record["transcript"]
    n = len(tr)
    offs = offsets if offsets and len(offsets) == n else offsets_fallback(tr)
    ev = np.zeros((n, len(EVENT_TYPES)), dtype=np.float32)
    for e in events or []:
        i = e.get("index")
        if isinstance(i, int) and 0 <= i < n and e.get("type") in EVENT_TYPES:
            ev[i, EVENT_TYPES.index(e["type"])] = 1.0
    roles = [r.get("speaker") for r in tr]
    first_op = next((i for i, s in enumerate(roles) if s == "operator"), n)
    last_op = max((i for i, s in enumerate(roles) if s == "operator"), default=-1)
    lang = np.zeros(len(LANGS), dtype=np.float32)
    if record.get("language") in LANGS:
        lang[LANGS.index(record["language"])] = 1.0
    call = 1.0 if record.get("channel") == "voice call" else 0.0
    feats = np.zeros((n, N_FEATS), dtype=np.float32)
    op_k = 0
    last_client_t = None
    for i, r in enumerate(tr):
        row = []
        role = np.zeros(len(ROLES) + 1, dtype=np.float32)
        role[ROLES.index(roles[i]) if roles[i] in ROLES else len(ROLES)] = 1.0
        row.extend(role)
        row.extend(ev[i])
        t = offs[i]
        prev_t = next((offs[j] for j in range(i - 1, -1, -1) if offs[j] is not None), None)
        pause = (t - prev_t) if t is not None and prev_t is not None else 0.0
        wait = (t - last_client_t) if roles[i] == "operator" and t is not None and last_client_t is not None else 0.0
        if roles[i] == "operator":
            op_k += 1
        row.extend([
            i / max(1, n - 1), math.log1p(i) / 5, math.log1p(n - 1 - i) / 5, float(i == 0), float(i == n - 1),
            float(i >= first_op), float(i > last_op >= 0), math.log1p(op_k) / 3 if roles[i] == "operator" else 0.0,
            math.log1p(max(0.0, pause)) / 6, math.log1p(max(0.0, t or 0.0)) / 8, math.log1p(max(0.0, wait)) / 6,
        ])
        row.extend(lang)
        row.append(call)
        text = str(r.get("text") or "")
        words = text.split()
        caps = sum(1 for w in words if len(w) > 2 and w.isupper())
        row.extend([
            math.log1p(len(words)) / 4, float("?" in text), caps / max(1, len(words)), float(bool(URL_RE.search(text))),
            float(bool(EMOJI_RE.search(text))), float(any(ch.isdigit() for ch in text)), float("[" in text and "]" in text),
        ])
        feats[i] = row
        if roles[i] == "client" and t is not None:
            last_client_t = t
    return feats
