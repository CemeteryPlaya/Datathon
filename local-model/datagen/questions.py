# Банк вопросов. Каждый вопрос — объект в формате критерия чек-листа (как его сохраняет редактор),
# чтобы модель на обучении видела ровно то, что увидит в работе: name, description, type, levels,
# polarity, na_allowed, na_condition. Несколько формулировок на вопрос — чтобы модель опиралась на смысл,
# а не запоминала строку.
#   kind: "criterion" — критерии стартового чек-листа (ответы считаются по правилам из labels.py)
#         "atomic"    — атомарные факты (метка = факт генератора)
#         "novel"     — «новые» критерии вроде «штраф за чихание» (метка = факт генератора)
#   split: "train" — можно учить; "zero_shot" — НЕ показывать на обучении, только для проверки обобщения

def yn(name, description, polarity="positive", na_allowed=False, na_condition=""):
    return dict(name=name, description=description, type="yesno", polarity=polarity, na_allowed=na_allowed, na_condition=na_condition)

QUESTIONS = []

def q(qid, kind, source, wordings, split="train"):
    QUESTIONS.append(dict(qid=qid, kind=kind, source=source, split=split, wordings=wordings))

# --- Альтернативные формулировки критериев стартового чек-листа (первая берётся из checklist.default.json в генераторе)
ALT_CRITERIA = {
 "c01": [yn("Приветствие и представление", "Да — в первой реплике оператор поздоровался на языке клиента и назвал своё имя."),
         yn("Greeting", "Yes — in the first reply the agent greeted the customer in the customer's language and introduced themselves.")],
 "c02": [yn("Уточнение запроса", "Да — прежде чем ответить, оператор выяснил недостающие детали и не переспрашивал уже известное.", na_allowed=True, na_condition="Сведений от клиента сразу хватало для ответа."),
         yn("Clarifying the need", "Yes — the agent asked for missing details before answering and did not re-ask what the customer already said.", na_allowed=True, na_condition="The customer's first message already had everything needed.")],
 "c03": [yn("Проверка личности", "Да — личность клиента подтверждена ДО того, как оператор раскрыл данные счёта или выполнил защищённое действие.", na_allowed=True, na_condition="Запрос не касался данных счёта и защищённых действий."),
         yn("Identity check", "Yes — the customer's identity was verified before any account data was disclosed or protected action taken.", na_allowed=True, na_condition="The request did not need identification.")],
 "c05": [yn("Вежливость и эмпатия", "Да — оператор вежлив и, если клиент жаловался, отреагировал именно на его проблему."),
         yn("Empathy", "Yes — the agent was polite and, if the customer complained, responded to their specific problem.")],
 "c07": [yn("Корректное завершение", "Да — в конце оператор подвёл итог или предложил помощь и попрощался. Одно «пожалуйста» или «до свидания» не засчитывается.", na_allowed=True, na_condition="Клиент ушёл или связь оборвалась до того, как можно было завершить."),
         yn("Closing", "Yes — the agent summarised or offered further help and said goodbye. A bare 'you're welcome' or 'bye' is not enough.", na_allowed=True, na_condition="The chat was cut off before it could be closed.")],
 "c08": [yn("Грубое нарушение", "Да — оскорбление клиента, предложение платных услуг в обход компании или раскрытие конфиденциальной информации.", polarity="negative"),
         yn("Critical violation", "Yes — insulting the customer, offering paid services bypassing the company, or disclosing confidential information.", polarity="negative")],
}
SCALE_ALT = {
 "c04": [dict(name="Качество консультации", description="Насколько полно и правильно оператор решил вопрос клиента.", type="scale", polarity="positive",
              na_allowed=True, na_condition="Клиент так и не сформулировал запрос.",
              levels=[dict(value=0, description="Ответа нет или он ошибочный."), dict(value=5, description="Общая подсказка, клиенту непонятно, что делать."),
                      dict(value=10, description="Закрыта часть запроса."), dict(value=15, description="Главное решено, упущена мелочь."),
                      dict(value=20, description="Всё закрыто или дан правильный следующий шаг.")])],
 "c06": [dict(name="Ясность и ведение диалога", description="Понятность ответов, их порядок и предупреждение, если клиенту пришлось ждать.", type="scale", polarity="positive",
              na_allowed=False, na_condition="",
              levels=[dict(value=0, description="Реплики бессвязны или противоречат друг другу."), dict(value=4, description="Клиенту пришлось переспрашивать."),
                      dict(value=7, description="Один заметный сбой."), dict(value=10, description="Всё ясно; об ожидании предупредил.")])],
}

