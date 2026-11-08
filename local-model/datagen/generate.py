"""Генератор синтетических диалогов поддержки с точной разметкой.

Каждый диалог собирается из сценария (тема, язык, канал, поведение оператора и клиента), поэтому
правильный ответ по каждому критерию и реплики-доказательства известны заранее.

  python generate.py --n 6000 --seed 7 --out ../data
"""
import argparse, json, random, re, copy, os, datetime, collections
from topics import TOPICS
from banks import B
from questions import QUESTIONS, ALT_CRITERIA, SCALE_ALT
from labels import default_answers

RU_FEMALE = {"Алина","Мадина","Айгерим","Наталья","Дина","Камила","Асель","Виктория","Жанна"}
FEM2MASC = [("Отправила","Отправил"),("отправила","отправил"),("Подала","Подал"),("подала","подал"),("Подключила","Подключил"),
            ("подключила","подключил"),("я могла","я мог"),("*чихнула*","*чихнул*"),("Буду благодарна","Буду благодарен")]
CLIENT_M2F = [("нашёл","нашла"),("Прошёл","Прошла"),("подтвердил.","подтвердила."),("Понял","Поняла"),("спрашивал","спрашивала"),
              ("запутался","запуталась"),("Подавал","Подавала"),("не покупал","не покупала")]
CLIENT_F2M = [("Подтвердила","Подтвердил")]

FILLER = {
 "RU": [("client", "Алло?"), ("operator", "Да-да, слышу вас."), ("client", "Секунду, записываю."), ("operator", "Угу, конечно."), ("client", "Вы меня слышите?"), ("operator", "Да, слышу хорошо.")],
 "KZ": [("client", "Алло?"), ("operator", "Иә, естіп тұрмын."), ("client", "Бір секунд, жазып алайын."), ("operator", "Жарайды."), ("client", "Мені естіп тұрсыз ба?"), ("operator", "Иә, жақсы естимін.")],
 "EN": [("client", "Hello?"), ("operator", "Yes, I can hear you."), ("client", "One sec, writing it down."), ("operator", "Sure, take your time."), ("client", "Can you hear me?"), ("operator", "Yes, loud and clear.")],
}
SECOND = {"RU": "И ещё вопрос: ", "KZ": "Тағы бір сұрақ: ", "EN": "One more question: "}

VOICE = {
 "RU": dict(op_open="{greet} Компания Фридом брокер, меня зовут {name}, чем могу помочь?", op_open_noname="{greet} Фридом брокер, слушаю вас.",
            id_req="Для этого назовите, пожалуйста, ИИН и кодовое слово.", id_ok="Спасибо, данные совпадают, личность подтверждена."),
 "KZ": dict(op_open="{greet} Фридом брокер компаниясы, менің атым {name}, қалай көмектесе аламын?", op_open_noname="{greet} Фридом брокер, тыңдап тұрмын.",
            id_req="Ол үшін ЖСН мен кодтық сөзді айтыңызшы.", id_ok="Рақмет, деректер сәйкес келеді, жеке басыңыз расталды."),
 "EN": dict(op_open="{greet} Freedom Broker, my name is {name}, how can I help?", op_open_noname="{greet} Freedom Broker, how can I help?",
            id_req="For that, please tell me your ID number and code word.", id_ok="Thank you, the details match, your identity is verified."),
}

OPENER = {"RU": "Чем могу помочь?", "KZ": "Қалай көмектесе аламын?", "EN": "How can I help you?"}
LATE_ID = {"RU": "И для дальнейшей работы со счётом подтвердите, пожалуйста, личность через push-уведомление.",
           "KZ": "Шотпен әрі қарай жұмыс істеу үшін push-хабарлама арқылы жеке басыңызды растаңызшы.",
           "EN": "Also, for further account actions please confirm your identity via the push notification."}

def pick(rng, xs): return rng.choice(xs)
def wpick(rng, d): 
    keys, w = zip(*d.items()); return rng.choices(keys, weights=w, k=1)[0]

