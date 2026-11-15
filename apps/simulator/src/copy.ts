// Every word on the landing page and on the simulator page, in English, French and Wolof.
// Rules: short plain sentences, no em dashes, no hype. Words in {braces} are filled in by the page.
// The words on the phone's own screen are not here: they come from the gateway, which takes them from
// packages/i18n. The only exception is `screens` at the bottom, the four screens the landing page
// plays in a loop; a test checks them against packages/i18n so they cannot drift.
// The Wolof was written by a non-native speaker and has not been reviewed. The page says so.
// No DOM in this file: the build (vite.config.ts) and the tests import it too.
export type Lang = "en" | "fr" | "wo";
export const LANGS: readonly Lang[] = ["wo", "fr", "en"];
export const LANG_NAMES: Record<Lang, string> = { wo: "Wolof", fr: "Français", en: "English" };
type M = Record<Lang, string>;

export const copy = {
  // ----- shared -----
  "nav.home": { en: "What is Melax?", fr: "C'est quoi Melax ?", wo: "Melax, lan la?" },
  "wolof.note": { en: "", fr: "", wo: "Wolof bii, nit ku ko nàmp seetagu ko. Su amee njuumte, baal nu." },

  // ----- landing: first screen -----
  "hero.kicker": { en: "Test version. No real money.", fr: "Version de test. Pas de vrai argent.", wo: "Jéemantu rekk. Du xaalis dëgg." },
  "hero.h1": { en: "Bitcoin on any phone.", fr: "Le bitcoin sur n'importe quel téléphone.", wo: "Bitcoin ci bépp telefon." },
  "hero.lede": {
    en: "Melax is a bitcoin wallet. You dial #2580# and it opens. No app. No internet. It works on the small phone you already have.",
    fr: "Melax est un portefeuille bitcoin. Vous composez #2580# et il s'ouvre. Pas d'application. Pas d'internet. Il marche sur le petit téléphone que vous avez déjà.",
    wo: "Melax kalpe bitcoin la. Dangay bind #2580#, mu ubbiku. Soxlawul application. Soxlawul internet. Dafay dox ci telefon bu ndaw bi nga am.",
  },
  "hero.cta": { en: "Try the demo", fr: "Essayer la démo", wo: "Jéemal demo bi" },
  "hero.note": { en: "Two minutes. Nothing to install.", fr: "Deux minutes. Rien à installer.", wo: "Ñaari minit rekk." },

  // ----- landing: the steps -----
  "how.title": { en: "How it works", fr: "Comment ça marche", wo: "Naka lay doxe" },
  "how.1.t": { en: "Dial #2580#", fr: "Composez #2580#", wo: "Bindal #2580#" },
  "how.1.d": { en: "Like checking your credit. The menu opens.", fr: "Comme pour voir votre crédit. Le menu s'ouvre.", wo: "Ni ngay seete sa kredi. Menu bi dafay ubbiku." },
  "how.2.t": { en: "Choose a secret code", fr: "Choisissez un code secret", wo: "Tannal sa kod" },
  "how.2.d": {
    en: "5 digits. Only you know it. Melax asks for it before any money moves.",
    fr: "5 chiffres. Vous seul le connaissez. Melax le demande avant chaque envoi.",
    wo: "5 chiffres. Yow rekk a ko xam. Melax dina ko laaj balaa xaalis di génn.",
  },
  "how.3.t": { en: "Send with a phone number", fr: "Envoyez avec un numéro", wo: "Yónnee ak nimero telefon" },
  "how.3.d": {
    en: "Type the number and the amount in francs. You see the name before you confirm.",
    fr: "Tapez le numéro et le montant en francs. Vous voyez le nom avant de confirmer.",
    wo: "Bindal nimero bi ak lim bi ci FCFA. Dinga gis turu nit ki balaa ngay nangu.",
  },
  "how.4.t": { en: "Both phones get an SMS", fr: "Les deux téléphones reçoivent un SMS", wo: "Ñaari telefon yi dinañu jot SMS" },
  "how.4.d": { en: "A receipt with a number. One for you, one for them.", fr: "Un reçu avec un numéro. Un pour vous, un pour l'autre.", wo: "Resi bu am nimero. Benn ngir yow, benn ngir moom." },

  // ----- landing: the dial string -----
  "line.title": { en: "One line does it too.", fr: "Une seule ligne suffit.", wo: "Benn rëdd doy na." },
  "line.d": {
    en: "In a hurry? Type it all at once. Melax still asks for your code. The code never goes in the line, because the phone keeps what you dial.",
    fr: "Pressé ? Tapez tout d'un coup. Melax demande quand même votre code. Il ne va jamais dans la ligne, parce que le téléphone garde ce que vous composez.",
    wo: "Soo yàkkamtee, bindal lépp ci benn yoon. Melax dina la laaj sa kod ba tey. Kod bi du dugg mukk ci rëdd wi, ndax telefon bi dafay denc li nga bind.",
  },
  "line.1": { en: "opens Melax", fr: "ouvre Melax", wo: "ubbi Melax" },
  "line.2": { en: "send", fr: "envoyer", wo: "yónnee" },
  "line.3": { en: "to this number", fr: "à ce numéro", wo: "ci nimero bii" },
  "line.4": { en: "500 francs", fr: "500 francs", wo: "500 FCFA" },

  // ----- landing: what is real -----
  "real.title": { en: "What works today", fr: "Ce qui marche aujourd'hui", wo: "Li dox tey" },
  "real.sub": { en: "On a test network. No real money.", fr: "Sur un réseau de test. Pas de vrai argent.", wo: "Ci réseau bu ñuy jéemantoo. Du xaalis dëgg." },
  "real.1": { en: "Open an account from the phone menu.", fr: "Ouvrir un compte depuis le menu du téléphone.", wo: "Ubbi kont ci menu telefon bi." },
  "real.2": {
    en: "A 5-digit secret code. Five wrong tries lock it for 15 minutes.",
    fr: "Un code secret de 5 chiffres. Cinq erreurs le bloquent 15 minutes.",
    wo: "Kod bu am 5 chiffres. Juróomi yoon yu baaxul, mu tëj 15 minit.",
  },
  "real.3": { en: "See your balance in francs and in sats.", fr: "Voir son solde en francs et en sats.", wo: "Gis li nga am ci FCFA ak ci sats." },
  "real.4": {
    en: "Send to another Melax number. The money is real ecash from a real mint.",
    fr: "Envoyer à un autre numéro Melax. L'argent est du vrai ecash, émis par un vrai mint.",
    wo: "Yónnee beneen nimero Melax. Xaalis bi ecash dëgg la, mint dëgg moo ko defar.",
  },
  "real.5": { en: "An SMS receipt for both sides.", fr: "Un reçu par SMS pour les deux.", wo: "Resi ci SMS ngir ñaar ñépp." },
  "real.6": { en: "Top up over Lightning, on the test network.", fr: "Recharger par Lightning, sur le réseau de test.", wo: "Dugal xaalis ci Lightning, ci réseau jéemantu bi." },
  "real.7": { en: "French, Wolof and English.", fr: "Français, wolof et anglais.", wo: "Français, Wolof ak English." },
  "real.8": {
    en: "Cash in and cash out with an agent. The agent's sats stay locked until you say the francs arrived.",
    fr: "Dépôt et retrait chez un agent. Les sats de l'agent restent bloqués tant que les francs ne sont pas arrivés.",
    wo: "Dugal ak génne xaalis ci agent. Sats agent bi dañuy tëju ba xaalis bi agsi.",
  },
  "not.title": { en: "Not built yet", fr: "Pas encore fait", wo: "Li agseegul" },
  "not.1": {
    en: "A real Wave or Orange Money transfer. In the demo the francs part is pretend.",
    fr: "Un vrai transfert Wave ou Orange Money. Dans la démo, la partie en francs est fictive.",
    wo: "Transfer Wave walla Orange Money bu dëgg. Ci demo bi, xaalis FCFA bi du dëgg.",
  },
  "not.2": { en: "Vouchers, and paying a shop.", fr: "Les bons, et payer un marchand.", wo: "Bon yi, ak fey jaaykat." },
  "not.3": { en: "Getting paid from any Lightning wallet.", fr: "Recevoir depuis n'importe quel portefeuille Lightning.", wo: "Jot xaalis bu jóge ci bépp kalpe Lightning." },
  "not.4": { en: "The voice line.", fr: "La ligne vocale.", wo: "Woote ak baat." },
  "not.5": {
    en: "A real short code from an operator. #2580# only exists in this demo.",
    fr: "Un vrai code court chez un opérateur. #2580# n'existe que dans cette démo.",
    wo: "Kod bu dëgg bu opérateur joxe. #2580# ci demo bii rekk la nekk.",
  },
  "not.6": { en: "SMS through a real phone. Here they stay on the page.", fr: "Des SMS par un vrai téléphone. Ici ils restent sur la page.", wo: "SMS ci telefon dëgg. Fii, ci paas bi lañuy des." },
  "not.7": { en: "Wolof checked by a native speaker.", fr: "Le wolof relu par quelqu'un dont c'est la langue.", wo: "Wolof bi, nit ku ko nàmp seetagu ko." },
  "honest.d": {
    en: "Melax holds the ecash for people on USSD. A small phone cannot hold keys. We say so.",
    fr: "Melax garde l'ecash des gens qui passent par USSD. Un petit téléphone ne peut pas garder de clés. On le dit.",
    wo: "Melax moo lay dencal sa ecash. Telefon bu ndaw mënul denc caabi. Dañu koy wax.",
  },

  // ----- landing: under it -----
  "under.title": { en: "What is under it", fr: "Sous le capot", wo: "Li nekk ci suuf" },
  "under.d": {
    en: "Lightning moves the sats. Cashu ecash holds the balances. The mint that issues the ecash never sees a phone number. The gateway that knows the numbers cannot issue money.",
    fr: "Lightning déplace les sats. L'ecash Cashu tient les soldes. Le mint qui émet l'ecash ne voit jamais un numéro de téléphone. La passerelle qui connaît les numéros ne peut pas créer d'argent.",
    wo: "Lightning mooy yóbbu sats yi. Cashu ecash mooy denc li nga am. Mint bi di defar ecash du gis mukk nimero telefon. Gateway bi xam nimero yi mënul defar xaalis.",
  },
  "foot.made": { en: "Built for the Dakar Bitcoin Hack 2026.", fr: "Fait pour le Dakar Bitcoin Hack 2026.", wo: "Defar nañu ko ngir Dakar Bitcoin Hack 2026." },
  "foot.net": { en: "Test network. These coins are worth nothing.", fr: "Réseau de test. Ces pièces ne valent rien.", wo: "Réseau jéemantu. Xaalis bii amul njëg." },

  // ----- simulator: frame -----
  "demo.warn": {
    en: "Test network. No real money. Do not use a code you use somewhere else.",
    fr: "Réseau de test. Pas de vrai argent. N'utilisez pas un code qui vous sert ailleurs.",
    wo: "Réseau jéemantu. Du xaalis dëgg. Bul jëfandikoo kod boo yore feneen.",
  },
  "demo.loading": { en: "Connecting...", fr: "Connexion...", wo: "Mu ngi lonku..." },
  "demo.down": {
    en: "The demo server does not answer. Start it with: docker compose up",
    fr: "Le serveur de démo ne répond pas. Lancez-le avec : docker compose up",
    wo: "Serwër demo bi tontuwul. Taal ko ak: docker compose up",
  },

  // ----- simulator: the guide -----
  "guide.step": { en: "Step {n} of 4", fr: "Étape {n} sur 4", wo: "Jéego {n} ci 4" },
  "guide.done": { en: "Done", fr: "Fait", wo: "Jeex na" },
  "g1.t": { en: "Open your account", fr: "Ouvrez votre compte", wo: "Ubbil sa kont" },
  "g1.d": {
    en: "Press the green key to dial #2580#. Pick a language. Choose a 5-digit code and type it twice. Then type your first name.",
    fr: "Appuyez sur la touche verte pour composer #2580#. Choisissez une langue. Choisissez un code de 5 chiffres et tapez-le deux fois. Puis tapez votre prénom.",
    wo: "Bësal butoŋ bu wert bi ngir bind #2580#. Tannal làkk. Tannal kod bu am 5 chiffres te bind ko ñaari yoon. Ginnaaw ga, bindal sa tur.",
  },
  "g1.tip": {
    en: "After each answer, press the green key. For letters, press abc.",
    fr: "Après chaque réponse, appuyez sur la touche verte. Pour les lettres, appuyez sur abc.",
    wo: "Saa yoo tontoo, bësal butoŋ bu wert bi. Ngir araf yi, bësal abc.",
  },
  "g1.ok": { en: "Account open. The welcome SMS is under the phone.", fr: "Compte ouvert. Le SMS de bienvenue est sous le téléphone.", wo: "Kont bi ubbiku na. SMS bi mu ngi ci suufu telefon bi." },
  "g2.t": { en: "Add test money", fr: "Ajoutez de l'argent de test", wo: "Dugal xaalis bu jéemantu" },
  "g2.d": {
    en: "Tap the button. 5 000 F arrive over Lightning, the way a relative abroad would send them.",
    fr: "Appuyez sur le bouton. 5 000 F arrivent par Lightning, comme si un parent à l'étranger les envoyait.",
    wo: "Bësal butoŋ bi. 5 000 F dinañu agsi ci Lightning, mel ni mbokk mu nekk bitim réew moo la ko yónnee.",
  },
  "g2.btn": { en: "Add 5 000 F", fr: "Ajouter 5 000 F", wo: "Dugal 5 000 F" },
  "g2.wait": { en: "On its way...", fr: "En route...", wo: "Mu ngi ñëw..." },
  "g2.ok": { en: "5 000 F arrived. You got an SMS.", fr: "5 000 F sont arrivés. Vous avez reçu un SMS.", wo: "5 000 F agsi na. Jot nga SMS." },
  "g2.fail": {
    en: "The top-up did not work. Try again in a moment.",
    fr: "La recharge n'a pas marché. Réessayez dans un instant.",
    wo: "Dugal bi antuwul. Jéemaatal ci kanam tuuti.",
  },
  "g2.off": {
    en: "Top-ups are off on this server. Use a ready account instead.",
    fr: "Les recharges sont coupées sur ce serveur. Prenez plutôt un compte prêt.",
    wo: "Dugal xaalis doxul ci serwër bii. Jëlal kont bu pare.",
  },
  "g3.t": { en: "Send 500 F to {name}", fr: "Envoyez 500 F à {name}", wo: "Yónneel {name} 500 F" },
  "g3.d": {
    en: "Dial #2580#. Press 2. Type {name}'s number: {number}. Type 500. Press 1 to confirm. Type your code.",
    fr: "Composez #2580#. Tapez 2. Tapez le numéro de {name} : {number}. Tapez 500. Tapez 1 pour confirmer. Tapez votre code.",
    wo: "Bindal #2580#. Bësal 2. Bindal nimero {name}: {number}. Bindal 500. Bësal 1 ngir nangu. Bindal sa kod.",
  },
  "g3.tip": { en: "After each answer, press the green key.", fr: "Après chaque réponse, appuyez sur la touche verte.", wo: "Saa yoo tontoo, bësal butoŋ bu wert bi." },
  "g3.ok": { en: "Sent. Your receipt came by SMS.", fr: "Envoyé. Votre reçu est arrivé par SMS.", wo: "Yónnee nga ko. Sa resi agsi na ci SMS." },
  "g4.t": { en: "Look at {name}'s phone", fr: "Regardez le téléphone de {name}", wo: "Xoolal telefonu {name}" },
  "g4.d": {
    en: "{name} got an SMS too, with the same receipt number. To open that wallet, the code is {code}.",
    fr: "{name} a reçu un SMS aussi, avec le même numéro de reçu. Pour ouvrir ce portefeuille, le code est {code}.",
    wo: "{name} it jot na SMS, ak benn nimero resi bi. Ngir ubbi kalpe googu, kod bi mooy {code}.",
  },
  "g4.btn": { en: "Show {name}'s phone", fr: "Voir le téléphone de {name}", wo: "Wonal telefonu {name}" },
  "done.t": { en: "That was real ecash.", fr: "C'était du vrai ecash.", wo: "Loolu ecash dëgg la woon." },
  "done.d": {
    en: "Two accounts, one payment, two receipts. Now try anything: 1 for the balance, 8 for the history, or a wrong code to see the lock.",
    fr: "Deux comptes, un paiement, deux reçus. Essayez ce que vous voulez : 1 pour le solde, 8 pour l'historique, ou un faux code pour voir le blocage.",
    wo: "Ñaari kont, benn fey, ñaari resi. Léegi jéemal lu la neex: 1 ngir li nga am, 8 ngir li weesu, walla kod bu baaxul ngir gis tëj bi.",
  },
  "skip.btn": { en: "No time? Use a ready account", fr: "Pas le temps ? Prenez un compte prêt", wo: "Amuloo jot? Jëlal kont bu pare" },
  "skip.note": { en: "You hold {name}'s phone. The code is {code}.", fr: "Vous tenez le téléphone de {name}. Le code est {code}.", wo: "Yaa yor telefonu {name}. Kod bi mooy {code}." },
  "restart.btn": { en: "Start again with a new number", fr: "Recommencer avec un nouveau numéro", wo: "Tambaliwaat ak nimero bu bees" },

  // ----- simulator: the phones -----
  "phone.you": { en: "Your phone", fr: "Votre téléphone", wo: "Sa telefon" },
  "phone.of": { en: "{name}'s phone", fr: "Téléphone de {name}", wo: "Telefonu {name}" },
  "pick.agent": { en: "{name} (agent)", fr: "{name} (agent)", wo: "{name} (agent)" },
  "phone.agent": { en: "{name}'s phone (agent)", fr: "Téléphone de {name} (agent)", wo: "Telefonu {name} (agent)" },

  // ----- simulator: cash-in with an agent -----
  "ag.title": { en: "Now cash in with an agent", fr: "Maintenant, un dépôt chez un agent", wo: "Leegi, dugal xaalis ci agent" },
  "ag.intro": {
    en: "{name} is an agent. You give {name} francs, {name} gives you sats. While you pay, {name}'s sats are locked. Here the francs are pretend.",
    fr: "{name} est agent. Vous donnez des francs à {name}, {name} vous donne des sats. Pendant que vous payez, les sats de {name} sont bloqués. Ici les francs sont fictifs.",
    wo: "{name} agent la. Dangay jox {name} FCFA, {name} jox la sats. Bi ngay fey, sats {name} yi dañuy tëju. Fii, FCFA yi du dëgg.",
  },
  "ag.btn": { en: "Use {name}, the agent", fr: "Prendre {name}, l'agent", wo: "Jël {name}, agent bi" },
  "ag1.t": { en: "On your phone: press 5", fr: "Sur votre téléphone : tapez 5", wo: "Ci sa telefon: bësal 5" },
  "ag1.d": {
    en: "Type 2000, pick {name}, then 1 to confirm. No code: nothing of yours moves yet.",
    fr: "Tapez 2000, choisissez {name}, puis 1 pour confirmer. Pas de code : rien ne bouge chez vous.",
    wo: "Bindal 2000, tannal {name}, te bësal 1. Kod amul: dara du génn ci sa kont.",
  },
  "ag1.ok": { en: "{name}'s sats are locked. Your SMS says where to send the francs.", fr: "Les sats de {name} sont bloqués. Votre SMS dit où envoyer les francs.", wo: "Sats {name} tëju nañu. Sa SMS wax na fan ngay yónnee FCFA yi." },
  "ag2.t": { en: "On {name}'s phone: 0, 4, then 1", fr: "Sur le téléphone de {name} : 0, 4, puis 1", wo: "Ci telefonu {name}: 0, 4, te 1" },
  "ag2.d": {
    en: "Answer 1, the francs arrived. Then {name}'s code: {code}.",
    fr: "Répondez 1, les francs sont arrivés. Puis le code de {name} : {code}.",
    wo: "Tontul 1, xaalis bi agsi na. Te kodu {name}: {code}.",
  },
  "ag.back": {
    en: "To go back to the four steps, pick someone else on the second phone.",
    fr: "Pour revenir aux quatre étapes, choisissez quelqu'un d'autre sur le deuxième téléphone.",
    wo: "Ngir dellu ci ñeenti tappi yi, tannal keneen ci ñaareelu telefon bi.",
  },
  "ag2.show": { en: "Show {name}'s phone", fr: "Voir le téléphone de {name}", wo: "Wone telefonu {name}" },
  "ag.done": {
    en: "Done. {name} said the francs arrived, so the locked sats came to you. Your SMS has the new balance.",
    fr: "C'est fait. {name} a dit que les francs sont arrivés, alors les sats bloqués sont venus chez vous. Votre SMS donne le nouveau solde.",
    wo: "Jeex na. {name} wax na ne FCFA yi agsi nañu, kon sats yi tëjoon ñoo ñów ci yow. Sa SMS wax na li nga am leegi.",
  },
  "a.bond:spendable": { en: "Agents' bonds", fr: "Cautions des agents", wo: "Garanti agent yi" },
  "a.bond:locked": { en: "Agents' bonds, locked", fr: "Cautions des agents, bloquées", wo: "Garanti agent yi, tëj" },
  "a.escrow:spendable": { en: "Cash-outs on hold", fr: "Retraits en attente", wo: "Génne yu ñuy xaar" },
  "a.escrow:locked": { en: "Cash-outs on hold, locked", fr: "Retraits en attente, bloqués", wo: "Génne yu ñuy xaar, tëj" },
  "phone.idle": { en: "Green key to dial", fr: "Touche verte pour composer", wo: "Butoŋ bu wert bi ngir woote" },
  "phone.wrongcode": { en: "This phone only knows {ussd}", fr: "Ce téléphone ne connaît que {ussd}", wo: "Telefon bii {ussd} rekk la xam" },
  "phone.neterr": { en: "No network. Is the demo running?", fr: "Pas de réseau. La démo tourne ?", wo: "Amul réseau. Ndax demo bi mu ngi dox?" },
  "phone.sending": { en: "Sending...", fr: "Envoi...", wo: "Mu ngi dem..." },
  "phone.newsms": { en: "New SMS", fr: "Nouveau SMS", wo: "SMS bu bees" },
  "key.ok": { en: "OK", fr: "OK", wo: "OK" },
  "key.end": { en: "End", fr: "Fin", wo: "Jeex" },
  "key.del": { en: "Del", fr: "Eff", wo: "Far" },
  "who.label": { en: "Other phone", fr: "L'autre téléphone", wo: "Beneen telefon bi" },
  "sms.title": { en: "SMS on this phone", fr: "SMS sur ce téléphone", wo: "SMS yi ci telefon bii" },
  "sms.empty": { en: "No SMS yet.", fr: "Pas encore de SMS.", wo: "Amagul SMS." },

  // ----- simulator: the books -----
  "led.title": { en: "What just happened", fr: "Ce qui vient de se passer", wo: "Li xew léegi" },
  "led.sub": {
    en: "The books, live. Each line is a real entry in the ledger.",
    fr: "Les comptes, en direct. Chaque ligne est une vraie écriture du registre.",
    wo: "Kayitu xaalis bi, léegi. Rëdd wu nekk mbind mu dëgg la.",
  },
  "led.empty": { en: "Nothing yet.", fr: "Rien encore.", wo: "Dara amagul." },
  "led.match": {
    en: "Accounts say {a} sats. Ecash held: {b} sats. They match.",
    fr: "Les comptes disent {a} sats. Ecash détenu : {b} sats. C'est égal.",
    wo: "Kont yi: {a} sats. Ecash bi ñu yor: {b} sats. Ñoo yem.",
  },
  "led.nomatch": {
    en: "Accounts say {a} sats. Ecash held: {b} sats. They do not match.",
    fr: "Les comptes disent {a} sats. Ecash détenu : {b} sats. Ce n'est pas égal.",
    wo: "Kont yi: {a} sats. Ecash bi ñu yor: {b} sats. Yemuñu.",
  },
  "led.mint": { en: "Mint: {name}. Keyset {id}.", fr: "Mint : {name}. Keyset {id}.", wo: "Mint: {name}. Keyset {id}." },
  "led.rate.fixed": { en: "1 BTC = {rate} F. Fixed for the demo.", fr: "1 BTC = {rate} F. Fixe pour la démo.", wo: "1 BTC = {rate} F. Dañu ko téye ngir demo bi." },
  "led.rate.live": { en: "1 BTC = {rate} F. Live rate.", fr: "1 BTC = {rate} F. Taux en direct.", wo: "1 BTC = {rate} F. Njëgu tey." },
  "k.ln.received": { en: "Sats arrived over Lightning", fr: "Des sats sont arrivés par Lightning", wo: "Sats agsi na ci Lightning" },
  "k.vault.mint.reserve": { en: "Set aside to buy ecash", fr: "Mis de côté pour acheter de l'ecash", wo: "Ber nañu ko ngir jënd ecash" },
  "k.vault.mint": { en: "The mint issued ecash", fr: "Le mint a émis de l'ecash", wo: "Mint bi defar na ecash" },
  "k.vault.mint.release": { en: "Top-up undone", fr: "Recharge annulée", wo: "Dugal bi far nañu ko" },
  "k.vault.reserve": { en: "Locked for a payment", fr: "Bloqué pour un paiement", wo: "Tëj nañu ko ngir fey" },
  "k.vault.transfer": { en: "Ecash changed hands", fr: "L'ecash a changé de mains", wo: "Ecash bi soppi na boroom" },
  "k.vault.release": { en: "Unlocked. Nothing was sent", fr: "Débloqué. Rien n'est parti", wo: "Ubbi nañu ko. Dara génnul" },
  "a.locked": { en: "{name}, locked", fr: "{name}, bloqué", wo: "{name}, tëj" },
  "a.float:node": { en: "Gateway's node", fr: "Nœud de la passerelle", wo: "Node gateway bi" },
  "a.float:minting": { en: "On its way to the mint", fr: "En route vers le mint", wo: "Mu ngi dem ci mint bi" },
  "a.ext:lightning": { en: "Lightning network", fr: "Réseau Lightning", wo: "Réseau Lightning" },
} satisfies Record<string, M>;

