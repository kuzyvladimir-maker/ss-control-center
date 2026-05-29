# 📞 Call Center AI Agent

## Суть
Voice-канал customer service. AI-агент (Sarah) принимает входящие звонки от покупателей Amazon и Walmart, решает проблемы голосом в реальном времени, эскалирует Vladimir по критическим сценариям.

## Цель
Дать клиентам Salutem Solutions голосовой канал поддержки (mandatory toll-free per Walmart policy + customer expectation на Amazon), при этом масштабируемо через AI без найма штата операторов.

## Платформа (planned)
Voice AI: Vapi / Retell / Bland / ElevenLabs Conversational AI + Twilio (номер) + Claude (LLM) + Deepgram (STT) + ElevenLabs (TTS) + SS Control Center API + Telegram (escalations).

## Категории обращений (C1–C20)
- C1–C10 — наследованы из текстового CS (where is my order, damaged, frozen thawed, wrong item, refund, A-to-Z, Walmart escalation, negative review, quality, pre-purchase)
- C11 — Allergen / ingredient question
- C12 — 🚨 Health concern after eating (immediate escalate)
- C13 — Cancellation request
- C14 — Wholesale / B2B inquiry
- C15 — Subscribe & Save questions
- C16 — Duplicate charge / billing dispute
- C17 — Wrong address / address change
- C18 — Expired product complaint
- C19 — 🚨 Counterfeit / authenticity claim (escalate)
- C20 — 🚨 Legal / media threat (immediate escalate)

## Ключевые правила
- **Frozen thawed:** первая фраза агента — "don't eat it"
- **Carrier delay + Amazon:** направить на A-to-Z, НЕ direct refund (Buy Shipping Protection)
- **Health concern:** never admit fault, escalate Vladimir within hour
- **Legal threat:** refund + escalate, no apology that admits liability
- **"Speak to human":** не сопротивляться, connect

## Threshold matrix (refund authority)
| Range | Авторизация |
|---|---|
| < $30 | Auto |
| $30–$50 | Auto + log reason |
| $50–$100 | Requires SMS confirm Vladimir |
| > $100 | Hold + escalate |

## Запрещённые фразы
"Calm down", "That's our policy", "There's nothing I can do", "It's not my fault", "You should have...", промо-фразы Amazon-violation, "buddy/honey/babe"

## Связанные файлы
- `docs/CALL_CENTER_AI_AGENT_v1_0.md` — полный master prompt и knowledge base

## KPI
- First Call Resolution > 80%
- Average Handle Time 4–6 мин
- CSAT > 4.3 / 5
- Escalation Rate < 8%
- A-to-Z prevention rate > 60%
- Buy Shipping Protection retention > 80%

## 🔗 Связи
- **← Зависит от:** [Customer Hub](customer-hub.md), [Amazon SP-API](amazon-sp-api.md), [Walmart API](walmart-api.md), [Veeqo API](veeqo-api.md), [Telegram](telegram-notifications.md), [Claude AI](claude-ai.md)
- **⊂ Часть:** Customer Service модуль (text + voice)
- **→ Влияет на:** [Account Health](account-health.md) (A-to-Z prevention), [Feedback Manager](feedback-manager.md) (negative review prevention), [A-to-Z & Chargeback](atoz-chargeback.md)
- **⇔ Связь с:** [Frozen Analytics v2.0](frozen-analytics.md) (proactive risk → reactive voice support)
- **Бизнес-правило:** Voice agent НЕ принимает платежи (PCI compliance); НЕ создаёт заказы (только маркетплейсы); НЕ раскрывает информацию о других клиентах

## История
- 2026-05-23: v1.0 создан — full master prompt с 21 разделом, 20 категориями, 15+ возражениями, deescalation, anti-fraud, escalation protocol, KPI
