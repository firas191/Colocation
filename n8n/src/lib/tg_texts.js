// Texts and formatting of the Telegram channel (D-079). Replies use Telegram's HTML mode: everything that
// comes from data goes through esc(). Language: the user's Telegram language (ar, en), French otherwise.
const TG_TEXTS = {
  fr: {
    consent: "Bonjour ! Ce bot sert à tester la plateforme de colocation (projet d'études).\n\nAvant de continuer, acceptez que :\n• vos messages, photos et notes vocales soient traités par la plateforme, qui tourne sur un ordinateur privé avec des modèles d'IA locaux ;\n• ces messages passent par les serveurs de Telegram ;\n• ce que vous envoyez soit conservé pour les tests : n'envoyez pas d'informations sensibles.\n\nVous pourrez retirer votre accord à tout moment avec /stop.",
    accept: "J'accepte", refuse: 'Non merci',
    refused: "D'accord, rien de ce que vous envoyez ne sera traité. Envoyez /start si vous changez d'avis.",
    stopped: 'Votre accord est retiré : vos prochains messages ne seront plus traités. /start pour recommencer.',
    help: "Écrivez votre recherche comme à un ami, par exemple :\n<i>chambre meublée près de l'ENIT, 400 dt max, à partir de novembre</i>\n\n/annonce &lt;texte&gt; : publier une annonce (pour des photos : envoyez-les ensemble, ce texte en légende, jusqu'à 10)\n/pays TN | FR | GB : changer de pays (actuel : {country})\n/moi : vos informations\n/stop : retirer votre accord",
    help_admin: '\n/trace : les étapes de votre dernière demande',
    welcome: "Merci, c'est noté.",
    me: "Telegram : {tg}\nCompte : {user}\nRôle : {role}\nPays : {country}",
    country_set: 'Pays enregistré : {country}.', country_bad: 'Pays inconnu. Utilisez /pays TN, /pays FR ou /pays GB.',
    voice: 'Les notes vocales arrivent bientôt (service de transcription en cours de construction). Écrivez votre message pour le moment.',
    photo_hint: "Pour publier une annonce avec photo, mettez /annonce suivi du texte de l'annonce dans la légende de la photo.",
    view_photos: '📷 Voir les {n} photos', no_photos: "Cette annonce n'a plus de photo visible.",
    photos_failed: "Les photos n'ont pas pu être envoyées. Réessayez dans un moment.",
    album_late: "Cette photo est arrivée après la création de l'annonce et n'y a pas été ajoutée. Renvoyez l'annonce avec toutes ses photos.",
    other: "Je ne lis que les messages texte, les photos (avec /annonce) et les commandes. /aide pour l'aide.",
    admin_only: 'Commande réservée aux administrateurs.', no_trace: "Aucune demande à tracer pour l'instant.",
    listing_empty: "Ajoutez le texte de l'annonce après /annonce, par exemple :\n/annonce Chambre meublée à Sahloul, 350 DT/mois, wifi, libre le 1er novembre",
    working: 'Analyse en cours…', listing_wait: "Annonce reçue, analyse en cours (quelques minutes, plus avec plusieurs photos)…",
    listing_slow: "L'analyse prend plus de temps que prévu (les photos sont analysées une par une). Je vous envoie le résultat dès qu'elle est finie.",
    listing_late: "L'analyse n'est toujours pas finie. Elle continue ; l'annonce est {id}.",
    published: '✅ Publiée : elle apparaît maintenant dans les recherches (mode test : sans vérification de confiance).',
    not_published: "Pas publiée : il manque {missing}. Écrivez-le simplement (par exemple « le loyer est 350 DT ») ou renvoyez l'annonce.",
    missing_rent: 'le loyer', missing_place: 'un quartier ou une ville connus',
    understood: "J'ai compris : {what}", results: '<b>{n} annonce(s)</b> :', no_results: "Aucune annonce ne correspond pour l'instant.",
    synthetic: '(annonces de test)', more: '… et {n} de plus.',
    clarify: '{q}', legal_later: 'Les réponses aux questions juridiques arrivent dans une prochaine phase du projet.',
    legal_sources: '<b>Sources :</b>', legal_seen: 'consulté le {d}',
    legal_conflict: '⚠️ Les sources ne disent pas toutes la même chose :',
    legal_not_found: "Je n'ai pas trouvé la réponse dans les textes et guides que j'ai pour ce pays ({c}). Je préfère ne pas répondre sans source.",
    legal_notice: "<i>Information générale tirée des sources citées, pas un avis juridique. Pour un litige ou une expulsion, adressez-vous à un avocat ou à une structure d'aide juridique.</i>",
    type_primary_law: 'texte de loi', type_regulator: 'autorité', type_government_guide: 'guide officiel', type_ngo: 'association',
    type_commercial_guide: 'guide commercial', type_blog: 'blog', type_internal: 'note interne',
    post_hint: 'Pour publier une annonce, envoyez /annonce suivi de son texte.',
    owner_proposed: '<b>Modification proposée</b> (annonce {n}) :', owner_confirm: '✅ Confirmer', owner_cancel: '✖ Annuler',
    owner_done: '✅ <b>Annonce modifiée</b> :', owner_cancelled: 'Modification annulée : rien n\'a changé.',
    owner_gone: "Cette proposition n'est plus valable (expirée ou déjà traitée). Redemandez la modification.",
    owner_refused: "La modification n'a pas été appliquée : {why}.", owner_status: 'Statut : {s}',
    f_rent: 'Loyer', f_deposit: 'Caution', f_rent_period: 'Période', f_bills_included: 'Charges comprises', f_furnished: 'Meublé',
    f_available_from: 'Disponible le', f_bedrooms: 'Chambres', f_min_stay_months: 'Durée minimum (mois)', f_place: 'Lieu',
    f_amenities: 'Équipements', f_house_rules: 'Règles', f_remove_photos: 'Photos retirées', f_status: 'Statut',
    st_published: 'publiée', st_archived: 'archivée (plus visible)', st_draft: 'brouillon', st_pending_review: 'en vérification',
    st_processing: 'en analyse', st_rejected: 'refusée', yes: 'oui', no: 'non',
    later: "Cette demande sera traitée dans une prochaine phase du projet.",
    unsupported: "Je n'ai pas compris votre demande. /aide pour des exemples.",
    failed: 'Désolé, une erreur est survenue ({code}). Réessayez dans un moment.',
    rate: 'Trop de messages : attendez une minute.', down: 'Le service est momentanément indisponible. Réessayez plus tard.',
    consent_needed: "Il manque votre accord : envoyez /start.",
    fields: "<b>Ce que j'ai lu dans l'annonce :</b>", issues: '<b>À vérifier :</b>', photos: '<b>Photos :</b> {ok} acceptée(s), {bad} refusée(s){blur}',
    blurred: ', zones floutées : {n}', none: 'rien',
    kind_room: 'chambre', kind_shared_flat: 'appartement en colocation', kind_roommate_wanted: 'recherche de colocataire',
    per_month: '/mois', per_week: '/semaine', bills_in: 'charges comprises', bills_out: 'charges en plus', furnished: 'meublé', unfurnished: 'non meublé',
    bedrooms: '{n} chambre(s)', from: 'dispo le {d}', deposit: 'caution {v}', near: 'près de {p}', budget_max: 'budget max {v}', move_in: 'à partir du {d}',
  },
  en: {
    consent: "Hi! This bot is a test bench for the flatshare platform (a student project).\n\nBefore going on, please accept that:\n• your messages, photos and voice notes are processed by the platform, which runs on a private computer with local AI models;\n• these messages go through Telegram's servers;\n• what you send is kept for testing: do not send sensitive information.\n\nYou can withdraw at any time with /stop.",
    accept: 'I accept', refuse: 'No thanks',
    refused: 'OK, nothing you send will be processed. Send /start if you change your mind.',
    stopped: 'Consent withdrawn: your next messages will not be processed. /start to begin again.',
    help: "Write what you are looking for, as you would to a friend, for example:\n<i>furnished room near Queen Mary, max £170 a week, from January</i>\n\n/listing &lt;text&gt;: post a listing (for photos: send them together, this text as the caption, up to 10)\n/country TN | FR | GB: change country (now: {country})\n/me: your details\n/stop: withdraw consent",
    help_admin: '\n/trace: the steps of your last request',
    welcome: 'Thanks, noted.',
    me: 'Telegram: {tg}\nAccount: {user}\nRole: {role}\nCountry: {country}',
    country_set: 'Country saved: {country}.', country_bad: 'Unknown country. Use /country TN, /country FR or /country GB.',
    voice: 'Voice notes are coming soon (the transcription service is being built). Please type your message for now.',
    photo_hint: 'To post a listing with a photo, put /listing followed by the listing text in the photo caption.',
    view_photos: '📷 See the {n} photos', no_photos: 'This listing has no visible photo any more.',
    photos_failed: 'The photos could not be sent. Try again in a moment.',
    album_late: 'This photo arrived after the listing was created and was not added to it. Send the listing again with all its photos.',
    other: 'I only read text messages, photos (with /listing) and commands. /help for help.',
    admin_only: 'Admins only.', no_trace: 'No request to trace yet.',
    listing_empty: 'Add the listing text after /listing, for example:\n/listing Double room in Fallowfield, £120 pw incl. bills, available 1 November',
    working: 'Working on it…', listing_wait: 'Listing received, analysis running (a few minutes, more with several photos)…',
    listing_slow: 'The analysis is taking longer than expected (photos are analysed one by one). I will send the result as soon as it is done.',
    listing_late: 'The analysis is still not finished. It continues; the listing is {id}.',
    published: '✅ Published: it now shows in searches (test mode: no trust check).',
    not_published: 'Not published: {missing} missing. Just write it (for example "the rent is 350 DT") or send the listing again.',
    missing_rent: 'the rent', missing_place: 'a known neighbourhood or city',
    understood: 'I understood: {what}', results: '<b>{n} listing(s)</b>:', no_results: 'No listing matches yet.',
    synthetic: '(test listings)', more: '… and {n} more.',
    clarify: '{q}', legal_later: 'Answers to legal questions come in a later phase of the project.',
    legal_sources: '<b>Sources:</b>', legal_seen: 'retrieved {d}',
    legal_conflict: '⚠️ The sources do not all say the same thing:',
    legal_not_found: "I did not find the answer in the laws and guides I have for this country ({c}). I would rather not answer without a source.",
    legal_notice: '<i>General information from the sources cited, not legal advice. For a dispute or an eviction, contact a lawyer or a legal aid service.</i>',
    type_primary_law: 'law', type_regulator: 'regulator', type_government_guide: 'official guide', type_ngo: 'NGO',
    type_commercial_guide: 'commercial guide', type_blog: 'blog', type_internal: 'internal note',
    post_hint: 'To post a listing, send /listing followed by its text.',
    owner_proposed: '<b>Proposed change</b> (listing {n}):', owner_confirm: '✅ Confirm', owner_cancel: '✖ Cancel',
    owner_done: '✅ <b>Listing changed</b>:', owner_cancelled: 'Change cancelled: nothing was changed.',
    owner_gone: 'This proposal is no longer valid (expired or already handled). Ask for the change again.',
    owner_refused: 'The change was not applied: {why}.', owner_status: 'Status: {s}',
    f_rent: 'Rent', f_deposit: 'Deposit', f_rent_period: 'Period', f_bills_included: 'Bills included', f_furnished: 'Furnished',
    f_available_from: 'Available from', f_bedrooms: 'Bedrooms', f_min_stay_months: 'Minimum stay (months)', f_place: 'Place',
    f_amenities: 'Amenities', f_house_rules: 'Rules', f_remove_photos: 'Photos removed', f_status: 'Status',
    st_published: 'published', st_archived: 'archived (not shown)', st_draft: 'draft', st_pending_review: 'under review',
    st_processing: 'being analysed', st_rejected: 'rejected', yes: 'yes', no: 'no',
    later: 'This kind of request comes in a later phase of the project.',
    unsupported: "I did not understand your request. /help for examples.",
    failed: 'Sorry, something went wrong ({code}). Please try again in a moment.',
    rate: 'Too many messages: please wait a minute.', down: 'The service is unavailable right now. Please try later.',
    consent_needed: 'Your consent is missing: send /start.',
    fields: '<b>What I read in the listing:</b>', issues: '<b>To check:</b>', photos: '<b>Photos:</b> {ok} accepted, {bad} refused{blur}',
    blurred: ', areas blurred: {n}', none: 'nothing',
    kind_room: 'room', kind_shared_flat: 'shared flat', kind_roommate_wanted: 'flatmate wanted',
    per_month: '/month', per_week: '/week', bills_in: 'bills included', bills_out: 'bills extra', furnished: 'furnished', unfurnished: 'unfurnished',
    bedrooms: '{n} bedroom(s)', from: 'available {d}', deposit: 'deposit {v}', near: 'near {p}', budget_max: 'max budget {v}', move_in: 'from {d}',
  },
  ar: {
    consent: 'مرحبا! هذا البوت لتجربة منصة السكن المشترك (مشروع دراسي).\n\nقبل المواصلة، يرجى الموافقة على أن:\n• تعالج المنصة رسائلك وصورك وتسجيلاتك الصوتية، وهي تعمل على حاسوب خاص بنماذج ذكاء اصطناعي محلية؛\n• تمر هذه الرسائل عبر خوادم تيليغرام؛\n• يحفظ ما ترسله لأغراض التجربة: لا ترسل معلومات حساسة.\n\nيمكنك سحب موافقتك في أي وقت بالأمر /stop.',
    accept: 'أوافق', refuse: 'لا شكرا',
    refused: 'حسنا، لن تتم معالجة أي شيء ترسله. أرسل /start إذا غيرت رأيك.',
    stopped: 'تم سحب موافقتك: لن تتم معالجة رسائلك القادمة. /start للبدء من جديد.',
    help: 'اكتب ما تبحث عنه كما تكتب لصديق، مثلا:\n<i>نحب بيت مفروشة قريبة من ENIT، 400 دينار ماكس</i>\n\n/listing &lt;النص&gt;: نشر إعلان (للصور: أرسلها معا مع هذا النص كتعليق، حتى 10 صور)\n/country TN | FR | GB: تغيير البلد (الحالي: {country})\n/me: معلوماتك\n/stop: سحب الموافقة',
    help_admin: '\n/trace: مراحل طلبك الأخير',
    welcome: 'شكرا، تم التسجيل.',
    me: 'تيليغرام: {tg}\nالحساب: {user}\nالدور: {role}\nالبلد: {country}',
    country_set: 'تم حفظ البلد: {country}.', country_bad: 'بلد غير معروف. استعمل /country TN أو /country FR أو /country GB.',
    voice: 'الرسائل الصوتية قريبا (خدمة التفريغ قيد الإنجاز). اكتب رسالتك حاليا.',
    photo_hint: 'لنشر إعلان بصورة، اكتب /listing ثم نص الإعلان في تعليق الصورة.',
    view_photos: '📷 شاهد الصور ({n})', no_photos: 'لم تعد لهذا الإعلان صور ظاهرة.',
    photos_failed: 'تعذر إرسال الصور. حاول بعد قليل.',
    album_late: 'وصلت هذه الصورة بعد إنشاء الإعلان ولم تُضف إليه. أعد إرسال الإعلان مع كل صوره.',
    other: 'أقرأ الرسائل النصية والصور (مع /listing) والأوامر فقط. /help للمساعدة.',
    admin_only: 'هذا الأمر للمشرفين فقط.', no_trace: 'لا يوجد طلب لتتبعه بعد.',
    listing_empty: 'أضف نص الإعلان بعد /listing، مثلا:\n/listing بيت مفروشة في سهلول، 350 دينار في الشهر، wifi، متاحة من 1 نوفمبر',
    working: 'جاري المعالجة…', listing_wait: 'تم استلام الإعلان، التحليل جار (بضع دقائق، وأكثر مع عدة صور)…',
    listing_slow: 'التحليل يأخذ وقتا أطول من المتوقع (الصور تُحلَّل واحدة تلو الأخرى). سأرسل لك النتيجة فور انتهائه.',
    listing_late: 'التحليل لم ينته بعد. يتواصل؛ رقم الإعلان {id}.',
    published: '✅ نُشر الإعلان: يظهر الآن في البحث (وضع تجريبي: دون فحص الثقة).',
    not_published: 'لم يُنشر: ينقص {missing}. اكتبه ببساطة (مثلا «الإيجار 350 دينار») أو أعد إرسال الإعلان.',
    missing_rent: 'الإيجار', missing_place: 'حي أو مدينة معروفة',
    understood: 'فهمت: {what}', results: '<b>{n} إعلان(ات)</b>:', no_results: 'لا يوجد إعلان مطابق حاليا.',
    synthetic: '(إعلانات تجريبية)', more: '… و{n} أخرى.',
    clarify: '{q}', legal_later: 'الإجابة عن الأسئلة القانونية تأتي في مرحلة لاحقة من المشروع.',
    legal_sources: '<b>المصادر:</b>', legal_seen: 'تاريخ الاطلاع {d}',
    legal_conflict: '⚠️ المصادر لا تقول كلها نفس الشيء:',
    legal_not_found: 'لم أجد الإجابة في النصوص والأدلة المتوفرة لدي لهذا البلد ({c}). أفضّل عدم الإجابة دون مصدر.',
    legal_notice: '<i>معلومات عامة مأخوذة من المصادر المذكورة، وليست استشارة قانونية. في حالة نزاع أو إخلاء، توجّه إلى محامٍ أو إلى هيكل للمساعدة القانونية.</i>',
    type_primary_law: 'نص قانوني', type_regulator: 'هيئة رسمية', type_government_guide: 'دليل رسمي', type_ngo: 'جمعية',
    type_commercial_guide: 'دليل تجاري', type_blog: 'مدونة', type_internal: 'ملاحظة داخلية',
    post_hint: 'لنشر إعلان، أرسل /listing ثم نصه.',
    owner_proposed: '<b>تعديل مقترح</b> (الإعلان {n}):', owner_confirm: '✅ تأكيد', owner_cancel: '✖ إلغاء',
    owner_done: '✅ <b>تم تعديل الإعلان</b>:', owner_cancelled: 'تم إلغاء التعديل: لم يتغير شيء.',
    owner_gone: 'هذا الاقتراح لم يعد صالحا (انتهت مدته أو تمت معالجته). اطلب التعديل من جديد.',
    owner_refused: 'لم يتم تطبيق التعديل: {why}.', owner_status: 'الحالة: {s}',
    f_rent: 'الإيجار', f_deposit: 'الضمان', f_rent_period: 'المدة', f_bills_included: 'المصاريف مشمولة', f_furnished: 'مفروش',
    f_available_from: 'متاح من', f_bedrooms: 'الغرف', f_min_stay_months: 'أدنى مدة (أشهر)', f_place: 'المكان',
    f_amenities: 'التجهيزات', f_house_rules: 'القواعد', f_remove_photos: 'الصور المحذوفة', f_status: 'الحالة',
    st_published: 'منشور', st_archived: 'مؤرشف (غير ظاهر)', st_draft: 'مسودة', st_pending_review: 'قيد المراجعة',
    st_processing: 'قيد التحليل', st_rejected: 'مرفوض', yes: 'نعم', no: 'لا',
    later: 'هذا النوع من الطلبات يأتي في مرحلة لاحقة من المشروع.',
    unsupported: 'لم أفهم طلبك. /help لأمثلة.',
    failed: 'عذرا، حدث خطأ ({code}). حاول بعد قليل.',
    rate: 'رسائل كثيرة: انتظر دقيقة.', down: 'الخدمة غير متاحة حاليا. حاول لاحقا.',
    consent_needed: 'موافقتك غير مسجلة: أرسل /start.',
    fields: '<b>ما قرأته في الإعلان:</b>', issues: '<b>للتثبت:</b>', photos: '<b>الصور:</b> {ok} مقبولة، {bad} مرفوضة{blur}',
    blurred: '، مناطق مموهة: {n}', none: 'لا شيء',
    kind_room: 'غرفة', kind_shared_flat: 'شقة مشتركة', kind_roommate_wanted: 'البحث عن شريك سكن',
    per_month: '/شهر', per_week: '/أسبوع', bills_in: 'الفواتير محتسبة', bills_out: 'الفواتير غير محتسبة', furnished: 'مفروش', unfurnished: 'غير مفروش',
    bedrooms: '{n} غرف', from: 'متاح من {d}', deposit: 'ضمان {v}', near: 'قرب {p}', budget_max: 'ميزانية قصوى {v}', move_in: 'ابتداء من {d}',
  },
};
// Issue codes from the listing checks (D-077) in plain words.
const TG_ISSUES = {
  fr: { rent_out_of_range: "loyer hors de la fourchette plausible : précisez le prix", rent_missing: 'loyer non indiqué',
    rent_scope_whole_flat: "le prix semble être celui de tout l'appartement : précisez le prix par chambre",
    rent_scope_unknown: 'précisez si le prix est par chambre ou pour tout le logement', deposit_out_of_range: 'caution hors fourchette',
    deposit_currency_differs: 'caution dans une autre devise que le loyer', contact_details_in_text: "le texte contient un téléphone ou un e-mail : il ne sera pas publié tel quel",
    rent_currency_assumed: 'devise du loyer supposée', rent_currency_unknown: 'devise du loyer inconnue', rent_range_unknown: 'pas de fourchette pour cette devise', available_from_not_in_text: "date de disponibilité non indiquée : précisez quand la chambre est libre",
    photos_show_amenities_not_in_text: 'les photos montrent des équipements absents du texte : à confirmer',
    photos_contradict_furnished: 'les photos ne correspondent pas à « meublé / non meublé » du texte',
    photo_text_readable: 'un texte reste lisible sur une photo', photo_not_a_room: "une photo ne montre pas une pièce",
    photo_analysis_failed: "l'analyse d'une photo a échoué : elle sera revue" },
  en: { rent_out_of_range: 'rent outside the plausible range: please confirm the price', rent_missing: 'no rent given',
    rent_scope_whole_flat: 'the price looks like the whole flat: please give the price per room',
    rent_scope_unknown: 'say whether the price is per room or for the whole place', deposit_out_of_range: 'deposit outside the plausible range',
    deposit_currency_differs: 'deposit in another currency than the rent', contact_details_in_text: 'the text contains a phone number or e-mail: it will not be published as is',
    rent_currency_assumed: 'rent currency assumed', rent_currency_unknown: 'unknown rent currency', rent_range_unknown: 'no range for this currency', available_from_not_in_text: 'no availability date given: say when the room is free',
    photos_show_amenities_not_in_text: 'the photos show amenities the text does not mention: please confirm',
    photos_contradict_furnished: 'the photos do not match furnished / unfurnished in the text',
    photo_text_readable: 'some text can still be read on a photo', photo_not_a_room: 'a photo does not show a room',
    photo_analysis_failed: 'the analysis of a photo failed: it will be reviewed' },
  ar: { rent_out_of_range: 'الإيجار خارج النطاق المعقول: يرجى تأكيد السعر', rent_missing: 'لم يذكر الإيجار',
    rent_scope_whole_flat: 'يبدو أن السعر للشقة كاملة: اذكر سعر الغرفة', rent_scope_unknown: 'وضح هل السعر للغرفة أم للمسكن كاملا',
    deposit_out_of_range: 'الضمان خارج النطاق', deposit_currency_differs: 'الضمان بعملة مختلفة عن الإيجار',
    contact_details_in_text: 'النص يحتوي على هاتف أو بريد: لن ينشر كما هو', rent_currency_assumed: 'عملة الإيجار مفترضة',
    rent_currency_unknown: 'عملة الإيجار غير معروفة', rent_range_unknown: 'لا يوجد نطاق لهذه العملة', available_from_not_in_text: 'لم يذكر تاريخ التوفر: حدد متى تكون الغرفة شاغرة',
    photos_show_amenities_not_in_text: 'الصور تظهر تجهيزات غير مذكورة في النص: يرجى التأكيد',
    photos_contradict_furnished: 'الصور لا تطابق ما في النص (مفروش أو غير مفروش)',
    photo_text_readable: 'نص ما زال مقروءا في إحدى الصور', photo_not_a_room: 'إحدى الصور لا تظهر غرفة',
    photo_analysis_failed: 'فشل تحليل إحدى الصور: ستتم مراجعتها' },
};