# --- Атомарные факты
A = [
 ("op_greeted", [yn("Оператор поздоровался", "Да — в первой своей реплике оператор поздоровался с клиентом на его языке."),
                 yn("Agent greeted", "Yes — the agent's first message contains a greeting in the customer's language.")]),
 ("op_introduced", [yn("Оператор назвал имя", "Да — в первой реплике оператор представился (назвал имя, в т.ч. скрытое как [Имя скрыто])."),
                    yn("Операторға аты", "Иә — оператор бірінші репликасында атын айтты.")]),
 ("op_greeting_wrong_language", [yn("Приветствие не на языке клиента", "Да — оператор поздоровался не на том языке, на котором пишет клиент.", polarity="negative")]),
 ("client_formulated_request", [yn("Клиент сформулировал запрос", "Да — клиент описал, что ему нужно (а не только попросил оператора).")]),
 ("needed_clarification", [yn("Не хватало деталей", "Да — по первому сообщению клиента не хватало сведений, чтобы точно ответить.")]),
 ("op_asked_clarification", [yn("Оператор задал уточняющий вопрос", "Да — оператор спросил у клиента недостающие детали до ответа.")]),
 ("op_reasked_known", [yn("Переспросил известное", "Да — оператор спросил то, что клиент уже сообщил.", polarity="negative")]),
 ("identity_required", [yn("Нужна идентификация", "Да — запрос касается данных конкретного счёта или защищённого действия.")]),
 ("identity_verified", [yn("Личность подтверждена", "Да — в диалоге есть подтверждение личности клиента (системное сообщение или подтверждение оператора).")]),
 ("protected_disclosed", [yn("Раскрыты данные счёта", "Да — оператор сообщил данные счёта клиента или выполнил защищённое действие.")]),
 ("client_asked_followup", [yn("Был дополнительный вопрос", "Да — после ответа клиент задал ещё один вопрос.")]),
 ("op_answered_followup", [yn("Ответил на дополнительный вопрос", "Да — оператор ответил на дополнительный вопрос клиента.", na_allowed=True, na_condition="Дополнительного вопроса не было.")]),
 ("client_complained", [yn("Клиент выразил недовольство", "Да — клиент жаловался или описывал неудобство.")]),
 ("op_reacted_to_complaint", [yn("Реакция на жалобу", "Да — оператор отреагировал на конкретную жалобу клиента.", na_allowed=True, na_condition="Клиент не жаловался.")]),
 ("op_rude", [yn("Грубый тон", "Да — оператор отвечал пренебрежительно или резко.", polarity="negative")]),
 ("explicit_wait", [yn("Клиент ждал", "Да — оператор уходил проверять информацию или ставил клиента на удержание.")]),
 ("op_warned_wait", [yn("Предупредил об ожидании", "Да — перед ожиданием оператор предупредил клиента.", na_allowed=True, na_condition="Ожидания не было.")]),
 ("client_had_to_repeat", [yn("Клиент повторил вопрос", "Да — клиенту пришлось повторить вопрос, потому что оператор ответил невпопад.", polarity="negative")]),
 ("op_incoherent", [yn("Противоречивые ответы", "Да — реплики оператора бессвязны или противоречат друг другу.", polarity="negative")]),
 ("op_summary_or_offer", [yn("Итог или предложение помощи", "Да — в конце оператор подвёл итог или предложил дальнейшую помощь.")]),
 ("op_said_goodbye", [yn("Оператор попрощался", "Да — оператор попрощался с клиентом.")]),
 ("chat_disconnected", [yn("Обрыв", "Да — клиент ушёл или связь прервалась.")]),
 ("op_closed_silently", [yn("Закрыл чат молча", "Да — оператор закрыл чат без прощания.", polarity="negative")]),
 ("gross_insult", [yn("Оскорбление клиента", "Да — оператор оскорбил клиента.", polarity="negative")]),
 ("gross_paid_bypass", [yn("Платные услуги в обход компании", "Да — оператор предложил свои платные услуги мимо компании.", polarity="negative")]),
 ("gross_confidential", [yn("Раскрытие конфиденциального", "Да — оператор раскрыл чужие данные или внутреннюю информацию компании.", polarity="negative")]),
]
for fact, ws in A:
    q("a_" + fact, "atomic", fact, ws)