class Dialog:
    def __init__(self, lang, channel, rng):
        self.lang, self.channel, self.rng = lang, channel, rng
        self.T, self.t = [], 0.0
        self.facts = {}
    def add(self, speaker, text, dt=None, tag=None):
        if dt is None: dt = self.rng.uniform(5, 40)
        self.t += dt
        self.T.append(dict(speaker=speaker, text=text, t=self.t, tag=tag))
        return len(self.T) - 1
    def fact(self, key, value, ev=()):
        f = self.facts.setdefault(key, dict(v=value, ev=[]))
        f["v"] = value
        for i in ev:
            if i is not None and i not in f["ev"]: f["ev"].append(i)

def fix_gender(text, lang, gender, who):
    if lang != "RU": return text
    pairs = (FEM2MASC if gender == "m" else []) if who == "op" else (CLIENT_M2F if gender == "f" else CLIENT_F2M)
    for a, b in pairs: text = text.replace(a, b)
    return text

# ---------- шум распознавания речи для звонков
PROTECT = re.compile(r"апчх|achoo|sneez|чих|түшкір|кхе|cough|кашл|жөтел|https?://|[😊👍🙂🙏]", re.I)

def asr_noise(text, rng, level=0.05):
    words = text.split()
    out = []
    for w in words:
        if PROTECT.search(w): out.append(w); continue
        r = rng.random()
        if r < level and len(w) > 3:
            i = rng.randrange(1, len(w) - 1); w = w[:i] + w[i+1:]                      # пропущенная буква
        elif r < level * 1.6 and len(w) > 3:
            i = rng.randrange(0, len(w) - 1); w = w[:i] + w[i+1] + w[i] + w[i+2:]      # перестановка
        elif r < level * 2.0 and out:
            out[-1] = out[-1] + w; continue                                            # склейка слов
        elif r < level * 2.3:
            out.append(w)                                                              # повтор слова
        out.append(w)
    s = " ".join(out)
    if rng.random() < 0.6: s = re.sub(r"[!«»]", "", s)
    if rng.random() < 0.3: s = s.lower()
    return s

def typos(text, rng):
    words = text.split()
    for i, w in enumerate(words):
        if len(w) > 3 and rng.random() < 0.45:
            j = rng.randrange(0, len(w) - 1); words[i] = w[:j] + w[j+1] + w[j] + w[j+2:]
    return " ".join(words)

# ---------- сценарий
def sample_scenario(rng, lang, channel):
    topic = pick(rng, TOPICS)
    s = dict(topic=topic["id"], lang=lang, channel=channel)
    s["no_request"] = rng.random() < 0.05
    s["q_full"] = topic["needs_clar"] and rng.random() < 0.35
    s["greeting"] = wpick(rng, {"ok": 0.76, "no_greet": 0.07, "no_intro": 0.08, "none": 0.04, "wrong_lang": 0.05 if channel == "agent chat" else 0})
    s["clar"] = ("asked" if rng.random() < 0.68 else "skipped") if topic["needs_clar"] and not s["q_full"] else "na"
    s["reask_known"] = s["clar"] != "asked" and rng.random() < 0.06
    s["id"] = wpick(rng, {"proper": 0.72, "before": 0.14, "never": 0.14}) if topic["needs_id"] else "na"
    s["quality"] = wpick(rng, {20: 0.52, 15: 0.12, 10: 0.13, 5: 0.11, 0: 0.12})
    if s["clar"] == "skipped": s["quality"] = min(s["quality"], 10)
    if s["id"] in ("before", "never"): s["quality"] = rng.choice([20, 15])
    s["followup"] = s["quality"] == 15 or (s["quality"] == 20 and rng.random() < 0.3)
    s["complaint"] = rng.random() < 0.27
    s["complaint_reaction"] = ("empathy" if rng.random() < 0.62 else "ignore") if s["complaint"] else "na"
    s["rude"] = rng.random() < 0.04
    s["mgmt"] = wpick(rng, {"clean": 0.70, "wait_warned": 0.12, "wait_unwarned": 0.06, "typos": 0.04 if channel == "agent chat" else 0,
                            "offtopic": 0.06, "incoherent": 0.03})
    s["ending"] = wpick(rng, {"full": 0.42, "bye_only": 0.17, "polite_only": 0.12, "silent_close": 0.08 if channel == "agent chat" else 0.02,
                              "offer_no_bye": 0.05, "disconnect": 0.12})
    s["gross"] = wpick(rng, {"none": 0.86, "insult": 0.045, "paid": 0.05, "conf": 0.045})
    novel_keys = list(B[lang]["novel"].keys()) + ["op_caps"]
    s["novel"] = [k for k in novel_keys if rng.random() < 0.05][:2]
    s["client_novel"] = [k for k in B[lang]["client_novel"] if rng.random() < 0.05]
    simple = [t["id"] for t in TOPICS if not t["needs_id"] and not t["needs_clar"] and t["id"] != topic["id"]]
    s["extra_topic"] = rng.choice(simple) if rng.random() < 0.15 else None
    s["filler"] = rng.choice([0, 1, 2, 3, 4]) if channel == "voice call" else 0
    if s["no_request"]:
        s.update(extra_topic=None, clar="na", reask_known=False, id="na", quality="na", followup=False, mgmt="clean", ending="disconnect", gross="none")
    return s

