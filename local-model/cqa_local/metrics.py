"""Метрики по набору предсказаний.

Предсказание: пример из data.py + поля pred (ключ варианта), probs ({ключ: p}), conf (= max p).
Главные метрики — macro-F1 и balanced accuracy ПО ВОПРОСУ (критерию), усреднённые по вопросам: обычная точность
почти ничего не говорит при перекосе классов (бейзлайн «частый ответ» на реальном эталоне ~80%).
"""
from __future__ import annotations

from collections import defaultdict


def _f1s(pairs):
    labels = sorted({y for y, _ in pairs} | {p for _, p in pairs})
    f1, rec = {}, {}
    for c in labels:
        tp = sum(1 for y, p in pairs if y == c and p == c)
        fp = sum(1 for y, p in pairs if y != c and p == c)
        fn = sum(1 for y, p in pairs if y == c and p != c)
        prec = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else None
        f1[c] = 2 * prec * (r or 0) / (prec + (r or 0)) if prec + (r or 0) else 0.0
        if r is not None:
            rec[c] = r
    return f1, rec


def group_scores(pairs):
    """pairs: [(y, pred)] → acc, macro-F1 (по классам, встретившимся в эталоне или в ответах), balanced acc."""
    if not pairs:
        return {"n": 0}
    f1, rec = _f1s(pairs)
    present = {y for y, _ in pairs}
    return {
        "n": len(pairs),
        "acc": sum(y == p for y, p in pairs) / len(pairs),
        "macro_f1": sum(f1.values()) / len(f1),
        "bal_acc": sum(rec[c] for c in present) / len(present),
    }


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _recall(preds, label):
    xs = [p for p in preds if p["y"] == label]
    return (sum(p["pred"] == label for p in xs) / len(xs), len(xs)) if xs else (None, 0)


def _precision(preds, label):
    xs = [p for p in preds if p["pred"] == label]
    return (sum(p["y"] == label for p in xs) / len(xs), len(xs)) if xs else (None, 0)


def brier(preds):
    tot = 0.0
    n = 0
    for p in preds:
        probs = p.get("probs") or {p["pred"]: 1.0}
        keys = set(probs) | {p["y"]}
        tot += sum((probs.get(k, 0.0) - (1.0 if k == p["y"] else 0.0)) ** 2 for k in keys)
        n += 1
    return tot / n if n else None


def question_key(p):
    """Группировка «по критерию»: стартовые критерии — по их id (все формулировки вместе), остальные — по qid."""
    return p["cid"] or p["qid"]


def compute(preds: list, by=question_key) -> dict:
    if not preds:
        return {"n": 0}
    groups = defaultdict(list)
    for p in preds:
        groups[by(p)].append((p["y"], p["pred"]))
    per_q = {k: group_scores(v) for k, v in sorted(groups.items())}
    gross = [p for p in preds if p["gross"]]
    hi = [p for p in preds if p["conf"] >= 0.9]
    lo = [p for p in preds if p["conf"] < 0.9]
    out = {
        "n": len(preds),
        "acc": sum(p["y"] == p["pred"] for p in preds) / len(preds),
        "acc_no_ambiguous": _mean([1.0 if p["y"] == p["pred"] else 0.0 for p in preds if not p["amb"]]),
        "macro_f1": _mean([s["macro_f1"] for s in per_q.values()]),
        "bal_acc": _mean([s["bal_acc"] for s in per_q.values()]),
        "recall_no": _recall(preds, "no")[0],
        "n_no": _recall(preds, "no")[1],
        "na_precision": _precision(preds, "na")[0],
        "na_recall": _recall(preds, "na")[0],
        "n_na": _recall(preds, "na")[1],
        "gross_recall": _recall(gross, "yes")[0],
        "gross_precision": _precision(gross, "yes")[0],
        "n_gross": _recall(gross, "yes")[1],
        "acc_conf_ge_0_9": _mean([1.0 if p["y"] == p["pred"] else 0.0 for p in hi]),
        "share_conf_ge_0_9": len(hi) / len(preds),
        "acc_conf_lt_0_9": _mean([1.0 if p["y"] == p["pred"] else 0.0 for p in lo]),
        "brier": brier(preds),
        "per_question": per_q,
    }
    for field in ("lang", "channel"):
        vals = sorted({p[field] for p in preds if p.get(field)})
        out["by_" + field] = {v: _sub(preds, lambda p, v=v, f=field: p[f] == v, by) for v in vals}
    return out


def _sub(preds, cond, by):
    xs = [p for p in preds if cond(p)]
    groups = defaultdict(list)
    for p in xs:
        groups[by(p)].append((p["y"], p["pred"]))
    return {"n": len(xs), "acc": sum(p["y"] == p["pred"] for p in xs) / len(xs) if xs else None,
            "macro_f1": _mean([group_scores(v)["macro_f1"] for v in groups.values()])}


def fmt(x, pct=True):
    if x is None:
        return "—"
    return f"{100 * x:.1f}" if pct else f"{x:.3f}"


SUMMARY_COLS = [("n", "n", False), ("acc", "точн.", True), ("macro_f1", "macro-F1", True), ("bal_acc", "bal.acc", True),
                ("recall_no", "полн. «нет»", True), ("na_precision", "N/A точн.", True), ("na_recall", "N/A полн.", True),
                ("gross_recall", "полн. грубых", True), ("acc_conf_ge_0_9", "точн. conf≥0.9", True),
                ("share_conf_ge_0_9", "доля conf≥0.9", True), ("acc_conf_lt_0_9", "точн. conf<0.9", True), ("brier", "Brier", False)]


def summary_row(name, m):
    cells = []
    for key, _, pct in SUMMARY_COLS:
        v = m.get(key)
        cells.append(str(v) if key == "n" else fmt(v, pct))
    return f"| {name} | " + " | ".join(cells) + " |"


def summary_header(first="Модель"):
    return f"| {first} | " + " | ".join(c[1] for c in SUMMARY_COLS) + " |\n|" + "---|" * (len(SUMMARY_COLS) + 1)