# --- «Новые» критерии: то, что заказчик может добавить в редакторе. Часть — zero_shot для проверки обобщения.
N = [
 ("op_sneezed", "train", [yn("Штраф за чихание", "Да — оператор чихнул в чат с клиентом (например, «апчхи»). Чих клиента не учитывается.", polarity="negative"),
                          yn("Плохо, если оператор чихнул", "Да = нарушение: в репликах оператора есть чихание.", polarity="negative"),
                          yn("Sneezing penalty", "Yes — the agent sneezed in the chat ('achoo'). The customer sneezing does not count.", polarity="negative")]),
 ("op_coughed", "zero_shot", [yn("Кашель в чате", "Да — оператор написал, что кашляет («кхе-кхе», *кашляет*).", polarity="negative")]),
 ("op_eating", "zero_shot", [yn("Еда на рабочем месте", "Да — оператор сообщил клиенту, что ест или обедает во время диалога.", polarity="negative")]),
 ("op_competitor", "zero_shot", [yn("Упоминание конкурентов", "Да — оператор хвалил или упоминал другую компанию-конкурента.", polarity="negative")]),
 ("op_emoji", "train", [yn("Эмодзи в ответах", "Да — оператор использовал эмодзи.", polarity="negative"),
                        yn("Emoji usage", "Yes — the agent used emoji in their messages.", polarity="negative")]),
 ("op_slang", "train", [yn("Сленг и жаргон", "Да — оператор писал на сленге или неформально («короче», «ща»).", polarity="negative")]),
 ("op_informal_ty", "train", [yn("Обращение на «ты»", "Да — оператор обратился к клиенту на «ты» (или фамильярно).", polarity="negative")]),
 ("op_rate_request", "train", [yn("Просьба об оценке", "Да — оператор попросил клиента оценить его работу.")]),
 ("op_link", "train", [yn("Ссылка на инструкцию", "Да — оператор отправил клиенту ссылку.")]),
 ("op_personal_talk", "train", [yn("Личные темы", "Да — оператор рассказывал о себе и личных делах.", polarity="negative")]),
 ("op_callback_promise", "train", [yn("Обещание перезвонить", "Да — оператор пообещал, что клиенту перезвонят или свяжутся позже.")]),
 ("op_apologized", "train", [yn("Извинение", "Да — оператор извинился перед клиентом за ожидание или неудобства.")]),
 ("op_code_switch", "train", [yn("Смешение языков", "Да — оператор смешивал языки в одной реплике.", polarity="negative")]),
 ("op_blamed_client", "train", [yn("Обвинение клиента", "Да — оператор обвинил клиента в проблеме.", polarity="negative")]),
 ("op_caps", "train", [yn("Капс", "Да — оператор писал заглавными буквами (крик).", polarity="negative")]),
 ("op_typos", "train", [yn("Много опечаток", "Да — в реплике оператора много опечаток.", polarity="negative")]),
]
for fact, split, ws in N:
    q("n_" + fact, "novel", fact, ws, split)
