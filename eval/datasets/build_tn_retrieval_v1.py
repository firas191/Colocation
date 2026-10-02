# Source of eval/datasets/tn_retrieval_v1.jsonl: `python eval/datasets/build_tn_retrieval_v1.py [out.jsonl]` writes it.
import json
def S(k, a, b=None): return {"source_key": k, "start": a, "end": b if b is not None else a}
J7 = "tn-coc-jurisite-727-738"; J40="tn-coc-jurisite-740-746"; J48="tn-coc-jurisite-748-757"; J58="tn-coc-jurisite-758-766"
J67="tn-coc-jurisite-767-790"; J91="tn-coc-jurisite-791-804"; AR="tn-coc-ar-cawtar"; L76="tn-loi-76-35-recueil"
LDP="tn-lo-2004-63-fr"; CD="tn-cdet-2017"; PF="tn-profiscal-det-ch7-2006"; NO="tn-notaire-tunisienumerique"
DW="tn-diwan-location"; CY="tn-cyriljarnias-location"; HO="tn-houni-colocation-tunis"; JU="tn-justice-questions-civiles"
LP="tn-lapresse-arnaque-sousse"; LO="gl-123loger-arnaques"; W6="tn-web6-inpdp"; MH="tn-mehat-logement-locatif-2014"

# shared spans
coc772 = S(J67, "Art. 772. - Le preneur a le droit de sous-louer", "même à titre gratuit.")
ar772 = S(AR, "للمكتري أن يكري لغيره ما اكتراه", "ولا إحالة الانتفاع ولو مجانا.")
l76_32 = S(L76, "Est interdite sans l'accord du propriétaire toutes souslocation", "définis à l'article 1er.")
coc797 = S(J91, "Le bailleur ne peut résoudre la location, encore qu'il déclare vouloir occuper", "la maison louée.")
ar797 = S(AR, "لا يسوغ لمكري محل أن يفسخ عقدة كرائه ولو كان مراده أن يسكنه بنفسه.")
l76_10 = S(L76, "Le droit au maintien n'est pas opposable au propriétaire de nationalité tunisienne qui veut reprendre son immeuble pour l'occuper lui-même ou le faire occuper par ses ascendants ou ses descendants et qui justifie", "ou à ses besoins professionnels.")
no_reprise = S(NO, "Si le bailleur souhaite récupérer son bien, notamment pour y habiter", "au moins trois mois avant la fin du contrat.")
coc743 = S(J40, "Dans les baux d'immeubles, le preneur n'est tenu des réparations locatives", "sont à la charge du bailleur.")
coc743_paint = S(J40, "Le blanchiment des chambres, la restauration des peintures", "sont à la charge du bailleur.")
ar743 = S(AR, "الإصلاحات الجزئية ومصاريف الحفظ لا تلزم المكتري", "فإن ذلك كله على المكري.")
reg_cdet = S(CD, "6°) les actes sous seing privé portant mutation de jouissance d'immeubles ou de fonds de commerce ;")
reg_pf = S(PF, "Immeubles destinés à l’habitation : Les locations d’immeubles à usage d’habitation s’enregistrent au tarif de 5 dinars par page.")
reg_no = S(NO, "Il a rappelé que la location résidentielle ne nécessite pas d’enregistrement", "moyennant une taxe symbolique.")
reg_dw = S(DW, "Le contrat de location s’enregistre à un taux de 1%", "(habitation ou agriculture).")
inc_no = S(NO, "Mais il a souligné qu’en cas de paiement accepté par le bailleur", "généralement avec une hausse de 10%.")
inc_76 = S(L76, "Le montant des loyers des locaux d'habitation visés à l'article 1er sera majoré au maximum de 5% par an")
inc_mh = S(MH, "Hors le cas des logements soumis à la loi 1976, qui aujourd’hui représentent", "à la loi de l’offre et de la demande.")
coc781 = S(J67, "S'il n'a pas été fait d'état des lieux ou de description de la chose, le preneur est présumé", "en bon état.")
ar781 = S(AR, "إن لم تحرر قائمة بينهما حمل المستأجر على أنه استلم العين المأجورة على الحالة المرضية.")
cy_edl = S(CY, "En l’absence d’état des lieux initial, la présomption joue en faveur du bailleur", "est donc crucial.")
coc788 = S(J67, "Le bailleur a le droit de rétention, pour les loyers échus", "pour assurer ses droits.")
ar788 = S(AR, "يجوز للمؤجر أن يحبس الأمتعة وغيرها من الأشياء المنقولة", "فليس له حق في استرجاع ما خرج من الأشياء.")
ju788 = S(JU, "Il est permis au propriétaire d'opérer un droit de rétention", "(Article 788 du code des contrats et des obligations).")
scam_lp = S(LP, "Cet individu a affirmé qu’il allait leur louer un appartement meublé", "résidant dans un gouvernorat voisin.")
scam_lo = S(LO, "Un bailleur peut effectivement être absent, mais dans ce cas, il mandate une agence", "est un drapeau rouge.")
scam_pay = S(LO, "Le paiement ne devrait jamais être demandé pour « valider un dossier » ou « réserver une visite ».", "Le paiement intervient à la signature du contrat, pas avant.")
dp27 = S(LDP, "A l’exclusion de cas prévus par la présente loi ou les lois en vigueur, le traitement des données à caractère personnel ne peut être effectué qu’avec le consentement exprès et écrit", "peut, à tout moment, se rétracter.")
coc803 = S(J91, "Le bail n'est point résolu par la mort du preneur", "ni par celle du bailleur.")

