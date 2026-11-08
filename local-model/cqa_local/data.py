"""Загрузка диалогов, событий, банка вопросов и сборка наборов «диалог × вопрос → ответ».

Утечка: gt-holdout и его аугментированные копии (split=test) попадают ТОЛЬКО в тестовые наборы.
Метки c01..c08 встречаются здесь только как ключи эталона (data/gt*, *_labels) — сама модель их не видит,
ей приходит текст критерия.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from . import DATA, ROOT
from .questions import normalize_answer

GT_DIRS = {"gt": ROOT / "data" / "gt", "gt-fresh": ROOT / "data" / "gt-fresh", "gt-holdout": ROOT / "data" / "gt-holdout"}

# Вопросы, которых модель не видит на обучении: zero-shot из генератора + «обещание перезвонить»
# (его используем в сценарии защиты как «новый критерий» с дообучением по апелляциям).
EXTRA_UNSEEN = {"n_op_callback_promise"}


def _records(raw):
    if isinstance(raw, dict):
        return (raw.get("data") or {}).get("records") or raw.get("records") or []
    return raw


@lru_cache(maxsize=None)
def records() -> dict:
    out = {}
    for f in (DATA / "synth_dialogs.json", DATA / "aug_dev_dialogs.json", ROOT / "data" / "DEV.json"):
        for r in _records(json.loads(f.read_text(encoding="utf-8"))):
            out[r["conversation_id"]] = r
    return out


@lru_cache(maxsize=None)
def events() -> dict:
    f = DATA / "events.json"
    if not f.exists():
        raise SystemExit("Нет local-model/data/events.json — запустите: npm run events")
    return json.loads(f.read_text(encoding="utf-8"))


@lru_cache(maxsize=None)
def bank() -> dict:
    qb = json.loads((DATA / "question_bank.json").read_text(encoding="utf-8"))
    return {q["qid"]: q for q in qb["questions"]}


@lru_cache(maxsize=None)
def default_checklist() -> dict:
    return json.loads((ROOT / "server" / "seed" / "checklist.default.json").read_text(encoding="utf-8"))


def unseen_qids() -> set:
    return {qid for qid, q in bank().items() if q.get("split") == "zero_shot"} | EXTRA_UNSEEN


@lru_cache(maxsize=None)
def synth_labels() -> dict:
    out = {}
    with open(DATA / "synth_labels.jsonl", encoding="utf-8") as f:
        for line in f:
            l = json.loads(line)
            out[l["conversation_id"]] = {"ambiguous": l.get("ambiguous", []), "facts": l["facts"], "split": l["split"]}
    return out


def aug_labels() -> list:
    with open(DATA / "aug_dev_labels.jsonl", encoding="utf-8") as f:
        return [json.loads(line) for line in f]


def _gross_qids() -> set:
    g = {"crit_" + c["id"] for c in default_checklist()["criteria"] if c.get("kind") == "gross"}
    return g | {qid for qid in bank() if qid.startswith("a_gross_")}


def make_example(src, d, qid, w, y, ev=(), amb=False, weight=1.0):
    q = bank()[qid]
    rec = records()[d]
    return {
        "src": src, "d": d, "qid": qid, "w": w, "crit": q["wordings"][w], "kind": q["kind"],
        "y": normalize_answer(y), "ev": list(ev or []), "amb": bool(amb), "weight": weight,
        "lang": rec.get("language"), "channel": rec.get("channel"), "gross": qid in _gross_qids(),
        "cid": q.get("source") if q["kind"] == "criterion" else None,
    }


def _fact_qid(key):
    b = bank()
    for p in ("a_", "n_"):
        if p + key in b:
            return p + key
    return None


def synth_pairs(split: str, include_unseen=False) -> list:
    lab = synth_labels()
    unseen = unseen_qids()
    out = []
    with open(DATA / f"pairs_{split}.jsonl", encoding="utf-8") as f:
        for line in f:
            p = json.loads(line)
            if p["q"] in unseen and not include_unseen:
                continue
            q = bank()[p["q"]]
            amb = q["kind"] == "criterion" and q["source"] in lab[p["d"]]["ambiguous"]
            out.append(make_example(f"synth-{split}", p["d"], p["q"], p["w"], p["y"], p.get("ev"), amb))
    return out


def synth_zero_shot(split="test") -> list:
    """Невиданные вопросы на синтетических диалогах split (как pairs_zero_shot + EXTRA_UNSEEN).
    split=val — для выбора эпохи (тестовые диалоги не трогаем)."""
    out = []
    for d, l in synth_labels().items():
        if l["split"] != split:
            continue
        for qid in sorted(unseen_qids()):
            v = l["facts"].get(bank()[qid]["source"], {"v": False, "ev": []})
            out.append(make_example(f"zero-{split}", d, qid, 0, "yes" if v["v"] is True else "no", v["ev"]))
    return out


def aug_examples(split: str, unseen: bool = False, weight=1.0) -> list:
    """Аугментированные реальные диалоги: критерии стартового чек-листа + факты новых поведений.
    unseen=False — только видимые на обучении вопросы; True — только невиданные (zero-shot)."""
    hidden = unseen_qids()
    out = []
    for l in aug_labels():
        if l["split"] != split:
            continue
        if not unseen:
            for cid, y in l["answers"].items():
                out.append(make_example(f"aug-{split}", l["conversation_id"], "crit_" + cid, 0, y, (), cid in l.get("ambiguous", []), weight))
        for key, v in l["facts"].items():
            qid = _fact_qid(key)
            if not qid or (qid in hidden) != unseen:
                continue
            y = "na" if v["v"] == "na" else ("yes" if v["v"] else "no")
            out.append(make_example(f"aug-{split}" + ("-zero" if unseen else ""), l["conversation_id"], qid, 0, y, v.get("ev"), False, weight))
    return out


def gt_examples(name: str, weight=1.0) -> list:
    out = []
    for f in sorted(GT_DIRS[name].glob("*.json")):
        g = json.loads(f.read_text(encoding="utf-8"))
        if g["conversation_id"] not in records():
            continue
        for cid, y in g["answers"].items():
            if "crit_" + cid not in bank():
                continue
            out.append(make_example(name, g["conversation_id"], "crit_" + cid, 0, y, (), cid in g.get("ambiguous", []), weight))
    return out


# ---------- наборы
def train_set(real_weight=4.0, aug_weight=2.0) -> list:
    return synth_pairs("train") + gt_examples("gt", real_weight) + aug_examples("train", weight=aug_weight)


def val_set() -> list:
    return synth_pairs("val") + gt_examples("gt-fresh") + aug_examples("val")


def calib_set() -> list:
    """Калибровка температуры: реальный gt-fresh (+ его аугментация) и синтетический val."""
    return val_set()


def test_sets() -> dict:
    return {
        "synth-test": synth_pairs("test"),
        "aug-test": aug_examples("test"),
        "gt-holdout": gt_examples("gt-holdout"),
        "zero-shot": synth_zero_shot() + aug_examples("test", unseen=True),
    }


def assert_no_leak(train: list):
    holdout = {f.stem for f in GT_DIRS["gt-holdout"].glob("*.json")}
    bad = [e for e in train if e["d"] in holdout or e["d"].rsplit("-aug", 1)[0] in holdout]
    assert not bad, f"утечка: {len(bad)} примеров из gt-holdout в обучении"
    unseen = unseen_qids()
    assert not [e for e in train if e["qid"] in unseen], "утечка: невиданные вопросы в обучении"
    test_d = {d for d, l in synth_labels().items() if l["split"] != "train"}
    assert not [e for e in train if e["d"] in test_d], "утечка: синтетические val/test-диалоги в обучении"
