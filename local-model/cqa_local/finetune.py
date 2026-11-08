"""Быстрое дообучение под конкретный вопрос по решениям проверяющих (апелляциям).

Энкодеры и базовый решающий слой заморожены. Обучается адаптер решающего слоя (AdaptedDecision) — на каждого члена
ансамбля своя копия:
  • «ключевые слова» — 4 вектора в пространстве лексического сопоставления: что искать в репликах оператора;
  • детектор: максимум их совпадения в репликах оператора → добавка к логиту «да»;
  • сдвиг вектора вопроса и смещения вариантов.
Апелляции смещены к ошибкам модели (проверяющий исправляет то, что модель пропустила), поэтому исправления
взвешиваются так, чтобы их эффективная доля была не больше 1:3 к классу, который чаще предсказывает базовая модель.
Без этого адаптер выучивает априорную вероятность 50/50 и даёт много ложных срабатываний (см. REPORT.md).
Адаптер сохраняется под хешем нормализованного текста вопроса и применяется автоматически.
"""
from __future__ import annotations

import json
import time
from collections import Counter

import torch

from .batch import build, to_device
from .infer import ADAPTERS, Ensemble, adapter_id
from .model import AdaptedDecision
from .questions import option_keys, question_text

MIN_EXAMPLES = 5
TRAINABLE = {"kw", "kw_w", "kw_b", "qdelta", "obias"}


class FinetuneError(ValueError):
    pass


def finetune(ens: Ensemble, crit: dict, examples: list, time_budget=50.0, steps=200, lr=0.05, ratio=1 / 3, seed=0):
    """examples: [{record, events, offsets?, answer}] → информация об адаптере."""
    keys = option_keys(crit)
    exs = [e for e in examples if e.get("record") and str(e.get("answer")) in keys]
    if len(exs) < MIN_EXAMPLES:
        raise FinetuneError(f"нужно минимум {MIN_EXAMPLES} примеров с допустимым ответом ({', '.join(keys)}), получено {len(exs)}")
    t0 = time.time()
    torch.manual_seed(seed)
    preps = [ens.prep.dialog(e["record"], e.get("events") or [], e.get("offsets")) for e in exs]
    pairs = [(i, crit, str(e["answer"]), None, 1.0) for i, e in enumerate(exs)]
    tb, db, qb, _ = build(ens.prep, preps, pairs)
    tb, db, qb = to_device(tb, db, qb, ens.device)

    encoded = []
    with torch.no_grad():
        base_p = 0
        for m in ens.members:
            enc = m.encode(tb, db, qb, tokens=True)
            encoded.append(enc)
            base_p = base_p + torch.softmax(m.decide(*enc[:4], db, qb)[0], -1)
    n_opt = base_p.shape[1]
    major = int(torch.bincount(base_p.argmax(-1), minlength=n_opt).argmax())
    cnt = torch.bincount(qb.target, minlength=n_opt).float()
    w = torch.clamp(ratio * cnt[major].clamp(min=1) / cnt.clamp(min=1), max=1.0)
    w[major] = 1.0
    cw = w[qb.target]

    decisions, stats = [], []
    budget = time_budget / len(ens.members)
    for m, (U, g, tvec, S, zd) in zip(ens.members, encoded):
        dec = AdaptedDecision(m.cfg["d"], m.cfg["heads"], m.cfg["dropout"]).to(ens.device)
        dec.load_state_dict(m.decision.state_dict(), strict=False)
        with torch.no_grad():
            kw0 = m.question_tokens(tb, qb)
            dec.kw[: len(kw0)] = kw0
        for n, p in dec.named_parameters():
            p.requires_grad_(n in TRAINABLE)
        dec.train()
        opt = torch.optim.Adam([p for n, p in dec.named_parameters() if n in TRAINABLE], lr=lr)
        ts = time.time()
        with torch.no_grad():
            before = m.decide(U, g, tvec, S, db, qb, decision=dec, zd=zd)[0].argmax(-1)
        step = 0
        for step in range(1, steps + 1):
            logits, _ = m.decide(U, g, tvec, S, db, qb, decision=dec, zd=zd)
            ce = torch.nn.functional.cross_entropy(logits, qb.target, reduction="none")
            loss = (ce * cw).sum() / cw.sum() + 1e-3 * (dec.qdelta ** 2).sum()
            opt.zero_grad()
            loss.backward()
            opt.step()
            if time.time() - ts > budget:
                break
        dec.eval()
        with torch.no_grad():
            after = m.decide(U, g, tvec, S, db, qb, decision=dec, zd=zd)[0].argmax(-1)
        stats.append({"steps": step, "acc_before": (before == qb.target).float().mean().item(), "acc_after": (after == qb.target).float().mean().item()})
        decisions.append(dec)
    aid = adapter_id(crit)
    ADAPTERS.mkdir(parents=True, exist_ok=True)
    torch.save({"kind": "keyword-v1", "decisions": [{k: v.detach().cpu().half() for k, v in d.state_dict().items()} for d in decisions]}, ADAPTERS / f"{aid}.pt")
    info = {"id": aid, "question": question_text(crit), "name": crit.get("name"), "examples": len(exs),
            "answers": dict(Counter(str(e["answer"]) for e in exs)), "steps": [s["steps"] for s in stats],
            "class_weights": {keys[i]: round(float(w[i]), 3) for i in range(len(keys))},
            "train_acc_before": round(sum(s["acc_before"] for s in stats) / len(stats), 3),
            "train_acc_after": round(sum(s["acc_after"] for s in stats) / len(stats), 3),
            "seconds": round(time.time() - t0, 1), "created_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    (ADAPTERS / f"{aid}.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    ens.adapters[aid] = decisions
    return info