Q = []
def q(i, text, lang, spans, tags=(), note=""):
    Q.append({"id": f"tn-{i:02d}", "query": text, "language": lang, "jurisdiction": "TN",
              "gold": {"spans": spans, "note": note}, "tags": list(tags)})

# ---- French: direct and article-specific lookups
q(1, "Qu'est-ce que le louage de choses selon le Code des obligations et des contrats ?", "fr",
  [S(J7, "Le louage de choses est un contrat par lequel", "s'oblige à lui payer.")], note="COC 727")
q(2, "Un bail d'habitation de deux ans doit-il obligatoirement être fait par écrit ?", "fr",
  [S(J7, "Néanmoins, les baux d'immeubles et de droits immobiliers doivent être constatés par écrit", "dans les conditions déterminées par la loi.")],
  note="COC 729: écrit si plus d'un an, sinon durée indéterminée")
q(3, "Qui doit payer les petites réparations dans un appartement loué, par exemple une vitre ou une serrure cassée ?", "fr",
  [coc743], note="COC 743-744")
q(4, "Le propriétaire peut-il faire des travaux urgents pendant la location, et si je ne peux plus utiliser le logement ?", "fr",
  [S(J48, "Toutefois, le bailleur a le droit de faire, malgré l'opposition du preneur", "résultant du défaut d'avis préalable.")], note="COC 749: plus de trois jours")
q(5, "À quelle date dois-je payer le loyer si le contrat ne dit rien ?", "fr",
  [S(J67, "Le preneur doit payer le prix au terme fixé par le contrat", "Les frais du paiement sont à la charge du preneur.")], note="COC 768")
q(6, "Je pars trois mois à l'étranger et je n'utilise pas l'appartement : dois-je quand même payer tout le loyer ?", "fr",
  [S(J67, "Le preneur est tenu de payer le prix par entier", "en déduction de ce qui lui serait dô par le preneur.")], note="COC 771")
q(7, "Ai-je le droit de sous-louer une chambre de mon appartement à un colocataire sans l'accord du propriétaire ?", "fr",
  [coc772, l76_32, S(HO, "La sous-location n’est autorisée que si le contrat de bail le prévoit expressément", "s’expose à la résiliation du bail.")],
  tags=["contradiction"], note="COC 772 permet sauf interdiction; loi 76-35 art. 32 interdit sans accord (locaux anciens); le blog houni exige l'accord")
