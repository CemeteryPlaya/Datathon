"""Бейзлайны: «частый ответ» и «только правила» (события + простые регулярки).

  py -3 local-model/baselines.py        → local-model/runs/preds/{majority,rules}/<набор>.jsonl
Потом: py -3 local-model/evaluate.py --models majority,rules

Правила выбираются по ТЕКСТУ вопроса (ключевые слова в названии/описании), а не по id критерия.
Если ни одно правило не подходит — частый ответ для этого вопроса.
"""
from __future__ import annotations

import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cqa_local import data as D  # noqa: E402
from cqa_local.predio import write_preds  # noqa: E402
from cqa_local.questions import option_keys, question_text  # noqa: E402


# ---------- «частый ответ»
def majority_tables():
    """Частый ответ по вопросу: для реальных наборов — по реальной разметке (gt + аугментация train),
    для синтетики — по синтетическому train. Невиданный вопрос → самый частый ответ среди «новых» вопросов."""
    synth, real, novel = defaultdict(Counter), defaultdict(Counter), Counter()
    for e in D.synth_pairs("train"):
        synth[e["qid"]][e["y"]] += 1
        if e["kind"] == "novel":
            novel[e["y"]] += 1
    for e in D.gt_examples("gt") + D.aug_examples("train"):
        real[e["qid"]][e["y"]] += 1
    top = lambda t: {q: c.most_common(1)[0][0] for q, c in t.items()}
    return top(synth), top(real), novel.most_common(1)[0][0]


def majority_predict(e, tables):
    synth, real, novel = tables
    t = synth if e["src"].startswith("synth") else real
    y = t.get(e["qid"]) or synth.get(e["qid"]) or novel
    keys = option_keys(e["crit"])
    if y not in keys:
        y = keys[0]
    return y, {y: 1.0}


# ---------- «только правила»
ROLE_OP = "operator"
RX = {
    "greet": r"здравствуй|добр(ый|ое|ого) (день|утр|вечер)|привет|сәлем|қайырлы|hello|hi\b|good (morning|afternoon|evening)",
    "name": r"меня зовут|на связи|с вами\s+\w+|менің атым|атым|my name is|this is \w+|\[имя скрыто\]",
    "bye": r"до свидания|всего доброго|хорошего (дня|вечера)|сау болыңыз|күніңіз|goodbye|have a (nice|good|great)|bye",
    "offer": r"остались вопросы|ещё вопрос|чем (ещё )?могу помочь|обращайтесь|пишите|тағы сұрақ|any other|anything else|feel free",
    "insult": r"тупит|глуп|читать умеете|ақымақ|оқи аласыз|stupid|dense|can you even read|переведите (мне|на мою карту)|личн(ый|ую) (номер|карт)",
    "sneeze": r"апчх|achoo|чихн|sneez|түшкір",
    "cough": r"кхе|кашля|cough|жөтел",
    "eat": r"обеда|доем|бутерброд|lunch|sandwich|түстен|жеп",
    "competitor": r"halyk|jusan|kaspi|tinkoff|т-банк|bcc|forte",
    "link": r"https?://|www\.",
    "callback": r"перезвон|свяжется|свяжутся|call you back|contact you|қоңырау шала|хабарлас",
    "apology": r"извин|прошу прощения|простите|sorry|apolog|кешіріңіз",
    "emoji": r"[\U0001F300-\U0001FAFF☀-➿]",
    "ty": r"\b(ты|тебе|тебя|твой|твоя|сен|саған)\b",
    "slang": r"\b(короче|ща|норм|чё|ок+|го|lol|gonna|wanna)\b",
    "rate": r"оцени|поставьте оценку|rate|бағала",
}
EVENT = {"disconnect", "identity_verified", "hold", "closed", "escalation", "long_wait"}

# ключевые слова в тексте вопроса → концепт
CONCEPTS = [
    ("sneeze", r"чих|sneez"), ("caps", r"капс|заглавн|caps"),("cough", r"кашл|cough"), ("eat", r"\bед[аы]\b|обед|eat"), ("competitor", r"конкурент|competitor"),
    ("link", r"ссылк|link"), ("callback", r"перезвон|свяж|call back|callback"), ("apology", r"извин|apolog"),
    ("emoji", r"эмодзи|emoji"), ("ty", r"«ты»|на ты"), ("slang", r"сленг|slang"), ("rate", r"оцен(ить|ку) (его )?работ|оценить|rate"),
    ("gross", r"груб|оскорб|insult|в обход"), ("disconnect", r"обрыв|связь прервал|cut off|disconnect"),
    ("identity", r"идентифик|личност|identity"), ("closing", r"заверш|попрощал|closing|goodbye"),
    ("greeting", r"поздоровал|приветств|установление контакта|greet"), ("intro", r"представил|назвал имя|introduc"),
]


def op_texts(rec):
    return [(i, r.get("text") or "") for i, r in enumerate(rec["transcript"]) if r.get("speaker") == ROLE_OP]


def any_op(rec, key):
    return any(re.search(RX[key], t, re.I) for _, t in op_texts(rec))


def rules_predict(e, tables):
    crit = e["crit"]
    rec = D.records()[e["d"]]
    evs = {x["type"] for x in D.events()[e["d"]]["events"]}
    keys = option_keys(crit)
    text = question_text(crit).lower()
    concept = next((c for c, rx in CONCEPTS if re.search(rx, text)), None)
    ops = op_texts(rec)
    first = ops[0][1] if ops else ""
    last = ops[-1][1] if ops else ""
    yn = lambda b: "yes" if b else "no"
    y = None
    if concept in RX:
        y = yn(any_op(rec, concept))
    elif concept == "caps":
        y = yn(any(sum(w.isupper() and len(w) > 2 for w in t.split()) >= 3 for _, t in ops))
    elif concept == "gross":
        y = yn(any_op(rec, "insult"))
    elif concept == "disconnect":
        y = yn("disconnect" in evs)
    elif concept == "identity":
        y = "yes" if "identity_verified" in evs else ("na" if "na" in keys else "no")
    elif concept == "closing":
        if "disconnect" in evs and "na" in keys:
            y = "na"
        else:
            y = yn(re.search(RX["bye"], last, re.I) and re.search(RX["offer"] + "|итак|вы можете|you can", " ".join(t for _, t in ops[-2:]), re.I))
    elif concept == "greeting":
        ok = bool(re.search(RX["greet"], first, re.I))
        if re.search(r"представ|introduc", text):
            ok = ok and bool(re.search(RX["name"], first, re.I))
        y = yn(ok)
    elif concept == "intro":
        y = yn(re.search(RX["name"], first, re.I))
    if y is None or y not in keys:
        return majority_predict(e, tables)
    return y, {y: 1.0}


def main():
    tables = majority_tables()
    sets = D.test_sets()
    for name, fn in (("majority", majority_predict), ("rules", rules_predict)):
        for s, exs in sets.items():
            preds = []
            for e in exs:
                y, probs = fn(e, tables)
                preds.append({**e, "pred": y, "probs": probs, "conf": max(probs.values())})
            write_preds(name, s, preds)
        print(f"{name}: готово ({', '.join(f'{s}={len(x)}' for s, x in sets.items())})")


if __name__ == "__main__":
    main()
