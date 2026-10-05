// Texts and formatting of the Telegram channel (D-079). Replies use Telegram's HTML mode: everything that
// comes from data goes through esc(). Language: the user's Telegram language (ar, en), French otherwise.
const TG_TEXTS = {
  fr: {
    consent: "Bonjour ! Ce bot sert à tester la plateforme de colocation (projet d'études).\n\nAvant de continuer, acceptez que :\n• vos messages, photos et notes vocales soient traités par la plateforme, qui tourne sur un ordinateur privé avec des modèles d'IA locaux ;\n• ces messages passent par les serveurs de Telegram ;\n• ce que vous envoyez soit conservé pour les tests : n'envoyez pas d'informations sensibles.\n\nVous pourrez retirer votre accord à tout moment avec /stop.",
    accept: "J'accepte", refuse: 'Non merci',
    refused: "D'accord, rien de ce que vous envoyez ne sera traité. Envoyez /start si vous changez d'avis.",
    stopped: 'Votre accord est retiré : vos prochains messages ne seront plus traités. /start pour recommencer.',
    help: "Écrivez votre recherche comme à un ami, par exemple :\n<i>chambre meublée près de l'ENIT, 400 dt max, à partir de novembre</i>\n\n/annonce &lt;texte&gt; : publier une annonce (envoyez une photo avec ce texte en légende pour l'ajouter)\n/pays TN | FR | GB : changer de pays (actuel : {country})\n/moi : vos informations\n/stop : retirer votre accord",
    help_admin: '\n/trace : les étapes de votre dernière demande',
    welcome: "Merci, c'est noté.",
    me: "Telegram : {tg}\nCompte : {user}\nRôle : {role}\nPays : {country}",
    country_set: 'Pays enregistré : {country}.', country_bad: 'Pays inconnu. Utilisez /pays TN, /pays FR ou /pays GB.',
    voice: 'Les notes vocales arrivent bientôt (service de transcription en cours de construction). Écrivez votre message pour le moment.',
    photo_hint: "Pour publier une annonce avec photo, mettez /annonce suivi du texte de l'annonce dans la légende de la photo.",
    other: "Je ne lis que les messages texte, les photos (avec /annonce) et les commandes. /aide pour l'aide.",
    admin_only: 'Commande réservée aux administrateurs.', no_trace: "Aucune demande à tracer pour l'instant.",
    listing_empty: "Ajoutez le texte de l'annonce après /annonce, par exemple :\n/annonce Chambre meublée à Sahloul, 350 DT/mois, wifi, libre le 1er novembre",
    working: 'Analyse en cours…', listing_wait: "Annonce reçue, analyse en cours (cela peut prendre une ou deux minutes)…",
    listing_late: "L'analyse prend plus de temps que prévu. Elle continue ; l'annonce est {id}.",
    published: '✅ Publiée : elle apparaît maintenant dans les recherches (mode test : sans vérification de confiance).',
    not_published: "Pas publiée : il manque {missing}. Renvoyez l'annonce avec ces informations.",
    missing_rent: 'le loyer', missing_place: 'un quartier ou une ville connus',
    understood: "J'ai compris : {what}", results: '<b>{n} annonce(s)</b> :', no_results: "Aucune annonce ne correspond pour l'instant.",
    synthetic: '(annonces de test)', more: '… et {n} de plus.',
    clarify: '{q}', legal_later: 'Les réponses aux questions juridiques arrivent dans une prochaine phase du projet.',
    post_hint: 'Pour publier une annonce, envoyez /annonce suivi de son texte.',
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
    help: "Write what you are looking for, as you would to a friend, for example:\n<i>furnished room near Queen Mary, max £170 a week, from January</i>\n\n/listing &lt;text&gt;: post a listing (send a photo with this text as its caption to add it)\n/country TN | FR | GB: change country (now: {country})\n/me: your details\n/stop: withdraw consent",
    help_admin: '\n/trace: the steps of your last request',
    welcome: 'Thanks, noted.',
    me: 'Telegram: {tg}\nAccount: {user}\nRole: {role}\nCountry: {country}',
    country_set: 'Country saved: {country}.', country_bad: 'Unknown country. Use /country TN, /country FR or /country GB.',
    voice: 'Voice notes are coming soon (the transcription service is being built). Please type your message for now.',
    photo_hint: 'To post a listing with a photo, put /listing followed by the listing text in the photo caption.',
    other: 'I only read text messages, photos (with /listing) and commands. /help for help.',
    admin_only: 'Admins only.', no_trace: 'No request to trace yet.',
    listing_empty: 'Add the listing text after /listing, for example:\n/listing Double room in Fallowfield, £120 pw incl. bills, available 1 November',
    working: 'Working on it…', listing_wait: 'Listing received, analysis running (this can take a minute or two)…',
    listing_late: 'The analysis is taking longer than expected. It continues; the listing is {id}.',
    published: '✅ Published: it now shows in searches (test mode: no trust check).',
    not_published: 'Not published: {missing} missing. Send the listing again with it.',
    missing_rent: 'the rent', missing_place: 'a known neighbourhood or city',
    understood: 'I understood: {what}', results: '<b>{n} listing(s)</b>:', no_results: 'No listing matches yet.',
    synthetic: '(test listings)', more: '… and {n} more.',
    clarify: '{q}', legal_later: 'Answers to legal questions come in a later phase of the project.',
    post_hint: 'To post a listing, send /listing followed by its text.',
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
    help: 'اكتب ما تبحث عنه كما تكتب لصديق، مثلا:\n<i>نحب بيت مفروشة قريبة من ENIT، 400 دينار ماكس</i>\n\n/listing &lt;النص&gt;: نشر إعلان (أرسل صورة مع هذا النص كتعليق لإضافتها)\n/country TN | FR | GB: تغيير البلد (الحالي: {country})\n/me: معلوماتك\n/stop: سحب الموافقة',
    help_admin: '\n/trace: مراحل طلبك الأخير',
    welcome: 'شكرا، تم التسجيل.',
    me: 'تيليغرام: {tg}\nالحساب: {user}\nالدور: {role}\nالبلد: {country}',
    country_set: 'تم حفظ البلد: {country}.', country_bad: 'بلد غير معروف. استعمل /country TN أو /country FR أو /country GB.',
    voice: 'الرسائل الصوتية قريبا (خدمة التفريغ قيد الإنجاز). اكتب رسالتك حاليا.',
    photo_hint: 'لنشر إعلان بصورة، اكتب /listing ثم نص الإعلان في تعليق الصورة.',
    other: 'أقرأ الرسائل النصية والصور (مع /listing) والأوامر فقط. /help للمساعدة.',
    admin_only: 'هذا الأمر للمشرفين فقط.', no_trace: 'لا يوجد طلب لتتبعه بعد.',
    listing_empty: 'أضف نص الإعلان بعد /listing، مثلا:\n/listing بيت مفروشة في سهلول، 350 دينار في الشهر، wifi، متاحة من 1 نوفمبر',
    working: 'جاري المعالجة…', listing_wait: 'تم استلام الإعلان، التحليل جار (قد يستغرق دقيقة أو دقيقتين)…',
    listing_late: 'التحليل يأخذ وقتا أطول من المتوقع. يتواصل؛ رقم الإعلان {id}.',
    published: '✅ نُشر الإعلان: يظهر الآن في البحث (وضع تجريبي: دون فحص الثقة).',
    not_published: 'لم يُنشر: ينقص {missing}. أعد إرسال الإعلان مع هذه المعلومات.',
    missing_rent: 'الإيجار', missing_place: 'حي أو مدينة معروفة',
    understood: 'فهمت: {what}', results: '<b>{n} إعلان(ات)</b>:', no_results: 'لا يوجد إعلان مطابق حاليا.',
    synthetic: '(إعلانات تجريبية)', more: '… و{n} أخرى.',
    clarify: '{q}', legal_later: 'الإجابة عن الأسئلة القانونية تأتي في مرحلة لاحقة من المشروع.',
    post_hint: 'لنشر إعلان، أرسل /listing ثم نصه.',
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

if (typeof module !== 'undefined') module.exports = { T, tgEsc, tgMoney, tgLang, tgApiError, TG_TEXTS, TG_ISSUES, TG_RULES };