q(8, "Que se passe-t-il s'il n'y a pas eu d'état des lieux à l'entrée dans le logement ?", "fr",
  [coc781, cy_edl], note="COC 781: présumé reçu en bon état")
q(9, "Le propriétaire peut-il garder mes meubles si je lui dois des loyers ?", "fr",
  [coc788, ju788], note="COC 788, droit de rétention")
q(10, "Puis-je quitter le logement avant la fin du bail ?", "fr",
  [S(JU, "Le locataire peut quitter les locaux avant la fin de la durée de location", "(Article 791 du code des obligations et des contrats)."),
   S(J91, "Le louage de choses cesse de plein droit à l'expiration du terme", "spéciales aux baux à ferme.")], note="COC 791")
q(11, "Si je reste dans le logement après la fin du bail sans nouveau contrat, le bail est-il renouvelé ?", "fr",
  [S(J91, "Au cas où, à l'expiration du contrat, le preneur reste en possession", "pour vider les lieux.")], note="COC 793, tacite reconduction")
q(12, "Le propriétaire peut-il mettre fin au bail pour venir habiter lui-même le logement ?", "fr",
  [coc797, l76_10, no_reprise], tags=["contradiction"],
  note="COC 797 l'interdit; loi 76-35 art. 10-11 le permet pour les locaux anciens avec préavis de six mois; un huissier notaire parle de trois mois")
q(13, "Le bail est-il annulé si le propriétaire vend l'appartement ?", "fr",
  [S(J91, "Le contrat de louage n'est pas résolu par l'aliénation", "antérieure à l'aliénation."),
   S(J91, "A défaut d'acte écrit ayant date certaine, l'acquéreur pourra expulser le locataire", "établis par l'usage.")], note="COC 798-799")
q(14, "Le décès du locataire met-il fin au contrat de location ?", "fr",
  [coc803, S(L76, "En cas de décès du locataire ou d'abandon de domicile, le droit au maintien", "à ses enfants handicapés.")], note="COC 803; loi 76-35 art. 3")
q(15, "Faut-il enregistrer un contrat de location d'habitation à la recette des finances ?", "fr",
  [reg_cdet, reg_pf, reg_no, reg_dw], tags=["contradiction"],
  note="CDET art. 3-I-6°: actes de mutation de jouissance enregistrés dans les 60 jours; tarif habitation 5 D par page (2006); un huissier notaire dit le contraire")
q(16, "Dans quel délai faut-il enregistrer un bail et que se passe-t-il en cas de retard ?", "fr",
  [S(DW, "Si le contrat de location est présenté à l’enregistrement après 60 jours", "pénalités de retard."),
   S(CY, "L’enregistrement d’un contrat doit impérativement être effectué dans les 60 jours", "des pénalités de retard s’ajoutent aux droits à payer."),
   S(CD, "I. Doivent être enregistrés dans un délai de soixante jours à compter de leur date :")], note="60 jours")
q(17, "Quels documents faut-il présenter pour enregistrer un contrat de location ?", "fr",
  [S(DW, "Pour enregistrer un contrat de location il faut :", "l'adresse du local le prix du loyer et l'activité à exercer.")])
q(18, "Le loyer peut-il augmenter automatiquement de 10 % au renouvellement du bail ?", "fr",
  [inc_no, inc_76, inc_mh], tags=["contradiction"],
  note="pratique de 10% rapportée par un huissier notaire; 5% max par an pour les locaux de la loi 76-35; marché libre ailleurs")
q(19, "La loi de 1976 sur le maintien dans les lieux s'applique-t-elle à un appartement construit en 2010 ?", "fr",
  [S(L76, "Les dispositions de la présente loi s'appliquent aux locaux à usage d'habitation", "achevée avant le 1er janvier 1954"),
   S(MH, "- le droit au maintien n’est pas reconnu au profit des locataires ayant conclut leur contrat après mars 1978", "soumis au droit commun des contrats ;")],
  note="champ limité aux locaux anciens (1954, étendu à 1970)")