export type CopyKey = keyof typeof copy;

/** Fill a sentence. A {word} with no value is left as it is, so a missing one shows up on the page. */
export function say(lang: Lang, key: CopyKey, vars: Record<string, string | number> = {}): string {
  return copy[key][lang].replace(/\{(\w+)\}/g, (m, name: string) => (vars[name] === undefined ? m : String(vars[name])));
}

/**
 * The four screens the landing page's phone plays: the menu, the question before a send, the code
 * prompt, the receipt. Exactly what the gateway would send. Checked against packages/i18n by
 * apps/simulator/test/copy.test.ts.
 */
export const screens: Record<Lang, readonly string[]> = {
  fr: ["Melax\n1 Solde\n2 Envoyer\n3 Recevoir\n4 Payer marchand\n5 Depot\n6 Retrait\n0 Suite", "Envoyer 500 F (1 250 sats) a Moussa (78*****02)?\n1 Confirmer\n2 Annuler", "Code secret:", "Envoye: 500 F a Moussa.\nRecu no 1006\nSolde: 12 500 F"],
  wo: ["Melax\n1 Sa xaalis\n2 Yonnee\n3 Jot\n4 Fey jaaykat\n5 Dugal xaalis\n6 Genne xaalis\n0 Yeneen", "Yonnee 500 F (1 250 sats) Moussa (78*****02)?\n1 Waaw\n2 Bayyi", "Sa kod:", "Yonnee nanu 500 F Moussa.\nResi no 1006\nLi des: 12 500 F"],
  en: ["Melax\n1 Balance\n2 Send\n3 Receive\n4 Pay a shop\n5 Cash in\n6 Cash out\n0 More", "Send 500 F (1 250 sats) to Moussa (78*****02)?\n1 Confirm\n2 Cancel", "Secret code:", "Sent: 500 F to Moussa.\nReceipt no 1006\nBalance: 12 500 F"],
};
