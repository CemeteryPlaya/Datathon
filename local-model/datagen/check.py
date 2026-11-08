"""Проверка датасета: валидность ответов по чек-листу, границы и роли доказательств, согласованность фактов и ответов.
  python check.py --data ../data --checklist ../../server/seed/checklist.default.json
"""
import argparse, json, collections

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--data", default="../data"); ap.add_argument("--checklist", default="../../server/seed/checklist.default.json")
    a = ap.parse_args()
    cl = json.load(open(a.checklist, encoding="utf-8")); crit = {c["id"]: c for c in cl["criteria"]}
    recs = {r["conversation_id"]: r for r in json.load(open(f"{a.data}/synth_dialogs.json", encoding="utf-8"))["data"]["records"]}
    errs = collections.Counter(); n = 0
    for line in open(f"{a.data}/synth_labels.jsonl", encoding="utf-8"):
        l = json.loads(line); r = recs[l["conversation_id"]]; T = r["transcript"]; n += 1
        for cid, v in l["answers"].items():
            c = crit[cid]
            ok = (v in [x["value"] for x in c["levels"]]) if c["type"] == "scale" and v != "na" else v in ("yes", "no", "na")
            if v == "na" and not c["na_allowed"]: ok = False
            if not ok: errs[f"недопустимый ответ {cid}={v}"] += 1
            for i in l["evidence"].get(cid, []):
                if not 0 <= i < len(T): errs[f"доказательство вне диалога {cid}"] += 1
        for k, f in l["facts"].items():
            if any(not 0 <= i < len(T) for i in f["ev"]): errs[f"факт {k}: индекс вне диалога"] += 1; continue
            if f["v"] is not True or not f["ev"]: continue
            role = "operator" if k.startswith("op_") and k != "op_closed_silently" else "client" if k.startswith("client_") and k != "client_formulated_request" else None
            if role and not any(T[i]["speaker"] == role for i in f["ev"]): errs[f"факт {k}: среди доказательств нет реплики {role}"] += 1
        F = {k: f["v"] for k, f in l["facts"].items()}; A = l["answers"]
        if (A["c08"] == "yes") != any(F.get(k) is True for k in ("gross_insult", "gross_paid_bypass", "gross_confidential")): errs["c08 ≠ факты"] += 1
        if (A["c07"] == "na") != (F.get("chat_disconnected") is True): errs["c07 N/A ≠ обрыв"] += 1
        if A["c01"] == "yes" and not (F["op_greeted"] and F["op_introduced"]): errs["c01 ≠ факты"] += 1
        if A["c03"] == "yes" and not F.get("identity_verified"): errs["c03=yes без подтверждения"] += 1
        if F.get("op_sneezed") and not any(w in T[i]["text"].lower() for i in l["facts"]["op_sneezed"]["ev"] for w in ("апчх", "achoo", "sneez", "чихн", "түшкір")): errs["чих без маркера"] += 1
        ops = [t for t in T if t["speaker"] == "operator"]
        if not ops: errs["нет реплик оператора"] += 1
    print(f"диалогов: {n}")
    print("ошибок нет" if not errs else "\n".join(f"  {k}: {v}" for k, v in errs.most_common()))

if __name__ == "__main__":
    main()