q(20, "Après une mise en demeure pour loyers impayés, combien de temps le propriétaire doit-il attendre avant de résilier ?", "fr",
  [S(L76, "Nonobstant toute stipulation contraire, la clause insérée dans le bail prévoyant la résiliation de plein droit", "mentionner ce délai."),
   S(CY, "En cas de loyers impayés, le bailleur doit d’abord adresser une mise en demeure écrite, accordant un délai d’au moins 15 jours pour régulariser."),
   S(J91, "La résolution a lieu en faveur du bailleur", "s'il ne paie pas le prix échu du bail ou de la location.")],
  tags=["contradiction"], note="loi 76-35 art. 21: un mois; blog: 15 jours; COC 796 sans délai")
q(21, "Une annonce Facebook : le propriétaire vit à l'étranger et demande deux mois de loyer à un proche avant la visite. Arnaque ?", "fr",
  [scam_lp, scam_lo])
q(22, "Une plateforme de colocation doit-elle déclarer le traitement des données personnelles à l'INPDP ?", "fr",
  [S(LDP, "Toute opération de traitement des données à caractère personnel est soumise à une déclaration préalable", "par tout autre moyen laissant une trace écrite."),
   S(W6, "- Déclarer le traitement à l'INPDP (formulaire en ligne)")], note="loi 2004-63 art. 7")
q(23, "Quelle est la sanction pour un traitement de données personnelles sans déclaration préalable ?", "fr",
  [S(LDP, "Est puni d’un an d’emprisonnement et d’une amende de cinq mille dinars, quiconque :", "ou sans l’obtention de l’autorisation prévue aux articles 15 et 69 de la présente loi"),
   S(W6, "Traitement sans déclaration Amende 1 000 à 10 000 DT + emprisonnement jusqu'à 1 an")],
  tags=["contradiction"], note="art. 90: 1 an et 5 000 D; le site web6 annonce 1 000 à 10 000 DT")
q(24, "Peut-on héberger les données des utilisateurs tunisiens sur un serveur à l'étranger ?", "fr",
  [S(LDP, "Dans tous les cas, l’obtention de l’autorisation de l’Instance pour effectuer le transfert", "est obligatoire."),
   S(W6, "Hébergement à l'étranger Autorisation de transfert transfrontalier")], note="loi 2004-63 art. 52")
q(25, "Le consentement de la personne doit-il être écrit pour traiter ses données personnelles ?", "fr", [dp27], note="loi 2004-63 art. 27")

# ---- English (cross-lingual: the corpus has no English text)
q(26, "Can my landlord end the lease because he wants to move into the flat himself?", "en",
  [coc797, l76_10, no_reprise], tags=["cross_lingual", "contradiction"])
q(27, "Who pays for repainting the walls of a rented apartment?", "en", [coc743_paint], tags=["cross_lingual"], note="COC 743")
q(28, "How much security deposit can a landlord in Tunisia ask for?", "en",
  [S(CY, "En Tunisie, la pratique du dépôt de garantie est généralisée.", "même pour un meublé."),
   S(NO, "Il a précisé que cette période de trois mois n’est pas gratuite", "ou à régler des factures impayées.")],
  tags=["cross_lingual"], note="only blog/press sources; no law text in the corpus sets a cap")
q(29, "Is a lease terminated when the tenant dies?", "en", [coc803], tags=["cross_lingual"], note="COC 803")
q(30, "The owner says he lives abroad and can't show the flat, but wants a deposit first. Is that a scam?", "en",
  [scam_lo, scam_pay, scam_lp], tags=["cross_lingual"])

