"""Самообучающие «пробные» вопросы: учат модель общему навыку — найти в РЕПЛИКАХ ОПЕРАТОРА то, о чём говорит текст
критерия (слово, фразу, их другую форму), и не путать с репликами клиента.

Разметка получается из самого текста диалога, без внешних моделей. Это помогает новым критериям из редактора
(«штраф за чихание», «кашель»), для которых в обучении не было ни одного примера.
"""
from __future__ import annotations

import random
import re

WORD_RE = re.compile(r"[^\W\d_]{4,}", re.UNICODE)

TEMPLATES = [
    ("Оператор написал «{x}»", "Да — в одной из реплик оператора есть «{x}» (или то же слово в другой форме). Реплики клиента и бота не учитываются."),
    ("Упоминание «{x}»", "Да — оператор упомянул {x}."),
    ("Фраза оператора: {x}", "Да — оператор сказал или написал клиенту «{x}»."),
    ("Agent wrote '{x}'", "Yes — one of the agent's messages contains '{x}' (or the same word in another form). Customer messages do not count."),
    ("Оператор жазды «{x}»", "Иә — оператордың хабарламасында «{x}» бар."),
    # в стиле настоящих критериев: правило + пример в скобках
    ("Штраф: {x}", "Да — оператор написал клиенту что-то вроде «{x}». Реплики клиента не учитываются."),
    ("Оператор: {x}", "Да — оператор в чате с клиентом (например, «{x}»)."),
    ("Нарушение «{x}»", "Плохо, если оператор пишет «{x}» в чат с клиентом."),
    ("Mentions {x}", "Yes — the agent wrote something like '{x}' to the customer."),
]


def spans(text):
    words = WORD_RE.findall(text)
    out = [w for w in words]
    out += [f"{a} {b}" for a, b in zip(words, words[1:])]
    return out


def present(phrase, texts):
    p = phrase.lower()
    return [i for i, t in texts if p in t.lower()]


def morph(phrase, rng):
    """Другая форма слова: отрезать 1–2 буквы окончания (чихнула → чихнул)."""
    w = phrase.split()
    if len(w) == 1 and len(w[0]) >= 6 and rng.random() < 0.4:
        return w[0][: -rng.choice((1, 2))]
    return phrase


def make_probe(record, rng: random.Random, pool: list):
    tr = record["transcript"]
    ops = [(i, r.get("text") or "") for i, r in enumerate(tr) if r.get("speaker") == "operator"]
    cls = [(i, r.get("text") or "") for i, r in enumerate(tr) if r.get("speaker") == "client"]
    if not ops:
        return None
    mode = rng.random()
    if mode < 0.5:
        i, t = rng.choice(ops)
        cand = spans(t)
        if not cand:
            return None
        x = rng.choice(cand)
    elif mode < 0.75 and cls:
        i, t = rng.choice(cls)
        cand = [s for s in spans(t) if not present(s, ops)]
        if not cand:
            return None
        x = rng.choice(cand)
    else:
        x = rng.choice(pool)
    ev = present(x, ops)
    y = "yes" if ev else "no"
    shown = morph(x, rng)
    if rng.random() < 0.3:
        shown = shown.lower()
    name, desc = rng.choice(TEMPLATES)
    crit = {"name": name.format(x=shown), "description": desc.format(x=shown), "type": "yesno",
            "polarity": "negative" if rng.random() < 0.5 else "positive", "na_allowed": False, "na_condition": ""}
    return crit, y, ev


def phrase_pool(records, rng: random.Random, n=20000):
    pool = []
    for r in records:
        for u in r["transcript"]:
            if u.get("speaker") in ("operator", "client"):
                pool.extend(spans(u.get("text") or ""))
    rng.shuffle(pool)
    return pool[:n]
