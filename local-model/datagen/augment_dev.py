"""Аугментация РЕАЛЬНЫХ диалогов DEV с эталонной разметкой (data/gt, data/gt-fresh, data/gt-holdout).

В реальный диалог вставляется поведение с известным эффектом (чих оператора, эмодзи, капс, грубое нарушение,
чих клиента как отвлекающий фактор и т.п.). Ответы стартового чек-листа берутся из эталона и меняются только там,
где вставка их явно меняет. Так модель видит «новые» критерии на настоящем распределении диалогов.

  python augment_dev.py --dev ../../data/DEV.json --gt ../../data --copies 6 --out ../data
Копии диалогов из gt-holdout получают split=test и не должны попадать в обучение.
"""
import argparse, json, random, os, glob
from banks import B

SPLIT = {"gt": "train", "gt-fresh": "val", "gt-holdout": "test"}
GROSS = {"gross_insult": "gross_insult", "gross_paid": "gross_paid_bypass", "gross_conf": "gross_confidential"}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dev", default="../../data/DEV.json")
    ap.add_argument("--gt", default="../../data")
    ap.add_argument("--copies", type=int, default=6)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--out", default="../data")
    a = ap.parse_args()
    rng = random.Random(a.seed)
    dev = {r["conversation_id"]: r for r in json.load(open(a.dev, encoding="utf-8"))["data"]["records"]}
    recs, labs = [], []
    for folder, split in SPLIT.items():
        for f in sorted(glob.glob(os.path.join(a.gt, folder, "*.json"))):
            gt = json.load(open(f, encoding="utf-8"))
            base = dev[gt["conversation_id"]]
            for k in range(a.copies):
                r, l = augment(base, gt, rng, k)
                l["split"] = split; l["base_set"] = folder
                recs.append(r); labs.append(l)
    os.makedirs(a.out, exist_ok=True)
    json.dump(dict(error="", isSuccess=True, data=dict(dataset_group_id="AUG-DEV", total_records=len(recs), records=recs)),
              open(f"{a.out}/aug_dev_dialogs.json", "w", encoding="utf-8"), ensure_ascii=False)
    with open(f"{a.out}/aug_dev_labels.jsonl", "w", encoding="utf-8") as fo:
        for l in labs: fo.write(json.dumps(l, ensure_ascii=False) + "\n")
    print(f"аугментировано: {len(recs)} диалогов из {len(recs) // a.copies} эталонных")

def augment(base, gt, rng, k):
    lang = base["language"]; L = B[lang]
    T = [dict(t) for t in base["transcript"]]
    ans = dict(gt["answers"]); amb = list(gt.get("ambiguous", []))
    facts = {}
    op = [i for i, t in enumerate(T) if t["speaker"] == "operator"]
    cl = [i for i, t in enumerate(T) if t["speaker"] == "client" and (not op or i > op[0])]
    applied = []

    def insert_after(i, speaker, text):
        """Новая реплика сразу после i с той же меткой времени (индексы после i сдвигаются)."""
        T.insert(i + 1, dict(timestamp=T[i]["timestamp"], speaker=speaker, text=text))
        for f in facts.values(): f["ev"] = [x + 1 if x > i else x for x in f["ev"]]
        return i + 1

    kinds = list(L["novel"].keys()) + ["op_caps", "op_typos", "client_novel", "gross"]
    n = rng.choice([1, 1, 2])
    for kind in rng.sample(kinds, n):
        op = [i for i, t in enumerate(T) if t["speaker"] == "operator"]
        if not op: break
        j = rng.choice(op)
        if kind == "op_caps":
            T[j]["text"] = T[j]["text"].upper(); facts[kind] = dict(v=True, ev=[j]); ans_set(ans, "c05", "no"); amb.append("c06")
        elif kind == "op_typos":
            T[j]["text"] = typo(T[j]["text"], rng); facts[kind] = dict(v=True, ev=[j]); ans["c06"] = min(ans["c06"], 7) if isinstance(ans.get("c06"), int) else ans.get("c06")
        elif kind == "op_emoji":
            T[j]["text"] += " " + rng.choice(L["novel"][kind]); facts[kind] = dict(v=True, ev=[j])
        elif kind == "client_novel":
            cl = [i for i, t in enumerate(T) if t["speaker"] == "client" and i > op[0]] or [op[0]]
            ck = rng.choice(list(L["client_novel"].keys()))
            i = insert_after(rng.choice(cl), "client", rng.choice(L["client_novel"][ck])); facts[ck] = dict(v=True, ev=[i])
        elif kind == "gross":
            gk = rng.choice(list(GROSS.keys()))
            i = insert_after(j, "operator", rng.choice(L[gk])); facts[GROSS[gk]] = dict(v=True, ev=[i]); ans["c08"] = "yes"
            if gk == "gross_insult": amb.append("c05")
        else:
            i = insert_after(j, "operator", rng.choice(L["novel"][kind])); facts[kind] = dict(v=True, ev=[i])
            if kind == "op_blamed_client": ans_set(ans, "c05", "no")
            if kind in ("op_slang", "op_code_switch"): amb.append("c06")
            if kind == "op_informal_ty": amb.append("c05")
        applied.append(kind)
    # все остальные «новые» факты — отрицательные (в исходном DEV их нет)
    for key in list(L["novel"].keys()) + ["op_caps", "op_typos"] + list(L["client_novel"].keys()):
        facts.setdefault(key, dict(v=False, ev=[]))
    cid = f"{base['conversation_id']}-aug{k}"
    rec = dict(base, conversation_id=cid, transcript=T)
    lab = dict(conversation_id=cid, base_id=base["conversation_id"], answers=ans, ambiguous=sorted(set(amb)), applied=applied,
               facts=dict(sorted(facts.items())), labeled_by="augment+" + gt.get("labeled_by", "gt"))
    return rec, lab

def ans_set(ans, cid, v):
    if cid in ans: ans[cid] = v

def typo(text, rng):
    w = text.split()
    for i, x in enumerate(w):
        if len(x) > 3 and rng.random() < 0.45:
            j = rng.randrange(0, len(x) - 1); w[i] = x[:j] + x[j + 1] + x[j] + x[j + 2:]
    return " ".join(w)

if __name__ == "__main__":
    main()
