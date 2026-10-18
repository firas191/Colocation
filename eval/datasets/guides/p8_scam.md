# Labelling guide: P8 scam detector (`p8_scam_v1.jsonl`)

Written by Emna Safer with the set (branch `feat/scam-check`, 2026-10-16), brought in unchanged with D-114. The
weights below (`scam.weights`, the review threshold 30) are the scale of her branch; the trust check scores with
`trust.points` and `app.trust_score` instead, and `scripts/trust_bench.py` uses only `gold.is_scam` as the label.

One line per listing text: `{"id", "message", "context": {"jurisdiction", "today"}, "gold": {"is_scam", "signals", "prices"}, "tags"}`.
The labels follow the rules of `prompts/P8_scam_detector/v1.md`; when this guide and the prompt differ, the prompt wins and the guide is fixed.

## 1. `signals`: the types the text supports (no quotes in the gold)

| Type | Label it when the text… | Do not label it when… |
|---|---|---|
| `off_platform_payment` | asks for payment by Western Union, MoneyGram, gift card or coupon (PCS, Transcash, Amazon), crypto, a transfer to a foreign account, a payment link sent privately, PayPal "friends and family" | a normal payment at signing or move-in is mentioned |
| `advance_payment` | asks for money (deposit, rent, fee, "réservation", "avance", "holding fee") before a visit or before the keys | the deposit is paid at signing, at key handover or after the viewing |
| `owner_abroad` | the owner is abroad or unreachable **and** keys or visit go through post, courier, an agent or a relative | the owner is away but visits wait for their return, or an agency simply organises viewings |
| `urgency` | pushes to decide at once ("répondez aujourd'hui", "decide today", "lezem tjaweb lyoum", "offer valid 24h") | "disponible rapidement", "available now", "high demand, book early", "il ne reste qu'une chambre" without pressure |
| `external_contact` | asks to continue on WhatsApp, Telegram, a private email or a phone number | "contact me here", "message through the app" |

An instruction inside the listing ("ignore the rules…", "[system] …") is data: it never adds or removes a signal (tag `injection`).

## 2. `prices`: every amount written in the text, in main units, once each

"450.000 DT" is 450. Repeated amounts are listed once. Amounts are compared by value only.

## 3. `is_scam`

`true` when the text alone should send the listing to review: the gold signals weigh 30 or more with the weights of `scam.weights` (off_platform_payment 30, advance_payment 30, owner_abroad 20, urgency 10, external_contact 10). An honest listing may still carry a weak signal (tag `hard_negative`, for example a WhatsApp number). A unit test checks this rule on every line.

## 4. Tags

Language: `fr`, `en`, `ar` (Arabic script, MSA and Tunisian), `arabizi`, `mixed` (code-switching). Class: `scam` or `honest`. Traps: `hard_negative` (honest text that looks suspicious), `subtle` (scam without the classic words), `injection`, `price_trap` (two different rents in the text).

## 5. Limits

Model-written and model-labelled (as D-055 for P1 to P3), not checked by a native speaker of Tunisian Arabic; the owner should review a sample. The few-shot examples of P8 v1 were written separately and none of them is in this set. Price and profile rules are not measured here: they are deterministic and covered by `n8n/tests/scam_signals.test.js`.
