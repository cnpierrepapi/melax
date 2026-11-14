// Every word Melax says on a USSD screen or in an SMS, in French, Wolof and English.
// Rules: GSM-7 only (no ç ê ô ë ŋ; the test enforces it), short enough for a 160-character screen,
// plain words, no jargon. Wolof is written the way people text it, without special letters.
// Wolof copy has NOT been reviewed by a native speaker yet: see WOLOF_REVIEWED in index.ts.
export type Lang = "fr" | "wo" | "en";
type M = Record<Lang, string>;

export const messages = {
  // ----- menu labels -----
  "m.balance": { fr: "Solde", wo: "Sa xaalis", en: "Balance" },
  "m.send": { fr: "Envoyer", wo: "Yonnee", en: "Send" },
  "m.receive": { fr: "Recevoir", wo: "Jot", en: "Receive" },
  "m.pay": { fr: "Payer marchand", wo: "Fey jaaykat", en: "Pay a shop" },
  "m.deposit": { fr: "Depot", wo: "Dugal xaalis", en: "Cash in" },
  "m.withdraw": { fr: "Retrait", wo: "Genne xaalis", en: "Cash out" },
  "m.more": { fr: "Suite", wo: "Yeneen", en: "More" },
  "m.vouchers": { fr: "Bons", wo: "Bon yi", en: "Vouchers" },
  "m.history": { fr: "Historique", wo: "Li weesu", en: "History" },
  "m.account": { fr: "Mon compte", wo: "Sama kont", en: "My account" },
  "m.agent": { fr: "Espace agent", wo: "Agent", en: "Agent desk" },
  "m.merchant": { fr: "Mes ventes", wo: "Sama jaay", en: "My sales" },
  "m.back": { fr: "Retour", wo: "Dellu", en: "Back" },
  "m.menu": { fr: "Menu", wo: "Menu", en: "Menu" },
  "m.confirm": { fr: "Confirmer", wo: "Waaw", en: "Confirm" },
  "m.cancel": { fr: "Annuler", wo: "Bayyi", en: "Cancel" },

  // ----- onboarding -----
  "onb.welcome": {
    fr: "Bienvenue sur Melax: du bitcoin sur ce telephone.\nChoisissez un code secret de 5 chiffres:",
    wo: "Dalal ak jamm ci Melax: bitcoin ci sa telefon.\nTannal kod bu am 5 chiffres:",
    en: "Welcome to Melax: bitcoin on this phone.\nChoose a 5-digit secret code:",
  },
  "onb.pin2": { fr: "Retapez le code secret:", wo: "Bindaatal sa kod:", en: "Type the secret code again:" },
  "onb.mismatch": {
    fr: "Les deux codes sont differents.\nChoisissez un code secret de 5 chiffres:",
    wo: "Naari kod yi bokkul.\nTannal kod bu am 5 chiffres:",
    en: "The two codes differ.\nChoose a 5-digit secret code:",
  },
  "onb.weak": {
    fr: "Code trop facile a deviner.\nChoisissez un autre code de 5 chiffres:",
    wo: "Kod bi dafa yomb.\nTannal beneen kod bu am 5 chiffres:",
    en: "That code is too easy to guess.\nChoose another 5-digit code:",
  },
  "onb.name": {
    fr: "Votre prenom (montre a ceux qui vous envoient de l'argent):",
    wo: "Sa tur (nu lay yonnee xaalis dinanu ko gis):",
    en: "Your first name (shown to people who send you money):",
  },
  "onb.badname": { fr: "Prenom: 2 a 16 lettres.\nVotre prenom:", wo: "Tur: 2 ba 16 araf.\nSa tur:", en: "Name: 2 to 16 letters.\nYour first name:" },
  "onb.done": {
    fr: "Compte cree.\nVotre adresse: {address}\nComposez {code} pour l'utiliser.",
    wo: "Sa kont sos na.\nSa adres: {address}\nBindal {code} ngir jefandikoo ko.",
    en: "Account created.\nYour address: {address}\nDial {code} to use it.",
  },

  // ----- PIN and account state -----
  "pin.ask": { fr: "Code secret:", wo: "Sa kod:", en: "Secret code:" },
  "pin.wrong": { fr: "Code faux. Essais restants: {left}.\nCode secret:", wo: "Kod bi baaxul. Li des: {left}.\nSa kod:", en: "Wrong code. Tries left: {left}.\nSecret code:" },
  "pin.locked": { fr: "Code bloque pendant {minutes} min.", wo: "Kod bi tej na {minutes} min.", en: "Code locked for {minutes} min." },
  "err.frozen": {
    fr: "Envois bloques {hours} h apres le changement de code. Votre argent est en securite.",
    wo: "Yonnee tej na {hours} h ginnaaw coppite kod bi. Sa xaalis aar na.",
    en: "Sending is blocked for {hours} h after the code change. Your money is safe.",
  },

  // ----- generic -----
  "amount.ask": { fr: "Montant en FCFA:", wo: "Naata la (FCFA):", en: "Amount in FCFA:" },
  "amount.bad": { fr: "Montant invalide.\nMontant en FCFA:", wo: "Lim bi baaxul.\nNaata la (FCFA):", en: "Invalid amount.\nAmount in FCFA:" },
  cancelled: { fr: "Annule.", wo: "Bayyi nanu ko.", en: "Cancelled." },
  "err.insufficient": { fr: "Solde insuffisant.\nSolde: {balance}", wo: "Sa xaalis doyul.\nLi nga am: {balance}", en: "Not enough balance.\nBalance: {balance}" },
  "err.limit.tx": { fr: "Maximum par operation: {allowed}.", wo: "Li gen a bari ci benn yoon: {allowed}.", en: "Maximum per operation: {allowed}." },
  "err.limit.day": { fr: "Limite du jour atteinte. Reste: {allowed}.", wo: "Limu bes bi jeex na. Li des: {allowed}.", en: "Daily limit reached. Left: {allowed}." },
  "err.limit.month": { fr: "Limite du mois atteinte. Reste: {allowed}.", wo: "Limu weer wi jeex na. Li des: {allowed}.", en: "Monthly limit reached. Left: {allowed}." },
  "err.limit.new": { fr: "Premier envoi a ce numero: maximum {allowed}.", wo: "Njekk yonnee ci nimero bii: {allowed} rekk.", en: "First payment to this number: maximum {allowed}." },
  "err.busy": {
    fr: "Une operation est deja en cours. Reessayez dans une minute.",
    wo: "Am na lu nekk ci yoon. Jeemaatal ci benn minit.",
    en: "Another operation is in progress. Try again in a minute.",
  },
  "err.paused": {
    fr: "Service en pause. Votre argent est en securite. Reessayez plus tard.",
    wo: "Serwis bi taxaw na tuuti. Sa xaalis aar na. Jeemaatal ci kanam.",
    en: "Service paused. Your money is safe. Try again later.",
  },
  "err.generic": { fr: "Service indisponible. Reessayez.", wo: "Serwis bi doxul leegi. Jeemaatal.", en: "Service unavailable. Try again." },
  "err.reported": {
    fr: "Attention: ce destinataire a ete signale pour arnaque. Envoi refuse.",
    wo: "Moytul: nii lanu ko wax ne dafay nax nit. Yonnee bi nanguwul.",
    en: "Warning: this recipient was reported for scams. Payment refused.",
  },
  pending: { fr: "Operation en cours. Vous recevrez un SMS.", wo: "Mi ngi ci yoon. Dinga jot SMS.", en: "In progress. You will get an SMS." },
  expired: { fr: "Session expiree. Recomposez {code}.", wo: "Jot gi jeex na. Bindaatal {code}.", en: "Session expired. Dial {code} again." },
  resume: { fr: "Reprendre ou vous en etiez?\n1 Oui\n2 Non", wo: "Nu topp fa nga yemoon?\n1 Waaw\n2 Deedeet", en: "Continue where you stopped?\n1 Yes\n2 No" },

  // ----- balance -----
  "bal.show": { fr: "Solde: {fcfa}\n({sats})\n1 BTC = {rate}\n0 Menu", wo: "Li nga am: {fcfa}\n({sats})\n1 BTC = {rate}\n0 Menu", en: "Balance: {fcfa}\n({sats})\n1 BTC = {rate}\n0 Menu" },

  // ----- send -----
  "send.to": {
    fr: "Envoyer a:\nnumero (ex 771234567)\nou code de paiement (6 chiffres)",
    wo: "Yonnee ci:\nnimero (ni 771234567)\nwalla kodu fey (6 chiffres)",
    en: "Send to:\nphone number (e.g. 771234567)\nor pay code (6 digits)",
  },
  "send.badto": { fr: "Numero ou code invalide.\nNumero ou code de paiement:", wo: "Nimero walla kod bi baaxul.\nNimero walla kodu fey:", en: "Invalid number or code.\nNumber or pay code:" },
  "send.self": { fr: "C'est votre propre numero.\nNumero ou code de paiement:", wo: "Sa nimero bopp la.\nNimero walla kodu fey:", en: "That is your own number.\nNumber or pay code:" },
  "send.confirm": {
    fr: "Envoyer {fcfa} ({sats}) a {name} ({masked})?\n1 Confirmer\n2 Annuler",
    wo: "Yonnee {fcfa} ({sats}) {name} ({masked})?\n1 Waaw\n2 Bayyi",
    en: "Send {fcfa} ({sats}) to {name} ({masked})?\n1 Confirm\n2 Cancel",
  },
  "send.confirm_voucher": {
    fr: "{masked} n'a pas Melax. Lui envoyer {fcfa} par bon SMS?\n1 Confirmer\n2 Annuler",
    wo: "{masked} amul Melax. Yonnee ko {fcfa} ci bon SMS?\n1 Waaw\n2 Bayyi",
    en: "{masked} is not on Melax. Send {fcfa} as an SMS voucher?\n1 Confirm\n2 Cancel",
  },
  "send.done": { fr: "Envoye: {fcfa} a {name}.\nRecu no {receipt}\nSolde: {balance}", wo: "Yonnee nanu {fcfa} {name}.\nResi no {receipt}\nLi des: {balance}", en: "Sent: {fcfa} to {name}.\nReceipt no {receipt}\nBalance: {balance}" },
  "send.voucher_done": { fr: "Bon de {fcfa} envoye par SMS au {masked}.\nSolde: {balance}", wo: "Bon bu {fcfa} yonnee nanu ko {masked} ci SMS.\nLi des: {balance}", en: "Voucher of {fcfa} sent by SMS to {masked}.\nBalance: {balance}" },
  "pc.confirm": { fr: "Payer {fcfa} ({sats}) a {label}?\n1 Confirmer\n2 Annuler", wo: "Fey {fcfa} ({sats}) {label}?\n1 Waaw\n2 Bayyi", en: "Pay {fcfa} ({sats}) to {label}?\n1 Confirm\n2 Cancel" },
  "pc.bad": { fr: "Code de paiement inconnu ou expire.", wo: "Kodu fey bi amul walla jeex na.", en: "Unknown or expired pay code." },
  "pc.done": { fr: "Paye: {fcfa} a {label}.\nSolde: {balance}", wo: "Fey nanu {fcfa} {label}.\nLi des: {balance}", en: "Paid: {fcfa} to {label}.\nBalance: {balance}" },

  // ----- receive -----
  "recv.show": {
    fr: "Pour recevoir, donnez votre numero, ou:\n{address}\n1 Recevoir l'adresse par SMS\n0 Menu",
    wo: "Ngir jot xaalis, joxeel sa nimero, walla:\n{address}\n1 Jot adres bi ci SMS\n0 Menu",
    en: "To receive, give your number, or:\n{address}\n1 Get the address by SMS\n0 Menu",
  },
  "recv.sent": { fr: "Adresse envoyee par SMS.", wo: "Adres bi yonnee nanu ko ci SMS.", en: "Address sent by SMS." },

  // ----- pay a merchant -----
  "pay.code": { fr: "Code marchand (5 chiffres):", wo: "Kodu jaaykat (5 chiffres):", en: "Shop code (5 digits):" },
  "pay.badcode": { fr: "Marchand introuvable.\nCode marchand (5 chiffres):", wo: "Jaaykat bi gisunu ko.\nKodu jaaykat (5 chiffres):", en: "Shop not found.\nShop code (5 digits):" },
  "pay.confirm": { fr: "Payer {fcfa} ({sats}) a {shop}?\n1 Confirmer\n2 Annuler", wo: "Fey {fcfa} ({sats}) {shop}?\n1 Waaw\n2 Bayyi", en: "Pay {fcfa} ({sats}) to {shop}?\n1 Confirm\n2 Cancel" },
  "pay.done": { fr: "Paye: {fcfa} a {shop}.\nRecu no {receipt}\nSolde: {balance}", wo: "Fey nanu {fcfa} {shop}.\nResi no {receipt}\nLi des: {balance}", en: "Paid: {fcfa} to {shop}.\nReceipt no {receipt}\nBalance: {balance}" },

  // ----- cash in / cash out with an agent -----
  "agents.none": { fr: "Aucun agent disponible pour ce montant.", wo: "Amul agent ngir lim bii.", en: "No agent available for this amount." },
  "agents.pick": { fr: "Choisir un agent:", wo: "Tannal agent:", en: "Choose an agent:" },
  "dep.confirm": {
    fr: "Depot de {fcfa} chez {agent} par {method}. Vous recevrez {sats}.\n1 Confirmer\n2 Annuler",
    wo: "Dugal {fcfa} ci {agent} ak {method}. Dinga jot {sats}.\n1 Waaw\n2 Bayyi",
    en: "Cash in {fcfa} with {agent} by {method}. You will get {sats}.\n1 Confirm\n2 Cancel",
  },
  "dep.done": {
    fr: "Envoyez {fcfa} par {method} au {number} ({agent}).\nRef {ref}. Details par SMS.",
    wo: "Yonneel {fcfa} ci {method} ci {number} ({agent}).\nRef {ref}. Lepp ci SMS.",
    en: "Send {fcfa} by {method} to {number} ({agent}).\nRef {ref}. Details by SMS.",
  },
  "wd.confirm": {
    fr: "Retrait de {fcfa} chez {agent} par {method}. {sats} seront bloques.\n1 Confirmer\n2 Annuler",
    wo: "Genne {fcfa} ci {agent} ak {method}. {sats} dinanu ko tej.\n1 Waaw\n2 Bayyi",
    en: "Cash out {fcfa} with {agent} by {method}. {sats} will be locked.\n1 Confirm\n2 Cancel",
  },
  "wd.done": {
    fr: "Retrait {ref} lance. {agent} vous envoie {fcfa} par {method}.\nConfirmez la reception au menu 6.",
    wo: "Genne {ref} tambali na. {agent} dina la yonnee {fcfa} ci {method}.\nWaxal ne jot nga ci menu 6.",
    en: "Cash out {ref} started. {agent} sends you {fcfa} by {method}.\nConfirm receipt in menu 6.",
  },
  "wd.pending": {
    fr: "Retrait {ref}: avez-vous recu {fcfa} de {agent}?\n1 Oui, recu\n2 Pas encore\n3 Litige",
    wo: "Genne {ref}: ndax jot nga {fcfa} ci {agent}?\n1 Waaw, jot naa\n2 Deedeet\n3 Am na jafe-jafe",
    en: "Cash out {ref}: did you get {fcfa} from {agent}?\n1 Yes, received\n2 Not yet\n3 Dispute",
  },
  "wd.confirmed": { fr: "Merci. Retrait {ref} termine.", wo: "Jerejef. Genne {ref} jeex na.", en: "Thank you. Cash out {ref} complete." },
  "wd.wait": { fr: "D'accord. Revenez au menu 6 quand l'argent arrive.", wo: "Baax na. Dellusil ci menu 6 bu xaalis bi agsee.", en: "OK. Come back to menu 6 when the money arrives." },
  "dispute.opened": {
    fr: "Litige ouvert pour {ref}. Un arbitre vous contactera. Gardez votre reference de transfert.",
    wo: "Jafe-jafe bi bind nanu ko ngir {ref}. Arbit bi dina la woo. Deel sa referans.",
    en: "Dispute opened for {ref}. An arbiter will contact you. Keep your transfer reference.",
  },

  // ----- vouchers -----
  "vch.create": { fr: "Creer un bon", wo: "Sos bon", en: "Create a voucher" },
  "vch.redeem": { fr: "Encaisser un bon", wo: "Jot bon", en: "Redeem a voucher" },
  "vch.created": {
    fr: "Bon de {fcfa}:\n{code}\nValable 30 jours. Aussi envoye par SMS.",
    wo: "Bon bu {fcfa}:\n{code}\nDina yagg 30 fan. Yonnee nanu ko itam ci SMS.",
    en: "Voucher of {fcfa}:\n{code}\nValid 30 days. Also sent by SMS.",
  },
  "vch.code": { fr: "Code du bon (16 caracteres):", wo: "Kodu bon bi (16 araf):", en: "Voucher code (16 characters):" },
  "vch.badcode": { fr: "Code invalide. Verifiez et retapez:", wo: "Kod bi baaxul. Seetal te bindaat ko:", en: "Invalid code. Check and type again:" },
  "vch.redeemed": { fr: "Bon encaisse: {fcfa}.\nSolde: {balance}", wo: "Bon bi jot nga ko: {fcfa}.\nLi nga am: {balance}", en: "Voucher redeemed: {fcfa}.\nBalance: {balance}" },
  "vch.gone": { fr: "Ce bon est deja utilise ou expire.", wo: "Bon bii jefandikoo nanu ko walla jeex na.", en: "This voucher is already used or expired." },

  // ----- history -----
  "hist.empty": { fr: "Aucune operation.", wo: "Amul dara.", en: "No transactions yet." },

  // ----- account -----
  "acct.pin": { fr: "Code secret", wo: "Kod", en: "Secret code" },
  "acct.lang": { fr: "Langue", wo: "Lakk", en: "Language" },
  "acct.address": { fr: "Mon adresse", wo: "Sama adres", en: "My address" },
  "acct.guardians": { fr: "Gardiens", wo: "Wottukat yi", en: "Guardians" },
  "acct.limits": { fr: "Limites", wo: "Lim yi", en: "Limits" },
  "acct.smartphone": { fr: "Smartphone", wo: "Smartphone", en: "Smartphone" },
  "pinchg.change": { fr: "Changer le code", wo: "Soppi kod bi", en: "Change the code" },
  "pinchg.forgot": { fr: "Code oublie", wo: "Fatte naa kod bi", en: "Forgot the code" },
  "pinchg.old": { fr: "Ancien code secret:", wo: "Kod bu yagg bi:", en: "Current secret code:" },
  "pinchg.new": { fr: "Nouveau code (5 chiffres):", wo: "Kod bu bees (5 chiffres):", en: "New code (5 digits):" },
  "pinchg.new2": { fr: "Retapez le nouveau code:", wo: "Bindaatal kod bu bees bi:", en: "Type the new code again:" },
  "pinchg.done": { fr: "Code secret change.", wo: "Kod bi soppiku na.", en: "Secret code changed." },
  "reset.started": {
    fr: "Demande {ref} envoyee a vos gardiens. Il faut 2 accords. Recomposez {code} ensuite.",
    wo: "Laaj {ref} yonnee nanu ko sa wottukat yi. Naar nangu war. Bindaatal {code} su ko defee.",
    en: "Request {ref} sent to your guardians. Two must agree. Then dial {code} again.",
  },
  "reset.noguardians": {
    fr: "Aucun gardien enregistre. Allez chez un agent Melax avec ce telephone.",
    wo: "Amul wottukat. Demal ci agent Melax ak telefon bii.",
    en: "No guardians on file. Visit a Melax agent with this phone.",
  },
  "reset.newpin": {
    fr: "Vos gardiens ont accepte.\nNouveau code secret (5 chiffres):",
    wo: "Sa wottukat yi nangu nanu.\nKod bu bees (5 chiffres):",
    en: "Your guardians agreed.\nNew secret code (5 digits):",
  },
  "reset.done": {
    fr: "Code change. Par securite, les envois sont bloques 24 h.",
    wo: "Kod bi soppiku na. Ngir kaaraange, yonnee tej na 24 h.",
    en: "Code changed. For safety, sending is blocked for 24 h.",
  },
  "lang.done": { fr: "Langue: Francais.", wo: "Lakk: Wolof.", en: "Language: English." },
  "addr.show": { fr: "Votre adresse:\n{address}\n1 Changer le nom\n0 Menu", wo: "Sa adres:\n{address}\n1 Soppi tur wi\n0 Menu", en: "Your address:\n{address}\n1 Change the name\n0 Menu" },
  "addr.ask": { fr: "Nouveau nom (lettres, chiffres, tirets; 3 a 20):", wo: "Tur bu bees (araf, chiffres, tire; 3 ba 20):", en: "New name (letters, digits, dashes; 3 to 20):" },
  "addr.bad": { fr: "Nom invalide ou deja pris.\nNouveau nom:", wo: "Tur bi baaxul walla am na boroom.\nTur bu bees:", en: "Invalid or taken.\nNew name:" },
  "addr.done": { fr: "Nouvelle adresse:\n{address}", wo: "Adres bu bees:\n{address}", en: "New address:\n{address}" },
  "grd.show": {
    fr: "Gardiens: {n}/3. Deux gardiens peuvent debloquer votre code.\n{list}\n1 Ajouter\n0 Menu",
    wo: "Wottukat: {n}/3. Naar mun nanu ubbi sa kod.\n{list}\n1 Yokk\n0 Menu",
    en: "Guardians: {n}/3. Two guardians can unlock your code.\n{list}\n1 Add\n0 Menu",
  },
  "grd.none": { fr: "(aucun)", wo: "(amul)", en: "(none)" },
  "grd.ask": { fr: "Numero du gardien:", wo: "Nimero wottukat bi:", en: "Guardian's phone number:" },
  "grd.bad": { fr: "Numero invalide.\nNumero du gardien:", wo: "Nimero bi baaxul.\nNimero wottukat bi:", en: "Invalid number.\nGuardian's phone number:" },
  "grd.added": { fr: "Gardien ajoute: {masked}. Il recoit un SMS.", wo: "Wottukat bi yokk nanu ko: {masked}. Dina jot SMS.", en: "Guardian added: {masked}. They get an SMS." },
  "grd.full": { fr: "Vous avez deja 3 gardiens.", wo: "Am nga 3 wottukat ba noppi.", en: "You already have 3 guardians." },
  "lim.show": {
    fr: "Niveau {tier}\nPar operation: {tx}\nReste aujourd'hui: {day}\nReste ce mois: {month}\n0 Menu",
    wo: "Niveau {tier}\nBenn yoon: {tx}\nLi des tey: {day}\nLi des ci weer wi: {month}\n0 Menu",
    en: "Level {tier}\nPer operation: {tx}\nLeft today: {day}\nLeft this month: {month}\n0 Menu",
  },
  "grad.title": { fr: "Passer au smartphone", wo: "Dem ci smartphone", en: "Move to a smartphone" },
  "grad.toaddr": { fr: "Vers une adresse Lightning", wo: "Ci adres Lightning", en: "To a Lightning address" },
  "grad.tovoucher": { fr: "Bon pour tout le solde", wo: "Bon ngir sa xaalis lepp", en: "Voucher for the full balance" },
  "grad.addr": { fr: "Adresse Lightning (nom@domaine):", wo: "Adres Lightning (tur@domaine):", en: "Lightning address (name@domain):" },
  "grad.badaddr": { fr: "Adresse invalide.\nAdresse Lightning (nom@domaine):", wo: "Adres bi baaxul.\nAdres Lightning (tur@domaine):", en: "Invalid address.\nLightning address (name@domain):" },
  "grad.confirm": { fr: "Envoyer tout le solde ({fcfa}) a {address}?\n1 Confirmer\n2 Annuler", wo: "Yonnee sa xaalis lepp ({fcfa}) ci {address}?\n1 Waaw\n2 Bayyi", en: "Send the full balance ({fcfa}) to {address}?\n1 Confirm\n2 Cancel" },
  "grad.done": { fr: "Envoye: {fcfa} a {address}.", wo: "Yonnee nanu {fcfa} ci {address}.", en: "Sent: {fcfa} to {address}." },
  "grad.voucher": {
    fr: "Bon cree pour tout le solde. Code par SMS. Ouvrez {url} sur le smartphone.",
    wo: "Bon bi sos na ngir sa xaalis lepp. Kod bi ci SMS. Ubbil {url} ci smartphone bi.",
    en: "Voucher created for the full balance. Code by SMS. Open {url} on the smartphone.",
  },

  // ----- agent desk -----
  "agent.deposits": { fr: "Depots a confirmer ({n})", wo: "Dugal yu war a wer ({n})", en: "Cash-ins to confirm ({n})" },
  "agent.withdrawals": { fr: "Retraits a payer ({n})", wo: "Genne yu war a fey ({n})", en: "Cash-outs to pay ({n})" },
  "agent.bond": { fr: "Ma caution", wo: "Sama garanti", en: "My bond" },
  "agent.offer": { fr: "Mon offre", wo: "Sama of", en: "My offer" },
  "agent.none": { fr: "Rien en attente.", wo: "Dara xaarul.", en: "Nothing waiting." },
  "agent.dep.ask": {
    fr: "{ref}: avez-vous recu {fcfa} de {masked} par {method}?\n1 Oui, recu\n2 Non",
    wo: "{ref}: ndax jot nga {fcfa} ci {masked} ak {method}?\n1 Waaw, jot naa\n2 Deedeet",
    en: "{ref}: did you receive {fcfa} from {masked} by {method}?\n1 Yes, received\n2 No",
  },
  "agent.dep.done": { fr: "Depot {ref} confirme. {sats} livres au client.", wo: "Dugal {ref} wer na. {sats} joxe nanu ko kliyan bi.", en: "Cash-in {ref} confirmed. {sats} delivered to the customer." },
  "agent.dep.no": { fr: "D'accord. {ref} reste ouvert jusqu'a son expiration.", wo: "Baax na. {ref} dina des ba mu jeex.", en: "OK. {ref} stays open until it expires." },
  "agent.wd.ask": {
    fr: "{ref}: envoyez {fcfa} par {method} au {number} ({name}).\n1 C'est envoye\n2 Refuser",
    wo: "{ref}: yonneel {fcfa} ci {method} ci {number} ({name}).\n1 Yonnee naa\n2 Bayyi",
    en: "{ref}: send {fcfa} by {method} to {number} ({name}).\n1 Sent\n2 Decline",
  },
  "agent.wd.done": { fr: "Note. Le client doit confirmer la reception.", wo: "Bind nanu ko. Kliyan bi war na wax ne jot na.", en: "Noted. The customer must confirm receipt." },
  "agent.wd.refused": { fr: "Retrait {ref} annule.", wo: "Genne {ref} bayyi nanu ko.", en: "Cash-out {ref} cancelled." },
  "agent.bond.show": {
    fr: "Caution: {sats}\nNiveau {tier}: jusqu'a {max} par echange.\n0 Menu",
    wo: "Garanti: {sats}\nNiveau {tier}: ba {max} ci benn wecce.\n0 Menu",
    en: "Bond: {sats}\nLevel {tier}: up to {max} per trade.\n0 Menu",
  },
  "agent.offer.show": {
    fr: "Offre: prime {premium}%, {methods}, {min} a {max}. {state}\n1 Activer/Desactiver\n0 Menu",
    wo: "Of: {premium}%, {methods}, {min} ba {max}. {state}\n1 Taal/Fey\n0 Menu",
    en: "Offer: premium {premium}%, {methods}, {min} to {max}. {state}\n1 Turn on/off\n0 Menu",
  },
  "agent.on": { fr: "Active.", wo: "Taal na.", en: "On." },
  "agent.off": { fr: "En pause.", wo: "Fey na.", en: "Paused." },

  // ----- merchant -----
  "merch.summary": {
    fr: "{shop}\nAujourd'hui: {count} ventes, {fcfa}.\nCode marchand: {mcode}\n1 Resume par SMS\n0 Menu",
    wo: "{shop}\nTey: {count} jaay, {fcfa}.\nKodu jaaykat: {mcode}\n1 Tenk ci SMS\n0 Menu",
    en: "{shop}\nToday: {count} sales, {fcfa}.\nShop code: {mcode}\n1 Summary by SMS\n0 Menu",
  },
  "merch.sent": { fr: "Resume envoye par SMS.", wo: "Tenk bi yonnee nanu ko ci SMS.", en: "Summary sent by SMS." },

  // ----- SMS -----
  "sms.welcome": {
    fr: "Melax: compte cree. Adresse: {address}. Composez {code}. Ne donnez jamais votre code secret, meme a un agent.",
    wo: "Melax: sa kont sos na. Adres: {address}. Bindal {code}. Bul joxe mukk sa kod, doonte agent la.",
    en: "Melax: account created. Address: {address}. Dial {code}. Never give your secret code to anyone, not even an agent.",
  },
  "sms.received": { fr: "Melax: recu {fcfa} de {name}. Solde: {balance}. Recu no {receipt}", wo: "Melax: jot nga {fcfa} ci {name}. Li nga am: {balance}. Resi no {receipt}", en: "Melax: received {fcfa} from {name}. Balance: {balance}. Receipt no {receipt}" },
  "sms.sent": { fr: "Melax: envoye {fcfa} a {name}. Solde: {balance}. Recu no {receipt}", wo: "Melax: yonnee nga {fcfa} {name}. Li des: {balance}. Resi no {receipt}", en: "Melax: sent {fcfa} to {name}. Balance: {balance}. Receipt no {receipt}" },
  "sms.ln_received": { fr: "Melax: recu {fcfa} par Lightning. {comment}Solde: {balance}.", wo: "Melax: jot nga {fcfa} ci Lightning. {comment}Li nga am: {balance}.", en: "Melax: received {fcfa} over Lightning. {comment}Balance: {balance}." },
  "sms.ln_sent": { fr: "Melax: paye {fcfa} par Lightning a {label}. Solde: {balance}.", wo: "Melax: fey nga {fcfa} ci Lightning {label}. Li des: {balance}.", en: "Melax: paid {fcfa} over Lightning to {label}. Balance: {balance}." },
  "sms.pay_failed": { fr: "Melax: le paiement de {fcfa} n'est pas passe. Rien n'a ete debite.", wo: "Melax: fey bu {fcfa} antuwul. Dara genul ci sa kont.", en: "Melax: the payment of {fcfa} did not go through. Nothing was debited." },
  "sms.merchant_paid": { fr: "Melax: {fcfa} recus de {name}. Recu no {receipt}. Solde: {balance}", wo: "Melax: jot nga {fcfa} ci {name}. Resi no {receipt}. Li nga am: {balance}", en: "Melax: {fcfa} received from {name}. Receipt no {receipt}. Balance: {balance}" },
  "sms.voucher_to": {
    fr: "{name} vous envoie {fcfa} en bitcoin. Code: {code}. Pour encaisser: composez {ussd} ou ouvrez {url}. Valable 30 jours.",
    wo: "{name} yonnee na la {fcfa} ci bitcoin. Kod: {code}. Ngir jot ko: bindal {ussd} walla ubbil {url}. 30 fan.",
    en: "{name} sent you {fcfa} in bitcoin. Code: {code}. To redeem: dial {ussd} or open {url}. Valid 30 days.",
  },
  "sms.voucher_self": { fr: "Melax: bon de {fcfa}. Code: {code}. Valable 30 jours. Encaisser: {ussd} ou {url}", wo: "Melax: bon bu {fcfa}. Kod: {code}. 30 fan. Jot ko: {ussd} walla {url}", en: "Melax: voucher of {fcfa}. Code: {code}. Valid 30 days. Redeem: {ussd} or {url}" },
  "sms.voucher_redeemed": { fr: "Melax: votre bon de {fcfa} a ete encaisse.", wo: "Melax: sa bon bu {fcfa} jot nanu ko.", en: "Melax: your voucher of {fcfa} was redeemed." },
  "sms.voucher_refund": { fr: "Melax: votre bon de {fcfa} n'a pas ete encaisse. L'argent est revenu sur votre compte.", wo: "Melax: sa bon bu {fcfa} kenn jotu ko. Xaalis bi dellusi na ci sa kont.", en: "Melax: your voucher of {fcfa} was not redeemed. The money is back in your account." },
  "sms.voucher_in": { fr: "Melax: bon encaisse, +{fcfa}. Solde: {balance}.", wo: "Melax: bon bi jot nga ko, +{fcfa}. Li nga am: {balance}.", en: "Melax: voucher redeemed, +{fcfa}. Balance: {balance}." },
  "sms.voucher_bad": { fr: "Melax: code de bon invalide ou deja utilise.", wo: "Melax: kodu bon bi baaxul walla jefandikoo nanu ko.", en: "Melax: voucher code invalid or already used." },
  "sms.dep_user": {
    fr: "Melax depot {ref}: envoyez {fcfa} par {method} au {number} ({agent}). Vous recevrez {sats}. Annule apres 45 min.",
    wo: "Melax dugal {ref}: yonneel {fcfa} ci {method} ci {number} ({agent}). Dinga jot {sats}. Dina far ginnaaw 45 min.",
    en: "Melax cash-in {ref}: send {fcfa} by {method} to {number} ({agent}). You will get {sats}. Cancelled after 45 min.",
  },
  "sms.dep_agent": {
    fr: "Melax {ref}: {masked} va vous envoyer {fcfa} par {method}. Confirmez la reception: {ussd}, Espace agent.",
    wo: "Melax {ref}: {masked} dina la yonnee {fcfa} ci {method}. Waxal ne jot nga: {ussd}, Agent.",
    en: "Melax {ref}: {masked} will send you {fcfa} by {method}. Confirm receipt: {ussd}, Agent desk.",
  },
  "sms.dep_done": { fr: "Melax: depot {ref} recu, +{fcfa}. Solde: {balance}.", wo: "Melax: dugal {ref} agsi na, +{fcfa}. Li nga am: {balance}.", en: "Melax: cash-in {ref} received, +{fcfa}. Balance: {balance}." },
  "sms.dep_cancel": { fr: "Melax: depot {ref} annule. Rien n'a ete debite.", wo: "Melax: dugal {ref} far na. Dara genul.", en: "Melax: cash-in {ref} cancelled. Nothing was debited." },
  "sms.wd_agent": {
    fr: "Melax {ref}: envoyez {fcfa} par {method} au {number} ({name}). Puis marquez-le envoye: {ussd}, Espace agent.",
    wo: "Melax {ref}: yonneel {fcfa} ci {method} ci {number} ({name}). Su ko defee, bind ko: {ussd}, Agent.",
    en: "Melax {ref}: send {fcfa} by {method} to {number} ({name}). Then mark it sent: {ussd}, Agent desk.",
  },
  "sms.wd_user_sent": {
    fr: "Melax {ref}: {agent} dit avoir envoye {fcfa} par {method}. Verifiez, puis confirmez: {ussd}, menu 6.",
    wo: "Melax {ref}: {agent} nee na yonnee na {fcfa} ci {method}. Seetal, te wer ko: {ussd}, menu 6.",
    en: "Melax {ref}: {agent} says {fcfa} was sent by {method}. Check, then confirm: {ussd}, menu 6.",
  },
  "sms.wd_done_user": { fr: "Melax: retrait {ref} termine, -{fcfa}. Solde: {balance}.", wo: "Melax: genne {ref} jeex na, -{fcfa}. Li des: {balance}.", en: "Melax: cash-out {ref} complete, -{fcfa}. Balance: {balance}." },
  "sms.wd_done_agent": { fr: "Melax: retrait {ref} confirme. {sats} payes sur votre portefeuille.", wo: "Melax: genne {ref} wer na. {sats} fey nanu ko ci sa kalpe.", en: "Melax: cash-out {ref} confirmed. {sats} paid to your wallet." },
  "sms.wd_cancel": { fr: "Melax: retrait {ref} annule. Vos {fcfa} sont debloques.", wo: "Melax: genne {ref} far na. Sa {fcfa} ubbiku na.", en: "Melax: cash-out {ref} cancelled. Your {fcfa} are unlocked." },
  "sms.dispute": { fr: "Melax: litige ouvert sur {ref}. Un arbitre tranche sous 24 h. Gardez votre reference {method}.", wo: "Melax: jafe-jafe ci {ref}. Arbit bi dina ko ate ci 24 h. Deel sa referans {method}.", en: "Melax: dispute opened on {ref}. An arbiter decides within 24 h. Keep your {method} reference." },
  "sms.dispute_won": { fr: "Melax: litige {ref} tranche en votre faveur.", wo: "Melax: jafe-jafe {ref}: yaa ko am.", en: "Melax: dispute {ref} decided in your favour." },
  "sms.dispute_lost": { fr: "Melax: litige {ref} tranche en faveur de l'autre partie.", wo: "Melax: jafe-jafe {ref}: keneen ki moo ko am.", en: "Melax: dispute {ref} decided for the other party." },
  "sms.guardian_added": {
    fr: "Melax: {name} ({masked}) vous a choisi comme gardien. S'il perd son code secret, on vous demandera votre accord.",
    wo: "Melax: {name} ({masked}) tann na la wottukat. Su fattee kodam, dinanu la laaj sa nangu.",
    en: "Melax: {name} ({masked}) chose you as a guardian. If they lose their secret code, you will be asked to approve.",
  },
  "sms.reset_ask": {
    fr: "Melax: {name} ({masked}) veut changer son code secret. Appelez-le pour verifier. Si c'est bien lui, repondez: OUI {ref}",
    wo: "Melax: {name} ({masked}) dafa beg soppi kodam. Woo ko ngir wer. Su dee moom la, tontul: OUI {ref}",
    en: "Melax: {name} ({masked}) wants to change their secret code. Call them to check. If it is them, reply: YES {ref}",
  },
  "sms.reset_alert": {
    fr: "Melax: on demande a changer votre code secret. Si ce n'est pas vous, repondez: ANNULER {ref}",
    wo: "Melax: am na ku beg soppi sa kod. Su dul yow, tontul: ANNULER {ref}",
    en: "Melax: someone asked to change your secret code. If it is not you, reply: CANCEL {ref}",
  },
  "sms.reset_ready": { fr: "Melax: vos gardiens ont accepte. Composez {code} pour choisir un nouveau code.", wo: "Melax: sa wottukat yi nangu nanu. Bindal {code} ngir tann kod bu bees.", en: "Melax: your guardians agreed. Dial {code} to choose a new code." },
  "sms.reset_cancelled": { fr: "Melax: demande {ref} annulee. Votre code n'a pas change.", wo: "Melax: laaj {ref} far na. Sa kod soppikuwul.", en: "Melax: request {ref} cancelled. Your code did not change." },
  "sms.approved": { fr: "Melax: accord enregistre. Merci.", wo: "Melax: sa nangu bind nanu ko. Jerejef.", en: "Melax: approval recorded. Thank you." },
  "sms.pin_changed": { fr: "Melax: votre code secret a ete change. Si ce n'est pas vous, allez chez un agent.", wo: "Melax: sa kod soppiku na. Su dul yow, demal ci agent.", en: "Melax: your secret code was changed. If it was not you, see an agent." },
  "sms.pin_locked": { fr: "Melax: 5 codes faux. Code bloque {minutes} min. Si ce n'est pas vous, gardez votre telephone pres de vous.", wo: "Melax: 5 kod yu baaxul. Kod bi tej na {minutes} min. Su dul yow, wottul sa telefon.", en: "Melax: 5 wrong codes. Code locked for {minutes} min. If it was not you, keep your phone close." },
  "sms.withdraw_wait": { fr: "Melax: sortie de {fcfa} prevue dans 30 min ({ref}). Pas vous? Repondez: ANNULER {ref}", wo: "Melax: {fcfa} dina genn ci 30 min ({ref}). Du yow? Tontul: ANNULER {ref}", en: "Melax: {fcfa} will leave in 30 min ({ref}). Not you? Reply: CANCEL {ref}" },
  "sms.withdraw_cancelled": { fr: "Melax: sortie {ref} annulee. Votre argent n'a pas bouge.", wo: "Melax: {ref} far na. Sa xaalis yenguwul.", en: "Melax: {ref} cancelled. Your money did not move." },
  "sms.balance": { fr: "Melax: solde {fcfa} ({sats}).", wo: "Melax: li nga am {fcfa} ({sats}).", en: "Melax: balance {fcfa} ({sats})." },
  "sms.address": { fr: "Melax: pour vous payer en bitcoin: {address}", wo: "Melax: ngir fey la ci bitcoin: {address}", en: "Melax: to pay you in bitcoin: {address}" },
  "sms.help": {
    fr: "Melax: composez {code}. Par SMS: SOLDE, BON <code>, ARNAQUE <message>. Ne donnez jamais votre code secret.",
    wo: "Melax: bindal {code}. Ci SMS: SOLDE, BON <kod>, ARNAQUE <bataaxal>. Bul joxe mukk sa kod.",
    en: "Melax: dial {code}. By SMS: BALANCE, VOUCHER <code>, SCAM <message>. Never give your secret code.",
  },
  "sms.unregistered": { fr: "Melax: composez {code} pour creer votre compte.", wo: "Melax: bindal {code} ngir sos sa kont.", en: "Melax: dial {code} to create your account." },
  "sms.scam.yes": { fr: "Melax: ARNAQUE probable. {reason} Ne repondez pas, ne donnez aucun code.", wo: "Melax: xel naa ne NAX la. {reason} Bul tontu, bul joxe benn kod.", en: "Melax: likely a SCAM. {reason} Do not reply, do not give any code." },
  "sms.scam.unsure": { fr: "Melax: prudence. {reason} Melax ne demande jamais votre code secret.", wo: "Melax: moytul. {reason} Melax du laaj mukk sa kod.", en: "Melax: be careful. {reason} Melax never asks for your secret code." },
  "sms.scam.no": { fr: "Melax: rien de suspect vu dans ce message. Restez prudent: ne donnez jamais votre code secret.", wo: "Melax: gisunu dara lu bon ci bataaxal bii. Waaye moytul: bul joxe sa kod.", en: "Melax: nothing suspicious seen in this message. Stay careful: never give your secret code." },
  "sms.merchant_summary": { fr: "Melax {shop}: {count} ventes aujourd'hui, {fcfa}. Solde: {balance}.", wo: "Melax {shop}: {count} jaay tey, {fcfa}. Li nga am: {balance}.", en: "Melax {shop}: {count} sales today, {fcfa}. Balance: {balance}." },

  // ----- scam verdict reasons (rules engine) -----
  "scam.r.pin": { fr: "On vous demande un code secret.", wo: "Dananu la laaj kod.", en: "It asks for a secret code." },
  "scam.r.prize": { fr: "Un gain que vous n'avez pas demande.", wo: "Ndam loo laajul.", en: "A prize you never asked for." },
  "scam.r.urgent": { fr: "On vous presse d'envoyer de l'argent.", wo: "Dananu la yaqamtal ngir nga yonnee xaalis.", en: "It rushes you to send money." },
  "scam.r.double": { fr: "Promesse de doubler votre argent.", wo: "Dig nanu la ne dinanu fulanti sa xaalis.", en: "It promises to double your money." },
  "scam.r.agent": { fr: "Un faux agent ou service client.", wo: "Agent walla serwis bu dul degg.", en: "A fake agent or support line." },
  "scam.r.link": { fr: "Un lien suspect.", wo: "Lien bu woorul.", en: "A suspicious link." },
  "scam.r.reported": { fr: "Ce numero a deja ete signale.", wo: "Nimero bii wax nanu ko ba noppi.", en: "This number was already reported." },
  "scam.r.none": { fr: "", wo: "", en: "" },
} satisfies Record<string, M>;

export type MessageKey = keyof typeof messages;
