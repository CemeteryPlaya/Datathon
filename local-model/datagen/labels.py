"""Ответы по стартовому чек-листу (server/seed/checklist.default.json, версия 1) из сценария генератора.

Это РАЗМЕТКА данных, а не код оценщика: правила повторяют PDF-чек-лист и соглашения data/gt/README.md.
Если стартовый чек-лист поменяется, правите только этот файл. Новые критерии размечаются через факты (questions.py).
"""

def default_answers(s, d, checklist):
    F = d.facts
    ev = lambda k: list(F.get(k, {}).get("ev", []))
    first_op = F["op_greeted"]["ev"][:1]
    ans, evd, amb = {}, {}, []
    noreq = s["no_request"]
    ai = getattr(d, "answer_idx", None)
    qi = getattr(d, "q_idx", None)

    # 01 Установление контакта: поздоровался на языке клиента И представился в первом ответе
    ans["c01"] = "yes" if F["op_greeted"]["v"] and F["op_introduced"]["v"] else "no"; evd["c01"] = first_op

    # 02 Выявление потребности
    if noreq: ans["c02"], evd["c02"] = "na", []
    elif s["clar"] == "asked": ans["c02"], evd["c02"] = "yes", ev("op_asked_clarification")
    elif s["clar"] == "skipped": ans["c02"], evd["c02"] = "no", [x for x in [qi, ai] if x is not None]
    elif s["reask_known"]: ans["c02"], evd["c02"] = "no", ev("op_reasked_known")
    else: ans["c02"], evd["c02"] = "na", [x for x in [qi] if x is not None]

    # 03 Идентификация
    if noreq or s["id"] == "na": ans["c03"], evd["c03"] = "na", [x for x in [qi] if x is not None]
    elif s["id"] == "proper": ans["c03"], evd["c03"] = "yes", ev("identity_verified") + ev("protected_disclosed")
    else: ans["c03"], evd["c03"] = "no", ev("protected_disclosed") + ev("identity_verified")

    # 04 Корректная и полная консультация
    if noreq: ans["c04"], evd["c04"] = "na", ev("chat_disconnected")
    else:
        if s["quality"] == 15 and s["ending"] == "disconnect": amb.append("c04")   # клиент ушёл сразу после второго вопроса
        ans["c04"] = s["quality"]; evd["c04"] = [x for x in [ai] if x is not None] + ev("client_asked_followup") + ev("op_answered_followup")

    # 05 Эмпатия и клиентоориентированность
    bad = (s["complaint"] and s["complaint_reaction"] == "ignore") or s["rude"] or F.get("op_blamed_client", {}).get("v") is True or F.get("op_caps", {}).get("v") is True
    ans["c05"] = "no" if bad else "yes"
    evd["c05"] = ev("client_complained") + ev("op_reacted_to_complaint") + ev("op_rude") + ev("op_blamed_client") + ev("op_caps")
    if s["complaint"] and s["complaint_reaction"] == "ignore" and ai is not None: evd["c05"].append(ai)
    if F.get("gross_insult", {}).get("v") is True or F.get("op_informal_ty", {}).get("v") is True: amb.append("c05")

    # 06 Управление диалогом, скорость и грамотность
    v, e = 10, []
    if s["mgmt"] == "wait_unwarned": v, e = min(v, 7), e + ev("explicit_wait")
    if s["mgmt"] == "typos": v, e = min(v, 7), e + ev("op_typos")
    if s["reask_known"]: v, e = min(v, 7), e + ev("op_reasked_known")
    if s["mgmt"] == "offtopic": v, e = min(v, 4), e + ev("client_had_to_repeat")
    if s["mgmt"] == "incoherent": v, e = min(v, 0), e + ev("op_incoherent")
    if s["mgmt"] == "wait_warned": e += ev("op_warned_wait")
    ans["c06"], evd["c06"] = v, e
    if any(F.get(k, {}).get("v") is True for k in ("op_caps", "op_slang", "op_code_switch")): amb.append("c06")

    # 07 Завершение
    if s["ending"] == "disconnect": ans["c07"], evd["c07"] = "na", ev("chat_disconnected")
    else:
        ans["c07"] = "yes" if s["ending"] == "full" else "no"
        evd["c07"] = ev("op_said_goodbye") + ev("op_summary_or_offer") + ev("op_closed_silently")

    # 08 Грубые ошибки
    g = [k for k in ("gross_insult", "gross_paid_bypass", "gross_confidential") if F.get(k, {}).get("v") is True]
    ans["c08"] = "yes" if g else "no"; evd["c08"] = sum((ev(k) for k in g), [])

    ids = [c["id"] for c in checklist["criteria"]]
    assert set(ans) == set(ids), f"чек-лист не совпадает со стартовым: {ids}"
    return ans, {k: sorted(set(v)) for k, v in evd.items()}, amb