def build(s, rng, idx):
    lang, ch = s["lang"], s["channel"]
    L = B[lang]; topic = next(t for t in TOPICS if t["id"] == s["topic"]); TT = topic[lang]
    voice = ch == "voice call"
    d = Dialog(lang, ch, rng)
    name = pick(rng, L["names"])
    op_g = ("f" if name in RU_FEMALE else "m") if lang == "RU" else "f"
    cl_g = rng.choice("mf")
    OP = lambda text, dt=None, tag=None: d.add("operator", fix_gender(text, lang, op_g, "op"), dt if dt is not None else rng.uniform(15, 70), tag)
    CL = lambda text, dt=None, tag=None: d.add("client", fix_gender(text, lang, cl_g, "cl"), dt if dt is not None else rng.uniform(6, 35), tag)
    SY = lambda text, dt=None: d.add("system", text, dt if dt is not None else rng.uniform(1, 4))
    BOT = lambda text, dt=None: d.add("bot", text, dt if dt is not None else rng.uniform(1, 3))

    q_text = pick(rng, TT["q_full"]) if s["q_full"] else pick(rng, TT["q"])
    complaint_text = pick(rng, L["complaint"])

    # ---------- приветствие оператора
    def opening(content):
        g, intro = pick(rng, L["greet"]), pick(rng, L["intro"]).format(name=name)
        other = rng.choice([x for x in ("RU", "KZ", "EN") if x != lang])
        gw, iw = pick(rng, B[other]["greet"]), pick(rng, B[other]["intro"]).format(name=name)
        parts = {"ok": [g, intro], "no_greet": [intro], "no_intro": [g], "none": [], "wrong_lang": [gw, iw]}[s["greeting"]]
        return " ".join(parts + ([content] if content else []))
    greeted = s["greeting"] in ("ok", "no_intro"); introduced = s["greeting"] in ("ok", "no_greet")

    # ---------- начало: бот или IVR
    first_op = None
    if voice:
        for x in rng.sample(L["voice_sys"][:1] + B["EN"]["voice_sys"][:1], 1): SY(x, 0)
        BOT(pick(rng, L["ivr"]), rng.uniform(8, 15)); CL({"RU": "2", "KZ": "1", "EN": "3"}[lang] if rng.random() < 0.8 else rng.choice("0123"), rng.uniform(2, 4))
        BOT(L["bot_consent"][0], rng.uniform(6, 12)); SY(L["voice_sys"][1]); SY(L["voice_sys"][2], rng.uniform(5, 15))
        V = VOICE[lang]
        masked = rng.random() < 0.6
        nm = L["masked_name"] if masked else name
        if s["greeting"] in ("ok", "no_greet"):
            txt = V["op_open"].format(greet=pick(rng, L["greet"]) if s["greeting"] == "ok" else "", name=nm).strip()
        else:
            txt = V["op_open_noname"].format(greet=pick(rng, L["greet"]) if s["greeting"] == "no_intro" else "").strip()
        first_op = OP(txt, rng.uniform(3, 8))
        if s["no_request"]:
            CL(pick(rng, L["client_ok"]))
        else:
            ci = CL(q_text + (" " + complaint_text if s["complaint"] else ""), rng.uniform(3, 10)); d.q_idx = ci
            if s["complaint"]: d.fact("client_complained", True, [ci])
    else:
        if s["no_request"]:
            CL(pick(rng, L["no_request"]), 0)
            BOT(L["bot_greet"][0]); BOT(L["bot_consent"][0], 1); BOT(pick(rng, L["bot_confirm"]))
            CL(pick(rng, L["client_yes"]), rng.uniform(3, 6)); BOT(pick(rng, L["bot_wait"]))
        else:
            direct = rng.random() < 0.2
            qt = q_text if q_text.rstrip()[-1:] in ".?!" else q_text.rstrip() + "."
            d.q_idx = CL(qt + " " + pick(rng, L["ask_operator"]) if direct else q_text, 0)
            BOT(L["bot_greet"][0]); BOT(L["bot_consent"][0], 1)
            if not direct:
                BOT(TT["bot"], rng.uniform(3, 8)); CL(pick(rng, L["ask_operator"]), rng.uniform(10, 40))
            BOT(pick(rng, L["bot_confirm"])); CL(pick(rng, L["client_yes"]), rng.uniform(3, 6)); BOT(pick(rng, L["bot_wait"]))
        SY(pick(rng, L["sys_escalation"]))
        if s["complaint"]:
            ci = CL(complaint_text, rng.uniform(5, 30)); d.fact("client_complained", True, [ci])
        for k in s["client_novel"]:
            if rng.random() < 0.5: d.fact(k, True, [CL(pick(rng, L["client_novel"][k]))])

    # реакция на жалобу и грубость — в первом содержательном ответе
    prefix = []
    if s["complaint"] and s["complaint_reaction"] == "empathy":
        prefix.append(pick(rng, L["empathy"]).format(problem=TT["problem"]))
    if s["rude"]: prefix.append(pick(rng, L["rude"]))

    def first_or_next(content, tag=None):
        """Первая реплика оператора в чате несёт приветствие; дальше — обычные реплики."""
        nonlocal first_op, prefix
        txt = " ".join(prefix + [content]); used = bool(prefix); prefix = []
        if first_op is None and not voice:
            first_op = OP(opening(txt), rng.uniform(20, 150), tag)
            i = first_op
        else:
            i = OP(txt, None, tag)
        if used:
            if s["complaint"] and s["complaint_reaction"] == "empathy": d.fact("op_reacted_to_complaint", True, [i])
            if s["rude"]: d.fact("op_rude", True, [i])
        return i

    if s["no_request"]:
        i = first_or_next(OPENER[lang])
        d.fact("client_formulated_request", False, [i])
        di = SY(pick(rng, L["sys_client_ended"] if voice else L["sys_disconnect"]), rng.uniform(20, 90))
        d.fact("chat_disconnected", True, [di])
        return finish(d, s, first_op, greeted, introduced, topic)

    d.fact("client_formulated_request", True)
    d.fact("needed_clarification", s["clar"] in ("asked", "skipped"))

    # ---------- уточнение / повторный вопрос
    if s["clar"] == "asked":
        i = first_or_next(TT["clar_q"]); d.fact("op_asked_clarification", True, [i]); CL(TT["clar_a"])
    elif s["clar"] == "skipped":
        d.fact("op_asked_clarification", False)
    if s["reask_known"]:
        i = first_or_next(pick(rng, L["reask"])); d.fact("op_reasked_known", True, [i])
        CL(rng.choice({"RU": ["Я же уже написал: ", "Я же написала: "], "KZ": ["Жоғарыда жаздым ғой: "], "EN": ["I already wrote it: "]}[lang]) + q_text)

    # ---------- идентификация до ответа
    def verify(late=False):
        if late and not voice:
            a = OP(LATE_ID[lang]); CL(pick(rng, L["client_id_ok"]), rng.uniform(30, 90)); b = SY(pick(rng, L["sys_identity"]))
            return [a, b]
        if voice:
            a = OP(VOICE[lang]["id_req"]); CL(L["masked_pd"], rng.uniform(5, 15)); b = OP(VOICE[lang]["id_ok"], rng.uniform(3, 10))
            return [a, b]
        a = first_or_next(pick(rng, L["id_request"])); CL(pick(rng, L["client_id_ok"]), rng.uniform(30, 90)); b = SY(pick(rng, L["sys_identity"]))
        return [a, b]
    d.fact("identity_required", topic["needs_id"])
    if s["id"] == "proper":
        ev = verify(); d.fact("identity_verified", True, ev)

    # ---------- сбой в ведении диалога до ответа
    if s["mgmt"] == "offtopic":
        i = first_or_next(pick(rng, L["offtopic"])); r = CL(pick(rng, L["client_repeat"]).format(q=pick(rng, TT["q"])))
        d.fact("client_had_to_repeat", True, [i, r])
    if s["mgmt"] == "incoherent":
        i = first_or_next(pick(rng, L["incoherent"])); r = CL(pick(rng, L["client_confused"]))
        d.fact("op_incoherent", True, [i, r])
    if s["mgmt"] == "wait_warned":
        i = first_or_next(pick(rng, L["wait_warn"]))
        if rng.random() < 0.6: SY(pick(rng, L["sys_hold"]), 3); SY(pick(rng, L["sys_unhold"]), rng.uniform(60, 200))
        else: d.t += rng.uniform(60, 180)
        d.fact("explicit_wait", True, [i]); d.fact("op_warned_wait", True, [i]); prefix.insert(0, pick(rng, L["wait_back"]))
    if s["mgmt"] == "wait_unwarned":
        if first_op is None and not voice: first_or_next(pick(rng, L["polite_only_start"]))
        h = SY(pick(rng, L["sys_hold"]), rng.uniform(5, 15)); SY(pick(rng, L["sys_unhold"]), rng.uniform(90, 240))
        d.fact("explicit_wait", True, [h]); d.fact("op_warned_wait", False, [h])

    # ---------- ответ по существу
    qv = s["quality"]
    if s["id"] in ("before", "never"): ans = TT["protected"]
    elif topic["needs_id"] and s["id"] == "proper" and qv in (20, 15): ans = TT["protected"]
    else: ans = {20: TT["main"], 15: TT["main"], 10: TT["partial"], 5: pick(rng, L["vague"]), 0: rng.choice([TT["wrong"], pick(rng, L["dunno"])])}[qv]
    if s["mgmt"] == "typos": ans = typos(ans, rng)
    ai = first_or_next(ans, tag="answer")
    if s["mgmt"] == "typos": d.fact("op_typos", True, [ai])
    if ans == TT.get("protected") and topic["needs_id"]: d.fact("protected_disclosed", True, [ai])
    d.answer_idx = ai
    if s["id"] == "before":
        ev = verify(late=True); d.fact("identity_verified", True, ev)

    # реакция клиента
    if qv in (20, 15):
        if s["followup"]:
            fi = CL(TT["q2"]); d.fact("client_asked_followup", True, [fi])
            if qv == 20:
                si = OP(TT["sec"]); d.fact("op_answered_followup", True, [si]); CL(pick(rng, L["client_thanks"]))
            else:
                d.fact("op_answered_followup", False, [fi])   # оператор пропустил второстепенный вопрос
        else:
            CL(pick(rng, L["client_thanks"]))
    else:
        CL(pick(rng, L["client_ok"]))

    # ---------- второй вопрос на другую тему (длиннее диалог; полный ответ — оценка консультации не меняется)
    if s.get("extra_topic"):
        t2 = next(t for t in TOPICS if t["id"] == s["extra_topic"])[lang]
        CL(SECOND[lang] + pick(rng, t2["q"])); OP(t2["main"]); CL(pick(rng, L["client_thanks"]))
    if voice and s.get("filler"):
        for _ in range(s["filler"]):
            j = rng.randrange(0, len(FILLER[lang]) - 1, 2)
            d.add(FILLER[lang][j][0], FILLER[lang][j][1], rng.uniform(2, 8)); d.add(FILLER[lang][j + 1][0], FILLER[lang][j + 1][1], rng.uniform(1, 4))

    # ---------- грубые нарушения
    if s["gross"] != "none":
        gi = OP(pick(rng, L[{"insult": "gross_insult", "paid": "gross_paid", "conf": "gross_conf"}[s["gross"]]]))
        d.fact({"insult": "gross_insult", "paid": "gross_paid_bypass", "conf": "gross_confidential"}[s["gross"]], True, [gi])
        CL(pick(rng, L["client_ok"]))

    # ---------- новые поведения
    for k in s["novel"]:
        op_idx = [i for i, r in enumerate(d.T) if r["speaker"] == "operator"]
        if k == "op_caps":
            j = rng.choice(op_idx); d.T[j]["text"] = d.T[j]["text"].upper(); d.fact(k, True, [j])
        elif k == "op_emoji":
            j = rng.choice(op_idx); d.T[j]["text"] += " " + pick(rng, L["novel"][k]); d.fact(k, True, [j])
        elif k in ("op_sneezed", "op_coughed") and rng.random() < 0.4:
            j = rng.choice(op_idx); d.T[j]["text"] = pick(rng, L["novel"][k]) + " " + d.T[j]["text"]; d.fact(k, True, [j])
        else:
            j = OP(fix_gender(pick(rng, L["novel"][k]), lang, op_g, "op")); d.fact(k, True, [j])
    for k in s["client_novel"]:
        if k not in d.facts: d.fact(k, True, [CL(pick(rng, L["client_novel"][k]))])

    # ---------- завершение
    e = s["ending"]
    if e == "disconnect":
        di = SY(pick(rng, L["sys_client_ended"] if voice else L["sys_disconnect"]), rng.uniform(10, 60)); d.fact("chat_disconnected", True, [di])
    else:
        bye = pick(rng, L["goodbye"])
        if e == "full":
            mid = rng.choice([[pick(rng, L["summary"])], [pick(rng, L["offer"])], [pick(rng, L["summary"]), pick(rng, L["offer"])]])
            i = OP(" ".join(mid + [bye])); d.fact("op_summary_or_offer", True, [i]); d.fact("op_said_goodbye", True, [i])
        elif e == "bye_only":
            i = OP(" ".join(([pick(rng, L["polite_only"])] if rng.random() < 0.5 else []) + [bye])); d.fact("op_said_goodbye", True, [i]); d.fact("op_summary_or_offer", False, [i])
        elif e == "polite_only":
            i = OP(pick(rng, L["polite_only"])); d.fact("op_said_goodbye", False, [i]); d.fact("op_summary_or_offer", False, [i])
        elif e == "offer_no_bye":
            i = OP(pick(rng, L["offer"])); d.fact("op_summary_or_offer", True, [i]); d.fact("op_said_goodbye", False, [i])
        elif e == "silent_close":
            i = SY(pick(rng, L["sys_op_closed"]), rng.uniform(20, 60)); d.fact("op_closed_silently", True, [i]); d.fact("op_said_goodbye", False, [i])
        if e != "silent_close" and rng.random() < 0.5:
            if rng.random() < 0.5: CL(pick(rng, L["client_bye"]))
            SY(pick(rng, L["sys_client_ended"] if voice else L["sys_op_closed"]), rng.uniform(5, 30))
    return finish(d, s, first_op, greeted, introduced, topic)