# ---- Arabic script (MSA and Tunisian)
q(31, "هل يجوز للمكتري أن يكري لغيره ما اكتراه دون إذن المالك؟", "ar", [ar772], note="الفصل 772")
q(32, "المكري يحب يخرجني من الدار باش يسكن فيها هو، عندو الحق؟", "ar", [ar797], note="الفصل 797، دارجة تونسية")
q(33, "شكون يخلص تصليح البلار والأبواب والأقفال في الدار المكرية؟", "ar", [ar743], note="الفصل 743")
q(34, "متى يجب على المكتري دفع الكراء إذا لم يحدد العقد أجلا؟", "ar",
  [S(AR, "على المكتري أداء الكراء في الأجل المعين في العقد", "ومصاريف الأداء على المكتري.")], note="الفصل 768")
q(35, "هل ينفسخ عقد الكراء إذا باع المالك العقار؟", "ar",
  [S(AR, "خروج الملك من يد مالكه طوعا أو كرها لا يفسخ الكراء", "سابق على تاريخ التفويت.")], note="الفصل 798")
q(36, "هل يجب تسجيل عقد كراء محل معد للسكنى بالقباضة المالية؟", "ar",
  [reg_cdet, reg_pf, reg_no, reg_dw], tags=["cross_lingual", "contradiction"], note="no Arabic text on registration in the corpus")

# ---- Transliterated Tunisian (arabizi): gold in Arabic and French where both exist
q(37, "el kari ynajem ykharajni mel dar bech yaskon fiha howa?", "ar-Latn", [ar797, coc797], tags=["arabizi"])
q(38, "najem nsakken m3aya colocataire fi chambre men dari mta3 el kra bla ma n9oul lel moula?", "ar-Latn",
  [ar772, coc772], tags=["arabizi"])
q(39, "chkoun ykhalles el sbigha mta3 el dar el mekrya?", "ar-Latn", [coc743_paint, ar743], tags=["arabizi"])
q(40, "lgit annonce fi facebook, el moula fel ghorba w y7eb nab3athlou flous 9bal ma nchouf el dar", "ar-Latn",
  [scam_lp, scam_lo, scam_pay], tags=["arabizi"])

# ---- Code-switched (Tunisian + French)
q(41, "est-ce que el proprio ynajem yzid fel kra 10% kol 3am automatiquement ?", "fr", [inc_no, inc_76, inc_mh],
  tags=["code_switch", "contradiction"])
q(42, "ken ma3malnech état des lieux à l'entrée, chnouwa ysir ki nokhrej ?", "fr", [coc781, ar781, cy_edl], tags=["code_switch"])
q(43, "lazem na3mel enregistrement lel contrat de location mta3 sakna wala le ?", "fr", [reg_cdet, reg_pf, reg_no, reg_dw],
  tags=["code_switch", "contradiction"])
q(44, "el bailleur 7abes affairi khater ma khalastech deux mois de loyer, est-ce que c'est légal ?", "fr", [coc788, ar788, ju788],
  tags=["code_switch"])

# ---- Out of scope: the corpus does not answer these; the system should abstain
q(45, "Quel est le montant de l'APL pour un étudiant qui loue une chambre à Tunis ?", "fr", [], tags=["abstain"],
  note="aide au logement française; aucune aide de ce type dans le corpus")
q(46, "What is the maximum rent increase allowed in Paris under rent control?", "en", [], tags=["abstain"], note="other jurisdiction")
q(47, "Quels sont les horaires d'ouverture de la recette des finances de l'Ariana ?", "fr", [], tags=["abstain"])
q(48, "ما هي إجراءات الحصول على تأشيرة دراسة إلى فرنسا؟", "ar", [], tags=["abstain"])

import sys
OUT = sys.argv[1] if len(sys.argv) > 1 else __import__("pathlib").Path(__file__).with_name("tn_retrieval_v1.jsonl")
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    for x in Q: f.write(json.dumps(x, ensure_ascii=False) + "\n")
print(len(Q), "queries")
