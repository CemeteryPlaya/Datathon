"""Инференс ансамбля: вероятности по вариантам, уверенность, доказательства из внимания. Общий для predict, train, serve."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import torch

from . import MODEL_NAME, WEIGHTS
from .batch import Prep, build, to_device
from .model import QTYPES, AdaptedDecision, CQAModel, n_params
from .questions import level_values, question_key, question_type

WEIGHTS_FILE = WEIGHTS / f"{MODEL_NAME}.pt"
ADAPTERS = WEIGHTS / "adapters"


def adapter_id(crit: dict) -> str:
    return hashlib.sha1(question_key(crit).encode("utf-8")).hexdigest()[:16]


def evidence_from_attention(att: np.ndarray, roles: list, k=3, mass=0.8):
    """Топ реплик оператора/системы по вниманию → evidence; связный участок с основной массой внимания → checked_range."""
    n = len(roles)
    att = att[:n]
    cand = [i for i in range(n) if roles[i] in ("operator", "system")] or list(range(n))
    top = max(att[i] for i in cand)
    ev = sorted(sorted(cand, key=lambda i: -att[i])[:k])
    ev = [i for i in ev if att[i] >= 0.5 * top]
    lo = hi = int(np.argmax(att))
    total = float(att.sum()) or 1.0
    acc = float(att[lo])
    while acc / total < mass and (lo > 0 or hi < n - 1):
        left = att[lo - 1] if lo > 0 else -1
        right = att[hi + 1] if hi < n - 1 else -1
        if left >= right:
            lo -= 1
            acc += float(att[lo])
        else:
            hi += 1
            acc += float(att[hi])
    return ev, [lo, hi]


class Ensemble:
    def __init__(self, members: list, temps: dict | None = None, meta: dict | None = None, device="cpu"):
        self.members = [m.to(device).eval() for m in members]
        self.temps = temps or {}
        self.meta = meta or {}
        self.device = device
        self.prep = Prep()
        self.adapters: dict[str, list] = {}

    # ---------- сохранение
    def save(self, path: Path = WEIGHTS_FILE):
        path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({"cfg": self.members[0].cfg, "temps": self.temps, "meta": self.meta,
                    "members": [{k: v.half() if v.is_floating_point() else v for k, v in m.state_dict().items()} for m in self.members]}, path)

    @classmethod
    def load(cls, path: Path = WEIGHTS_FILE, device="cpu"):
        ck = torch.load(path, map_location="cpu", weights_only=True)
        members = []
        for sd in ck["members"]:
            m = CQAModel(**ck["cfg"])
            m.load_state_dict({k: v.float() if v.is_floating_point() else v for k, v in sd.items()})
            members.append(m)
        ens = cls(members, ck.get("temps"), ck.get("meta"), device)
        ens.load_adapters()
        return ens

    def n_params(self):
        return sum(n_params(m) for m in self.members)

    # ---------- адаптеры дообучения (решающий слой под конкретный вопрос)
    def load_adapters(self):
        self.adapters = {}
        if not ADAPTERS.exists():
            return
        for f in ADAPTERS.glob("*.pt"):
            try:
                ck = torch.load(f, map_location="cpu", weights_only=True)
                if ck.get("kind") != "keyword-v1" or len(ck["decisions"]) != len(self.members):
                    raise ValueError("формат адаптера не совпадает с текущей моделью")
                decs = []
                for m, sd in zip(self.members, ck["decisions"]):
                    d = AdaptedDecision(m.cfg["d"], m.cfg["heads"], m.cfg["dropout"])
                    d.load_state_dict({k: v.float() for k, v in sd.items()})
                    decs.append(d.to(self.device).eval())
                self.adapters[f.stem] = decs
            except Exception as e:  # старый или повреждённый адаптер не должен ронять сервис
                print(f"адаптер {f.name} пропущен: {e} — переобучите кнопкой «Дообучить»", flush=True)

    def adapter_info(self):
        out = []
        for f in sorted(ADAPTERS.glob("*.json")) if ADAPTERS.exists() else []:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        return out

    # ---------- предсказание
    @torch.no_grad()
    def raw(self, dialogs: list, questions: list, batch_dialogs=16, use_adapters=True):
        """dialogs: [(record, events, offsets)]; questions: [[crit, ...] по диалогу].
        → по диалогу список (probs по ключам вариантов без калибровки — массив, keys, attention)."""
        out = []
        for s in range(0, len(dialogs), batch_dialogs):
            chunk = dialogs[s:s + batch_dialogs]
            qchunk = questions[s:s + batch_dialogs]
            preps = [self.prep.dialog(r, e, o) for r, e, o in chunk]
            pairs = [(i, c, None, None, 1.0) for i, qs in enumerate(qchunk) for c in qs]
            if not pairs:
                out.extend([[] for _ in chunk])
                continue
            tb, db, qb, qs = build(self.prep, preps, pairs)
            tb, db, qb = to_device(tb, db, qb, self.device)
            ad_rows = {}
            if use_adapters and self.adapters:
                for p, (_, c, *_r) in enumerate(pairs):
                    aid = adapter_id(c)
                    if aid in self.adapters:
                        ad_rows.setdefault(aid, []).append(p)
            probs, atts = 0, 0
            for mi, m in enumerate(self.members):
                U, g, tvec, S, zd = m.encode(tb, db, qb, tokens=bool(ad_rows))
                logits, att = m.decide(U, g, tvec, S, db, qb)
                for aid, rows in ad_rows.items():
                    l2, a2 = m.decide(U, g, tvec, S, db, qb, decision=self.adapters[aid][mi], zd=zd)
                    idx = torch.tensor(rows, device=logits.device)
                    logits[idx] = l2[idx]
                    att[idx] = a2[idx]
                probs = probs + torch.softmax(logits, -1)
                atts = atts + att
            probs = (probs / len(self.members)).cpu().numpy()
            atts = (atts / len(self.members)).cpu().numpy()
            p = 0
            for i, qs_i in enumerate(qchunk):
                res = []
                for _ in qs_i:
                    k = qs[p].keys
                    res.append((probs[p, :len(k)], k, atts[p, :preps[i].n], pairs[p][1]))
                    p += 1
                out.append(res)
        return out

    def calibrate(self, probs: np.ndarray, crit: dict) -> np.ndarray:
        t = float(self.temps.get(question_type(crit), 1.0))
        p = np.clip(probs, 1e-6, 1.0) ** (1.0 / t)
        return p / p.sum()

    def answer(self, probs, keys, att, crit, roles):
        p = self.calibrate(probs, crit)
        best = int(np.argmax(p))
        ev, rng = evidence_from_attention(att, roles)
        res = {"choice": keys[best], "probabilities": {k: round(float(x), 4) for k, x in zip(keys, p)},
               "confidence": round(float(p[best]), 4), "evidence": ev, "checked_range": rng}
        lv = level_values(crit)
        if crit.get("type") == "scale" and lv:
            num = [(lv[k], float(x)) for k, x in zip(keys, p) if k in lv]
            z = sum(x for _, x in num) or 1.0
            res["score"] = round(sum(v * x for v, x in num) / z, 3)
        return res

    def predict(self, dialogs: list, questions: list, **kw):
        raw = self.raw(dialogs, questions, **kw)
        out = []
        for (rec, _, _), res in zip(dialogs, raw):
            roles = [r.get("speaker") for r in rec["transcript"]][:len(res[0][2]) if res else None]
            out.append([self.answer(p, k, a, c, roles) for p, k, a, c in res])
        return out


def default_device():
    return "cuda" if torch.cuda.is_available() else "cpu"


def qtype_names():
    return QTYPES