// House rules (P3 keys) in plain words.
const TG_RULES = {
  fr: { smoking: { no: 'non-fumeur', yes: 'fumeurs acceptés' }, pets: { no: "pas d'animaux", yes: 'animaux acceptés' },
    guests: { no: "pas d'invités", yes: 'invités acceptés' }, parties: { no: 'pas de fêtes', yes: 'fêtes acceptées' } },
  en: { smoking: { no: 'no smoking', yes: 'smokers welcome' }, pets: { no: 'no pets', yes: 'pets welcome' },
    guests: { no: 'no guests', yes: 'guests welcome' }, parties: { no: 'no parties', yes: 'parties OK' } },
  ar: { smoking: { no: 'ممنوع التدخين', yes: 'التدخين مسموح' }, pets: { no: 'ممنوع الحيوانات', yes: 'الحيوانات مسموحة' },
    guests: { no: 'ممنوع الضيوف', yes: 'الضيوف مسموحون' }, parties: { no: 'ممنوع الحفلات', yes: 'الحفلات مسموحة' } },
};

function tgEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// T(lang, key, vars): the text with {name} replaced by the ESCAPED value of vars.name (raw: vars._raw.name).
function T(lang, key, vars = {}) {
  const table = TG_TEXTS[lang] || TG_TEXTS.fr;
  const s = table[key] !== undefined ? table[key] : TG_TEXTS.fr[key];
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (vars._raw && vars._raw[k] !== undefined ? vars._raw[k] : tgEsc(vars[k] ?? '')));
}