def finish(d, s, first_op, greeted, introduced, topic):
    lang, ch, rng = d.lang, d.channel, d.rng
    d.fact("op_greeted", greeted, [first_op]); d.fact("op_introduced", introduced, [first_op])
    d.fact("op_greeting_wrong_language", s["greeting"] == "wrong_lang", [first_op])
    for k in ("op_asked_clarification", "op_reasked_known", "identity_verified", "protected_disclosed", "client_asked_followup", "client_complained",
              "op_rude", "explicit_wait", "client_had_to_repeat", "op_incoherent", "chat_disconnected", "op_closed_silently",
              "gross_insult", "gross_paid_bypass", "gross_confidential", "op_typos", "op_caps"):
        d.facts.setdefault(k, dict(v=False, ev=[]))
    for k in list(B[lang]["novel"].keys()) + list(B[lang]["client_novel"].keys()):
        d.facts.setdefault(k, dict(v=False, ev=[]))
    d.facts.setdefault("op_answered_followup", dict(v="na", ev=[]))
    d.facts.setdefault("op_reacted_to_complaint", dict(v=("na" if not s["complaint"] else False), ev=[]))
    d.facts.setdefault("op_warned_wait", dict(v="na", ev=[]))
    if ch == "voice call":
        for r in d.T:
            if r["speaker"] in ("client", "operator") and not r["text"].startswith("["): r["text"] = asr_noise(r["text"], rng)
    first_op_idx = first_op
    op_idx = [i for i, r in enumerate(d.T) if r["speaker"] == "operator"]
    d.last_op = op_idx[-1] if op_idx else None
    return d, first_op_idx

