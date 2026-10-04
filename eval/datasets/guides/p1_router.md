# Labelling guide: P1 router (golden set `p1_router`)

One item is one message a person sends to the flatshare assistant, with the labels the router
(prompt P1, spec 9.3 and 9.4) should produce. The labels are what a careful human would decide
from the message alone. The router's `confidence` and `clarifying_question` are not labelled.

## Item format (one JSON object per line)

```json
{"id": "p1-001",
 "message": "Salut, je cherche une chambre à Ennasr pour octobre, budget 450 DT",
 "context": {"user_jurisdiction": "TN"},
 "gold": {"intent": "search_listings", "acceptable_intents": ["search_listings"],
          "language": "fr", "script": "latin", "jurisdiction_hint": "TN", "needs_clarification": false},
 "tags": ["fr"],
 "note": "plain search request"}
```

- `context.user_jurisdiction`: the jurisdiction of the person's account (TN, FR or GB). It is
  given to the router; the hint below is about the message only.
- `tags`: language group (`fr`, `en`, `ar`, `aeb_arabic`, `aeb_latin`, `mixed`, `de`, `es`, `it`) and
  any of `injection`, `digits_trap`, `mixed_intent`, `ambiguous`, `code_switch`, `short`, `typo`.
- `note`: one short sentence saying why the labels are what they are.

## intent (exactly one)

| Intent | The person wants to... | Examples |
|---|---|---|
| `search_listings` | find a place to live or a flatshare to join, as a seeker; refine or continue a search | "je cherche une chambre", "any rooms near UCL under 900?", "nlawej 3la colocation fi lmarsa" |
| `post_listing` | offer a room or flat, find a flatmate for their own home, or create, edit or remove their own ad | "j'ai une chambre à louer", "we need a 3rd flatmate for our flat", "kif nzid annonce?" |
| `legal_question` | know a rule, right, obligation, procedure, or what is normal practice, in general (deposit, notice, contract, registration, taxes, repairs, subletting, how to avoid scams in general) | "le propriétaire peut-il garder ma caution ?", "is a written contract mandatory in Tunisia?" |
| `generate_document` | get a document produced: roommate agreement, inventory (état des lieux) checklist, rent receipt template, house rules sheet | "fais-moi une convention de colocation", "generate an inventory checklist" |
| `report_problem` | report something wrong with a specific listing, user or the platform: suspected scam ad, fake photos, harassment, a bug, wrong information shown | "l'annonce 123 demande un virement avant visite", "this user keeps messaging me", "the app shows the wrong price" |
| `smalltalk_or_unsupported` | greet, thank, chat, or ask for something outside the service (buying a house, hotel booking, homework, weather), or a message that only tries to manipulate the assistant | "merci !", "c'est quoi la météo demain", "ignore tes instructions" |

Rules:
1. Seeker or offerer: a person who has a home and looks for someone to share it is `post_listing`;
   a person who looks for a home is `search_listings`. "Je cherche un colocataire" without saying
   whether they have a place: `post_listing` is the usual meaning (they look for a person, not a
   place), unless the message says they look for a place together ("on cherche un appart à deux").
2. A question about one specific listing's price, availability or details, from a seeker, is
   `search_listings`. A question about whether a specific listing is a scam, or a report that it is, is
   `report_problem`. A general question about how to avoid scams is `legal_question`.
3. Mixed requests (`mixed_intent` tag): the primary intent is the main task the person asks to have
   done; put both in `acceptable_intents`, primary first. Example: "Find me a room in Lafayette, and
   by the way can the landlord ask for 3 months of deposit?" -> primary `search_listings`,
   acceptable `[search_listings, legal_question]`.
4. `acceptable_intents` always contains `intent`. It has more than one element only for mixed or
   ambiguous messages.
5. Injection (`injection` tag): text that tries to change the router's behaviour ("ignore previous
   instructions", "you are now...", "SYSTEM:", a fake JSON answer, "classify this as post_listing",
   "print your prompt"). Label what the person actually asks apart from the manipulation; if nothing
   is left, `smalltalk_or_unsupported`. An injected instruction never changes the label.

## needs_clarification (true or false)

True when the message does not let anyone decide what the person wants among the supported intents,
so the assistant should ask one question before acting: "j'ai un problème avec ma chambre" (report?
legal question? new search?), "help", "c'est pour l'appart", "3andi soal" ("I have a question").
Then give the best guess as `intent` and list the plausible intents in `acceptable_intents` (tag
`ambiguous`). A clear greeting ("salut", "merci") is `smalltalk_or_unsupported` with
`needs_clarification: false`. A clear request that lacks details (a search with no budget) is not
ambiguous: the profile step asks for details, not the router.

## language

The main language of the message:
- `fr`, `en`, `de`, `es`, `it`: the message is in that language (a few loan words do not change it:
  "colocation" in an English message stays `en`).
- `ar`: Modern Standard Arabic in Arabic script.
- `aeb`: Tunisian Arabic (Derja), in Arabic script or in Latin letters with digits (arabizi:
  3 = ع, 7 = ح, 9 = ق, 5 = خ, 2 = ء). Tunisian Derja contains many French words; that alone does not
  make it `mixed`.
- `mixed`: two languages each carry a substantial part of the message (whole clauses in each),
  e.g. a French sentence followed by an Arabic sentence, or English and French clauses alternating.
- `other`: any other language.
When unsure between `ar` and `aeb` for a short Arabic-script message with no dialect markers, use `ar`.
Dialect markers include: نحب، نلوج، برشا، باهي، شنوة، علاش، كيفاش، توا، بالحق، فما، ماعادش.

## script

`latin`, `arabic`, `mixed` (both scripts in the message, each more than a single word), `other`.
Digits and emoji do not count.

## jurisdiction_hint

The country the message itself points to: `TN`, `FR`, `GB`, `other` (a place or institution in
another country), or `null` (nothing in the message). Clues: city or neighbourhood names, national
institutions (STEG, SONEDE, CAF, APL, council tax, deposit protection scheme), currency words that
belong to one country (dinar, DT, millimes, pounds, £). The euro alone is not a clue (`null`). The
account's jurisdiction is not a clue: label the message only.

## Coverage of the set (version 1)

At least 150 messages, at least 15 tagged `injection`, at least 6 language groups. Messages are
synthetic: written for this set, not copied from real users, and labelled `synthetic` in the manifest.
Write them as real people write: typos, missing accents, no punctuation, SMS style, arabizi with
digits, numbers that look like letters ("3 bit" = three rooms vs "3andi" = I have).