const TG_EXP = { TND: 3, EUR: 2, GBP: 2, USD: 2 };
function tgMoney(minor, cur, exp) {
  if (minor === null || minor === undefined || !cur) return null;
  const e = exp !== undefined && exp !== null ? Number(exp) : (TG_EXP[cur] ?? 2);
  const v = Number(minor) / Math.pow(10, e);
  const shown = String(Number(v.toFixed(Math.min(e, 2))));
  return cur === 'GBP' ? `£${shown}` : cur === 'EUR' ? `${shown} €` : `${shown} ${cur === 'TND' ? 'DT' : cur}`;
}

function tgLang(code) {
  const c = String(code || '').slice(0, 2).toLowerCase();
  return c === 'ar' ? 'ar' : c === 'en' ? 'en' : 'fr';
}

// A failed API call in plain words, or null when it succeeded.
function tgApiError(lang, r) {
  if (r && r.status >= 200 && r.status < 300) return null;
  const code = (r && r.error_code) || 'NO_ANSWER';
  if (r && r.status === 429) return T(lang, 'rate');
  if (!r || !r.status || r.status === 503) return T(lang, 'down');
  if (code === 'CONSENT_REQUIRED') return T(lang, 'consent_needed');
  return T(lang, 'failed', { code });
}

// A change of a listing (D-088), one line per field: "Loyer : 350 DT → 400 DT". diff: [{field, before, after, currency}]
// with amounts in main units, as app.listing_change_check gives it.
function tgDiff(lang, diff) {
  const cur = (c) => (c === 'TND' ? 'DT' : c === 'EUR' ? '€' : c === 'GBP' ? '£' : (c || ''));
  const val = (d, v) => {
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return '—';
    if (d.field === 'rent' || d.field === 'deposit') return `${Number(v)} ${cur(d.currency)}`.trim();
    if (typeof v === 'boolean') return T(lang, v ? 'yes' : 'no');
    if (d.field === 'status') return T(lang, 'st_' + v);
    if (d.field === 'house_rules' && typeof v === 'object') {
      const R = TG_RULES[lang] || TG_RULES.fr;
      return Object.entries(v).map(([k, x]) => ((R[k] || {})[x]) || `${k}: ${x}`).join(', ') || '—';
    }
    if (Array.isArray(v)) return v.join(', ');
    return d.field === 'available_from' ? String(v).slice(0, 10) : String(v);
  };
  return (diff || []).map((d) => d.field === 'remove_photos'
    ? `• ${T(lang, 'f_remove_photos')} : ${tgEsc(val(d, d.after))}`
    : `• ${T(lang, 'f_' + d.field)} : ${tgEsc(val(d, d.before))} → ${tgEsc(val(d, d.after))}`);
}

if (typeof module !== 'undefined') module.exports = { T, tgEsc, tgMoney, tgLang, tgApiError, tgDiff, TG_TEXTS, TG_ISSUES, TG_RULES };