def fmt_ts(sec, ch, base):
    if ch == "voice call":
        t = base + datetime.timedelta(seconds=sec)
        return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond * 10 + random.randrange(10):07d}"[:7] + "+00:00"
    m, s_ = divmod(int(sec), 60)
    return f"{m:02d}:{s_:02d}"

def make(i, rng, lang, ch, checklist):
    s = sample_scenario(rng, lang, ch)
    d, first_op = build(s, rng, i)
    base = datetime.datetime(2026, 10, 1, 9) + datetime.timedelta(days=rng.randrange(0, 40), minutes=rng.randrange(0, 600))
    cid = f"syn-{lang.lower()}-{'v' if ch == 'voice call' else 'c'}-{i:05d}"
    rec = dict(conversation_id=cid, channel=ch, language=lang,
               transcript=[dict(timestamp=fmt_ts(r["t"], ch, base), speaker=r["speaker"], text=r["text"]) for r in d.T],
               audio_url=None)
    ans, ev, amb = default_answers(s, d, checklist)
    lab = dict(conversation_id=cid, answers=ans, evidence=ev, ambiguous=amb,
               facts={k: v for k, v in sorted(d.facts.items())}, scenario={k: v for k, v in s.items()}, labeled_by="generator")
    return rec, lab

# ---------- пары «диалог × вопрос» для обучения
def make_pairs(lab, rng, checklist, bank):
    out = []
    by_id = {c["id"]: c for c in checklist["criteria"]}
    for cid, a in lab["answers"].items():
        alts = ALT_CRITERIA.get(cid, []) + SCALE_ALT.get(cid, [])
        w = 0 if not alts or rng.random() < 0.6 else rng.randrange(1, len(alts) + 1)
        out.append(dict(d=lab["conversation_id"], q="crit_" + cid, w=w, y=a, ev=lab["evidence"].get(cid, [])))
    facts = lab["facts"]
    cand = [q for q in bank if q["kind"] in ("atomic", "novel") and q["split"] == "train" and q["source"] in facts]
    pos = [q for q in cand if facts[q["source"]]["v"] is True]
    neg = [q for q in cand if q not in pos]
    chosen = rng.sample(pos, min(len(pos), 3)) + rng.sample(neg, min(len(neg), 3))
    for q in chosen:
        v = facts[q["source"]]["v"]
        y = "na" if v == "na" else ("yes" if v else "no")
        out.append(dict(d=lab["conversation_id"], q=q["qid"], w=rng.randrange(len(q["wordings"])), y=y, ev=facts[q["source"]]["ev"]))
    return out

def bank_with_checklist(checklist):
    bank = []
    for c in checklist["criteria"]:
        base = {k: c[k] for k in ("name", "description", "type", "na_allowed", "na_condition") if k in c}
        base["polarity"] = "negative" if c.get("kind") == "gross" or c.get("polarity") == "negative" else "positive"
        if c["type"] == "scale": base["levels"] = c["levels"]
        bank.append(dict(qid="crit_" + c["id"], kind="criterion", source=c["id"], split="train",
                         wordings=[base] + ALT_CRITERIA.get(c["id"], []) + SCALE_ALT.get(c["id"], [])))
    return bank + QUESTIONS

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=6000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="../data")
    ap.add_argument("--checklist", default="../../server/seed/checklist.default.json")
    ap.add_argument("--sample", type=int, default=150, help="сколько диалогов положить в data/SYNTH.json для просмотра в UI")
    a = ap.parse_args()
    rng = random.Random(a.seed); random.seed(a.seed)
    checklist = json.load(open(a.checklist, encoding="utf-8"))
    os.makedirs(a.out, exist_ok=True)
    bank = bank_with_checklist(checklist)
    json.dump(dict(checklist=dict(id=checklist["id"], version=checklist["version"]), questions=bank),
              open(f"{a.out}/question_bank.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    recs, labs = [], []
    for i in range(a.n):
        lang = rng.choices(["RU", "KZ", "EN"], weights=[0.5, 0.25, 0.25])[0]
        ch = "voice call" if rng.random() < (0.14 if lang == "RU" else 0.06) else "agent chat"
        r, l = make(i, rng, lang, ch, checklist)
        # сплит по сценарию: test 10%, val 10%
        l["split"] = rng.choices(["train", "val", "test"], weights=[0.8, 0.1, 0.1])[0]
        recs.append(r); labs.append(l)

    json.dump(dict(error="", isSuccess=True, data=dict(dataset_group_id="SYNTH-FULL", total_records=len(recs), records=recs)),
              open(f"{a.out}/synth_dialogs.json", "w", encoding="utf-8"), ensure_ascii=False)
    with open(f"{a.out}/synth_labels.jsonl", "w", encoding="utf-8") as f:
        for l in labs: f.write(json.dumps(l, ensure_ascii=False) + "\n")
    files = {sp: open(f"{a.out}/pairs_{sp}.jsonl", "w", encoding="utf-8") for sp in ("train", "val", "test")}
    npairs = collections.Counter()
    for l in labs:
        for p in make_pairs(l, rng, checklist, bank):
            files[l["split"]].write(json.dumps(p, ensure_ascii=False) + "\n"); npairs[l["split"]] += 1
    # zero-shot пары: «новые» критерии, которых не было на обучении — только на test-диалогах
    with open(f"{a.out}/pairs_zero_shot.jsonl", "w", encoding="utf-8") as f:
        for l in labs:
            if l["split"] != "test": continue
            for q in bank:
                if q["split"] != "zero_shot": continue
                v = l["facts"].get(q["source"], dict(v=False, ev=[]))
                f.write(json.dumps(dict(d=l["conversation_id"], q=q["qid"], w=0, y="yes" if v["v"] is True else "no", ev=v["ev"]), ensure_ascii=False) + "\n")
                npairs["zero_shot"] += 1
    for f in files.values(): f.close()

    # небольшая выборка для UI и для сверки с API-оценщиком (npm run accuracy -- --gt local-model/data/gt-synth)
    sample = rng.sample(range(len(recs)), min(a.sample, len(recs)))
    json.dump(dict(error="", isSuccess=True, data=dict(dataset_group_id="SYNTH", total_records=len(sample), records=[recs[i] for i in sample])),
              open(f"{a.out}/SYNTH.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.makedirs(f"{a.out}/gt-synth", exist_ok=True)
    for i in sample:
        l = labs[i]
        json.dump(dict(conversation_id=l["conversation_id"], answers=l["answers"], ambiguous=l["ambiguous"], note="", labeled_by="generator"),
                  open(f"{a.out}/gt-synth/{l['conversation_id']}.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    stats(recs, labs, npairs, a.out)

def stats(recs, labs, npairs, out):
    st = dict(dialogs=len(recs), pairs=dict(npairs),
              by_language=dict(collections.Counter(r["language"] for r in recs)),
              by_channel=dict(collections.Counter(r["channel"] for r in recs)),
              by_split=dict(collections.Counter(l["split"] for l in labs)),
              by_topic=dict(collections.Counter(l["scenario"]["topic"] for l in labs)),
              turns=dict(min=min(len(r["transcript"]) for r in recs), max=max(len(r["transcript"]) for r in recs),
                         mean=round(sum(len(r["transcript"]) for r in recs) / len(recs), 1)),
              answers={}, facts_true={})
    for l in labs:
        for c, a in l["answers"].items():
            st["answers"].setdefault(c, collections.Counter())[str(a)] += 1
        for k, v in l["facts"].items():
            if v["v"] is True: st["facts_true"][k] = st["facts_true"].get(k, 0) + 1
    st["answers"] = {c: dict(v) for c, v in sorted(st["answers"].items())}
    st["facts_true"] = dict(sorted(st["facts_true"].items()))
    maj = sum(max(v.values()) for v in st["answers"].values()); tot = sum(sum(v.values()) for v in st["answers"].values())
    st["majority_baseline_pct"] = round(maj / tot * 100, 1)
    json.dump(st, open(f"{out}/stats.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(st, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    main()
