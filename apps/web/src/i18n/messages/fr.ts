// French. Written with the code; a fluent speaker reviews it before a client sees it (plan §1.18).
// "Vous" throughout. French typography: a narrow space before ":" is left to the reviewer.
import type { Messages } from "../catalog";

export const fr: Messages = {
  // ── Common ──
  "common.loading": "Chargement…",
  "common.tryAgain": "Réessayer",
  "common.cancel": "Annuler",
  "common.save": "Enregistrer",
  "common.saving": "Enregistrement…",
  "common.copy": "Copier",
  "common.copied": "Copié",
  "common.sending": "Envoi…",
  "common.send": "Envoyer",
  "common.enterToSend": "Entrée pour envoyer, Maj+Entrée pour aller à la ligne",
  "voice.dictate": "Dicter",
  "voice.stop": "Arrêter",
  "voice.listening": "À l’écoute…",
  "voice.writing": "Transcription…",
  "voice.blocked": "Votre navigateur ne nous a pas laissé utiliser le micro.",
  "voice.failed": "Nous n'avons pas pu le transcrire. Réessayez.",
  "attach.add": "Joindre",
  "attach.uploading": "Envoi en cours…",
  "attach.remove": "Retirer",
  "attach.failed": "Nous n'avons pas pu l'envoyer. Réessayez.",
  "attach.refused": "{name} : joignez des PDF ou des images.",
  "common.filter": "Filtre",
  "common.sections": "Sections",
  "common.waiting": "En attente",
  "common.waitingOnYou": "Vous attend",
  "common.expired": "Expiré",
  "common.notBuiltTitle": "Pas encore prêt",
  "common.notBuiltBody": "Cet écran arrive dans une prochaine étape.",
  "common.notFoundTitle": "Page introuvable",
  "common.notFoundBody": "Il n'y a pas de page ici.",
  "common.yes": "Oui",
  "common.no": "Non",
  "common.close": "Fermer",

  // ── Error pages (a page that failed to load) ──
  "errorPage.notFound.run": "Nous n'avons pas trouvé cette exécution.",
  "errorPage.notFound.agent": "Nous n'avons pas trouvé cet agent.",
  "errorPage.notFound.record": "Nous n'avons pas trouvé cet enregistrement.",
  "errorPage.notFound.document": "Nous n'avons pas trouvé ce document.",
  "errorPage.notFound.conversation": "Nous n'avons pas trouvé cette conversation.",
  "errorPage.notFound.client": "Nous n'avons pas trouvé ce client.",
  "errorPage.notFound.template": "Nous n'avons pas trouvé ce modèle.",
  "errorPage.notFound.skill": "Nous n'avons pas trouvé cette compétence.",
  "errorPage.notFound.page": "Nous n'avons pas trouvé cette page.",
  "errorPage.notFound.line":
    "Elle a peut-être été supprimée, ou le lien est celui d'un autre compte.",
  "errorPage.connection.title": "Il faut pour cela une connexion que vous n'avez pas encore faite.",
  "errorPage.connection.line": "Connectez-la dans Connecteurs, puis revenez sur cette page.",
  "errorPage.forbidden.title": "Vous n'avez pas accès à cette page.",
  "errorPage.failure":
    "Un problème est survenu au chargement de cette page. Réessayez dans un instant.",
  "errorPage.crash":
    "Un problème est survenu à l'affichage de cette page. Réessayez ou ouvrez une autre page.",
  "errorPage.crashPart": "Cette partie n'a pas pu s'afficher. Réessayez ou ouvrez une autre page.",
  "errorPage.back.home": "Aller à l'accueil",
  "errorPage.back.runs": "Aller aux exécutions",
  "errorPage.back.records": "Aller aux enregistrements",
  "errorPage.back.sloan": "Aller à Sloan",
  "errorPage.back.accounts": "Aller aux connecteurs",
  "errorPage.back.clients": "Aller aux clients",
  "errorPage.back.lab": "Aller au laboratoire d'agents",
  "errorPage.back.skills": "Aller aux compétences",
  "errorPage.report": "Signaler un problème",
  "errorPage.reportComment": "Cette page ne s'est pas chargée.",
  "errorPage.reported": "Merci, nous avons prévenu l'équipe.",

  // ── Errors ──
  "error.not_found": "Introuvable.",
  "error.forbidden": "Vous n'avez pas accès à ceci.",
  "error.network":
    "Nous ne pouvons pas joindre Mezonas pour le moment. Vérifiez votre connexion et réessayez.",
  "error.internal": "Un problème est survenu de notre côté. Réessayez dans un instant.",
  "error.invalid_request": "Quelque chose ne va pas. Vérifiez et réessayez.",
  "error.invalid_response": "Nous avons reçu une réponse inattendue. Réessayez.",
  "error.unauthenticated": "Votre session a pris fin. Reconnectez-vous.",
  "error.no_access":
    "Votre compte n'est encore lié à aucun client. Demandez à votre contact chez Mezonas.",
  "error.conflict": "Cela existe déjà.",
  "error.no_op": "Rien à changer : c'est déjà le cas.",
  "error.already_resolved": "Quelqu'un a déjà répondu.",
  "error.expired": "Ceci a expiré.",
  "error.changed": "Cet élément a changé depuis que vous l'avez ouvert ; regardez-le à nouveau.",
  "error.run_ended": "Cette exécution est terminée ; rien ne sera fait avec cet élément.",
  "error.fingerprint_required":
    "Cette page n'est plus à jour ; rechargez-la et regardez à nouveau.",
  "error.signature_required":
    "Ceci demande la signature de votre téléphone. Signez avec Face ID ou l'empreinte dans l'app, ou décidez dans un navigateur.",
  "error.not_assignee": "Ceci attend quelqu'un d'autre.",
  "error.not_connected": "Cet outil n'est pas connecté.",
  "error.not_available": "Ce n'est pas encore disponible.",
  "error.too_large": "Ce fichier est trop volumineux.",
  "error.empty": "C'est vide.",
  "error.invalid_state": "Ce n'est pas possible pour le moment.",
  "error.feedback_off": "Les retours ne sont pas activés pour vous.",
  "error.not_configured": "Ceci n'est pas encore configuré sur ce site.",
  "error.loosening": "Seuls nous pouvons assouplir ceci. Vous pouvez le restreindre.",
  "error.invalid_credentials": "Remplissez tous les champs.",
  "error.invalid_grant": "Cet accès n'est pas possible pour cet outil.",
  "error.organization_exists": "Cette organisation est déjà dans l'annuaire.",
  "error.vendor_linked": "Une autre organisation est déjà la fiche de ce fournisseur.",
  "error.unknown_organization": "Cette organisation n'est pas dans l'annuaire.",
  "error.invalid_csv":
    "Nous ne pouvons pas lire ce fichier. Vérifiez qu'il a une ligne d'en-têtes et une colonne de nom.",
  "error.connector_failed": "L'outil connecté n'a pas répondu. Réessayez dans un instant.",
  "error.not_importable": "L'annuaire importe depuis Zoho CRM ou Podio.",
  "error.contact_exists": "Quelqu'un dans l'annuaire a déjà cette adresse e-mail ou ce numéro.",
  "error.rate_limited": "Attendez une minute et réessayez.",
  "error.daily_limit": "Vous avez atteint la limite du jour pour ceci. Réessayez demain.",
  "error.no_address": "Nous ne connaissons pas l'adresse de ce compte. Connectez-le à nouveau.",
  "error.different_account":
    "Ce compte n'est pas celui qui est connecté ici. Déconnectez-le d'abord, puis connectez l'autre.",
  "error.different_company":
    "Votre comptabilité ici vient d'une autre entreprise QuickBooks. Demandez-nous de changer d'entreprise.",
  "error.sync_running":
    "Nous lisons la comptabilité de cette entreprise en ce moment. Réessayez dans quelques minutes.",
  "error.invalid_hours":
    "Ces horaires ne peuvent pas être enregistrés. Indiquez les horaires d'au moins un jour, et gardez chaque absence sous un an.",
  "error.sends_form":
    "Ce bouton envoie le formulaire. Marquez le clic comme celui qui l’envoie, ou choisissez un autre bouton.",

  // ── Shell ──
  "shell.navigation": "Navigation",
  "shell.account": "Compte : {name}",
  "shell.signOut": "Se déconnecter",
  "shell.noClient": "Aucun client",
  "shell.search": "Rechercher",
  "shell.searchPlaceholder": "Rechercher vos agents, exécutions, enregistrements et personnes",
  "shell.desk": "Boîte de réception", // fluent review
  "shell.menu": "Menu",
  "shell.closeMenu": "Fermer le menu",
  "shell.collapse": "Réduire",
  "shell.expand": "Développer",
  "shell.switchAgent": "Changer d'agent",
  "shell.theme": "Thème",
  "shell.theme.system": "Système",
  "shell.theme.light": "Clair",
  "shell.theme.dark": "Sombre",
  "search.title": "Recherche",
  "search.close": "Fermer la recherche",
  "search.hint": "Saisissez un nom, un numéro d'exécution, un montant ou un numéro de facture.",
  "search.empty": "Rien ne correspond à « {q} ».",
  "search.group.agents": "Agents",
  "search.group.runs": "Exécutions",
  "search.group.records": "Enregistrements",
  "search.group.people": "Personnes",
  "search.group.documents": "Documents",
  "search.runsAbout": {
    one: "{count} exécution sur {name}",
    other: "{count} exécutions sur {name}",
  },
  "nav.table": "La Table",
  "nav.desk": "Votre bureau",
  "nav.yourAgents": "Vos agents",
  "nav.yourBusiness": "Votre entreprise",
  "nav.connectors": "Connecteurs",
  "nav.more": "Plus",
  "nav.lead": "Votre interlocuteur Mezonas",
  "nav.noAgents": "Pas encore d'agents.",
  "ui.step.done": "Fait",
  "ui.step.current": "En cours",
  "ui.step.waiting": "En attente de vous",
  "ui.step.failed": "Échec",
  "ui.step.person": "Étape d'une personne",
  "ui.step.todo": "Pas commencé",
  "ui.before": "Avant",
  "ui.after": "Après",

  // ── Language ──
  "language.label": "Langue",
  "language.followClient": "Langue de l'équipe",
  "language.followBrowser": "Langue du navigateur",
  "language.clientDefault": "Langue de {client}",
  "language.clientDefaultHint":
    "Tout le monde chez {client} lit dans cette langue, sauf choix personnel.",
  "language.clientDefaultNone": "La langue du navigateur de chacun",

  // ── Navigation and pages ──
  "nav.runs": "Exécutions",
  "nav.reports": "Rapports",
  "nav.requests": "Demandes",
  "nav.settings": "Paramètres",
  "nav.knowledge": "Connaissances",
  "nav.contacts": "Contacts",
  // v0.14 capture
  "nav.conversations": "Conversations",
  "nav.people": "Personnes",
  "nav.access": "Accès",
  "nav.directory": "Annuaire",
  "nav.records": "Enregistrements",
  "page.service": "Agent",

  // ── Overview ──
  "overview.title": "Vue d'ensemble",
  "overview.subtitleWithClient": "{client} : vos agents, ce qu'ils ont fait et ce qui vous attend.",
  "overview.subtitle": "Vos agents, ce qu'ils ont fait et ce qui vous attend.",
  "overview.services": "Vos agents",
  "overview.noServices":
    "Pas encore d'agents. Nous les mettons en place avec vous, et ils apparaissent ici.",
  "overview.openInbox": "Ouvrir la boîte de réception",
  "overview.needsYou": "Vous attend",
  "overview.inboxItems": {
    one: "élément dans votre boîte de réception",
    other: "éléments dans votre boîte de réception",
  },
  "overview.changesWait": "Les modifications de vos outils attendent votre approbation",
  "overview.questionsWait": "Les questions attendent votre réponse",
  "overview.health": "Contrôle du compte",
  "overview.healthGood": "Tout va bien",
  "overview.healthAttention": "À regarder",
  "overview.healthChecked": "Vérifié {time}",
  "overview.healthRuns": {
    one: "{count} exécution sur la dernière journée",
    other: "{count} exécutions sur la dernière journée",
  },
  "overview.healthFailed": { one: "{count} n'a pas abouti", other: "{count} n'ont pas abouti" },
  "overview.healthConnections": {
    one: "{count} compte a besoin de vous",
    other: "{count} comptes ont besoin de vous",
  },
  "overview.healthWaiting": {
    one: "{count} élément vous attend",
    other: "{count} éléments vous attendent",
  },
  "overview.findings": "Ce qui vous attend maintenant",
  "overview.findingReminder": "Rappel",
  // ── The Table and the agent page (UI-1a) ──
  "table.greeting.morning": "Bonjour, {name}",
  "table.greeting.afternoon": "Bonjour, {name}",
  "table.greeting.evening": "Bonsoir, {name}",
  "table.hello.morning": "Bonjour",
  "table.hello.afternoon": "Bonjour",
  "table.hello.evening": "Bonsoir",
  "table.waitLine": { one: "{count} chose vous attend.", other: "{count} choses vous attendent." },
  "table.waitNone": "Rien ne vous attend.",
  "table.view.today": "Aujourd'hui",
  "table.askSloan": "Demander à Sloan",
  "table.workingNow": "Au travail",
  "table.meta.running": { one: "{count} en cours", other: "{count} en cours" },
  "table.meta.waiting": { one: "{count} vous attend", other: "{count} vous attendent" },
  "table.meta.setup": { one: "{count} en préparation", other: "{count} en préparation" },
  "table.meta.paused": { one: "{count} en pause", other: "{count} en pause" },
  "table.now": "Maintenant",
  "table.lastRun": "Dernière exécution",
  "table.noRunsYet": "Pas encore d'exécution.",
  "table.stepOf": "Étape {index} sur {total}",
  "table.started": "commencée {time}",
  "table.waitingSince": "en attente depuis {time}",
  "table.finished": "terminée {time}",
  "table.thisWeek": "Cette semaine",
  "table.stat.runs": "Exécutions faites",
  "table.stat.changes": "Mises à jour de vos outils",
  "table.stat.onYourDesk": "Sur votre bureau",
  "table.latest": "Les dernières nouvelles de vos agents",
  "table.seeAllRuns": "Voir toutes les exécutions",
  "table.noLatest": "Rien encore cette semaine. Ce que font vos agents apparaît ici.",
  "table.moreOnDesk": {
    one: "{count} de plus sur votre bureau",
    other: "{count} de plus sur votre bureau",
  },
  "table.openDesk": "Ouvrir votre bureau",
  "table.dueToday": "À faire aujourd'hui",
  "table.due": "Échéance {time}",
  "table.reviewSign": "Vérifier et approuver",
  "table.openItem": "Ouvrir",
  "table.notNow": "Pas maintenant",
  "table.lead.yourReply": "Votre réponse",
  "table.lead.reply": "Répondre à {name}",
  "table.lead.sent": "Envoyé. {name} vous répond dans vos messages.",
  // QA round 1: the client's status model (portal/status.ts).
  "state.run.running": "En cours",
  "state.run.done": "Terminé",
  "state.run.failed": "Échec",
  "state.run.stopped": "Arrêté",
  "state.agent.working": "Au travail",
  "state.agent.ready": "Prêt",
  "state.agent.paused": "En pause",
  "state.agent.settingUp": "En préparation",
  "runs.waitedOnYou": "A attendu {duration} après vous",
  "table.week.finished": { one: "{count} terminée", other: "{count} terminées" },
  "table.weekRuns": "Exécutions lancées cette semaine : {counts}.",
  "runsPage.perDay.day": "{day} : {parts}",
  "agent.stage.trial": "En essai",
  "agent.stage.signoff": "Attend votre approbation pour démarrer",
  "agent.pause": "Mettre en pause",
  "agent.resume": "Reprendre",
  "agent.pauseReason": "Pourquoi mettez-vous {name} en pause ?",
  "agent.pauseHelp": "Aucune nouvelle exécution ne démarre. Celles en cours se terminent.",
  "agent.pauseConfirm": "Mettre {name} en pause",
  "agent.pausedByYou": "Mis en pause par vous : {reason}",
  "agent.pausedByYouAlone": "Mis en pause par vous",
  "agent.pausedByUs": "Mis en pause par nous : {reason}",
  "agent.pausedByUsAlone": "Mis en pause par nous",
  "agent.pausedUntil": "Jusqu'à {time}",
  "agent.resumeOurs": "Nous l'avons mis en pause. Demandez à votre interlocuteur de le relancer.",
  "agent.missed": {
    one: "Pendant la pause, entre {from} et {to}, {count} événement est arrivé qui l'aurait fait démarrer. Il n'a pas démarré tout seul.",
    other:
      "Pendant la pause, entre {from} et {to}, {count} événements sont arrivés qui l'auraient fait démarrer. Aucun n'a démarré tout seul.",
  },
  "agent.missedOrMore":
    "Pendant la pause, entre {from} et {to}, {count} événements ou plus sont arrivés qui l'auraient fait démarrer. Aucun n'a démarré tout seul.",
  "agent.missedUncounted":
    "Pendant la pause, entre {from} et {to}, plus d'événements sont arrivés que nous ne pouvons en vérifier d'un coup. Certains l'auraient peut-être fait démarrer. Aucun n'a démarré tout seul.",
  "agent.missedAsk": "Demandez à votre interlocuteur de les lancer si vous en avez besoin.",
  "agent.rightNow": "En ce moment",
  "agent.nothingRunning": "Rien en cours. La prochaine exécution apparaît ici, étape par étape.",
  "agent.openRun": "Ouvrir l'exécution",
  "agent.latest": "Les dernières nouvelles de {name}",
  "agent.history": "Historique",
  "agent.took": "Durée : {duration}",
  "agent.reach": "Connecteurs utilisés par {name}",
  "agent.reachChange": "Modifier",
  "agent.reachNone": "{name} n'utilise encore aucun de vos connecteurs.",
  "agent.revoked": "Aucun accès",
  "agent.runNow": "Exécuter maintenant",
  "agent.run": "Démarrer",
  "agent.runStarted": "{name} a commencé.",

  // ── Inbox ──
  "inbox.title": "Boîte de réception",
  "inbox.subtitle":
    "Les modifications que vos agents veulent faire, et les questions qui attendent une réponse. Rien ne change dans vos outils tant qu'une personne de votre équipe n'a pas dit oui.",
  "inbox.emptyOpen": "Rien ne vous attend pour le moment.",
  "inbox.emptyResolved": "Rien ici pour l'instant.",
  "inbox.filter.open": "Ouverts",
  "inbox.filter.resolved": "Résolus",
  "inbox.kind.external_action": "Modification",
  "inbox.kind.approval": "Approbation",
  "inbox.kind.request": "Question",
  "inbox.kind.review": "Revue",
  "inbox.kind.extraction_review": "Vérification",
  "inbox.kind.change_request": "Demande",
  "inbox.outcome.approved": "Approuvé",
  "inbox.outcome.approvedBy": "Approuvé par {name}",
  "inbox.outcome.rejected": "Refusé",
  "inbox.outcome.rejectedBy": "Refusé par {name}",
  "inbox.outcome.answered": "Répondu",
  "inbox.outcome.answeredBy": "Répondu par {name}",
  "inbox.outcome.declined": "Décliné",
  "inbox.outcome.declinedBy": "Décliné par {name}",
  "inbox.outcome.resolved": "Résolu",
  "inbox.outcome.resolvedBy": "Résolu par {name}",
  "inbox.status.needsApproval": "À approuver",
  "inbox.status.needsAnswer": "Réponse attendue",
  "inbox.yourAnswer": "Votre réponse",
  "inbox.viewRun": "Voir l'exécution",
  "inbox.nothingChangesUntilSign": "Rien ne change dans l'outil tant que vous n'avez pas approuvé.",
  "inbox.waitsUntil": "Attend jusqu'à {time}.",
  "inbox.openRequestsQueue": "Ouvrir la file des demandes",
  "inbox.decline": "Décliner",
  "inbox.sendAnswer": "Envoyer la réponse",
  "inbox.undo": "Annuler",
  "inbox.undoWindow":
    "Approuvé. Nous faisons le changement dans une minute ; vous pouvez encore l'annuler.",
  // R5: an answer after the run went ahead, and the undo a late no is offered (§1.86)
  "inbox.late.answeredYes": "Réponse oui à {time}, après que nous avions continué.",
  "inbox.late.answeredNo": "Réponse non à {time}, après que nous avions continué.",
  "inbox.late.yes": "Rien d'autre à faire.",
  "inbox.late.offer": "Nous pouvons annuler le changement, si personne ne l'a modifié depuis.",
  "inbox.late.undo": "Annuler ce changement",
  "inbox.late.done": "Annulé. Nous avons remis les choses comme avant.",
  "inbox.late.failed":
    "Nous n'avons pas pu annuler le changement. Votre responsable Mezonas va s'en occuper.",
  "inbox.late.none":
    "Ceci ne peut pas être annulé. Un message envoyé ne peut pas être repris, ce changement non plus.",
  "inbox.late.nothing": "Rien n'a changé dans vos outils : il n'y a rien à annuler.",
  "inbox.late.refused.changed_since":
    "Quelqu'un l'a modifié après nous : nous l'avons laissé tel quel.",
  "inbox.late.refused.record_gone": "L'enregistrement n'existe plus.",
  "inbox.late.refused.already_undone": "C'est déjà revenu comme avant.",
  "inbox.late.refused.other":
    "Nous n'avons pas pu l'annuler. Votre responsable Mezonas va s'en occuper.",
  "inbox.reject": "Refuser",
  "inbox.sign": "Approuver",
  "inbox.findingSteps": "Que faire",
  "inbox.sentAs": "Tel qu'il partira",
  "inbox.sentAsNote":
    "Le premier SMS à une personne, et le premier après 30 jours, vous nomme et se termine par la façon de se désinscrire. Nous l'ajoutons.",
  "inbox.findingDone": "Fait",
  "inbox.signAndUpdate": "Approuver et mettre à jour {tool}",
  // B3: a change that rests on a decision nobody has discussed
  "inbox.undiscussed": "Repose sur une décision dont personne n'a encore discuté : {what}", // fluent review
  // ── Your Desk (UI-1b) ──
  "desk.title": "Boîte de réception", // fluent review
  "desk.subtitle": "Ce dont vos agents ont besoin de vous, et ce qu'ils ont fait.", // fluent review
  "desk.filter.agent": "Agent",
  "desk.filter.allAgents": "Tous les agents",
  "desk.view.label": "Vue de la boîte de réception", // fluent review
  "desk.view.questions": "Questions",
  "desk.view.later": "Pas maintenant",
  "desk.view.done": "Fait",
  "desk.empty.waiting": "Rien ne vous attend pour l'instant.",
  "desk.empty.questions": "Aucune question pour vous pour l'instant.",
  "desk.empty.later":
    "Rien de mis de côté. Ce que vous repoussez avec « Pas maintenant » apparaît ici.", // fluent review
  "desk.empty.done": "Rien de fait pour l'instant.",
  "desk.day.today": "Aujourd'hui",
  "desk.day.yesterday": "Hier",
  "desk.day.doneThisWeek": "Fait cette semaine",
  "desk.pick": "Choisissez un élément à gauche pour le voir ici.",
  "desk.chip.sign": "Demande votre approbation",
  "desk.chip.code": "Saisir le code",
  "desk.chip.todo": "À faire",
  "desk.chip.answer": "Répondre",
  "desk.chip.request": "Demande",
  "desk.chip.done": "Fait",
  "desk.chip.back": "Revient {time}",
  "desk.batch.count": { one: "{count} modification", other: "{count} modifications" },
  "desk.batch.title": {
    one: "{count} modification dans {what}",
    other: "{count} modifications dans {what}",
  },
  "desk.batch.lead": {
    one: "Une étape a préparé cette modification. Décochez ce que vous ne voulez pas approuver.",
    other:
      "Une étape a préparé ces {count} modifications. Décochez celles que vous ne voulez pas approuver.",
  },
  "desk.batch.include": "Approuver {what}",
  "desk.batch.rejectAll": "Tout refuser",
  "desk.batch.rejectSome": { one: "Refuser {count}", other: "Refuser {count}" },
  "desk.batch.signAll": { one: "Approuver {count}", other: "Approuver les {count}" },
  "desk.batch.signSome": {
    one: "Approuver {count} sur {total}",
    other: "Approuver {count} sur {total}",
  },
  "desk.band.answer": "Attend votre réponse",
  "desk.band.drafted": "{agent} l'a préparé à {time}",
  "desk.band.came": "Arrivé à {time}",
  "desk.band.due": "échéance {time}",
  "desk.band.later": "Mis de côté pour plus tard",
  "desk.band.resolvedAt": "Fait à {time}",
  "desk.viewer": "Vous pouvez le voir, mais vous n'approuvez pas pour votre équipe.",
  "desk.snoozedUntil": "Mis de côté jusqu'à {time}. Il revient alors dans « En attente ».", // fluent review
  "desk.notNow": "Pas maintenant",
  "desk.openRequests": "Ouvrir les demandes",
  "desk.edit": "Modifier",
  "desk.edited": "Vous avez modifié ce changement. Nous utilisons votre version.",
  "desk.afterYouSign": "Après votre approbation",
  // §1.121: a form request's card
  "desk.form.heading": "Le formulaire qu’ils recevront : {title}", // fluent review
  "desk.form.fixed": "Votre question", // fluent review
  "desk.form.added": "Ajoutée par l’agent", // fluent review
  "desk.form.required": "obligatoire", // fluent review
  "desk.editHint":
    "Modifiez ce qu'il faut, puis enregistrez. Nous vérifions à nouveau avant que vous approuviez.",
  "desk.editSave": "Enregistrer",
  "desk.edit.number": "Saisissez un nombre, par exemple 1200.",
  "desk.edit.money": "Saisissez un montant, par exemple 1200.",
  "desk.snooze.until": "Le faire revenir",
  "desk.snooze.later": "Plus tard aujourd'hui",
  "desk.snooze.tomorrow": "Demain à 8:00",
  "desk.snooze.monday": "Lundi à 8:00",
  "desk.outcome.signed": "Approuvé par vous",
  "desk.outcome.rejected": "Refusé par vous",
  "desk.outcome.answered": "Répondu par vous",
  "desk.outcome.declined": "Décliné par vous",
  "desk.outcome.done": "Fait par vous",
  "desk.notDone": "Non fait : {reason}",
  "desk.outcome.batch": {
    one: "{count} sur {total} fait par vous",
    other: "{count} sur {total} faits par vous",
  },
  "desk.undoLeft": { one: "{count} seconde pour annuler", other: "{count} secondes pour annuler" },
  "desk.worksheet.title": "Feuille de travail",
  "desk.worksheet.how": "Comment {agent} en est arrivé là",
  "desk.worksheet.yourSign": "Votre approbation",
  "desk.worksheet.earlierChange": "Ouvrir le changement précédent",
  "desk.team.title": "Qui approuve quoi",
  "desk.team.undo": "Délai d'annulation",
  "desk.team.undoOff": "Désactivé",
  "desk.team.undoSeconds": { one: "{count} seconde", other: "{count} secondes" },
  "desk.team.undoHint":
    "Combien de temps après une approbation la personne qui a approuvé peut encore la retirer.",
  "desk.team.undoIs": "Délai d'annulation : {window}.",
  "desk.approvalSettings": "Réglages d'approbation",
  "change.now": "Maintenant",
  "change.after": "Après la modification",
  "change.createsIt": "N'existe pas encore : cette modification le crée.",
  "change.nothingRecorded": "Rien d'enregistré.",
  "change.noFields": "Aucun champ.",
  "change.field": "Champ",
  "change.value": "Valeur",
  "change.noneYet": "Aucun.",
  "change.unchanged": "Inchangé :",
  "change.noChange": "Cette modification laisse tous les champs tels quels.",
  "change.lines.description": "Description",
  "change.lines.bookedTo": "Compte ou article",
  "change.lines.qtyPrice": "Qté × prix",
  "change.lines.amount": "Montant",
  "change.lines.total": "Total",
  "change.files.name": "Fichier",
  "change.files.size": "Taille",
  "change.item.added": "ajouté",
  "change.item.removed": "retiré",

  // ── Runs ──
  "runs.title": "Exécutions",
  "runs.subtitle": "Chaque fois qu'un de vos agents a fait son travail.",
  "runs.empty": "Pas encore d'exécutions.",
  "runs.col.service": "Agent",
  "runs.col.status": "Statut",
  "runs.col.started": "Début",
  "runs.col.took": "Durée",
  "run.status.queued": "En file",
  "run.status.running": "En cours",
  "run.status.waiting": "En attente",
  "run.status.succeeded": "Terminé",
  "run.status.failed": "Échec",
  "run.status.cancelled": "Annulé",
  // P-4: a conversation on the run timeline
  "run.conversation.sent": "Envoyé",
  "run.conversation.reply": "Réponse",
  // P-6: stepping in, taking a conversation over, editing a message (docs/plan.md §1.68); needs a fluent review
  "run.conversation.takenOver": "{who} a repris la conversation",
  "run.conversation.ended": "{who} a mis fin à la conversation",
  "run.conversation.editedBy": "Modifié par {who} avant l'envoi",
  "run.conversation.takenOverByUs": "Nous avons repris la conversation", // fluent review
  "run.conversation.endedByUs": "Nous avons mis fin à la conversation", // fluent review
  "run.conversation.editedByUs": "Nous l'avons modifié avant l'envoi", // fluent review
  "run.conversation.takeOver": "Reprendre",
  "run.conversation.end": "Terminer la conversation",
  "run.conversation.reason": "Motif (facultatif)",
  "run.conversation.controlHint":
    "Reprendre : l'agent n'envoie plus rien et la question arrive sur votre bureau. Terminer : l'agent s'arrête ici.",
  "desk.steppedIn": "Nous sommes intervenus : {reason}", // fluent review
  "desk.passedToYou": "Nous vous l'avons transmis : {reason}", // fluent review
  "desk.editMessage": "Modifier le message",
  "desk.editMessageSave": "Enregistrer le message",
  "desk.messageEdited":
    "Vous avez modifié ce message. Ce que vous approuvez est exactement ce qui part.",
  "step.status.pending": "Pas commencé",
  "step.status.running": "En cours",
  "step.status.waiting": "En attente",
  "step.status.succeeded": "Terminé",
  "step.status.failed": "Échec",
  "step.status.skipped": "Ignoré",
  "step.status.cancelled": "Annulé",
  "duration.seconds": "{n} s",
  "duration.minutes": "{n} min",
  "duration.hours": "{n} h",
  "duration.hoursMinutes": "{h} h {m} min",
  "duration.days": "{n} j",
  "duration.daysHours": "{d} j {h} h",
  "run.started": "Démarré {time}",
  "run.notStarted": "Pas encore démarré",
  "run.took": "durée {duration}",
  "run.whatHappened": "Ce qui s'est passé",
  "run.stepsDone": { one: "{done} étape sur {count}", other: "{done} étapes sur {count}" },
  "run.nothingYet": "Rien à afficher pour l'instant.",
  "run.changes": "Modifications de vos outils",
  "run.noChanges": "Aucune modification de vos outils dans cette exécution.",
  "run.approvals": "Approbations",
  "run.noApprovals": "Aucune approbation dans cette exécution.",
  "run.openInbox": "Ouvrir votre boîte de réception",
  // Step panel (docs/plan.md §1.95): a run step's details, beside the run.
  "stepPanel.tab.step": "Étape",
  "stepPanel.tab.data": "Données",
  "stepPanel.eyebrow": "Étape {n} sur {count}",
  "stepPanel.status": "Statut",
  "stepPanel.started": "Début",
  "stepPanel.finished": "Fin",
  "stepPanel.took": "Durée",
  "stepPanel.tries": "Essais",
  "stepPanel.triesValue": { one: "{count} essai", other: "{count} essais" },
  "stepPanel.notYet": "Pas encore",
  "stepPanel.ai": "Lu par l'IA",
  "stepPanel.aiHint": "Un modèle d'IA a lu ce qui est entré pour établir ce qui est sorti.",
  "stepPanel.input": "Ce qui est entré",
  "stepPanel.output": "Ce qui est sorti",
  "stepPanel.nothing": "Rien d'enregistré.",
  "stepPanel.raw.show": "Voir les données brutes",
  "stepPanel.raw.hide": "Masquer les données brutes",
  "stepPanel.more": { one: "et {count} de plus", other: "et {count} de plus" },
  "stepPanel.checks": "Vérifications et approbations",
  "stepPanel.oversight": "Ce que nous avons fait",
  "stepPanel.changes": "Modifications dans vos outils",
  "stepPanel.data.records": "Fiches",
  "stepPanel.data.documents": "Documents",
  "stepPanel.data.changes": "Modifications",
  "stepPanel.data.empty":
    "Cette étape n'a créé, modifié ni cité aucune fiche, aucun document ni aucune modification.",
  "stepPanel.data.document": "Document {tail}",
  "stepPanel.missing": "Cette étape ne fait pas partie de cette exécution.",
  // R8: what a step's checks did, on the run's timeline (§1.86)
  "run.confer.person": "Vérifié avec {who} : {verdict}",
  "run.confer.second": "Une seconde vérification : {verdict}",
  "run.confer.away": "{who} était absent, nous n'avons pas demandé",
  "run.confer.on": "Vérifié : {step}",
  "run.write.saved": "Enregistré dans vos dossiers",
  "run.write.saves": "Enregistre dans vos dossiers",
  "run.write.changedIn": "Modifié dans {connector}",
  "run.write.changesIn": "Modifie {connector}",
  "run.write.changedInTool": "Modifié dans votre outil",
  "run.write.changesInTool": "Modifie votre outil",
  "run.confer.verdict.agree": "est d'accord",
  "run.confer.verdict.disagree": "n'est pas d'accord",
  "run.confer.verdict.unsure": "n'est pas sûr",
  "run.confer.verdict.no_answer": "pas de réponse",
  "run.approval.mode.in_turn": "Demandé à chacun tour à tour, dans l'ordre",
  "run.approval.mode.any": "Demandé à tous en même temps ; la première réponse décide",
  "run.approval.mode.all": "Demandé à tous en même temps ; tous doivent approuver",
  "run.approval.approver.waiting": "{who} : en attente",
  "run.approval.approver.approved": "{who} : approuvé",
  "run.approval.approver.rejected": "{who} : refusé",
  "run.approval.approver.no_answer": "{who} : pas de réponse à temps",
  "run.noAnswer.proceeded": "Poursuivi : personne n'a répondu à temps",
  "run.noAnswer.stopped": "Arrêté : personne n'a répondu à temps",
  "run.urgent.waiting": "Urgent : en attente de « Vu » jusqu'à {time}",
  "run.urgent.waitingNoTime": "Urgent : en attente de « Vu »",
  "run.urgent.seen": "Urgent : vu à {time}",
  "run.urgent.notSeen": "Urgent : pas vu à temps",
  // Wave 5 (docs/plan.md §1.86 "Forks (wave 5)"): the route an if took and why; a failure the
  // run carried on past; how a step ended.
  "run.route.took": "A pris le chemin « {path} »",
  "run.route.because": "A pris le chemin « {path} » : {reasons}",
  "run.route.otherwise": "Aucun chemin ne correspondait, il a donc continué comme d'habitude",
  "run.route.reason": "{step} : {outcome}",
  "run.carriedOn": "Échec, et l'exécution a continué",
  "run.carriedOn.some": "Certains éléments ont échoué, et l'exécution a continué",
  "run.carriedOn.stopped": "Arrêté, et l'exécution a continué",
  "run.outcome.done": "fait",
  "run.outcome.empty": "rien trouvé",
  "run.outcome.rejected": "refusé",
  "run.outcome.no_answer": "pas de réponse à temps",
  "run.outcome.skipped": "ignoré",
  "run.outcome.needs_help": "a eu besoin d'aide",
  "run.outcome.failed": "échec",
  "run.outcome.answered": "répondu",
  "run.outcome.not_found": "pas trouvé",
  "run.outcome.declined": "refusé",
  "run.outcome.sent": "envoyé",
  "run.outcome.not_seen": "pas vu à temps",
  "run.outcome.arrived": "arrivé",
  "run.outcome.timed_out": "délai écoulé",
  "run.outcome.some_failed": "certains éléments ont échoué",
  "run.outcome.all_failed": "tous les éléments ont échoué",
  "run.outcome.limit": "a atteint son nombre maximal de tours",
  "run.outcome.completed": "terminé",
  "run.outcome.stopped": "arrêté",
  "run.who.client_admin": "votre administrateur",
  "run.who.client_user": "votre équipe",
  "run.who.lead": "votre responsable Mezonas",
  "run.who.operator": "Mezonas",
  "run.who.someone": "quelqu'un de votre équipe",
  "action.status.proposed": "En attente d'approbation",
  "action.status.approved": "Approuvé",
  "action.status.executing": "En cours",
  "action.status.done": "Fait",
  "action.status.rejected": "Refusé",
  "action.status.failed": "Échec",

  // ── Connections ──
  "connections.title": "Comptes",
  "connections.subtitle":
    "Connectez chaque outil une fois. Vos agents utilisent ces comptes, dans les limites des autorisations affichées ici.",
  "connections.connected": "Connectés · {count}",
  "connections.connectBelow": "Connectez-en un ci-dessous.",
  "connections.matrixNote":
    "Approbation : la modification attend dans votre boîte de réception jusqu'à ce que quelqu'un dise oui.",
  "connections.available": "Disponibles",
  "connections.synced": "synchronisé {time}",
  "connections.live": "en direct",
  "connections.usedByServices": {
    one: "Utilisé par {count} agent",
    other: "Utilisé par {count} agents",
  },
  "connections.actions": { one: "{count} action", other: "{count} actions" },
  "connections.usedByNames": "Utilisé par {names}",
  "connections.permissions": "Autorisations",
  "connections.disconnect": "Déconnecter",
  "connections.disconnectWarning":
    "Les agents cessent d'utiliser {tool} jusqu'à ce que vous le reconnectiez.",
  "connections.keepIt": "Le garder",
  "connections.notAvailable": "Pas encore disponible",
  "connections.connect": "Connecter",
  "connections.adminCanConnect": "Votre administrateur peut le connecter.",
  "connections.enterKey": "Saisir ses identifiants",
  "connections.gmail.description":
    "Envoyez des e-mails depuis votre Gmail. Nous ne pouvons pas lire votre boîte mail.",
  "connections.gmail.testSend": "Envoyer un e-mail de test",
  "connections.gmail.testSent":
    "Envoyé à {address}. Vérifiez le dossier Messages envoyés et la boîte de réception de cette adresse.",
  // v0.14 W4-C: Slack (new strings: the fluent speaker's review).
  "connections.slack.description":
    "Publiez des messages dans les canaux Slack de votre choix. Nous ne pouvons pas lire vos messages.",
  "slack.section": "Slack · canaux",
  "slack.workspace": "Espace de travail : {name}",
  "slack.help":
    "Les agents publient uniquement dans les canaux que vous choisissez. Ajoutez l'app Mezonas à un canal dans Slack avant de le choisir.",
  "slack.noChannels": "Aucun canal public dans cet espace de travail.",
  "slack.notMember": "Ajoutez Mezonas à ce canal dans Slack",
  "slack.gone": "ne figure plus dans Slack",
  "slack.noPicks": "Aucun canal choisi : les agents ne peuvent pas publier dans Slack.",
  "slack.picked": { one: "{count} canal choisi", other: "{count} canaux choisis" },
  "slack.saved": "Enregistré.",
  "connection.status.connected": "Connecté",
  "connection.status.pending": "Non connecté",
  "connection.status.disconnected": "Déconnecté",
  "connection.status.error": "À reconnecter",
  "access.runs": "S'exécute",
  "access.asks_first": "Demande d'abord",
  "access.steps_may_skip_approval": "Peut s'exécuter sans demander",
  "access.not_allowed": "Non autorisé",
  "matrix.title": "Ce que les agents peuvent faire dans chaque outil",
  "matrix.tool": "Outil",
  "matrix.scope": "Portée",
  "matrix.scopeFor": "Portée pour {name}",
  "matrix.everything": "Tout ce que le compte atteint",
  "matrix.verb.read": "lire",
  "matrix.verb.create": "créer",
  "matrix.verb.update": "modifier",
  "matrix.verb.delete": "supprimer",
  "matrix.level.auto": "En autonomie", // fluent review
  "matrix.level.approval": "Avec approbation", // fluent review
  "matrix.level.off": "Désactivé", // fluent review
  "matrix.tightenNote":
    "Vous pouvez les restreindre vous-même. Nous seuls pouvons les élargir à nouveau.",
  "matrix.operatorNote":
    "Les changements s'appliquent au prochain appel d'outil et sont enregistrés.",
  "matrix.discard": "Annuler les changements",
  "matrix.save": "Enregistrer les autorisations",
  "callback.title": "Connexion",
  "callback.subtitle": "Fin de la connexion à votre outil.",
  "callback.back": "Retour aux connecteurs",
  "callback.connecting": "Connexion…",
  // v0.12 bankfeed (pending review by a fluent speaker).
  "connections.bankfeed.description":
    "Lisez les opérations de vos comptes bancaires et de vos cartes. Rien ici ne peut déplacer d'argent.",
  "connections.bankfeed.connect": "Connecter une banque ou une carte",
  "callback.linkLost":
    "Cette connexion bancaire a commencé dans un autre onglet ou une autre fenêtre. Recommencez depuis Connecteurs.",

  // ── Access (the vault and agents' access) ──
  "vault.title": "Accès",
  "vault.subtitle":
    "Chaque accès à vos outils, si son secret est enregistré, et quels agents peuvent l'utiliser.",
  "vault.setupTitle": "Configurer",
  "vault.setupHint":
    "Saisissez les identifiants de chaque outil. Nous les chiffrons avec votre propre clé. Personne ne peut les relire, nous compris.",
  "vault.itemsTitle": "Votre coffre · {count}",
  "vault.none": "Votre coffre est encore vide.",
  "vault.connectionsLink": "Connecter un outil",
  "vault.kind.oauth": "Connecté à votre compte",
  "vault.kind.api_key": "Clé d'API",
  "vault.kind.browser": "Identifiants d'un site web",
  "vault.kind.built_in": "Intégré",
  "vault.secretSet": "Secret enregistré",
  "vault.secretNotSet": "Aucun secret enregistré",
  "vault.fieldSet": "Renseigné",
  "vault.fieldNotSet": "Non renseigné",
  "vault.updated": "Mis à jour {time}",
  "vault.enterKey": "Saisir les identifiants",
  "vault.replaceKey": "Remplacer les identifiants",
  "vault.saveKey": "Enregistrer",
  "vault.keyNote":
    "Remplissez tous les champs. Vous pouvez remplacer ou supprimer ce que vous saisissez, mais personne ne pourra le revoir.",
  "vault.agentsTitle": "Agents qui peuvent l'utiliser",
  "vault.noAgents": "Aucun agent ne l'utilise encore.",
  "vault.tools": "Outils",
  "vault.allTools": "Tous les outils",
  "vault.someTools": { one: "{count} outil sur {total}", other: "{count} outils sur {total}" },
  "vault.revoked": "Révoqué",
  "vault.tighten": "Restreindre",
  "vault.revoke": "Révoquer",
  "vault.revokeWarning":
    "{agent} cesse aussitôt d'utiliser {tool}. Seuls nous pouvons lui rendre l'accès.",
  "vault.keepAccess": "Garder l'accès",
  "vault.tightenNote":
    "Vous pouvez restreindre ce qu'un agent peut faire. Seuls nous pouvons l'assouplir à nouveau.",
  "vault.saveAccess": "Enregistrer l'accès",
  "vault.browser.setupTitle": "Connexions à des sites web",
  "vault.browser.setupHint":
    "Nos agents peuvent se connecter à ces sites avec un compte que vous créez pour eux. C'est nous qui nous connectons, jamais l'agent, et il ne voit jamais le mot de passe ni un code.",
  "vault.browser.tier.low": "Risque faible",
  "vault.browser.tier.medium": "Risque moyen",
  "vault.browser.tier.high": "Risque élevé",
  "vault.browser.tier.blocked": "Bloqué",
  "vault.browser.tierHelp.low":
    "Nous nous connectons seuls. Les modifications demandent votre approbation, sauf si vous les autorisez.",
  "vault.browser.tierHelp.medium":
    "Nous nous connectons seuls. Chaque modification demande une approbation.",
  "vault.browser.tierHelp.high": "Une personne se connecte. Ce n'est pas encore disponible.",
  "vault.browser.tierHelp.blocked": "Les agents ne se connectent jamais à ce site.",
  "vault.browser.confirm":
    "Le compte que nous créons pour l'agent nous appartient, et les conditions du site autorisent l'accès automatisé.",
  "vault.browser.authenticator": "Lien de configuration de l'authentificateur",
  "vault.browser.authenticatorHint":
    "Le lien otpauth:// que le site affiche quand vous activez une application d'authentification pour le compte de l'agent.",
  "vault.browser.setUp": "Configurer",
  "vault.browser.setupFailed":
    "Nous n'avons pas pu configurer cette connexion pour l'instant. Réessayez dans quelques minutes.",
  "vault.browser.badLink":
    "Nous n'avons pas pu utiliser ce lien de configuration. Copiez-le à nouveau depuis le site et collez-le ici.",
  "vault.browser.identity": "E-mail du compte de l'agent",
  "vault.browser.identityPhone": "Téléphone du compte de l'agent",
  "vault.browser.identityHint":
    "Créez le compte de l'agent sur le site avec cette adresse et le rôle le plus restreint qui suffit. Ses codes de connexion nous arrivent.",
  "vault.browser.signIns": "Connexions aujourd'hui : {count} sur {limit}",
  "vault.browser.stopped":
    "Les connexions sont arrêtées jusqu'à ce que quelqu'un vérifie le compte de l'agent : {reason}. Saisissez à nouveau l'identifiant pour reprendre.",
  "vault.browser.stricter": "Rendre plus strict",
  "vault.browser.noWrites": "Aucune modification sur ce site",
  "vault.browser.personSignIn": "Une personne se connecte",
  "vault.browser.stricterNote":
    "Vous pouvez rendre une connexion à un site plus stricte. Seuls nous pouvons l'assouplir à nouveau.",
  "vault.browser.saveStricter": "Enregistrer",
  "vault.browser.version": "Version du site {version}",

  // ── Scripts des accès aux sites web ──
  "scripts.title": "Scripts",
  "scripts.subtitle":
    "Des étapes fixes sur l’un de vos accès à un site web, enregistrées dans notre navigateur. Nous nous connectons pour vous : vous ne saisissez jamais l’accès. Un script fonctionne pour vos agents dès que nous le publions.",
  "scripts.empty": "Aucun script pour l’instant.",
  "scripts.record": "Enregistrer un script",
  "scripts.login": "Accès au site web",
  "scripts.name": "Nom",
  "scripts.start": "Commencer l’enregistrement",
  "scripts.open": "Ouvrir",
  "scripts.close": "Fermer",
  "scripts.state.recording": "En cours d’enregistrement",
  "scripts.state.draft": "En attente de notre publication",
  "scripts.state.published": "Publié · v{version}",
  "scripts.steps": "Étapes",
  "scripts.noSteps": "Rien n’est encore enregistré. Ouvrez une page pour commencer.",
  "scripts.remove": "Retirer",
  "scripts.next": "Étape suivante",
  "scripts.op.open": "Ouvrir une page",
  "scripts.op.fill": "Remplir un champ",
  "scripts.op.click": "Cliquer",
  "scripts.op.read_field": "Lire un champ",
  "scripts.op.read_table": "Lire un tableau",
  "scripts.op.download": "Télécharger un fichier",
  "scripts.address": "Adresse ou chemin de la page",
  "scripts.selector": "Champ ou bouton",
  "scripts.value": "Valeur",
  "scripts.asInput": "En faire une entrée nommée (facultatif)",
  "scripts.asOutput": "Garder ce qui est lu sous le nom",
  "scripts.table": "Numéro du tableau",
  "scripts.submits":
    "Ce clic envoie le formulaire. Nous l’enregistrons et ne cliquons jamais dessus.",
  "scripts.do": "Le faire",
  "scripts.working": "Travail en cours dans notre navigateur…",
  "scripts.page": "La page maintenant",
  "scripts.screenshot": "La page après cette étape",
  "scripts.controls": "Sur cette page",
  "scripts.control.submits": "envoie le formulaire",
  "scripts.read": "Lu : {value}",
  "scripts.inputs": "Entrées",
  "scripts.outputs": "Sorties",
  "scripts.label": "Libellé",
  "scripts.type": "Type",
  "scripts.saveReview": "Enregistrer les noms",
  "scripts.saveVersion": "Enregistrer comme version",
  "scripts.saved": "Enregistré. Nous le vérifions et le publions ; il ne fonctionne pas avant.",
  "scripts.problems": "Avant de l’enregistrer : {problems}",
  "scripts.step.open": "Ouvrir {url}",
  "scripts.step.fill": "Remplir {selector} avec « {value} »",
  "scripts.step.fillInput": "Remplir {selector} avec l’entrée {name}",
  "scripts.step.click": "Cliquer sur {selector}",
  "scripts.step.submit": "Envoyer le formulaire avec {selector}",
  "scripts.step.readField": "Lire {selector} sous le nom {name}",
  "scripts.step.readTable": "Lire le tableau {n} sous le nom {name}",
  "scripts.step.download": "Télécharger {url} sous le nom {name}",
  "scripts.valueType.text": "Texte",
  "scripts.valueType.decimal": "Nombre décimal",
  "scripts.valueType.integer": "Nombre entier",
  "scripts.valueType.date": "Date",
  "scripts.valueType.table": "Tableau",
  "scripts.valueType.document": "Document",
  "scripts.state.waiting": "Publié · v{version}, v{newest} en attente de notre publication",
  "scripts.problem.duplicate_input": "deux entrées s’appellent {name}",
  "scripts.problem.duplicate_output": "deux sorties s’appellent {name}",
  "scripts.problem.duplicate_step": "deux étapes s’appellent {name}",
  "scripts.problem.reserved_output": "« {name} » ne peut pas être le nom d’une sortie",
  "scripts.problem.unknown_input": "l’étape {step} utilise {name}, qui n’est pas une entrée",
  "scripts.problem.unknown_output": "l’étape {step} lit {name}, qui n’est pas une sortie",
  "scripts.problem.wrong_output_type": "l’étape {step} ne peut pas lire {name} comme {type}",
  "scripts.problem.unused_input": "aucune étape n’utilise l’entrée {name}",
  "scripts.problem.unread_output": "aucune étape ne lit la sortie {name}",
  "scripts.problem.output_read_twice": "plusieurs étapes lisent {name}",
  "scripts.problem.read_submits":
    "un script qui envoie un formulaire modifie quelque chose : c’est une écriture",
  "scripts.problem.write_without_submit":
    "une écriture envoie un formulaire : marquez le clic qui l’envoie",
  "scripts.problem.submits_twice": "un script n’envoie un formulaire qu’une fois",
  "scripts.problem.submit_not_last": "l’envoi du formulaire est la dernière étape du script",
  "scripts.problem.reverse_on_read":
    "seul un script qui envoie un formulaire nomme celui qui l’annule",
  "scripts.problem.reverse_unknown_input":
    "{name} du script d’annulation vient de {from}, qui n’est pas une entrée",
  "scripts.problem.reverse_unknown_output":
    "{name} du script d’annulation vient de {from}, qui n’est pas une sortie",
  "scripts.problem.invalid":
    "l’enregistrement ne se lit pas comme un script à {path} : enregistrez cette étape à nouveau",
  "scripts.problem.site_gone": "ce site n’est plus dans notre catalogue",
  "scripts.problem.off_site":
    "l’étape {step} ouvre {url}, une page que les agents ne peuvent pas ouvrir sur ce site",

  // ── Webhooks ──
  "webhook.section": "Webhooks · configuration",
  "webhook.inTitle": "Vers Mezonas",
  "webhook.inHelp":
    "Créez un hook, puis collez son URL dans l'action « Webhooks by Zapier · POST » de votre Zap. Chaque hook lance les agents qui l'écoutent. Gardez l'URL privée : elle contient le secret du hook.",
  "webhook.noHooks": "Pas encore de hooks.",
  "webhook.made": "créé {time}",
  "webhook.urlOf": "URL de {name}",
  "webhook.remove": "Retirer",
  "webhook.newHook": "Nouveau hook",
  "webhook.newHookPlaceholder": "ex. formulaires du site web",
  "webhook.makeHook": "Créer le hook",
  "webhook.outTitle": "Depuis Mezonas",
  "webhook.outHelp":
    "Collez l'URL « Catch Hook » de votre Zap. Chaque événement attend d'abord une approbation dans votre boîte de réception, sauf si vos autorisations laissent une étape s'exécuter sans demander.",
  "webhook.sendTo": "Envoyer les événements à (https)",
  "webhook.sendingTo": "Envoi vers {host}.",
  "webhook.sendingToSince": "Envoi vers {host} depuis {time}.",
  "webhook.secretHelp":
    "Secret de signature, pour vérifier l'en-tête {header} si votre outil le permet :",
  "webhook.secret": "Secret de signature",
  "webhook.noOutbound":
    "Pas encore d'URL de sortie : les agents ne peuvent pas envoyer d'événements.",

  // ── Upload and forwarding ──
  "forwarding.section": "Transfert",
  "upload.title": "Envoyer",
  "upload.help":
    "Factures et reçus (PDF ou image), ou un CSV d'achats avec date, fournisseur et montant.",
  "upload.drop": "Déposez les fichiers ici",
  "upload.uploading": "Envoi…",
  "upload.choose": "Choisir des fichiers",
  "upload.refused": "Refusé.",
  "upload.purchasesAdded": { one: "{count} achat ajouté", other: "{count} achats ajoutés" },
  "upload.alreadyHere": "{count} déjà présents",
  "upload.rowsSkipped": { one: "{count} ligne ignorée", other: "{count} lignes ignorées" },
  "upload.received": "Reçu",
  "upload.duplicate": "Déjà présent : nous gardons une seule copie.",
  // UI cleanup (duplicates and matches): needs a fluent speaker's review.
  "upload.duplicateOf": "Même facture que {filename} : nous ne la traiterons pas une seconde fois.",
  "upload.sameFile": "Le même fichier que celui reçu ({time}). Nous gardons une seule copie.",
  "forwarding.title": "Transférer les factures par e-mail",
  "forwarding.uploadInRecords": "Envoyez vous-même des fichiers depuis Enregistrements",
  "forwarding.off": "Le transfert n'est pas encore activé. Votre adresse privée apparaîtra ici.",
  "forwarding.help":
    "Ajoutez une règle de transfert dans votre messagerie (par exemple depuis la boîte de la comptabilité fournisseurs) vers cette adresse privée. Nous gardons les pièces jointes, jamais le texte du message.",
  "forwarding.received": { one: "{count} reçu", other: "{count} reçus" },
  "forwarding.dropped": { one: "{count} refusé", other: "{count} refusés" },
  "forwarding.lastDrop": "(dernier {time} : {reason})",
  "forwarding.whoMay": "Qui peut transférer",
  "forwarding.adminAdd":
    "Ajoutez les adresses ou domaines qui vous transfèrent des e-mails. Le courrier de toute autre personne est refusé.",
  "forwarding.userWait":
    "Votre administrateur ajoute qui peut transférer. D'ici là, rien n'est accepté.",
  "forwarding.sendersLabel": "Adresses ou domaines, un par ligne",
  "forwarding.sendersHelp":
    "Un par ligne. Un domaine (votrefournisseur.com) couvre tout le monde chez lui.",
  "forwarding.edit": "Modifier qui peut transférer",
  "forwarding.drop.sender_not_allowed": "l'expéditeur n'est pas dans votre liste",
  "forwarding.drop.sender_unverified":
    "l'expéditeur est dans votre liste, mais nous n'avons pas pu confirmer qu'il venait de lui",
  "forwarding.drop.auto_reply": "c'était une réponse automatique, comme un message d'absence",
  "forwarding.drop.unknown_address": "il a été envoyé à une adresse ancienne ou erronée",
  "forwarding.drop.too_large": "il dépassait 25 Mo",
  "forwarding.drop.unreadable": "le message était illisible",

  // ── Documents ──
  "documents.recent": "Documents récents",
  "documents.empty": "Rien pour l'instant. Envoyez ou transférez une facture, elle apparaîtra ici.",
  "documents.col.document": "Document",
  "documents.col.vendor": "Fournisseur",
  "documents.col.total": "Total",
  "documents.col.status": "Statut",
  "documents.col.received": "Reçu",
  // UI cleanup (duplicates and matches): needs a fluent speaker's review.
  "documents.duplicate": "Doublon",
  "documents.invoiceNumber": "Facture {number}",
  "documents.sameInvoice": "La même facture que celle reçue ({time})",
  "document.status.stored": "Reçu",
  "document.status.extracting": "Lecture",
  "document.status.extracted": "Lu",
  "document.status.needs_review": "À vérifier",
  "document.status.failed": "Illisible",
  "document.source.upload": "Envoyé",
  "document.source.email": "Transféré",
  "document.source.connector": "Depuis un outil connecté",
  "document.source.request": "Demandé",
  "document.source.message": "D'un message", // fluent review
  "document.source.generated": "Créé par votre agent", // fluent review
  "document.title": "{vendor} · facture {number}",
  "document.received": "{source} {time}",
  "document.receivedFrom": "{source} {time} par {from}",
  "document.openOriginal": "Ouvrir l'original",
  "document.reading": "Nous lisons ce document. Cela prend environ une minute.",
  "document.failed": "Nous n'avons pas pu lire ce document. Votre équipe Mezonas va s'en occuper.",
  "document.notRead": "Pas encore lu.",
  "document.totalsOff": "Les totaux ne concordent pas : une personne va les vérifier.",
  "document.whatItSays": "Ce qu'il indique",
  "document.vendor": "Fournisseur",
  "document.invoice": "Facture",
  "document.invoiceDate": "Date de facture",
  "document.due": "Échéance",
  "document.po": "Commande ou chantier",
  "document.pages": "Pages",
  "document.matched": "Rapproché d'un achat.",
  // UI cleanup (duplicates and matches): needs a fluent speaker's review.
  "document.matchedBill": "Rapproché d'une facture fournisseur.",
  "document.matchedVendorCredit": "Rapproché d'un avoir fournisseur.",
  "document.duplicateOf":
    "Même facture que {filename}, arrivée en premier. Nous l'avons lue sans rien en faire de plus.",
  "document.totals": "Totaux",
  "document.lines": "Lignes",
  "document.subtotal": "Sous-total",
  "document.freight": "Transport",
  "document.tax": "Taxes",
  "document.total": "Total",
  "document.lineCount": { one: "{count} ligne", other: "{count} lignes" },
  "document.col.item": "Article",
  "document.col.description": "Description",
  "document.col.qty": "Qté",
  "document.col.unit": "Unité",
  "document.col.unitPrice": "Prix unitaire",
  "document.col.amount": "Montant",
  "document.col.page": "Page",

  // ── Requests ──
  "requests.subtitle":
    "Demandez-nous de modifier un de vos agents, ou quelque chose de nouveau. Nous répondons ici.",
  "requests.which": "Quelles demandes",
  "requests.filter.all": "Toutes",
  "requests.filter.open": "Chez nous",
  "requests.filter.resolved": "Répondues",
  "requests.team": "Les demandes de votre équipe",
  "requests.yours": "Vos demandes",
  "requests.emptyAll":
    "Pas encore de demandes. Demandez-nous ce que vous voulez avec le formulaire.",
  "requests.emptyFiltered": "Aucune ici.",
  "requests.status.open": "Chez nous",
  "requests.status.done": "Fait",
  "requests.status.declined": "Déclinée",
  "requests.askUs": "Nous demander",
  "requests.about": "À propos de",
  "requests.somethingNew": "Quelque chose de nouveau, ou autre chose",
  "requests.subject": "Objet",
  "requests.subjectHint": "Facultatif. Sans objet, nous prenons la première ligne.",
  "requests.what": "Que souhaitez-vous ?",
  "requests.placeholder":
    "ex. Nous achetons maintenant chez Bois Acme. Merci de suivre aussi leurs prix.",
  "requests.send": "Envoyer la demande",
  "requests.sent": "Envoyée. Nous répondons ici.",
  "requests.failed": "Nous n'avons pas pu l'envoyer. Réessayez.",
  "requests.doneOn": "Fait le {date}",
  "requests.declinedOn": "Déclinée le {date}",
  "requests.nowOnVersion": "{service} : désormais en version {version}",

  // ── Sign-in ──
  "signin.title": "Se connecter à {product}",
  "signin.workosHelp":
    "Utilisez l'adresse e-mail avec laquelle vous avez été invité. Nous vous envoyons vers notre page de connexion, puis vous revenez ici.",
  "signin.continue": "Continuer",
  "signin.devHelp": "Connexion de développement : choisissez un utilisateur de test.",
  "signin.email": "E-mail",
  "signin.submit": "Se connecter",
  "signin.noSession":
    "Connecté, mais la session ne s'est pas ouverte. Cet utilisateur de test existe-t-il ?",
  "signin.role.operator": "Opérateur",
  "signin.role.client_admin": "Administrateur client",
  "signin.role.client_user": "Utilisateur client",
  "signin.operatorClients": {
    one: "Opérateur · {count} client",
    other: "Opérateur · {count} clients",
  },
  "signin.noClient": "Aucun client",
  "signin.error.not_invited":
    "Cette adresse e-mail n'a pas été invitée sur Mezonas. Demandez une invitation à votre contact chez Mezonas, puis connectez-vous avec la même adresse.",
  "signin.error.email_not_verified":
    "Vérifiez d'abord votre adresse e-mail sur la page de connexion, puis reconnectez-vous.",
  "signin.error.email_taken":
    "Cette adresse e-mail est liée à une autre connexion. Contactez-nous pour régler cela.",
  "signin.error.misconfigured": "La connexion n'est pas encore configurée sur ce site.",
  "signin.error.default": "La connexion n'a pas abouti. Recommencez.",

  // ── Feedback ──
  "feedback.button": "Signaler un problème dans l'app",
  "feedback.short": "Signaler un problème",
  "feedback.tapWhere": "Touchez l'endroit du problème",
  "feedback.noSpot": "Pas d'endroit précis",
  "feedback.capturing": "Capture de l'image…",
  "feedback.thanks": "Merci. Nous avons reçu votre retour.",
  "feedback.pictureFailed": "Votre commentaire est enregistré, mais l'image n'a pas été envoyée.",
  "feedback.title": "Envoyer un retour",
  "feedback.weRead": "Nous les lisons tous.",
  "feedback.pictureOff": "L'image ne sera pas envoyée.",
  "feedback.noPicture":
    "Nous n'avons pas pu capturer cette page. Votre commentaire nous aide quand même.",
  "feedback.pinned": "Épinglé :",
  "feedback.question": "Qu'est-ce qui ne va pas, ou qu'est-ce qui vous aiderait ?",
  "feedback.leaveOff": "Ne pas joindre l'image",
  "feedback.sayWhat": "Dites-nous ce qui ne va pas, ou ce qui vous aiderait.",
  "feedback.failed": "Nous n'avons pas pu l'envoyer. Réessayez.",
  "feedback.pictureAlt": "La page au moment de l'envoi du retour",

  // ── Settings (client admins) ──
  "settings.adminOnly": "Seul votre administrateur peut modifier les paramètres.",
  "settings.peopleCount": {
    one: "{count} personne utilise votre portail.",
    other: "{count} personnes utilisent votre portail.",
  },
  "settings.people": "Personnes",
  "settings.approvals": "Approbations",
  "settings.approvals.byUs":
    "Nous approuvons les changements dans vos outils en votre nom. Vous voyez toujours chaque changement dans vos exécutions.",
  "settings.approvals.byYou":
    "Vous approuvez les changements dans vos outils avant qu'ils aient lieu.",
  "settings.approvals.howToChange":
    "Ajoutez une règle ci-dessous pour choisir qui approuve. Vous pouvez rendre les approbations plus strictes ; seuls nous les assouplissons. Pour limiter ce que les agents peuvent faire dans un outil, allez dans",
  "settings.approvals.accountsLink": "Connecteurs.",
  "settings.approvals.askAdmin": "Pour changer qui approuve, demandez à votre administrateur.",
  "settings.emails": "E-mails",
  "settings.emailsSoon": "Les e-mails arrivent bientôt",
  "settings.email.itemsWaiting": "Quelque chose vous attend",
  "settings.email.itemsWaitingHelp":
    "Un e-mail quand une approbation ou une question vous revient.",
  "settings.email.weeklyDigest": "Résumé hebdomadaire",
  "settings.email.weeklyDigestHelp": "Ce que vos agents ont fait chaque semaine.",
  "settings.emailsNotYet":
    "Nous n'envoyons pas encore ces e-mails. Nous gardons vos choix et les appliquerons dès que ce sera le cas.",
  "settings.saved": "Enregistré.",
  "settings.saveFailed": "Nous n'avons pas pu l'enregistrer. Réessayez.",

  // ── People and invitations ──
  "people.role.client_admin": "Administrateur",
  "people.role.client_user": "Utilisateur",
  "people.role.operator": "Mezonas",
  "people.invited": "Invité",
  "people.remove": "Retirer",
  "people.removeWarning":
    "{name} perd l'accès dans les 5 minutes. Ce qui l'attend passe aux administrateurs.",
  "people.removeKeep": "Garder",
  "people.removeProblem": "Nous n'avons pas pu retirer cette personne. Réessayez.",
  "people.none": "Personne pour l'instant. Invitez quelqu'un ci-dessous.",
  "people.email": "E-mail",
  "people.name": "Nom (facultatif)",
  "people.role": "Rôle",
  "people.invite": "Inviter",
  "people.rolesHelp":
    "Les administrateurs connectent les outils, approuvent les changements et invitent des personnes. Les utilisateurs voient les éléments de la boîte de réception qui leur sont confiés, les exécutions et les rapports.",
  "people.invite.sent": "Nous avons envoyé une invitation à {email}.",
  "people.invite.signedUpBefore":
    "{email} a été ajouté. Cette personne s'est déjà connectée, il n'y avait donc rien à envoyer.",
  "people.invite.noEmails":
    "{email} a été invité. Cet environnement n'envoie pas d'e-mails : la personne peut se connecter avec cette adresse dès maintenant.",
  "people.invite.emailFailed":
    "{email} a été invité, mais l'e-mail n'est pas parti. Demandez-lui de se connecter avec cette adresse.",
  "people.problem.hasAccess": "Cette adresse a déjà accès.",
  "people.problem.otherClient": "Cette adresse appartient à un autre client.",
  "people.problem.isOperator": "Cette adresse appartient à un opérateur Mezonas.",
  "people.problem.unavailable":
    "Cette adresse ne peut pas être invitée ici. Demandez-nous et nous réglerons cela.",
  "people.problem.noEmail": "Saisissez une adresse e-mail.",
  "people.problem.failed": "Nous n'avons pas pu envoyer cette invitation. Réessayez.",
  "people.problem.notInvitable": "Seul votre propre personnel peut être invité à se connecter.",
  "people.access.member": "Peut se connecter",
  "people.access.invited": "Invité, ne s'est pas encore connecté",
  "people.fromDirectory.invite": "Inviter à se connecter",
  "people.fromDirectory.title": "Inviter à se connecter",
  "people.fromDirectory.help": "La personne se connecte avec l'adresse e-mail de votre annuaire.",
  "people.fromDirectory.canSign": "Peut approuver",
  "people.fromDirectory.adminSigns": "Les administrateurs approuvent toujours.",
  "people.fromDirectory.addEmail": "Ajoutez un e-mail pour inviter",
  "people.fromDirectory.close": "Fermer",
  "people.fromDirectory.link": "Inviter depuis l'annuaire",

  // ── Reports ──
  "reports.subtitle": "Ce que vos agents ont fait.",
  "reports.subtitlePeriod": "Ce que vos agents ont fait, {period}.",
  "reports.activity": "Activité",
  "reports.period": "Période",
  "reports.period.month": "Ce mois-ci",
  "reports.period.last": "Le mois dernier",
  "reports.period.quarter": "Les 3 derniers mois",
  "reports.forService": "Agent :",
  "reports.thisService": "cet agent",
  "reports.allServices": "Tous les agents",
  "reports.runs": "Exécutions",
  "reports.runs.done": { one: "{count} terminée", other: "{count} terminées" },
  "reports.runs.failed": { one: "{count} en échec", other: "{count} en échec" },
  "reports.runs.running": { one: "{count} en cours", other: "{count} en cours" },
  "reports.runs.cancelled": { one: "{count} annulée", other: "{count} annulées" },
  "reports.runs.none": "Rien n'a été exécuté",
  "reports.documentsRead": "Documents lus",
  "reports.documentsIn": { one: "{count} document reçu", other: "{count} documents reçus" },
  "reports.changes": "Changements dans vos outils",
  "reports.changesNone": "Aucun sur cette période",
  "reports.byService": "Par agent",
  "reports.noServices":
    "Pas encore d'agents. Nous les mettons en place avec vous, et leur travail apparaît ici.",
  "reports.col.done": "Terminées",
  "reports.col.failed": "En échec",
  "reports.col.waiting": "En attente",
  "reports.col.changes": "Changements",
  "reports.notAvailable": "Ce rapport n'est pas disponible pour vous.",
  "reports.seeActivity": "Voir votre activité",

  // ── Service page ──
  "service.thisMonth": "Ce mois-ci",
  "service.nothingRan": "Rien n'a encore été exécuté ce mois-ci",
  "service.allRuns": "Toutes les exécutions",
  "service.recentRuns": "Exécutions récentes",
  "service.noRuns": "Pas encore d'exécutions. Chaque exécution de cet agent apparaît ici.",
  "service.activityHelp": {
    one: "{count} exécution ce mois-ci, selon son issue, avec les documents lus et les changements effectués.",
    other:
      "{count} exécutions ce mois-ci, selon leur issue, avec les documents lus et les changements effectués.",
  },

  // ── Record pages ──
  "record.kind.purchase": "Achat",
  "record.kind.bill": "Facture fournisseur",
  "record.kind.vendor_credit": "Avoir fournisseur",
  "record.status.needs_doc": "Document manquant",
  "record.status.doc_requested": "Document demandé",
  "record.status.doc_found": "Document trouvé",
  "record.status.extracted": "Document lu",
  "record.status.processed": "Terminé",
  "record.fromTool": "depuis {tool}",
  "record.date": "Date",
  "record.paidWith": "Payé avec",
  "record.purchaser": "Acheteur",
  "record.memo": "Mémo",
  "record.whereFrom": "D'où il vient",
  "record.recorded": "Enregistré {time}",
  "record.asItArrived": "Tel qu'il est arrivé",
  "record.noLines": "Pas de lignes : nous n'avons que le total.",
  "record.col.item": "Compte ou article",
  "record.col.transaction": "Transaction",
  "record.documents": "Documents",
  "record.noDocuments": "Aucun document n'y est encore lié.",
  "record.runs": "Exécutions",
  "record.runs.empty": "Aucune exécution ne l'a encore traité.",
  "record.runs.role.read": "Lu",
  "record.runs.role.decided": "Rapproché",
  "record.runs.role.changed": "Modifié",
  "record.runs.role.changedIn": "Modifié dans {tool}",
  "record.runs.hide": "Masquer les exécutions",
  "record.value": "Valeur",
  "record.rawTitle": "{type} depuis {tool}",
  "record.fileRow": "{file}, ligne {row}",
  "record.received": "reçu {time}",
  "record.deletedInTool": "Supprimé dans l'outil",
  "record.tool": "Outil",
  "record.idThere": "Son identifiant là-bas",
  "record.version": "Version",
  "record.madeFrom": "Ce qui en a été créé",
  "record.nothingMade": "Rien n'en a été créé.",
  "record.vendorSince": "Fournisseur · vu pour la première fois {time}",
  "record.aliases": "Aussi appelé {names}",
  "record.recentTransactions": "Transactions récentes",
  "record.noTransactions": "Pas encore de transactions de ce fournisseur.",
  "record.notFound":
    "Il n'y a pas de page pour cet identifiant. Il s'agit peut-être d'un enregistrement d'un outil ou d'un pack que nous n'affichons pas ici.",
  "record.source": "Enregistrement ·{tail}",
  // v0.12 W1-H: the portal records list.
  "records.title": "Enregistrements",
  "records.subtitle":
    "Ce que vos outils ont apporté, du plus récent au plus ancien. Ouvrez-en un pour voir d’où il vient.",
  "records.kind.transactions": "Transactions",
  "records.kind.vendors": "Fournisseurs",
  "records.kind.items": "Articles",
  "records.search": "Rechercher",
  "records.empty":
    "Rien pour l’instant. Les enregistrements arrivent quand vos outils se synchronisent.",
  "records.noMatch": "Rien ne correspond à « {q} ».",
  "records.col.date": "Date",
  "records.col.type": "Type",
  "records.col.vendor": "Fournisseur",
  "records.col.number": "Numéro",
  "records.col.total": "Total",
  "records.col.name": "Nom",
  "records.col.transactions": "Transactions",
  "records.col.description": "Description",
  "records.col.source": "Source",
  "records.range": "{from}–{to} sur {total}",
  "records.previous": "Précédent",
  "records.next": "Suivant",

  // ── Who approves ──
  "approvers.title": "Qui approuve",
  "approvers.intro":
    "La première règle qui correspond à un changement décide. Si aucune ne correspond, votre administrateur approuve, sauf si l'agent désigne quelqu'un.",
  "approvers.empty": "Pas encore de règles. Votre administrateur approuve chaque changement.",
  "approvers.who.admin": "Votre administrateur",
  "approvers.who.team": "N'importe qui dans votre équipe",
  "approvers.who.us": "Nous approuvons pour vous",
  "approvers.who.left": "Une personne qui est partie",
  "approvers.whoForRule": "Qui approuve la règle {n}",
  "approvers.verb.any": "Crée ou modifie",
  "approvers.verb.create": "Crée",
  "approvers.verb.update": "Modifie",
  "approvers.verb.delete": "Supprime",
  "approvers.over": "Plus de {amount} {currency}",
  "approvers.anyChange": "Tout changement",
  "approvers.anyTool": "Tout outil",
  "approvers.anyService": "Tout agent",
  "approvers.serviceLeft": "Un agent qui n'existe plus",
  "approvers.addedByYou": "Ajoutée par vous",
  "approvers.setByUs": "Définie par nous",
  "approvers.notSaved": "pas encore enregistrée",
  "approvers.add": "Ajouter une règle",
  "approvers.addRule": "Ajouter la règle",
  "approvers.updateRule": "Mettre à jour la règle",
  "approvers.remove": "Retirer",
  "approvers.save": "Enregistrer les règles",
  "approvers.tightenNote":
    "Vous pouvez rendre les approbations plus strictes vous-même. Nous seuls pouvons les assouplir à nouveau.",
  "approvers.changedByUs": "Nous les avons modifiées le {date} :",
  "approvers.changedBy": "{name} les a modifiées le {date} :",
  "approvers.yourTeam": "Votre équipe",
  "approvers.field.tool": "Outil",
  "approvers.field.change": "Changement",
  "approvers.field.kind": "Type",
  "approvers.field.amount": "Montant supérieur à",
  "approvers.field.amountHelp":
    "Laissez vide pour tout montant. Seule la même devise est prise en compte.",
  "approvers.field.currency": "Devise",
  "approvers.field.service": "Agent",
  "approvers.field.note": "Note (facultatif)",
  "approvers.field.where": "Position",
  "approvers.where.top": "En premier, avant les autres règles",
  "approvers.where.end": "En dernier, après les autres règles",
  "approvers.amountProblem": "Écrivez le montant sous forme de nombre, par exemple 500 ou 1250.50.",
  "approvers.currencyProblem": "Utilisez un code de devise à trois lettres, par exemple EUR.",
  "approvers.problem.removed": "Nous seuls retirons des règles.",
  "approvers.problem.reordered": "Nous seuls changeons l'ordre des règles.",
  "approvers.problem.match_changed": "Nous seuls changeons ce que couvre une règle.",
  "approvers.problem.looser": "Cet approbateur est moins strict.",
  "approvers.problem.to_operator": "Vous ne pouvez pas nous confier les approbations.",
  "approvers.problem.new_rule_too_loose":
    "Une nouvelle règle doit désigner votre administrateur ou une personne.",

  // ── Knowledge (FAQs and policies; plan §1.21) ──
  "knowledge.title": "Connaissances",
  "knowledge.subtitle":
    "Vos FAQ et vos règles. Nos agents s'en servent pour répondre à votre place. Nous gardons chaque version précédente.",
  "knowledge.which": "Quelles entrées",
  "knowledge.show.active": "En usage",
  "knowledge.show.all": "Toutes, avec les archivées",
  "knowledge.section": "FAQ et règles",
  "knowledge.empty":
    "Rien pour l'instant. Ajoutez avec le formulaire une question qu'on vous pose souvent, ou une règle.",
  "knowledge.add": "Ajouter",
  "knowledge.us": "nous",
  "knowledge.yourTeam": "votre équipe",
  "knowledge.byline": "Version {version} · {who} · {date}",
  "knowledge.kind.faq": "FAQ",
  "knowledge.kind.policy": "Règle",
  "knowledge.type": "Type",
  "knowledge.type.faq": "FAQ : une question et sa réponse",
  "knowledge.type.policy": "Règle : comment les choses se font",
  "knowledge.question": "Question",
  "knowledge.entryTitle": "Titre",
  "knowledge.answer": "Réponse",
  "knowledge.policy": "Règle",
  "knowledge.placeholder.question": "p. ex. Quand livrez-vous ?",
  "knowledge.placeholder.title": "p. ex. Retours",
  "knowledge.placeholder.answer": "p. ex. Nous livrons le mardi et le jeudi.",
  "knowledge.placeholder.policy":
    "p. ex. Les panneaux non utilisés peuvent être retournés sous 30 jours.",
  "knowledge.saving": "Enregistrement…",
  "knowledge.saveAndRestore": "Enregistrer et restaurer",
  "knowledge.edit": "Modifier",
  "knowledge.editAndRestore": "Modifier et restaurer",
  "knowledge.archive": "Archiver",
  "knowledge.archived": "Archivée",
  "knowledge.problem.archived": "C'est déjà archivé.",
  "knowledge.problem.changed":
    "Quelqu'un l'a modifiée depuis que vous l'avez ouverte. Rechargez pour voir la dernière version, puis réessayez.",
  "knowledge.problem.failed": "Nous n'avons pas pu l'enregistrer. Réessayez.",
  // B6 (docs/builder-plan.md §8): the charter, tags and how our agents work.
  "knowledge.charter.section": "Votre charte",
  "knowledge.charter.intro":
    "Qui vous êtes, comment vous parlez, ce qui compte pour vous et ce que vous ne faites jamais. Nos agents la lisent avant chaque tâche.",
  "knowledge.charter.none":
    "Nous rédigerons votre charte à partir de ce que vous nous avez dit au démarrage, pour que vous la confirmiez.",
  "knowledge.charter.waiting": "En attente de votre part",
  "knowledge.charter.waitingLine":
    "Lisez-la, puis confirmez-la ou modifiez-la. Nos agents la suivent dès que vous la confirmez.",
  "knowledge.charter.inUse":
    "Nos agents suivent la version {version} jusqu'à ce que vous confirmiez celle-ci.",
  "knowledge.charter.confirmed": "Confirmée",
  "knowledge.charter.confirmedLine": "Confirmée par {who} le {date}",
  "knowledge.charter.confirm": "Confirmer",
  "knowledge.charter.confirming": "Confirmation…",
  "knowledge.charter.problem": "Nous n'avons pas pu la confirmer. Réessayez.",
  "knowledge.tags": "Ce qu'elle couvre",
  "knowledge.tagsHint":
    "Les agents lisent une politique quand leur travail correspond à ce qu'elle couvre.",
  "governance.tag.security": "Sécurité",
  "governance.tag.writing-into-tools": "Écrire dans les outils",
  "governance.tag.money": "Argent",
  "governance.tag.contacting-people": "Contacter des personnes",
  "governance.tag.data-handling": "Traitement des données",
  "governance.tag.people-and-roles": "Personnes et rôles",
  "governance.tag.purchasing": "Achats",
  "governance.tag.sales": "Ventes",
  "governance.tag.receivables": "Créances",
  "governance.tag.bookkeeping": "Comptabilité",
  "governance.tag.marketing": "Marketing",
  "governance.tag.general": "Général",
  "howAgentsWork.title": "Comment travaillent les agents Mezonas",
  "howAgentsWork.intro": "Les règles que suit chaque agent, avant votre charte et vos politiques.",
  "howAgentsWork.tools.title": "Ils passent uniquement par vos outils",
  "howAgentsWork.tools.body":
    "Les agents lisent et modifient les données uniquement via les connexions que vous nous avez données, dans les limites de vos autorisations.",
  "howAgentsWork.evidence.title": "Chaque chiffre a une source",
  "howAgentsWork.evidence.body":
    "Un agent n'invente jamais un nombre ou un nom. Ce qu'il rapporte renvoie aux enregistrements d'où il vient.",
  "howAgentsWork.data.title": "Les documents sont lus, pas obéis",
  "howAgentsWork.data.body":
    "Le texte d'une facture, d'un e-mail ou d'une réponse est une information. Un agent ne suit jamais les instructions qui y sont écrites.",
  "howAgentsWork.approval.title": "Vous approuvez les changements",
  "howAgentsWork.approval.body":
    "Les changements dans vos outils attendent l'accord d'une personne. Seuls nous pouvons l'assouplir, et seulement avec votre accord.",
  "howAgentsWork.money.title": "L'argent ne bouge pas tout seul",
  "howAgentsWork.money.body":
    "Les agents ne paient, ne virent et ne modifient jamais de coordonnées bancaires d'eux-mêmes, et ne se connectent jamais à une banque ou une messagerie.",
  "howAgentsWork.privacy.title": "Vos données restent les vôtres",
  "howAgentsWork.privacy.body":
    "Ce qu'un agent apprend de votre entreprise ne sert qu'à vous, jamais à un autre client.",
  "howAgentsWork.yours.title": "Ensuite, votre charte et vos politiques",
  "howAgentsWork.yours.body":
    "Les agents lisent ensuite votre charte et vos politiques. Elles peuvent ajouter des règles et durcir les nôtres, jamais les assouplir.",

  // ── Contacts and consent (plan §1.22, §1.25) ──
  "contacts.title": "Contacts",
  "contacts.subtitle":
    "Les personnes que nous pouvons contacter pour vous par e-mail, SMS, WhatsApp ou téléphone. Nous ne contactons que celles qui ont accepté, et jamais pendant les heures de silence.",
  "contacts.adminOnly": "Votre administrateur tient la liste des contacts.",
  // v0.14 capture: WhatsApp conversations (docs/plan.md §1.55); five languages need a fluent review.
  "conversations.title": "Conversations",
  "conversations.subtitle":
    "Les discussions WhatsApp avec votre numéro. Choisissez ce que nous gardons de chacune : les messages, et leurs pièces jointes comme documents.",
  "conversations.adminOnly":
    "Votre administrateur choisit ce que nous gardons des conversations WhatsApp.",
  "conversations.empty":
    "Aucune conversation WhatsApp pour l'instant. Une conversation commence quand quelqu'un écrit à votre numéro.",
  "conversations.lastMessage": "Dernier message {when}",
  "conversations.noMessages": "Aucun message pour l'instant.",
  "conversations.keepMessages": "Garder les messages",
  "conversations.attachments": "Télécharger les pièces jointes",
  "conversations.attachments.off": "Non",
  "conversations.attachments.documents": "PDF et images",
  "conversations.attachments.all": "Tous les fichiers",
  "conversations.yes": "Oui",
  "conversations.no": "Non",
  "conversations.showMessages": "Voir les messages",
  "conversations.hideMessages": "Masquer les messages",
  "conversations.notKept": "Non gardé",
  "conversations.downloadNow": "Télécharger maintenant",
  "conversations.downloading": {
    one: "Téléchargement de {count} pièce jointe.",
    other: "Téléchargement de {count} pièces jointes.",
  },
  "conversations.failed": "Cela n'a pas marché. Réessayez.",
  "conversations.attachment.not_downloaded": "Non téléchargée",
  "conversations.attachment.pending": "Téléchargement",
  "conversations.attachment.filed": "Classée",
  "conversations.attachment.refused": "Non prise",
  "conversations.attachment.failed": "Téléchargement impossible",
  "contacts.empty":
    "Aucun contact pour l'instant. Ajoutez les personnes que vos agents peuvent contacter, avec la façon dont elles ont accepté.",
  "contacts.channel.sms": "SMS",
  "contacts.channel.whatsapp": "WhatsApp",
  "contacts.channel.voice": "Appels",
  "contacts.channel.email": "E-mail",
  "contacts.consentOption.voice": "Appels d'un assistant automatique",
  "contacts.optedOut": "Désinscrit",
  "contacts.optedOutByText": "Désinscrit par SMS",
  "contacts.agreed": "{channel} : accepté",
  "contacts.notAgreed": "{channel} : non accepté",
  "contacts.email": "E-mail",
  "contacts.phone": "Téléphone",
  "contacts.whatsapp": "Numéro WhatsApp",
  "contacts.firstBy": "Contacter d'abord par",
  "contacts.then": "Puis",
  "contacts.noPreference": "Pas de préférence",
  "contacts.nothingElse": "Rien d'autre",
  "contacts.language": "Langue",
  "contacts.yourLanguage": "Votre langue",
  "contacts.timezone": "Fuseau horaire",
  "contacts.emptyIsYours": "Vide : le vôtre.",
  "contacts.quietFrom": "Silence à partir de",
  "contacts.quietUntil": "Silence jusqu'à",
  "contacts.roles": "Rôles",
  "contacts.rolesHint": "Séparés par des virgules, p. ex. purchaser, owner.",
  "contacts.notes": "Notes",
  "contacts.saveDetails": "Enregistrer les coordonnées",
  "contacts.saved": "Enregistré.",
  "contacts.problem.quietHours": "Indiquez les deux heures de silence, ou aucune.",
  "contacts.problem.notSaved": "Ce n'est pas enregistré. Réessayez.",
  "contacts.problem.notAdded": "Nous n'avons pas pu l'ajouter. Réessayez.",
  "contacts.manage": "Gérer",
  "contacts.close": "Fermer",
  "contacts.stoppedByText":
    "A envoyé STOP par SMS le {date}. Seule cette personne peut se réinscrire, en envoyant START.",
  "contacts.optedOutOn": "Désinscrit le {date}. Rien ne lui est envoyé.",
  "contacts.liftOptOut": "Lever la désinscription",
  "contacts.consentChannel": "Canal",
  "contacts.howAgreed": "Comment la personne a accepté",
  "contacts.howAgreedHint": "Par exemple : a signé le contrat de service.",
  "contacts.recordConsent": "Enregistrer le consentement",
  "contacts.business": "Ce numéro nous a été donné pour nos échanges",
  "contacts.businessHint":
    "Couvre les appels de notre assistant et les e-mails sur votre travail ensemble. Les SMS et WhatsApp demandent leur inscription : envoyez-leur une invitation.",
  "contacts.businessWhere": "Où il a été donné",
  "contacts.businessWhereHint": "Par exemple : numéro sur leurs factures.",
  "contacts.businessRecord": "Enregistrer",
  "contacts.businessLine": "{channels} : ce numéro vous a été donné pour vos échanges ({source}).",
  "contacts.withdrawConsent": "Retirer le consentement",
  "contacts.optOutAll": "Désinscrire de tout",
  "contacts.loadingMessages": "Chargement des messages…",
  // P-7: a message and its translation (docs/plan.md §1.69).
  "translation.from": "Traduit de : {language}",
  "translation.original": "Original",
  "translation.showOriginal": "Voir l'original",
  "translation.showTranslation": "Voir la traduction",
  "translation.truncated": "Les 6 000 premiers caractères ont été traduits",
  "translation.unknownLanguage": "une autre langue",
  "contacts.noMessages": "Aucun message pour l'instant.",
  "contacts.message.theyCalled": "A appelé",
  "contacts.message.weCalled": "Nous avons appelé",
  "contacts.message.theyWrote": "A écrit",
  "contacts.message.weSent": "Nous avons envoyé",
  "contacts.message.call": "Appel",
  "contacts.message.reachOut": "prise de contact",
  "contacts.status.queued": "en file d'attente",
  "contacts.status.sent": "envoyé",
  "contacts.status.delivered": "remis",
  "contacts.status.undelivered": "non remis",
  "contacts.status.failed": "échec",
  "contacts.status.read": "lu",
  "contacts.status.received": "reçu",
  "contacts.status.unverified": "reçu, expéditeur non confirmé",
  "contacts.status.other_sender": "reçu d'une autre adresse de son entreprise, pas sa réponse",
  "contacts.status.replied": "a répondu",
  "contacts.status.not_sent": "non envoyé",
  "contacts.status.no_reply": "pas de réponse",
  "contacts.status.completed": "terminé",
  "contacts.status.busy": "occupé",
  "contacts.status.no-answer": "sans réponse",
  "contacts.add": "Ajouter un contact",
  "contacts.name": "Nom",
  "contacts.phoneHint": "Avec l'indicatif du pays, p. ex. +33 6 12 34 56 78.",
  "contacts.whatsappHint": "Laissez vide si la personne n'utilise pas WhatsApp.",
  "contacts.agreedToHear":
    "La personne a accepté d'être contactée par vous à ces numéros et à cette adresse",
  "contacts.addContact": "Ajouter le contact",

  // ── People: who each service reaches (plan §1.25) ──
  "reach.title": "Personnes",
  "reach.subtitle":
    "Qui chacun de vos agents contacte, et quand. Nous ne contactons que les personnes qui ont accepté, sur les canaux qu'elles ont acceptés.",
  "reach.adminOnly": "Votre administrateur choisit qui vos agents contactent.",
  "reach.none": "Aucun de vos agents ne contacte encore de personnes.",
  "reach.noRoles": "Ne contacte personne : aucun rôle.",
  "reach.channel.email": "E-mail",
  "reach.channel.sms": "SMS",
  "reach.channel.whatsapp": "WhatsApp",
  "reach.channel.voice": "Appel",
  "reach.required": "Obligatoire",
  "reach.requiredNobody": "Obligatoire : personne pour l'instant",
  "reach.who": "Qui",
  "reach.noContacts": "Aucun contact pour l'instant. Ajoutez-les sur la page Contacts.",
  "reach.optedOut": "Désinscrit",
  "reach.noConsent": "pas encore de consentement",
  "reach.channels": "Canaux",
  "reach.urgent": "L'urgent peut passer hors de ses heures de silence",
  "reach.maxPerDay": "Au plus par jour",
  "reach.escalate": "Canal suivant après",
  "reach.escalateHint": "Sans réponse pendant cette durée.",
  "reach.escalateUnit": "Unité",
  "reach.unit.minute": "minutes",
  "reach.unit.hour": "heures",
  "reach.unit.day": "jours",
  "reach.onlyIf": "Seulement si",
  "reach.field": "Champ",
  "reach.comparison": "Comparaison",
  "reach.value": "Valeur",
  "reach.missing": "Choisissez quelqu'un pour {roles} avant que cela puisse démarrer.",
  "reach.save": "Enregistrer les personnes",
  "reach.saved": "Enregistré.",
  "reach.problem.notSaved": "Ce n'est pas enregistré. Réessayez.",

  // ── Billing (plan §1.32) ──
  "billing.title": "Facturation",
  "billing.subtitle":
    "Ce mois-ci jusqu'à présent, les crédits utilisés par vos agents et vos factures.",
  "billing.notSetUp":
    "La facturation n'est pas encore configurée. Nous vous préviendrons avant votre première facture.",
  "billing.paymentProblem":
    "Votre dernier paiement n'est pas passé. Ouvrez la facture ci-dessous pour la régler.",
  "billing.included": "Inclus jusqu'ici",
  "billing.creditUnit": { one: "crédit", other: "crédits" },
  "billing.shared": "Partagés par tous vos agents",
  "billing.extra": "Crédits supplémentaires",
  "billing.extraEach": "{price} l'unité, sur votre prochaine facture",
  "billing.periodBody":
    "{period}. Les crédits mesurent le travail de vos agents : lire des documents, des messages, des appels. {credits} sont inclus.",
  "billing.credits": { one: "{count} crédit", other: "{count} crédits" },
  "billing.meter.label": "Crédits utilisés sur cette période",
  "billing.meter.valueText": "{used} sur {allowance}",
  "billing.meter.used": "{used} sur {allowance} utilisés",
  "billing.meter.over": "{credits} au-delà du forfait",
  "billing.column.amount": "Montant",
  "billing.column.links": "Liens",
  "billing.status.paid": "Payée",
  "billing.status.sent": "À payer",
  "billing.status.draft": "Brouillon",
  "billing.status.void": "Annulée",
  "billing.view": "Voir",
  "billing.viewAndPay": "Voir et payer",
  "billing.pdf": "PDF",
  "billing.soFar": "Ce mois-ci jusqu'à présent",
  "billing.soFarNote": "{period}. Le montant final arrive au début du mois prochain.",
  "billing.byService": "Par agent",
  "billing.statements": "Factures",
  "billing.noStatements":
    "Aucune facture pour l'instant. La première arrive au début du mois prochain.",
  "billing.column.item": "Élément",
  "billing.pricePerMonth": "{price} par mois",
  "billing.priceForDays": {
    one: "{price} pendant {count} jour",
    other: "{price} pendant {count} jours",
  },
  "billing.daysOf": "{days} jours sur {total}",
  "billing.includedPrice": "Inclus",
  "line.ask": "Demander un numéro dédié",
  "line.help":
    "Un numéro dédié permet à votre équipe d'écrire et d'appeler {name} directement. {price} par mois.",
  "line.confirm":
    "Nous achèterons un numéro pour {name} et ajouterons {price} par mois à votre facture dès sa mise en place.",
  "line.confirmButton": "Nous le demander",
  "line.asked": "Demande envoyée. Nous vous préviendrons ici une fois le numéro en place.",
  "line.seeRequest": "Voir la demande",
  "line.subject": "Un numéro de téléphone pour {name}",
  "line.text":
    "Merci de donner à {name} un numéro de téléphone dédié, à {price} par mois, pour que notre équipe puisse lui écrire et l'appeler directement.",
  "billing.phoneLine": "Ligne téléphonique {number}",
  "billing.extraUsage": "Utilisation supplémentaire",
  "billing.extraUsageDetail":
    "{credits} au-delà des {included} inclus ({used} utilisés), {price} chacun",
  "billing.total": "Total",
  "billing.totalSoFar": "Total à ce jour",
  "billing.dueOn": "À payer avant le {date}",
  "billing.details": "Détails",
  "billing.hideDetails": "Masquer les détails",
  "billing.status.payment_failed": "Paiement échoué",
  "billing.status.nothing_due": "Rien à payer",

  // ── Human release (Access phase 4) ──
  "release.title": "Libération par une personne",
  "release.hint":
    "Avant qu'un agent l'utilise, nous envoyons un code à 6 chiffres à une personne. L'agent attend qu'elle le saisisse.",
  "release.off": "Désactivée : les agents l'utilisent sans demander à personne.",
  "release.on": "{person} le libère avec un code par {channel}, {window}.",
  "release.byText": "SMS",
  "release.byEmail": "e-mail",
  "release.forRun": "pour une exécution",
  "release.forHours": { one: "pendant {count} heure", other: "pendant {count} heures" },
  "release.stateOn": "Activée",
  "release.stateOff": "Désactivée",
  "release.needsCode": "Code attendu",
  "release.turnOn": "Activer",
  "release.turnOff": "Désactiver",
  "release.change": "Modifier",
  "release.person": "Qui le libère",
  "release.channel": "Envoyer le code par",
  "release.channelText": "SMS",
  "release.channelEmail": "E-mail",
  "release.noText":
    "Nous ne pouvons pas encore envoyer de SMS à cette personne. Ajoutez-la dans Contacts avec son téléphone et son accord pour les SMS, ou choisissez l'e-mail.",
  "release.window": "Une libération dure",
  "release.windowRun": "Une exécution",
  "release.windowHours": { one: "{count} heure", other: "{count} heures" },
  "release.offNote":
    "Vous seul pouvez la désactiver. Nous pouvons l'activer, jamais la désactiver.",
  "release.live": "Libéré maintenant",
  "release.noLive": "Rien n'est libéré pour le moment.",
  "release.liveBy": "{agent} · libéré par {person}",
  "release.liveRun": "Pour l'exécution en cours",
  "release.liveUntil": "Jusqu'à {time}",
  "release.revoke": "Révoquer",
  "release.code.sentTo": "Nous avons envoyé un code à {to}. Il expire à {time}.",
  "release.code.replyHint": "Saisissez-le ici, ou répondez à notre message avec le code seul.",
  "release.code.label": "Code",
  "release.code.submit": "Libérer",
  "release.code.wrong": {
    one: "Ce code n'est pas le bon. Il reste {count} essai.",
    other: "Ce code n'est pas le bon. Il reste {count} essais.",
  },
  "release.code.failed": "Trop de codes erronés. Demandez-en un nouveau.",
  "release.code.expired": "Ce code a expiré. Demandez-en un nouveau.",
  "release.code.released": "Libéré. L'agent continue.",
  "release.code.closed": "L'agent n'attend plus ce code.",
  "release.code.notMine": "Seule la personne à qui nous avons envoyé le code peut le saisir.",
  "release.code.resend": {
    one: "Envoyer un nouveau code ({count} restant)",
    other: "Envoyer un nouveau code ({count} restants)",
  },
  "release.code.sent": "Nous avons envoyé un nouveau code.",

  // ── Directory (plan §1.27) ──
  "directory.title": "Annuaire",
  "directory.subtitle":
    "Les personnes et organisations avec lesquelles vos agents travaillent. Tous vos agents partagent cet annuaire.",
  "directory.readOnly":
    "Votre administrateur tient l'annuaire. Vous pouvez y chercher des personnes.",
  "directory.tab.people": "Personnes",
  "directory.tab.organizations": "Organisations",
  "directory.tab.import": "Importer",
  "directory.tab.suggestions": "Suggestions",
  "directory.search": "Rechercher",
  "directory.searchPlaceholder": "Nom, e-mail, téléphone, organisation ou rôle",
  "directory.filter.relationship": "Relation",
  "directory.filter.kind": "Type d'organisation",
  "directory.filter.any": "Tous",
  "directory.relationship.employee": "Salarié",
  "directory.relationship.contractor": "Prestataire",
  "directory.relationship.customer": "Client",
  "directory.relationship.vendor": "Fournisseur",
  "directory.relationship.partner": "Partenaire",
  "directory.relationship.other": "Autre",
  "directory.kind.vendor": "Fournisseur",
  "directory.kind.customer": "Client",
  "directory.kind.partner": "Partenaire",
  "directory.kind.own": "Votre entreprise",
  "directory.kind.other": "Autre",
  "directory.source.csv": "D'un CSV",
  "directory.source.agent": "Suggéré par un agent",
  "directory.source.zoho_crm": "De Zoho CRM",
  "directory.source.podio": "De Podio",
  "directory.field.name": "Nom",
  "directory.field.email": "E-mail",
  "directory.field.phone": "Téléphone",
  "directory.field.whatsapp": "Numéro WhatsApp",
  "directory.field.title": "Fonction",
  "directory.field.relationship": "Relation",
  "directory.field.organization": "Organisation",
  "directory.field.roles": "Rôles",
  "directory.field.language": "Langue",
  "directory.field.notes": "Notes",
  "directory.field.kinds": "Types",
  "directory.field.website": "Site web",
  "directory.field.address": "Adresse",
  "directory.people.empty": "Aucune personne ne correspond. Ajoutez-en une ou importez un fichier.",
  "directory.organizations.empty":
    "Aucune organisation ne correspond. Ajoutez-en une ou importez un fichier.",
  "directory.person.noOrganization": "Aucune organisation",
  "directory.person.notSaid": "Non précisé",
  "directory.person.add": "Ajouter une personne",
  "directory.person.added": "Ajoutée.",
  "directory.person.needsAddress":
    "Indiquez un e-mail ou un téléphone pour que vos agents puissent la joindre.",
  "directory.person.phoneHint": "Au format international, par ex. +15551234567.",
  "directory.person.addressNote":
    "Une nouvelle adresse demande à nouveau son accord : celui de l'ancienne ne suit pas.",
  "directory.edit": "Modifier",
  "directory.save": "Enregistrer",
  "directory.notSaved": "Ce n'est pas enregistré. Réessayez.",
  "directory.org.vendorLinked": "Fiche fournisseur : {name}",
  "directory.org.linkVendor": "Lier à sa fiche fournisseur",
  "directory.org.unlinkVendor": "Délier",
  "directory.org.linkHint":
    "Le rapprochement des factures et l'annuaire partagent alors une seule fiche pour ce fournisseur.",
  "directory.org.add": "Ajouter une organisation",
  "directory.org.added": "Ajoutée.",
  "directory.import.kind": "Ce qu'il contient",
  "directory.import.people": "Personnes",
  "directory.import.organizations": "Organisations",
  "directory.import.note":
    "Vous voyez d'abord ce que ferait chaque ligne. Rien ne change avant que vous appliquiez les lignes choisies.",
  "directory.import.csv": "Un fichier CSV",
  "directory.import.csvHint":
    "Une ligne d'en-têtes, puis une ligne par fiche. Nous lisons des colonnes comme Name, Email, Phone, Company, Title et Relationship.",
  "directory.import.fromTool": "Depuis un outil connecté",
  "directory.import.noTools": "Connectez Zoho CRM ou Podio pour importer depuis eux.",
  "directory.import.tool": "Outil",
  "directory.import.word": "Chercher dans Zoho CRM",
  "directory.import.wordHint": "Un nom ou une entreprise, au moins deux lettres.",
  "directory.import.app": "ID de l'app Podio",
  "directory.import.read": "Lire",
  "directory.import.apply": {
    one: "Appliquer {count} ligne",
    other: "Appliquer {count} lignes",
  },
  "directory.import.counts":
    "{add} à ajouter, {update} à mettre à jour, {same} inchangées, {error} avec des problèmes",
  "directory.import.more": "Il y en avait d'autres. Affinez la recherche pour voir la suite.",
  "directory.import.row": "Ligne",
  "directory.import.what": "Ce qu'elle fait",
  "directory.import.details": "Détails",
  "directory.import.choose": "Appliquer la ligne {row}",
  "directory.import.matches": "Correspond à {name}",
  "directory.import.changesAddress": "Change la façon dont les messages leur parviennent",
  "directory.import.action.add": "Ajoute",
  "directory.import.action.update": "Met à jour",
  "directory.import.action.same": "Aucun changement",
  "directory.import.action.error": "Import impossible",
  "directory.import.result.added": "Ajoutée",
  "directory.import.result.updated": "Mise à jour",
  "directory.import.result.unchanged": "Inchangée",
  "directory.import.result.skipped": "Ignorée",
  "directory.import.result.failed": "Échec",
  "directory.import.done": "Terminé : {added} ajoutées, {updated} mises à jour, {failed} en échec",
  "directory.suggestions.empty": "Aucune suggestion en attente.",
  "directory.suggestions.from": "{agent} suggère",
  "directory.suggestions.anAgent": "Un agent",
  "directory.suggestions.add": "Ajouter {name}",
  "directory.suggestions.update": "Mettre à jour {name}",
  "directory.suggestions.why": "Pourquoi",
  "directory.suggestions.address":
    "Rien ne change avant votre accord. Une nouvelle adresse demande à nouveau son consentement.",
  "directory.suggestions.accept": "Accepter",
  "directory.suggestions.decline": "Refuser",
  "directory.language.uses": "Utilise : {language}",
  "directory.language.fromOrganization": "Utilise : {language} (de {organization})",
  "directory.language.fromClient": "Utilise : {language} (votre langue par défaut)",
  "directory.language.fromDefault": "Utilise : {language} (aucune langue indiquée)",
  "directory.language.inherit": "Celle de son organisation, sinon la vôtre",
  "directory.language.yours": "La vôtre",
  "directory.language.personHint": "Les agents lui écrivent dans cette langue.",
  "directory.language.orgHint": "Pour ses personnes qui n'ont pas de langue à elles.",
  "directory.pickFilter": "Chercher dans l'annuaire",
  "directory.org.people": {
    one: "{count} personne",
    other: "{count} personnes",
  },
  // v0.14 W4-E: Google Chat (needs a fluent speaker's review).
  "gchat.section": "Google Chat · espaces",
  "gchat.spacesTitle": "Espaces connectés",
  "gchat.help":
    "Les agents publient uniquement dans ces espaces, et seulement après votre approbation de chaque message. Nous ne pouvons pas lire vos messages.",
  "gchat.noSpaces": "Aucun espace connecté pour l'instant.",
  "gchat.groupChat": "Discussion de groupe",
  "gchat.boundBy": "Connecté {time} par {name}",
  "gchat.boundAt": "Connecté {time}",
  "gchat.codeTitle": "Connecter un espace",
  "gchat.steps":
    "Dans Google Chat, ajoutez Mezonas à l'espace, puis envoyez-y ce message. Le code ne sert qu'une fois.",
  "gchat.codeExpires": "Valable jusqu'à {time}.",
  "gchat.codeWaiting":
    "Un code est valable jusqu'à {time}. Si vous ne l'avez plus, demandez-en un nouveau.",
  "gchat.getCode": "Obtenir un code",
  "gchat.newCode": "Obtenir un nouveau code",
  "gchat.adminAllow":
    "Vous ne trouvez pas Mezonas dans Google Chat ? L'administrateur de Google Workspace doit autoriser l'application.",
  // v0.14 W4-D: Google Sheets (Connections and the picking page). Needs the fluent speaker's review.
  // §1.114: Microsoft Teams and Excel (needs a fluent speaker's review).
  "teams.section": "Microsoft Teams · canaux",
  "teams.channelsTitle": "Canaux connectés",
  "teams.help":
    "Les agents publient seulement dans ces canaux, et seulement après que vous avez approuvé chaque publication. Nous ne pouvons pas lire vos messages.",
  "teams.noChannels": "Aucun canal connecté pour l'instant.",
  "teams.boundBy": "Connecté {time} par {name}",
  "teams.boundAt": "Connecté {time}",
  "teams.codeTitle": "Connecter un canal",
  "teams.steps":
    "Dans Teams, ajoutez l'app Mezonas à l'équipe, puis envoyez ce message dans le canal. Le code ne sert qu'une fois.",
  "teams.codeExpires": "Valable jusqu'à {time}.",
  "teams.codeWaiting":
    "Un code est valable jusqu'à {time}. Si vous ne l'avez pas, demandez-en un nouveau.",
  "teams.getCode": "Obtenir un code",
  "teams.newCode": "Obtenir un nouveau code",
  "teams.adminAllow":
    "Vous ne trouvez pas Mezonas dans Teams ? Votre administrateur Microsoft 365 doit ajouter l'app. Les canaux privés ne peuvent pas être connectés.",
  "excel.section": "Excel · classeurs",
  "excel.help":
    "Les agents utilisent seulement les classeurs que vous ajoutez ici, dans votre propre OneDrive. La connexion Microsoft parle de « vos fichiers », mais nous n'ouvrons rien d'autre.",
  "excel.none": "Aucun classeur ajouté pour l'instant.",
  "excel.remove": "Retirer",
  "excel.otherAccount":
    "Ajouté avec un autre compte Microsoft. Ajoutez-le de nouveau pour l'utiliser.",
  "excel.searchLabel": "Trouver un classeur dans votre OneDrive",
  "excel.searchPlaceholder": "Nom du classeur",
  "excel.search": "Rechercher",
  "excel.noResults":
    "Aucun classeur Excel trouvé. Seuls les fichiers .xlsx de votre propre OneDrive sont listés.",
  "excel.add": "Ajouter",
  "excel.added": "Ajouté",
  "excel.notConnected": "Connectez d'abord Excel, puis ajoutez des classeurs ici.",
  "connections.excel.description":
    "Lire et mettre à jour les classeurs Excel que vous choisissez dans votre OneDrive. Nous n'ouvrons rien d'autre.",
  "connections.onedrive.description":
    "Classer des documents dans un dossier Mezonas de votre OneDrive. Nous ne voyons rien d'autre.",
  "connections.teams.description":
    "Publier des nouvelles dans les canaux Teams que vous connectez. Nous ne pouvons pas lire vos messages.",
  "connections.gsheets.description":
    "Lisez et ajoutez des lignes dans les feuilles Google Sheets que vous choisissez. Nous ne pouvons ouvrir aucune autre feuille.",
  "gsheets.section": "Google Sheets",
  "gsheets.help":
    "Les agents ne peuvent ouvrir que les feuilles que vous choisissez ici. Vous les choisissez dans la fenêtre de Google.",
  "gsheets.none": "Aucune feuille choisie pour l'instant.",
  "gsheets.choose": "Choisir des feuilles",
  "gsheets.remove": "Retirer",
  "gsheets.otherAccount":
    "Choisie avec un autre compte Google. Choisissez-la à nouveau pour l'utiliser.",
  "gsheets.notSetUp":
    "Le choix des feuilles n'est pas encore disponible ici. Nous vous préviendrons dès qu'il le sera.",
  "gsheets.pick.title": "Choisir des feuilles Google Sheets",
  "gsheets.pick.subtitle":
    "Google ouvre une fenêtre où vous choisissez les feuilles que les agents peuvent utiliser. Nous ne voyons que celles-là.",
  "gsheets.pick.open": "Ouvrir le sélecteur de Google",
  "gsheets.pick.loading": "Chargement du sélecteur de Google…",
  "gsheets.pick.saving": "Enregistrement de votre choix…",
  "gsheets.pick.cancelled":
    "Aucune feuille choisie. Ouvrez à nouveau le sélecteur, ou revenez en arrière.",
  "gsheets.pick.failed":
    "Le sélecteur de Google ne s'est pas ouvert. Vérifiez que les fenêtres pop-up sont autorisées, puis réessayez.",
  // v0.14 W4-A: WhatsApp through Meta (needs a fluent speaker's review).
  "connections.whatsappMeta.description":
    "Connectez votre propre numéro WhatsApp Business via Meta. Les agents écrivent à vos contacts depuis ce numéro, et nous gardons ce qu'ils vous envoient.",
  "connections.whatsappMeta.connect": "Connecter WhatsApp (votre propre numéro)",
  "whatsappMeta.signup.title": "Connectez votre numéro WhatsApp",
  "whatsappMeta.signup.subtitle":
    "Meta ouvre une fenêtre où vous choisissez votre compte WhatsApp Business et votre numéro. Nous ne voyons jamais vos identifiants Facebook.",
  "whatsappMeta.signup.open": "Ouvrir la fenêtre de Meta",
  "whatsappMeta.signup.loading": "Chargement de la fenêtre de Meta…",
  "whatsappMeta.signup.saving": "Connexion de votre numéro…",
  "whatsappMeta.signup.cancelled":
    "Rien n'a été connecté. Ouvrez à nouveau la fenêtre de Meta, ou revenez en arrière.",
  "whatsappMeta.signup.failed":
    "La fenêtre de Meta ne s'est pas ouverte. Vérifiez que les fenêtres pop-up sont autorisées, puis réessayez.",
  "whatsappMeta.signup.notSetUp":
    "La connexion de votre propre numéro WhatsApp n'est pas encore disponible ici. Nous vous préviendrons dès qu'elle le sera.",
  // ── UI-1c: Accounts and vault, People ──
  "accounts.stat.connected": "Connectés",
  "accounts.stat.allWorking": "Tout fonctionne",
  "accounts.stat.stopped": {
    one: "{count} ne fonctionne plus",
    other: "{count} ne fonctionnent plus",
  },
  "accounts.stat.logins": "Identifiants dans votre coffre",
  "accounts.stat.loginsOk": "Protégés par la clé de votre entreprise",
  "accounts.stat.loginsNeed": {
    one: "{count} a besoin d'un identifiant",
    other: "{count} ont besoin d'un identifiant",
  },
  "accounts.stat.waiting": "En attente de vous",
  "accounts.stat.fixBelow": "À régler ci-dessous",
  "accounts.stat.nothingWaits": "Rien ne vous attend",
  "accounts.vault.title": "Votre coffre",
  "accounts.vault.subtitle": "Identifiants de sites web et clés qu'utilisent vos agents",
  "accounts.vault.note":
    "Protégé par la clé propre à votre entreprise. Les agents utilisent un identifiant pour une étape à la fois. Personne chez Mezonas ne peut le lire.",
  "accounts.vault.add": "Ajouter un identifiant",
  "accounts.vault.closeAdd": "Terminé",
  "accounts.vault.noOffers":
    "Aucun identifiant de site web ne vous est encore proposé. Demandez à votre interlocuteur Mezonas.",
  "accounts.vault.empty": "Pas encore d'identifiants dans votre coffre.",
  "accounts.vault.needsYou": "Vous attend",
  "accounts.vault.needsLogin": "Identifiant requis",
  "accounts.vault.working": "Fonctionne",
  "accounts.vault.notInUse": "Inutilisé",
  "accounts.vault.agentLogin": "Identifiant de l'agent · {email}",
  "accounts.vault.details": "Détails",
  "accounts.vault.hideDetails": "Masquer les détails",
  "peoplePage.title": "Personnes",
  "peoplePage.subtitle":
    "Toutes les personnes que vos agents peuvent contacter, ce qu'elles sont pour vous et comment elles préfèrent être jointes.",
  "peoplePage.add": "Ajouter une personne",
  "peoplePage.import": "Importer des personnes",
  "peoplePage.adminOnly": "Votre administrateur gère cette partie de Personnes.",
  "peoplePage.tab.people": "Personnes",
  "peoplePage.tab.organizations": "Organisations",
  "peoplePage.tab.consent": "Consentement et messages",
  "peoplePage.tab.reach": "Qui les agents contactent",
  "peoplePage.tab.voice": "Exemples de style",
  "peoplePage.tab.import": "Import et suggestions",
  "peoplePage.channel.email": "E-mail",
  "peoplePage.channel.sms": "SMS",
  "peoplePage.channel.whatsapp": "WhatsApp",
  "peoplePage.channel.voice": "Appels",
  "peoplePage.filter.all": "Toutes · {count}",
  "peoplePage.filter.employee": "Employés",
  "peoplePage.filter.contractor": "Sous-traitants",
  "peoplePage.filter.customer": "Clients",
  "peoplePage.filter.vendor": "Fournisseurs",
  "peoplePage.filter.partner": "Partenaires",
  "peoplePage.filter.other": "Autres",
  "peoplePage.level.auto": "En autonomie", // fluent review
  "peoplePage.level.approval": "Avec approbation", // fluent review
  "peoplePage.level.off": "Désactivé",
  "peoplePage.level.unset": "Pas de limite en plus",
  "peoplePage.search": "Rechercher des personnes",
  "peoplePage.col.person": "Personne",
  "peoplePage.col.who": "Qui c'est",
  "peoplePage.col.reach": "Joignable par",
  "peoplePage.col.agents": "Agents en contact",
  "peoplePage.col.about": "À savoir",
  "peoplePage.empty": "Personne pour l'instant.",
  "peoplePage.noMatch": "Personne ne correspond.",
  "peoplePage.selectPerson": "Sélectionner {name}",
  "peoplePage.selectShown": "Sélectionner toutes les personnes affichées",
  "peoplePage.selectQuickBooks": "Sélectionner toutes les personnes de QuickBooks",
  "peoplePage.selected": "{count} sélectionnés",
  "peoplePage.clearSelection": "Effacer",
  "peoplePage.bulkBusiness": "Ces numéros nous ont été donnés pour nos échanges",
  "peoplePage.bulkDone": "Enregistré pour {count}.",
  "peoplePage.bulkSkipped": "{count} laissés de côté : désinscrits, ou sans téléphone ni e-mail.",
  "peoplePage.reachNone": "Pas encore de moyen de la joindre",
  "peoplePage.cannot.optedOut": "Désinscrit",
  "peoplePage.cannot.noConsent": "Pas encore de consentement",
  "peoplePage.addTitle": "Ajouter une personne",
  "peoplePage.pick": "Choisissez quelqu'un pour voir ses détails.",
  "peoplePage.know": "Ce que les agents doivent savoir",
  "peoplePage.knowNone": "Rien pour l'instant.",
  "peoplePage.howReach": "Comment les agents peuvent la joindre",
  "peoplePage.noAgents": "Aucun agent n'est en contact avec elle.",
  "peoplePage.recent": "Messages récents",
  "peoplePage.recentNone": "Pas encore de messages.",
  "peoplePage.fromThem": "De sa part · {channel}",
  "peoplePage.toThem": "À son intention · {channel}",
  "peoplePage.levelNote":
    "Vous pouvez rendre un canal plus strict : avec approbation, ou désactivé. Seuls nous pouvons l'assouplir.", // fluent review
  "peoplePage.tighten": "Rendre plus strict",
  "peoplePage.voice.title": "Exemples de style",
  "peoplePage.voice.subtitle":
    "Comment écrivent vos équipes. Nos agents en suivent le ton, jamais comme des instructions.",
  "peoplePage.voice.add": "Ajouter un exemple",
  "peoplePage.voice.empty": "Pas encore d'exemples de style.",
  "peoplePage.voice.byline": "{person} · mis à jour {time}",
  "peoplePage.voice.archive": "Archiver",
  "peoplePage.voice.person": "De qui est le style",
  "peoplePage.voice.you": "Vous",
  "peoplePage.voice.channel": "Canal",
  "peoplePage.voice.sampleTitle": "Titre",
  "peoplePage.voice.text": "Ses mots",
  "peoplePage.voice.textHint":
    "Collez un e-mail ou un message écrit par cette personne. Les réponses citées sont retirées.",
  // UI-1d: Runs, a run's page, the Weekly Table, Settings and Sloan (docs/ui-plan.md C6–C10).
  "nav.weekly": "Table de la semaine",
  "nav.sloan": "Sloan",
  "nav.sloanLine": "Votre agent de compte. Posez-lui vos questions.",
  "shell.askSloan": "Demander à Sloan, votre agent de compte : {q}", // fluent review
  "runsPage.subtitle":
    "Chaque fois qu'un agent a travaillé pour vous : quand il a commencé, chaque étape, ce qui a changé et qui a approuvé.",
  "runsPage.tab.all": "Toutes",
  "runsPage.tab.going": "En cours",
  "runsPage.tab.waiting": "Vous attendent",
  "runsPage.tab.done": "Terminées",
  "runsPage.tab.notFinished": "Non terminées",
  "runsPage.status.failed": "Non terminée",
  "runsPage.startedBy.schedule": "Planning",
  "runsPage.startedBy.event": "Un événement",
  "runsPage.startedBy.webhook": "Un autre système",
  "runsPage.startedBy.manual": "Mezonas",
  "runsPage.startedBy.message": "Un message",
  "runsPage.startedBy.handoff": "Un autre agent",
  "runsPage.startedBy.person": "Quelqu'un de votre équipe",
  "runsPage.chip.agents": "agent",
  "runsPage.chip.statuses": "statut",
  "runsPage.chip.startedBy": "lancée par",
  "runsPage.chip.changedConnector": "modifié",
  "runsPage.chip.since": "depuis",
  "runsPage.chip.until": "jusqu'au",
  "runsPage.chip.attemptsOver": "essais au-delà de",
  "runsPage.chip.amount": "montant",
  "runsPage.chip.text": "mots",
  "runsPage.chip.about": "sur",
  "runsPage.about.remove": "Retirer {name} du filtre",
  "runsPage.about.record": "un enregistrement",
  "runsPage.ask.label": "Posez une question sur vos exécutions, avec vos mots",
  "runsPage.ask.placeholder": "Avec vos mots : « factures de plus de 5 000 $ ce mois-ci »",
  "runsPage.ask.send": "Demander",
  "runsPage.ask.asking": "Recherche…",
  "runsPage.ask.clear": "Effacer",
  "runsPage.ask.unclear":
    "Nous n'avons pas pu en faire un filtre. Essayez de nommer un agent, un statut ou une date.",
  "runsPage.ask.leftOut": "Pas dans ce filtre : {parts}",
  "runsPage.filter.agent": "Agent",
  "runsPage.filter.anyAgent": "Agent : tous",
  "runsPage.filter.startedBy": "Lancée par",
  "runsPage.filter.anyStart": "Lancée par : tous",
  "runsPage.noMatch": "Aucune exécution ne correspond.",
  "runsPage.col.run": "Exécution",
  "runsPage.col.agent": "Agent",
  "runsPage.perDay": "Exécutions par jour",
  "runDetail.run": "exécution {id}",
  "runDetail.copyLink": "Copier le lien",
  // Hand off (2026-11-11)
  "runDetail.handedOffFrom": "Transmis par {agent} (exécution {id})",
  "runDetail.startedAtStep": "commencé à l'étape {step}",
  "runDetail.openRun": "Ouvrir l'exécution {id}",
  "runDetail.review": "Vérifier et approuver",
  "runDetail.about": "À propos de cette exécution",
  "runDetail.changes": "Modifications",
  "runDetail.changesLine": "{made} faites sur {count}",
  "runDetail.waiting": "Vous attend",
  "runDetail.waitingCount": { one: "{count} élément", other: "{count} éléments" },
  "runDetail.nothingWaiting": "Rien",
  "runDetail.otherRuns": "Autres exécutions de {name}",
  "runDetail.allRuns": "Toutes",
  "runDetail.noOther": "Pas encore d'autres exécutions.",
  "runDetail.waitingChanges": "Modifications en attente de votre approbation",
  "runDetail.askSloan.prompt": "Quelque chose cloche dans cette exécution ?",
  "runDetail.askSloan": "Demander à Sloan",
  "runDetail.askSloan.text": "À propos de l'exécution {id} : ",
  "runDetail.audit": "Journal d'audit",
  "runDetail.audit.meta": "Qui a vu ou fait quoi, dans l'ordre",
  "runDetail.audit.empty": "Personne n'a encore ouvert cette exécution.",
  "runDetail.audit.times": { one: "une fois", other: "{count} fois" },
  "runDetail.audit.opened_run": "a ouvert cette exécution",
  "runDetail.audit.item_edit": "a modifié un changement avant de l'approuver",
  "runDetail.audit.item_snooze": "a remis un élément à plus tard",
  "runDetail.audit.item_undo": "a retiré une approbation",
  "runDetail.audit.signed": "a approuvé",
  "runDetail.audit.declined": "a refusé",
  "runDetail.audit.answered": "a répondu à une question",
  "weekly.title": "La Table de la semaine",
  "weekly.subtitle": "Votre semaine, par votre interlocuteur Mezonas, chaque lundi.",
  "weekly.none":
    "Votre première Table de la semaine arrive un lundi matin, quand vos agents ont une semaine de travail.",
  "weekly.weekOf": "Semaine du {date}",
  "weekly.fromLead": "De {name}, votre interlocuteur Mezonas.",
  "weekly.sent": "Envoyée {time}.",
  "weekly.earlier": "Semaines précédentes",
  "weekly.pdf": "Télécharger le PDF",
  "weekly.stat.runs": "Exécutions terminées",
  "weekly.stat.same": "Comme la semaine dernière",
  "weekly.stat.up": "{n} de plus que la semaine dernière",
  "weekly.stat.down": "{n} de moins que la semaine dernière",
  "weekly.stat.changes": "Modifications dans vos outils",
  "weekly.stat.changesNote": "{signed} approuvées par vous, {automatic} seules",
  "weekly.stat.signatures": "Approbations",
  "weekly.stat.documents": "Documents lus",
  "weekly.decisions": "Décisions pour vous",
  "weekly.reply": "Répondre",
  "weekly.replyPlaceholder": "Votre réponse va à votre interlocuteur",
  "weekly.replied": "Répondu par {name}, {time}",
  "weekly.setup": "Configuration",
  "weekly.connect": "Connecter",
  "weekly.connectTool": "Connecter {tool}",
  "weekly.connectWhy": "{agent} peut commencer dès qu'il accède à {tool}.",
  "weekly.team": "Ce que l'équipe a fait",
  "weekly.agentRuns": {
    one: "{name} a terminé {count} exécution",
    other: "{name} a terminé {count} exécutions",
  },
  "weekly.details": "Détails",
  "weekly.nextWeek": "La semaine prochaine",
  "settingsPage.subtitle":
    "Votre entreprise, qui approuve, comment vous payez et comment nous vous joignons.",
  "settingsPage.subtitleMember":
    "Comment nous vous joignons, la langue dans laquelle vous lisez et qui approuve quoi.", // fluent review
  "settingsPage.billing": "Facturation",
  "settingsPage.team": "Équipe",
  "settingsPage.notifications": "Notifications",
  "settingsPage.language": "Langue",
  "settingsPage.languageBody": "Chaque choix est enregistré aussitôt.",
  "settingsPage.plan": "Ce mois-ci",
  "settingsPage.statements": "Relevés et consommation",
  "settingsPage.creditsThisMonth": "Crédits ce mois-ci",
  "settingsPage.creditsUsed": "{used} utilisés sur {included} inclus à ce jour",
  "settingsPage.creditsIncludedHelp":
    "Chaque agent ajoute ses crédits inclus jour après jour : le nombre de crédits inclus augmente au fil du mois.",
  "settingsPage.creditsOut": "Si les crédits sont épuisés",
  "settingsPage.creditsOut.continue": "Continuer et ajouter des crédits",
  "settingsPage.creditsOut.continueHelp":
    "Les crédits au-delà des crédits inclus figurent sur votre prochaine facture. Nous vous écrivons chaque fois que {block} crédits supplémentaires de plus sont utilisés.",
  "settingsPage.creditsOut.pause": "Mettre les agents en pause jusqu'au mois prochain",
  "settingsPage.creditsOut.pauseHelp":
    "Les agents s'arrêtent quand les crédits du mois sont utilisés. Sloan reste actif.",
  "settingsPage.creditsOut.paused": "En pause faute de crédits : {names}",
  "settingsPage.mine": "Vos notifications",
  "settingsPage.mine.email": "E-mails",
  "settingsPage.mine.emailHelp":
    "Éléments qui vous attendent, la Table de la semaine et les reconnexions.",
  "settingsPage.mine.sms": "SMS",
  "settingsPage.mine.smsHelp": "Depuis le numéro de votre entreprise.",
  "settingsPage.mine.cantText":
    "Nous pourrons vous écrire par SMS quand votre téléphone sera dans Personnes, avec votre accord.",
  "settingsPage.teamEmails": "E-mails à votre équipe",
  "sloan.title": "Sloan",
  "sloan.subtitle":
    "Gère vos agents et votre compte. Vos administrateurs et votre interlocuteur Mezonas peuvent lire cette conversation.",
  "sloan.past": "Conversations précédentes",
  "sloan.pastItem": "Commencée le {date}",
  "sloan.new": "Nouvelle",
  "sloan.openPage": "Ouvrir la page complète",
  "sloan.empty":
    "Demandez pourquoi quelque chose attend, mettez un agent en pause, ajoutez un approbateur ou transmettez une idée à votre interlocuteur.",
  "sloan.answering": "Sloan répond…",
  "sloan.compose": "Demandez à Sloan, ou dites-lui quoi changer",
  "sloan.commandHint":
    "Commencez par / et le nom d'un agent pour lui poser la question, comme /pia.",
  "sloan.you": "Vous",
  "sloan.mezonas": "Mezonas",
  "sloan.changes": "Vous attend : modifications de votre compte",
  "sloan.adminSigns": "Votre administrateur approuve les modifications de votre compte.",
  "sloan.reach.title": "Écrire à Sloan par e-mail ou SMS",
  "sloan.reach.email": "E-mail",
  "sloan.reach.text": "SMS",
  "sloan.reach.note":
    "Les réponses reviennent par le même moyen et s'affichent aussi ici. Les SMS parviennent à Sloan depuis le numéro avec lequel vous avez accepté les SMS.",
  "sloan.canTitle": "Sloan peut",
  "sloan.can.see": "Voir le travail, les exécutions et les justificatifs de chaque agent",
  "sloan.can.pause": "Mettre en pause ou relancer un agent, tout de suite",
  "sloan.can.draft":
    "Préparer des modifications de personnes et d'approbateurs, que vous approuvez",
  "sloan.can.pass": "Transmettre demandes et idées de nouveaux agents à votre interlocuteur",
  "sloan.can.never": "N'assouplit jamais une règle et ne voit pas votre coffre",
  "sloan.team": "Votre équipe en ce moment",
  "sloan.leadNote": "Sloan s'occupe des choses rapides. Pour le reste, {name} est là.",
  "sloan.starter.today": "Qu'ont fait mes agents aujourd'hui ?",
  "sloan.starter.waiting": "Qu'est-ce qui m'attend, et pourquoi ?",
  "sloan.starter.newAgent": "J'ai une idée de nouvel agent.",

  // ── UI-3a : enregistrements, envoi, équipe, exports ──
  "records.lastSync": "Dernière synchronisation {time}.",
  "records.fromAccount": "De {account}",
  "records.found": { one: "{count} enregistrement", other: "{count} enregistrements" },
  "records.kind.receivables": "Créances",
  "records.col.customer": "Client",
  "records.col.due": "Échéance",
  "records.col.owed": "Reste dû",
  "records.col.status": "Statut",
  "records.overdue": "En retard",
  "records.receivable.open": "Ouverte",
  "records.receivable.paid": "Payée",
  "records.receivable.void": "Annulée",
  "records.receivable.deleted": "Supprimée dans l'outil",
  "uploadPage.title": "Envoyer des documents",
  "uploadPage.subtitle":
    "Factures, reçus ou un CSV d'achats. Déposez-les ici ou transférez-les par e-mail, et vos agents lisent chacun d'eux.",
  "uploadPage.records": "Voir les enregistrements",
  "uploadPage.documents": "Documents",
  "teamPage.title": "Équipe",
  "teamPage.subtitle":
    "Qui utilise votre portail et ce que chaque personne approuve. Invitez ici des personnes de votre entreprise.",
  "teamPage.subtitleMember": "Qui utilise votre portail et ce que chaque personne approuve.",
  "teamPage.people": "Personnes",
  "teamPage.invite": "Inviter quelqu'un",
  "teamPage.viewer": "N'approuve rien. Peut tout lire.",
  "exports.title": "Exports",
  "exports.subtitle":
    "Des fichiers pour votre comptable et vos propres dossiers. Chacun couvre des jours entiers, jusqu'à un an.",
  "exports.adminOnly": "Seul votre administrateur peut télécharger les exports.",
  "exports.accountant": "Pour votre comptable",
  "exports.accountantHelp":
    "Chaque modification faite par vos agents dans vos outils sur la période : qui l'a approuvée, son exécution et ses documents.",
  "exports.from": "Du",
  "exports.to": "Au",
  "exports.format": "Format",
  "exports.format.zip": "ZIP avec les documents",
  "exports.format.zipHelp": "Les modifications en tableur, avec chaque facture et reçu derrière.",
  "exports.format.csv": "Modifications seules (CSV)",
  "exports.format.csvHelp": "Un tableur des modifications, sans les fichiers.",
  "exports.download": "Télécharger",
  "exports.audit": "Journal d'audit",
  "exports.auditHelp":
    "Qui a ouvert, approuvé ou modifié quoi, et quand. Vos équipes par leur nom ; les nôtres comme Mezonas, sauf votre interlocuteur.",
  "exports.downloadCsv": "Télécharger le CSV",
  "exports.problem.missing": "Choisissez les deux jours.",
  "exports.problem.order": "Le premier jour doit précéder le dernier.",
  "exports.problem.long": "Une période compte au plus {days} jours.",
  "settingsPage.teamLink": "Équipe",
  "settingsPage.exportsLink": "Exports",
  "settingsPage.exportsLinkHelp": "L'export pour votre comptable et votre journal d'audit.",
  "knowledge.adminOnly":
    "Seul votre administrateur peut voir et modifier ce que les agents savent de votre entreprise.",
  "sloan.requests": "Vos demandes",
  "sloan.mode.change": "Demander un changement",
  "signin.needAccess":
    "Besoin d'un accès ? Demandez à votre administrateur ou à votre interlocuteur Mezonas.",
  "nav.upload": "Envoyer",
  // UI cleanup (run pages and changes): new strings, and the runDetail approval words above
  // (approve, not sign). Needs a fluent speaker's review.
  "run.subject.invoice": "Facture {number}",
  "runDetail.waitingSince": "Vous attend depuis {time}",
  "runDetail.waitingItems": {
    one: "{count} élément attend votre approbation.",
    other: "{count} éléments attendent votre approbation.",
  },
  "change.linesUnchanged": { one: "{count} ligne inchangée", other: "{count} lignes inchangées" },

  // UI cleanup, stream E: the portal's new structure (Home, Inbox, Contacts, the agent page's
  // tabs, Settings sections). Needs a fluent speaker's review, as do the lines marked above.
  "nav.home": "Accueil",
  "nav.inbox": "Boîte de réception",
  "home.addDocuments": "Ajouter des documents",
  "home.owner.rename": "Renommer",
  "home.owner.renameLabel": "Nouveau nom pour {name}",
  "home.owner.save": "Enregistrer",
  "stepPanel.tell": "Dites-nous ce qui n'allait pas",
  "stepPanel.tellPrompt": "À propos de « {step} » dans cette exécution : ",
  "home.owners": "Qui s'occupe de quoi",
  "home.owner.health.working": "Au travail",
  "home.owner.health.needs_you": "A besoin de vous",
  "home.owner.health.paused": "En pause",
  "home.owner.week": "Exécutions cette semaine : {runs}. Corrigées et relancées : {corrected}.",
  "home.owner.ask": "Demander à {name}",
  "home.ideas": "Idées pour vous",
  "home.ideas.ask": "Nous en parler",
  "home.ideas.prompt": "Dites-m'en plus sur {title}.",
  "home.quick": "Actions rapides",
  "home.quick.upload": "Importer une liste",
  "home.quick.feedback": "Nous envoyer un avis",
  "home.quick.feedbackPrompt": "J'ai un avis pour Mezonas : ",
  "sloanPanel.new": "Nouvelle conversation",
  "sloanPanel.full": "Tout l'historique",
  "home.agents": "Vos agents",
  "home.needsYou": "Vous attend",
  "home.openInbox": "Ouvrir votre boîte de réception",
  "home.moreInInbox": {
    one: "{count} de plus dans votre boîte de réception",
    other: "{count} de plus dans votre boîte de réception",
  },
  "home.card.now": "En cours : {step}",
  "home.card.lastRun": "Dernière exécution {time}",
  "home.card.waitingSince": "Vous attend depuis {time}",
  "home.weekly.title": "Votre résumé de la semaine",
  "home.weekly.open": "Lire le résumé",
  "home.weekly.ready": "Votre interlocuteur a envoyé le résumé de la semaine.",
  "agent.tab.overview": "Vue d'ensemble",
  "agent.tab.runs": "Exécutions",
  "agent.tab.report": "Rapport",
  "agent.tab.settings": "Réglages de l’agent",
  // B3: the agent manual (docs/builder-plan.md §5)
  "agent.tab.manual": "Manuel", // fluent review
  // docs/sop-plan.md S1: the agent's SOP tab.
  "agent.tab.sop": "SOP", // fluent review
  "sop.title": "{agent} : procédure opérationnelle standard", // fluent review
  "sop.subtitle":
    "Établie à partir de la configuration actuelle de {agent}. Elle change quand la configuration change.", // fluent review
  "sop.asOf": "Au {date}", // fluent review
  "sop.contents": "Sommaire", // fluent review
  "sop.revision": "Révision", // fluent review
  "sop.revisionDate": "Date de révision", // fluent review
  "sop.previous": "Révision précédente", // fluent review
  "sop.notRecorded": "Pas encore enregistrée", // fluent review
  "sop.stage": "Étape", // fluent review
  "sop.area": "Domaine", // fluent review
  "sop.accountable": "Responsable", // fluent review
  "sop.areaOwner": "Responsable du domaine", // fluent review
  "sop.lead": "Votre référent Mezonas", // fluent review
  "sop.whatChanged": "Ce qui a changé dans la révision {number}", // fluent review
  "sop.was": "avant {value}", // fluent review
  "sop.allRevisions": "Toutes les révisions", // fluent review
  "sop.find":
    "Chercher dans cette procédure : une étape, une personne, un système, un enregistrement", // fluent review
  "sop.find.count": "{count} endroits correspondent à « {text} ».", // fluent review
  "sop.find.none": "Rien ne correspond à « {text} ».", // fluent review
  "sop.filter.party": "Étapes auxquelles {name} participe.", // fluent review
  "sop.filter.system": "Étapes qui utilisent {name}.", // fluent review
  "sop.showAll": "Tout afficher", // fluent review
  "sop.ask": "Poser une question sur cette procédure", // fluent review
  "sop.askLine": "Procédure de {agent}", // fluent review
  "sop.askText": "À propos de la procédure de {agent} : « {line} » ", // fluent review
  "sop.print": "Imprimer ou enregistrer en PDF", // fluent review
  "sop.printFooter": "{code} · {agent} · Révision {number} du {date}", // fluent review
  "sop.sec.control": "Maîtrise du document", // fluent review
  "sop.sec.purpose": "Objet", // fluent review
  "sop.sec.scope": "Périmètre", // fluent review
  "sop.sec.roles": "Rôles", // fluent review
  "sop.sec.start": "Comment il démarre", // fluent review
  "sop.sec.procedure": "Procédure", // fluent review
  "sop.sec.controls": "Contrôles", // fluent review
  "sop.sec.systems": "Systèmes", // fluent review
  "sop.sec.data": "Données", // fluent review
  "sop.sec.exceptions": "Exceptions", // fluent review
  "sop.sec.decisions": "Décisions et réglages", // fluent review
  "sop.sec.measures": "Indicateurs", // fluent review
  "sop.sec.references": "Références", // fluent review
  "sop.sec.history": "Historique des révisions", // fluent review
  "assurance.sec": "Architecture et sécurité", // fluent review
  "assurance.lede":
    "D'où vient le travail de {agent}, ce qui l'exécute, quel fournisseur d'IA voit quoi, lesquels de vos systèmes il atteint et comment, et où vos données sont conservées. Ses contrôles de sécurité s'exécutent chaque nuit.", // fluent review
  "assurance.diagramLabel":
    "{agent} : d'où vient son travail, ce qui l'exécute, quel fournisseur d'IA voit quoi et où les données sont conservées", // fluent review
  "assurance.diagramKey":
    "Les cadres en pointillés sont des limites de confiance. C1, C3… sont les contrôles de la section 6 ; DAT-3 et les autres sont les contrôles de sécurité de Mezonas (mezonas.com/security).", // fluent review
  "assurance.result.verified": "Vérifié", // fluent review
  "assurance.result.in_review": "En examen", // fluent review
  "assurance.result.not_checked": "Pas encore vérifié", // fluent review
  "assurance.result.not_applicable": "Sans objet", // fluent review
  "assurance.resultWhat.verified": "Le contrôle s'est exécuté et a trouvé ce qu'il devait trouver.", // fluent review
  "assurance.resultWhat.in_review":
    "Le contrôle a trouvé quelque chose que nous examinons. Il indique depuis quand ; vous n'avez rien à faire sauf si nous vous le demandons.", // fluent review
  "assurance.resultWhat.not_checked":
    "Un nouvel agent ou une nouvelle version, avant sa première nuit.", // fluent review
  "assurance.resultWhat.not_applicable": "Il ne s'applique pas à cet agent, et dit pourquoi.", // fluent review
  "assurance.stat.checks": "Contrôles", // fluent review
  "assurance.stat.lastChecked": "Dernier contrôle", // fluent review
  "assurance.stat.never": "Pas encore", // fluent review
  "assurance.col.check": "Contrôle", // fluent review
  "assurance.col.how": "Comment", // fluent review
  "assurance.col.result": "Résultat", // fluent review
  "assurance.col.found": "Ce qu'il a trouvé", // fluent review
  "assurance.col.evidence": "Preuve", // fluent review
  "assurance.col.checked": "Contrôlé", // fluent review
  "assurance.kind.setup": "Configuration", // fluent review
  "assurance.kind.runs": "Exécutions", // fluent review
  "assurance.kind.attack": "Attaque", // fluent review
  "assurance.inReviewSince":
    "En examen depuis le {date}. Nous l'examinons ; vous n'avez rien à faire sauf si nous vous le demandons.", // fluent review
  "assurance.openIssue": "Ouvrir le ticket", // fluent review
  "assurance.soc2Note":
    "Les références SOC 2 nomment les Trust Services Criteria auxquels répond chaque contrôle, selon notre propre correspondance. Elles ne signifient pas que nous sommes certifiés : un auditeur confirme la correspondance, et nous n'avons pas encore de rapport SOC 2.", // fluent review
  "assurance.coverage.title": "Chaque contrôle, pris en compte", // fluent review
  "assurance.coverage.lede":
    "Chaque contrôle de sécurité de Mezonas qui touche au travail de cet agent, dans l'un des trois états.", // fluent review
  "assurance.state.checked": "Contrôlé pour cet agent", // fluent review
  "assurance.state.inherited": "Hérité de la plateforme", // fluent review
  "assurance.state.not_applicable": "Sans objet", // fluent review
  "assurance.status.in_place": "En place", // fluent review
  "assurance.status.partial": "En partie en place", // fluent review
  "assurance.status.planned": "Prévu", // fluent review
  "assurance.data.title": "Données : ce qu'il récupère, ce qu'il conserve, et où", // fluent review
  "assurance.data.lede":
    "Au repos, tout est chiffré (AES-256) ; en transit, TLS 1.2 ou plus récent.", // fluent review
  "assurance.col.data": "Données", // fluent review
  "assurance.col.from": "Récupéré depuis", // fluent review
  "assurance.col.keptWhere": "Conservé où", // fluent review
  "assurance.col.keptFor": "Conservé pendant", // fluent review
  "assurance.col.whoSees": "Qui peut le voir", // fluent review
  "assurance.ai.title": "Ce qui va à l'IA, et comment c'est protégé", // fluent review
  "assurance.ai.none": "Il n'utilise pas d'IA.", // fluent review
  "assurance.col.use": "Utilisé pour", // fluent review
  "assurance.col.provider": "Fournisseur et modèle", // fluent review
  "assurance.col.sent": "Ce qui est envoyé", // fluent review
  "assurance.col.protection": "Protection", // fluent review
  "assurance.col.providerKeeps": "Conservé par le fournisseur", // fluent review
  "assurance.access.title": "Accès à chacun de vos outils", // fluent review
  "assurance.col.tool": "Outil", // fluent review
  "assurance.col.signsIn": "Se connecte par", // fluent review
  "assurance.col.credential": "L'identifiant", // fluent review
  "assurance.col.agentMay": "L'agent peut", // fluent review
  "assurance.col.whoChanges": "Qui peut le modifier", // fluent review
  "sop.noPurpose": "Pas encore rédigé.", // fluent review
  "sop.covers": "Démarre quand", // fluent review
  "sop.notCovered": "Non couvert", // fluent review
  "sop.never": "Jamais", // fluent review
  "sop.nothingLeftOut": "Rien à notre connaissance.", // fluent review
  "sop.roles.lede": "Qui fait quoi. Cliquez sur un nom pour ne voir que ses étapes.", // fluent review
  "sop.whoElse": "Qui d'autre participe, par étape", // fluent review
  "sop.whoElse.hint": "{agent} fait tout le reste", // fluent review
  "sop.cell.does": "Fait", // fluent review
  "sop.cell.approves": "Approuve", // fluent review
  "sop.cell.checks": "Vérifie", // fluent review
  "sop.cell.told": "Informé", // fluent review
  "sop.col.step": "Étape", // fluent review
  "sop.hours": "Travaille pendant vos heures d'ouverture : {hours}", // fluent review
  "sop.legend.person": "Une personne", // fluent review
  "sop.legend.agent": "Un agent", // fluent review
  "sop.legend.rules": "Règles : la même entrée donne toujours le même résultat", // fluent review
  "sop.legend.ai": "IA : un modèle s'en charge ; le modèle est indiqué", // fluent review
  "sop.summary.lead":
    "{agent} fait chaque étape, sauf si une personne ou un autre agent est indiqué.", // fluent review
  "sop.summary.counts":
    "{steps} étapes : {rules} par règles, {ai} par IA, {mixed} par règles puis IA, {person} par une personne.", // fluent review
  "sop.summary.writes": "Chaque modification de vos outils se fait par règles.", // fluent review
  "sop.summary.owner":
    "{owner} examine les étapes en échec et celles qui mènent à une modification", // fluent review
  "sop.method.rules": "Règles", // fluent review
  "sop.method.rulesThen": "Règles, puis", // fluent review
  "sop.method.ai": "IA", // fluent review
  "sop.level.auto": "Seul", // fluent review
  "sop.level.ask": "Me demander d'abord", // fluent review
  "sop.level.off": "Désactivé", // fluent review
  "sop.level.on": "Activé", // fluent review
  "sop.approves": "Approuve", // fluent review
  "sop.within": "sous {when}", // fluent review
  "sop.ifNoAnswer": "sans réponse : {what}", // fluent review
  "sop.ifRejected": "En cas de refus : {what}", // fluent review
  "sop.onError": "En cas d'échec : {what}", // fluent review
  "sop.told": "Informés", // fluent review
  "sop.controls": "Contrôles", // fluent review
  "sop.path.if": "Si", // fluent review
  "sop.path.otherwise": "Sinon", // fluent review
  "sop.path.straightOn": "on continue", // fluent review
  "sop.controls.lede": "Ce qui garantit ce processus, où cela s'applique et où trouver la preuve.", // fluent review
  "sop.col.control": "Contrôle", // fluent review
  "sop.col.kind": "Type", // fluent review
  "sop.col.how": "Comment", // fluent review
  "sop.col.steps": "Étapes", // fluent review
  "sop.col.owner": "Responsable", // fluent review
  "sop.col.evidence": "Preuve", // fluent review
  "sop.kind.prevents": "Empêche", // fluent review
  "sop.kind.catches": "Détecte", // fluent review
  "sop.how.person": "Par une personne", // fluent review
  "sop.how.automatic": "Automatique", // fluent review
  "sop.how.rules": "Par règles", // fluent review
  "sop.how.ai": "Par IA", // fluent review
  "sop.allSteps": "Toutes", // fluent review
  "sop.systems.lede":
    "Les outils que cet agent utilise et ce qu'il peut y faire : le plus strict entre le réglage de votre connexion et l'accès que nous lui avons donné.", // fluent review
  "sop.noSystems": "Il n'utilise aucun de vos outils.", // fluent review
  "sop.col.system": "Système", // fluent review
  "sop.col.read": "Lecture", // fluent review
  "sop.col.create": "Création", // fluent review
  "sop.col.update": "Modification", // fluent review
  "sop.col.delete": "Suppression", // fluent review
  "sop.connectedBy": "Connecté par {name}", // fluent review
  "sop.notConnected": "Non connecté", // fluent review
  "sop.data.lede":
    "Ce que l'agent lit, enregistre et modifie, où c'est conservé et combien de temps.", // fluent review
  "sop.col.record": "Enregistrement", // fluent review
  "sop.col.livesIn": "Conservé dans", // fluent review
  "sop.col.agentDoes": "L'agent", // fluent review
  "sop.col.readByAi": "Lu par l'IA", // fluent review
  "sop.col.kept": "Conservé", // fluent review
  "sop.no": "Non", // fluent review
  "sop.data.ai":
    "Les modèles d'IA ne lisent les données que dans les étapes marquées IA et ne s'entraînent jamais dessus. Nos fournisseurs sont listés sur mezonas.com/subprocessors.", // fluent review
  "sop.learned": "Ce qu'il a appris pour vous", // fluent review
  "sop.col.decision": "Décision", // fluent review
  "sop.col.setBy": "Défini par", // fluent review
  "sop.onStep": "Étape {step}", // fluent review
  "sop.us": "Nous", // fluent review
  "sop.confirmedWithYou": "Confirmé avec vous", // fluent review
  "sop.noDecisions": "Aucune décision enregistrée.", // fluent review
  "sop.settings": "Ce que vous pouvez ajuster", // fluent review
  "sop.setup": "Ce que nous avons configuré avec vous", // fluent review
  "sop.follows": "Ce qu'il suit", // fluent review
  "sop.handsOverTo": "Passe la main à", // fluent review
  "sop.takesOverFrom": "Prend le relais de", // fluent review
  "sop.knowledge": "Connaissances", // fluent review
  "sop.history.lede":
    "Chaque changement du fonctionnement de {agent}, du plus récent au plus ancien. Une nouvelle révision est créée quand ses étapes, les personnes, les approbations, ce qu'il peut faire dans vos outils ou ses réglages changent.", // fluent review
  "sop.col.revision": "Révision", // fluent review
  "sop.col.date": "Date", // fluent review
  "sop.col.changes": "Ce qui a changé", // fluent review
  "sop.col.by": "Modifié par", // fluent review
  "agent.tab.workflow": "Flux de travail", // fluent review
  "workflow.viewOnly": "Lecture seule", // fluent review
  "workflow.revision": "Révision {number}", // fluent review
  "workflow.hint": "Pointez une étape pour voir ce qu'elle fait ; cliquez pour sa fiche.", // fluent review
  "workflow.which": "Quel flux", // fluent review
  "workflow.askChange": "Demander un changement", // fluent review
  "workflow.changeLine": "Flux de travail de {agent}", // fluent review
  "workflow.empty": "Cet agent n'a pas encore d'étapes.", // fluent review
  "workflow.foot":
    "Vous voyez chaque étape, qui la fait, comment elle décide et ses réglages ; vous ne pouvez pas les modifier ici. Nous modifions les étapes, et chaque changement devient une nouvelle révision du SOP.", // fluent review
  "workflow.noModel": "règles", // fluent review
  "workflow.noModel.title": "Fonctionne par règles, sans IA", // fluent review
  "workflow.rulesThenAi": "D'abord les règles, puis l'IA", // fluent review
  "workflow.kind.read": "Lire", // fluent review
  "workflow.kind.change": "Modifier", // fluent review
  "workflow.kind.person": "Personne", // fluent review
  "workflow.kind.conversation": "Conversation", // fluent review
  "workflow.kind.notify": "Prévenir", // fluent review
  "workflow.kind.wait": "Attendre", // fluent review
  "workflow.kind.stop": "Arrêt", // fluent review
  "workflow.kind.process": "Automatisation", // fluent review
  "workflow.kind.handoff": "Passage de relais", // fluent review
  "workflow.kind.decision": "Décision", // fluent review
  "workflow.kind.forEach": "Pour chaque", // fluent review
  "workflow.kind.repeat": "Répéter", // fluent review
  "workflow.kind.aiSkill": "Compétence IA", // fluent review
  "workflow.kind.rulesSkill": "Compétence par règles", // fluent review
  "workflow.aPerson": "Une personne", // fluent review
  "workflow.card.doneBy": "Fait par", // fluent review
  "workflow.card.deadline": "Pour quand", // fluent review
  "workflow.card.ifRejected": "Si refusé", // fluent review
  "workflow.card.ifFails": "En cas d'échec", // fluent review
  "workflow.card.inSop": "Étape {step} dans le SOP", // fluent review
  "workflow.close": "Fermer", // fluent review
  "manual.whatItDoes": "Ce qu'il fait", // fluent review
  "manual.howItWorks": "Comment il fonctionne", // fluent review
  "manual.decisions": "Décisions", // fluent review
  "manual.decisionPoints": "Où une personne décide", // fluent review
  "manual.knownRisks": "Risques connus", // fluent review
  "manual.setup": "Ce que nous avons mis en place avec vous", // fluent review
  "manual.learned": "Ce qu'il a appris", // fluent review
  "manual.reads": "Ce qu'il lit", // fluent review
  "manual.notWritten":
    "Nous n'avons pas encore écrit le manuel de cet agent. Son fonctionnement est lu à partir de ses étapes.", // fluent review
  "manual.nothingYet": "Rien pour l'instant.", // fluent review
  "manual.notAnswered": "Pas encore de réponse", // fluent review
  "manual.highRisk": "Risque élevé", // fluent review
  "manual.learnedHidden": "Ce qu'il a appris est réservé à votre administrateur.", // fluent review
  "manual.ask": "Poser une question à ce sujet", // fluent review
  "manual.askText": "À propos du manuel de {agent} : « {line} » ", // fluent review
  "manual.startsAt": "Commence à {value}", // fluent review
  "manual.onStep": "Étape : {step}", // fluent review
  "manual.who": "Qui : {who}", // fluent review
  "manual.byWhen": "Sous {when}", // fluent review
  "manual.kind.assumption": "Hypothèse", // fluent review
  "manual.kind.decision_point": "Point de décision", // fluent review
  "manual.kind.client_setup": "Mis en place avec vous", // fluent review
  "manual.status.never_discussed": "Jamais discuté", // fluent review
  "manual.status.discussed": "Discuté", // fluent review
  "manual.status.confirmed": "Confirmé", // fluent review
  "manual.status.changed": "Modifié", // fluent review
  // B5 (docs/builder-plan.md §7): changes on the agent's settings, and feedback on the manual.
  "manual.changedBy": "Modifié par {who} le {date}", // fluent review
  "manual.changedByUs": "Modifié par nous le {date}", // fluent review
  "manual.wrong": "C'est faux", // fluent review
  "manual.wrongBecause": "C'est faux, parce que…", // fluent review
  "manual.wrongSend": "Nous l'envoyer", // fluent review
  "manual.wrongSent": "Envoyé comme demande n° {number}. Nous répondrons là-bas.", // fluent review
  "adjust.title": "Ce que vous pouvez ajuster", // fluent review
  "adjust.help":
    "Nous les avons configurés pour {name}. Un changement dans les limites, ou plus strict, s'applique tout de suite. Au-delà, il nous arrive comme une demande.", // fluent review
  "adjust.adminOnly": "Votre administrateur peut les modifier.", // fluent review
  "adjust.between": "Entre {min} et {max}", // fluent review
  "adjust.atLeast": "Au moins {min}", // fluent review
  "adjust.atMost": "Au plus {max}", // fluent review
  "adjust.tighterLower": "Plus bas est plus strict.", // fluent review
  "adjust.tighterHigher": "Plus haut est plus strict.", // fluent review
  "adjust.notSet": "Non défini", // fluent review
  "adjust.change": "Modifier", // fluent review
  "adjust.other": "Autre chose", // fluent review
  "adjust.otherWhat": "Ce que vous souhaitez", // fluent review
  "adjust.why": "Pourquoi (facultatif)", // fluent review
  "adjust.applied": "Enregistré. {label} vaut maintenant {value}.", // fluent review
  "adjust.unchanged": "{label} vaut déjà {value}.", // fluent review
  "adjust.requested":
    "Cela dépasse ce que nous avons configuré, c'est donc arrivé chez nous comme demande n° {number}. Nous répondrons là-bas.", // fluent review
  "agent.about": "Ce que fait {name}",
  "agent.aboutNone": "Nous n’avons pas encore décrit {name}.",
  "agent.status": "Statut",
  "agent.jobs": "Ses tâches",
  "agent.triggers": "Quand {name} s’exécute",
  "agent.triggersNone": "Rien ne lance encore {name} de lui-même.",
  "agent.lastStarted": "Dernier lancement {time}",
  "agent.neverStarted": "Pas encore lancé",
  "agent.skipsHolidays": "Saute les jours fériés",
  "agent.reachIt": "Comment joindre {name}",
  "agent.reachItNone": "{name} n’a pas encore de numéro ni d’adresse à lui.",
  "agent.thread": "Dans un fil",
  "agent.trigger.daily": "Tous les jours à {time}",
  "agent.trigger.weekdays": "En semaine à {time}",
  "agent.trigger.weekly": "Chaque {day} à {time}",
  "agent.trigger.schedule": "Selon un horaire",
  "agent.trigger.manual": "Quand quelqu’un le lance à la main",
  "agent.trigger.manualYou": "Quand vous le lancez avec Lancer maintenant",
  "agent.trigger.command": "Quand quelqu’un tape /{command} dans un fil",
  "agent.trigger.message": "Quand quelqu’un lui écrit par {channels}",
  "agent.trigger.webhook": "Quand l’un de vos systèmes lui envoie quelque chose",
  "agent.trigger.handoff": "Quand un autre de vos agents lui confie du travail",
  "agent.trigger.event.documentReceived": "Quand un document arrive",
  "agent.trigger.event.documentRead": "Quand un document a été lu",
  "agent.trigger.event.transactionCreated": "Quand une facture ou un achat arrive",
  "agent.trigger.event.transactionUpdated": "Quand une facture ou un achat change",
  "agent.trigger.event.receivableCreated": "Quand une facture client arrive",
  "agent.trigger.event.receivablePaid": "Quand une facture client est payée",
  "agent.trigger.event.bankTransaction": "Quand une opération bancaire arrive",
  "agent.trigger.event.cardCharge": "Quand un paiement par carte arrive",
  "agent.trigger.event.inboxResolved": "Quand quelqu’un répond à une approbation ou une question",
  "agent.trigger.event.threadMessage": "Quand quelqu’un écrit dans un fil",
  "agent.trigger.event.inboundMessage": "Quand quelqu’un lui écrit",
  "agent.trigger.event.messageReceived": "Quand un SMS ou un message WhatsApp arrive",
  "agent.trigger.event.runFailed": "Quand une exécution échoue",
  "agent.trigger.event.connectionAttention": "Quand une connexion demande votre attention",
  "agent.trigger.event.other": "Quand quelque chose qu’il surveille se produit",
  "agent.recentRuns": "Exécutions récentes",
  "agent.allRuns": "Toutes les exécutions",
  "agent.actionItems": "À faire",
  "agent.noActionItems": "Rien de {name} ne vous attend.",
  "agent.documents": "Documents",
  "agent.documentsAll": "Tous les documents",
  "agent.fullReport": "Voir le rapport complet",
  "agent.contacts": "Qui {name} contacte",
  "agent.contactsHelp":
    "Les personnes qu'il peut joindre pour chacun de ses rôles, et quand. Le consentement reste sur chaque contact.",
  "inbox.askUs": "Nous demander",
  "inbox.askUsPrompt": "Je voudrais demander à Mezonas : ",
  "inbox.showLater": {
    one: "Afficher {count} mis de côté avec « Pas maintenant »",
    other: "Afficher {count} mis de côté avec « Pas maintenant »",
  },
  "matrix.recordTypes": {
    one: "{count} type d'enregistrement",
    other: "{count} types d'enregistrement",
  },
  "contactsPage.backToList": "Retour à vos contacts",
  "contactsPage.consent": "Consentement et comment la personne préfère être jointe",
  "contacts.prefers": "Préfère, dans l'ordre : {channels}",
  "contacts.quietLine": "Pas de contact de {start} à {end}",
  "contacts.timezoneLine": "Son fuseau horaire : {zone}",
  "contacts.consentEdit": "Enregistrer ou modifier le consentement",
  "contacts.reachEdit": "Modifier comment la joindre",
  "settingsPage.general": "Général",
  "settingsPage.approvals": "Approbations",
  "settingsPage.exports": "Exports",
  "settingsPage.conversations": "Conversations",
  "settingsPage.voice": "Exemples de style",
  "settingsPage.charter": "Charte et politiques",
  "settingsPage.sloanBody":
    "Sloan est votre agent de compte. Interrogez-le sur le travail de vos agents, ou demandez-lui d'en mettre un en pause : utilisez « Demander à Sloan » en haut, ou la recherche. Sloan n'assouplit jamais une règle.",
  "settingsPage.sloanOpen": "Ouvrir Sloan",

  // UI cleanup (design pass): Home's figures, each agent's figures, and Ask Sloan in the top bar.
  // Needs a fluent speaker's review.
  "home.kpi.runsDone": "Exécutions terminées · cette semaine",
  "home.kpi.changes": "Changements d'outils · cette semaine",
  "home.kpi.changesNote": "{automatic} d'eux-mêmes · {approved} approuvés par vous",
  "home.kpi.waiting": "Vous attend",
  "home.kpi.waitingNote": "Approbations et questions",
  "home.kpi.documents": "Documents lus · cette semaine",
  "home.kpi.up": "{count} de plus que la semaine dernière",
  "home.kpi.down": "{count} de moins que la semaine dernière",
  "home.kpi.same": "Comme la semaine dernière",
  "kpi.runsDays": {
    one: "{count} exécution sur les {days} derniers jours",
    other: "{count} exécutions sur les {days} derniers jours",
  },
  "home.card.runsWeek": { one: "exécution cette semaine", other: "exécutions cette semaine" },
  "home.card.changes": { one: "changement dans vos outils", other: "changements dans vos outils" },
  "shell.askSloanButton": "Demander à Sloan",
  "shell.askSloanHint": "Votre agent de compte : interrogez-le sur le travail de vos agents",

  // Materials pack (packs/materials).
  "materials.prices.title": "Suivi des prix",
  "materials.prices.description":
    "Ce que vous payez pour chaque matériau, par fournisseur, et les prix qui ont bougé.",
  "materials.prices.subtitle":
    "Ce que coûte chaque matériau, par fournisseur, dans une même unité. Prix au {date}.",
  "materials.catalog.title": "Catalogue",
  "materials.catalog.description":
    "Les matériaux que vous achetez, avec le nom que leur donne chaque fournisseur.",
  "materials.catalog.subtitle": {
    one: "{count} matériau auquel vos lignes de facture sont associées.",
    other: "{count} matériaux auxquels vos lignes de facture sont associées.",
  },
  "materials.downloadCsv": "Télécharger le CSV",
  "materials.stat.openAlerts": "Alertes ouvertes",
  "materials.stat.openAlertsNote": {
    one: "Changement de prix à examiner",
    other: "Changements de prix à examiner",
  },
  "materials.stat.atStake": "En jeu",
  "materials.stat.atStakeNote": "Sur les quantités des 90 derniers jours",
  "materials.stat.watched": "Suivis",
  "materials.stat.items": { one: "{count} article", other: "{count} articles" },
  "materials.stat.vendors": { one: "Chez {count} fournisseur", other: "Chez {count} fournisseurs" },
  "materials.alerts.title": "Alertes",
  "materials.alerts.none": "Aucune alerte ouverte. Nous vous prévenons ici quand un prix bouge.",
  "materials.alerts.closed": { one: "{count} alerte fermée", other: "{count} alertes fermées" },
  "materials.alert.atStake": "{amount} en jeu",
  "materials.alert.accepted": "Acceptée",
  "materials.alert.dismissed": "Écartée",
  "materials.alert.kind.price_jump": "Prix en hausse",
  "materials.alert.kind.price_vs_avg": "Au-dessus de la moyenne",
  "materials.alert.kind.vendor_spread": "Moins cher ailleurs",
  "materials.alert.kind.price_creep": "Hausse progressive",
  "materials.alert.kind.new_fee": "Nouveaux frais",
  "materials.alert.kind.outlier": "Inhabituel",
  "materials.alert.kind.above_contract": "Au-dessus du contrat",
  "materials.alert.kind.not_on_contract": "Hors contrat",
  "materials.alert.kind.contract_not_in_effect": "Contrat non en vigueur",
  "materials.alert.kind.terms_mismatch": "Conditions différentes",
  "materials.alert.kind.below_contract": "Sous le contrat",
  "materials.alert.kind.within_tolerance": "Dans la tolérance",
  "materials.alert.saved": "{amount} économisés",
  "materials.alert.kind.other": "Alerte",
  "materials.prices.none":
    "Pas encore de prix. Ils apparaissent ici dès que nous avons lu votre première facture.",
  "materials.prices.table": "Prix par article et fournisseur",
  "materials.prices.rows": { one: "{count} ligne", other: "{count} lignes" },
  "materials.prices.filter": "Filtrer les articles ou fournisseurs",
  "materials.prices.purchases90": {
    one: "{count} achat en 90 jours",
    other: "{count} achats en 90 jours",
  },
  "materials.prices.alerts": { one: "{count} alerte", other: "{count} alertes" },
  "materials.prices.at": "{item} chez {vendor}",
  "materials.spark.label": {
    one: "{what} : {count} prix du {from} au {to}",
    other: "{what} : {count} prix du {from} au {to}",
  },
  "materials.spark.title": { one: "{what}, {count} prix", other: "{what}, {count} prix" },
  "materials.change.up": "en hausse",
  "materials.change.down": "en baisse",
  "materials.col.item": "Article",
  "materials.col.vendor": "Fournisseur",
  "materials.col.lastPrice": "Dernier prix",
  "materials.col.change": "Variation",
  "materials.col.days90": "90 jours",
  "materials.col.lastBought": "Dernier achat",
  "materials.col.alerts": "Alertes",
  "materials.col.category": "Catégorie",
  "materials.col.unit": "Unité",
  "materials.col.attributes": "Attributs",
  "materials.col.vendors": "Fournisseurs",
  "materials.col.purchases": "Achats",
  "materials.perUnit": "/ {unit}",
  "materials.each": "l'unité",
  "materials.unit.sheet": "panneau",
  "materials.unit.board_foot": "pied-planche", // fluent review
  "materials.unit.linear_foot": "pied linéaire",
  "materials.unit.each": "unité",
  "materials.unit.gallon": "gallon",
  "materials.unit.quart": "quart de gallon",
  "materials.category.sheet_goods": "Panneaux",
  "materials.category.hardwood": "Bois dur",
  "materials.category.mouldings": "Moulures et chants", // fluent review
  "materials.category.hardware": "Quincaillerie",
  "materials.category.finishes": "Finitions et colles",
  "materials.category.other": "Autres",
  "materials.catalog.empty":
    "Votre catalogue est vide. Les articles apparaissent ici à mesure que nous associons vos lignes de facture.",
  "materials.catalog.items": "Articles",
  "materials.catalog.filter": "Filtrer les articles",
  // §1.88: the vendor catalog and a master item's vendors.
  "materials.vendors.title": "Catalogue fournisseurs",
  "materials.vendors.description": "Ce que chaque fournisseur vous vend, avec son dernier prix.",
  "materials.vendors.subtitle": { one: "{count} fournisseur", other: "{count} fournisseurs" },
  "materials.vendors.empty":
    "Aucun article fournisseur pour l'instant. Nous les ajoutons en associant les lignes d'une facture, ou depuis la liste de prix d'un fournisseur.",
  "materials.vendors.none": "{vendor} n'a encore aucun article dans le catalogue.",
  "materials.vendors.pick": "Fournisseur",
  "materials.vendors.option": {
    one: "{name} ({count} article)",
    other: "{name} ({count} articles)",
  },
  "materials.vendors.lastPriced": "Dernier prix le {date}",
  "materials.vendors.search": "Chercher une référence, un nom ou un matériau",
  "materials.vendors.noMatch": "Aucun article ne correspond à votre recherche.",
  "materials.vendors.listedOn": "Au tarif du {date}",
  "materials.vendors.agreed": "Convenu",
  "materials.vendors.tolerance": "Tolérance {value}",
  "materials.vendors.holds": "{qty} × {unit}",
  "materials.vendors.preferred": "Préféré",
  "materials.vendors.discontinued": "Arrêté",
  "materials.vendors.active": "Actif",
  "materials.vendors.col.sku": "Référence",
  "materials.vendors.col.theirName": "Leur libellé",
  "materials.vendors.col.pack": "Conditionnement",
  "materials.vendors.col.on": "Le",
  "materials.vendors.col.from": "Source",
  "materials.vendors.col.listPrice": "Prix catalogue",
  "materials.vendors.col.status": "Statut",
  "materials.vendors.col.perUnit": "Par {unit}",
  "materials.vendors.source.invoice": "Facture",
  "materials.vendors.source.quote": "Devis",
  "materials.vendors.source.qbo_bill": "Facture QuickBooks",
  "materials.vendors.source.import": "Liste de prix",
  "materials.vendors.source.person": "Votre équipe",
  "materials.item.back": "Tous les matériaux",
  "materials.item.loading": "Chargement du matériau…",
  "materials.item.vendors": "Fournisseurs, par {unit}",
  "materials.item.vendorsNote":
    "Votre fournisseur préféré d'abord, puis le prix le plus bas par {unit}. Un prix que nous ne pouvons pas convertir en {unit} n'est pas comparé.",
  "materials.item.noVendors": "Aucun fournisseur ne vous vend encore ce matériau.",
  "materials.review.loading": "Chargement des lignes…",
  "materials.review.line": "{qty} à {price}",
  "materials.review.now": "Associée à {item}",
  "materials.review.matched": "Associée",
  "materials.review.newItem": "Nouvel article",
  "materials.review.skipped": "Ignorée",
  "materials.review.pick": "Article du catalogue pour {line}",
  "materials.review.candidate": "{name} (sûr à {sure})",
  "materials.review.match": "Associer",
  "materials.review.skip": "Ignorer",
  "materials.review.allDecided": "Toutes les lignes sont traitées.",
  "materials.review.left": {
    one: "Ligne restante : {left} sur {count}.",
    other: "Lignes restantes : {left} sur {count}.",
  },
  "materials.review.finish": "Terminer la vérification",
  // §1.164: Confirm matches (sales.review.*). Written with the code; a fluent speaker reviews it
  // before a client sees it, as the rest of this file.
  "sales.review.loading": "Chargement des lignes…",
  "sales.review.unsure": {
    one: "{count} ligne dont nous n'étions pas sûrs",
    other: "{count} lignes dont nous n'étions pas sûrs",
  },
  "sales.review.noneFound": {
    one: "Aucune correspondance ({count})",
    other: "Aucune correspondance ({count})",
  },
  "sales.review.matched": {
    one: "Associées ({count})",
    other: "Associées ({count})",
  },
  "sales.review.approveHigh": {
    one: "Approuver toutes celles en confiance élevée ({count})",
    other: "Approuver toutes celles en confiance élevée ({count})",
  },
  "sales.review.allDecided": "Toutes les lignes sont décidées.",
  "sales.review.left": {
    one: "{left} ligne sur {count} vous attend.",
    other: "{left} lignes sur {count} vous attendent.",
  },
  "sales.review.finish": "Terminer",
  "sales.review.noMatch": "Aucune correspondance",
  "sales.review.confirmed": "Confirmée",
  "sales.review.noneWord": "Aucune correspondance",
  "sales.review.matchedWord": "Associée",
  "sales.review.row": "Ligne {n}",
  "sales.review.confidence": "{word} ({sure})",
  "sales.review.confidence.high": "Élevée",
  "sales.review.confidence.medium": "Moyenne",
  "sales.review.confidence.low": "Faible",
  "sales.review.found.email": "Même e-mail",
  "sales.review.found.phone": "Même téléphone",
  "sales.review.found.website": "Même site web",
  "sales.review.found.alias": "Un nom que vous avez confirmé avant",
  "sales.review.found.name": "Nom proche",
  "sales.review.found.meaning": "Sens proche",
  "sales.review.found.model": "Le choix du modèle",
  "sales.review.found.person": "Votre choix",
  "sales.review.fieldColumn": "Champ",
  "sales.review.sheet": "Votre feuille",
  "sales.review.suggested": "Suggéré",
  "sales.review.record": "Dans votre CRM",
  "sales.review.field.name": "Nom",
  "sales.review.field.company": "Entreprise",
  "sales.review.field.email": "E-mail",
  "sales.review.field.phone": "Téléphone",
  "sales.review.field.website": "Site web",
  "sales.review.field.deal": "Affaire",
  "sales.review.differs": "Différent",
  "sales.review.noValues": "Cette ligne n'a aucune des valeurs que nous comparons.",
  "sales.review.approve": "Approuver",
  "sales.review.pick": "Un autre enregistrement pour la ligne {n}",
  "sales.review.another": "Un autre candidat…",
  "sales.review.candidate": "{record} ({word}, {sure})",
  "sales.review.use": "Utiliser celui-ci",
  "sales.review.lookUp": "Rechercher",
  "sales.review.module": "Où chercher",
  "sales.review.search": "Rechercher dans {module}",
  "sales.review.searchHint": "Nom, entreprise, e-mail, téléphone ou affaire",
  "sales.review.nothingFound": "Rien trouvé pour « {q} ».",
  "sales.review.choose": "Choisir",
  // P-8: US texting registration (docs/plan.md §1.70)
  "settingsPage.texting": "SMS aux États-Unis",
  "texting.subtitle":
    "Les opérateurs exigent que votre entreprise soit enregistrée avant que nous envoyions des SMS à des numéros américains pour vous. Décrivez-la une fois. Nous l'envoyons à Twilio et vous tenons informé.",
  "texting.adminOnly":
    "Votre administrateur fournit les informations de l'entreprise pour les SMS aux États-Unis.",
  "texting.notAvailable":
    "Les SMS ne sont pas encore configurés pour vous. Demandez-le-nous et nous les configurons.",
  "texting.status": "Où en est-on",
  "texting.stage.draft": "En attente de vos informations",
  "texting.stage.submitted": "Chez Twilio",
  "texting.stage.campaign": "En cours d'examen par les opérateurs",
  "texting.stage.ready": "Les SMS sont prêts",
  "texting.stage.needs_changes": "Twilio demande des modifications",
  "texting.stage.suspended": "En pause",
  "texting.stageHelp.draft":
    "Remplissez le formulaire ci-dessous. Nous le vérifions et l'envoyons à Twilio.",
  "texting.stageHelp.submitted":
    "Twilio vérifie votre entreprise. Cela prend généralement quelques jours.",
  "texting.stageHelp.campaign":
    "Votre entreprise est approuvée. Les opérateurs examinent vos envois. Cela prend jusqu'à une semaine.",
  "texting.stageHelp.ready":
    "Vos agents peuvent envoyer des SMS à des numéros américains depuis votre numéro.",
  "texting.stageHelp.needs_changes":
    "Modifiez ci-dessous ce que Twilio a demandé et enregistrez. Nous le renvoyons.",
  "texting.stageHelp.suspended":
    "Nous travaillons avec le support de Twilio. Les SMS vers les numéros américains ne peuvent pas partir d'ici là.",
  "texting.needs": "Ce que Twilio a demandé",
  "texting.locked":
    "Vos informations sont maintenant chez Twilio. Vous pourrez les modifier si Twilio le demande.",
  "texting.business": "Votre entreprise",
  "texting.legalName": "Raison sociale",
  "texting.legalNameHelp": "Exactement comme sur votre lettre d'EIN (CP 575 ou 147C).",
  "texting.businessType": "Forme juridique",
  "texting.industry": "Secteur",
  "texting.companyType": "Statut",
  "texting.companyType.private": "Entreprise privée",
  "texting.companyType.non-profit": "Association à but non lucratif",
  "texting.companyType.government": "Administration publique",
  "texting.website": "Site web",
  "texting.websiteHelp":
    "Il doit s'ouvrir sans connexion et correspondre au nom de votre entreprise.",
  "texting.ein": "EIN",
  "texting.einHelp": "Nous le gardons chiffré et ne l'affichons plus jamais.",
  "texting.einSet": "Enregistré ({hint}). Saisissez-le à nouveau seulement pour le remplacer.",
  "texting.address": "Adresse",
  "texting.street": "Rue",
  "texting.streetSecondary": "Bureau ou unité",
  "texting.city": "Ville",
  "texting.region": "État",
  "texting.postalCode": "Code postal",
  "texting.rep": "Qui peut parler au nom de l'entreprise",
  "texting.firstName": "Prénom",
  "texting.lastName": "Nom",
  "texting.title": "Intitulé du poste",
  "texting.position": "Fonction",
  "texting.phone": "Téléphone",
  "texting.phoneHelp": "Avec l'indicatif du pays, p. ex. +15125550199.",
  "texting.email": "E-mail",
  "texting.texts": "Vos SMS",
  "texting.volume": "SMS par jour",
  "texting.volume.low": "Moins de 6 000",
  "texting.volume.standard": "6 000 ou plus",
  "texting.uses": "À qui vous écrivez",
  "texting.uses.team": "Votre équipe",
  "texting.uses.vendors": "Vos fournisseurs",
  "texting.uses.customer_care": "Vos clients, au sujet de leurs commandes",
  "texting.noMarketing":
    "Nous n'enregistrons que les SMS de votre entreprise, jamais de marketing.",
  "texting.optIn": "Comment les personnes acceptent vos SMS",
  "texting.optInHelp":
    "Avec vos mots : où elles donnent leur numéro et ce qu'elles acceptent. Au moins 40 caractères.",
  "texting.optInRelationship": "Partir du texte de votre page d'inscription",
  "texting.optInRelationshipHelp":
    "Il décrit votre lien d'inscription et les invitations par e-mail, que les opérateurs peuvent ouvrir et vérifier. Modifiez-le si vous faites autre chose.",
  "texting.privacy": "Lien vers la politique de confidentialité",
  "texting.terms": "Lien vers les conditions",
  "texting.hasLinks": "Nos SMS contiennent des liens",
  "texting.hasPhones": "Nos SMS contiennent des numéros de téléphone",
  "texting.fees":
    "Twilio facture des frais d'enregistrement uniques et des frais mensuels. Ils sont facturés en crédits.",
  "texting.save": "Enregistrer les informations",
  "texting.saved": "Enregistré. Nous vérifions vos informations et les envoyons à Twilio.",
  "texting.problem": "Vérifiez les champs signalés ci-dessus.",
  // P-9: purchase requests, the line review and the vendor choice (docs/plan.md §1.71). A fluent speaker's review is still needed.
  "materials.requests.title": "Demandes d'achat",
  "materials.requests.description":
    "Ce que votre équipe a demandé d'acheter, les devis et les commandes.",
  "materials.requests.empty": "Aucune demande d'achat pour l'instant.",
  "materials.requests.asked": "Demandée le {date}",
  "materials.requests.neededBy": "Pour le {date}",
  "materials.requests.order": "Commande {ref}",
  "materials.requests.items": {
    one: "{count} article",
    other: "{count} articles",
  },
  "materials.requests.quotes": {
    one: "{received} devis reçu sur {count}",
    other: "{received} devis reçus sur {count}",
  },
  "materials.requests.status.open": "Ouverte",
  "materials.requests.status.quoting": "Devis demandés",
  "materials.requests.status.quoted": "Devis reçus",
  "materials.requests.status.ordered": "Commandée",
  "materials.requests.status.cancelled": "Annulée",
  "materials.requests.status.closed": "Clôturée",
  "materials.request.back": "Toutes les demandes",
  "materials.request.loading": "Chargement de la demande…",
  "materials.request.lines": "Ce qui a été demandé",
  "materials.request.quotes": "Devis",
  "materials.request.compare": "Comparaison",
  "materials.request.documents": "Documents",
  "materials.request.orders": "Commandes",
  "materials.request.howMany": "Combien ?",
  "materials.request.unmatched": "Pas encore associé",
  "materials.request.deliver": "Livrer à {place}",
  "materials.request.pickup": "Retrait",
  "materials.request.quote.draft": "Non envoyée",
  "materials.request.quote.sent": "En attente de réponse",
  "materials.request.quote.received": "Devis reçu",
  "materials.request.quote.declined": "Refusée",
  "materials.request.quote.expired": "Pas de réponse",
  "materials.request.col.item": "Article",
  "materials.request.col.qty": "Qté",
  "materials.request.col.total": "Total",
  "materials.request.notQuoted": "Non chiffré",
  "materials.request.unavailable": "Indisponible",
  "materials.request.suggested": "Nous suggérons {vendor} : {total}",
  "materials.request.suggestedSplit": "Nous suggérons de partager la commande",
  "materials.request.chosen": "Vous avez choisi {vendor}",
  "materials.request.chosenSplit": "Vous avez choisi de partager",
  "materials.request.doc.purchase_order": "Bon de commande",
  "materials.request.doc.rfq": "Demande de devis",
  "materials.request.doc.other": "Document",
  "materials.request.lead": {
    one: "{count} jour",
    other: "{count} jours",
  },
  "materials.lineReview.loading": "Chargement des lignes…",
  "materials.lineReview.pick": "Article du catalogue pour {line}",
  "materials.lineReview.qty": "Combien de {line}",
  "materials.lineReview.choose": "Choisissez un article",
  "materials.lineReview.save": "Enregistrer la ligne",
  "materials.lineReview.settled": "Réglée",
  "materials.lineReview.allSettled": "Chaque ligne a son article et sa quantité.",
  "materials.lineReview.left": {
    one: "Reste {left} ligne sur {count}.",
    other: "Restent {left} lignes sur {count}.",
  },
  "materials.lineReview.finish": "Terminé",
  "materials.choice.loading": "Chargement des devis…",
  "materials.choice.none": "Aucun devis n'est encore arrivé.",
  "materials.choice.pick": "Choisir {vendor}",
  "materials.choice.pickSplit": "Choisir le partage",
  "materials.choice.picked": "Choisi",
  "materials.choice.suggested": "Suggéré",
  "materials.choice.incomplete": "Ne chiffre pas toutes les lignes",
  "materials.choice.late": "Plus tard que nécessaire",
  "materials.choice.finish": "Terminé",

  // ── Marketing area (M50, plan §1.78): the whole block is for the fluent review ──
  "marketing.downloadCsv": "Télécharger le CSV",
  "marketing.site": "Site",
  "marketing.noSite": "Aucun site web n'est encore mesuré",
  "marketing.noSiteLine":
    "Nous ajoutons votre site et vous envoyons un extrait de code pour ses pages. Ses chiffres s'affichent ici le lendemain.",
  "marketing.smallSample": "Petit échantillon",
  "marketing.privacy":
    "Compté sans cookies. Nous ne gardons aucune adresse IP ni rien qui nomme un visiteur.",
  "marketing.period": "Période",
  "marketing.period.7": "7 derniers jours",
  "marketing.period.28": "28 derniers jours",
  "marketing.period.90": "90 derniers jours",
  "marketing.rangeLine": {
    one: "{period}, par rapport à la veille.",
    other: "{period}, par rapport aux {count} jours précédents.",
  },
  "marketing.notCounted": {
    one: "{count} jour n'est pas encore compté.",
    other: "{count} jours ne sont pas encore comptés.",
  },
  "marketing.change.up": "{by} de plus que les jours précédents",
  "marketing.change.down": "{by} de moins que les jours précédents",
  "marketing.change.same": "Comme les jours précédents",
  "marketing.seconds": "{n} s",
  "marketing.minutes": "{n} min",
  "marketing.minutesSeconds": "{m} min {s} s",
  "marketing.band.under": "Moins de {to}",
  "marketing.band.over": "{from} ou plus",
  "marketing.band.between": "De {from} à {to}",
  "marketing.source.direct": "Direct",
  "marketing.source.search": "Recherche",
  "marketing.source.social": "Réseaux sociaux",
  "marketing.source.referral": "Un autre site",
  "marketing.source.campaign": "Campagne",
  "marketing.source.internal": "Votre propre site",
  "marketing.col.page": "Page",
  "marketing.col.views": "Vues",
  "marketing.col.goals": "Objectifs",
  "marketing.col.source": "Source",
  "marketing.col.visits": "Visites",
  "marketing.col.query": "Recherche",
  "marketing.col.impressions": "Affichages",
  "marketing.col.clicks": "Clics",
  "marketing.col.position": "Position",
  "marketing.website.title": "Site web",
  "marketing.website.description":
    "Les visites de votre site web, les pages lues et d'où venaient les visiteurs.",
  "marketing.website.subtitle":
    "Les visites, objectifs et pages de votre site web, par journée terminée.",
  "marketing.website.visits": "Visites",
  "marketing.website.pagesRead": { one: "{count} page lue", other: "{count} pages lues" },
  "marketing.website.goals": "Ont atteint un objectif",
  "marketing.website.goalShare": "{rate} des visites",
  "marketing.website.bounce": "Repartis aussitôt",
  "marketing.website.bounceNote": {
    one: "{count} visite a lu une page et est repartie",
    other: "{count} visites ont lu une page et sont reparties",
  },
  "marketing.website.engaged": "Temps d'attention médian",
  "marketing.website.perVisit": "Par visite",
  "marketing.website.byDay": "Visites par jour",
  "marketing.website.byDayLabel": "Visites par jour, {period}",
  "marketing.website.noVisits": "Aucune visite ces jours-ci",
  "marketing.website.noVisitsLine":
    "Dès que l'extrait est sur les pages de votre site, les visites s'affichent ici le lendemain.",
  "marketing.website.pages": "Pages principales",
  "marketing.website.noPages": "Aucune page lue pour l'instant.",
  "marketing.website.sources": "D'où venaient les visites",
  "marketing.website.noSources": "Aucune visite pour l'instant.",
  "marketing.website.filtered": {
    one: "{count} requête d'un robot ou d'un script n'a pas été comptée.",
    other: "{count} requêtes de robots et de scripts n'ont pas été comptées.",
  },
  "marketing.search.title": "Recherche",
  "marketing.search.description": "Comment votre site apparaît dans les recherches Google et Bing.",
  "marketing.search.subtitle": "Votre site dans Google et Bing : affichages, clics et positions.",
  "marketing.search.provider": "Moteur de recherche",
  "marketing.search.provider.all": "Google et Bing",
  "marketing.search.provider.google": "Google",
  "marketing.search.provider.bing": "Bing",
  "marketing.search.none": "Pas encore de chiffres de recherche",
  "marketing.search.noneLine":
    "Dès que Search Console ou Bing est connecté, les chiffres s'affichent ici le lendemain.",
  "marketing.search.rangeLine": "{period}. Les chiffres vont jusqu'au {day}.",
  "marketing.search.capped": "La période s'arrête là où s'arrêtent les chiffres.",
  "marketing.search.impressions": "Affichages dans les recherches",
  "marketing.search.clicks": "Clics",
  "marketing.search.ctr": "Taux de clics",
  "marketing.search.position": "Position moyenne",
  "marketing.search.positionNote": "1 est le haut de la première page",
  "marketing.search.queries": "Recherches principales",
  "marketing.search.noQueries": "Aucune recherche ces jours-ci.",
  "marketing.search.private":
    "Google garde certaines recherches privées : les recherches n'additionnent donc pas les totaux.",
  "marketing.search.pages": "Pages principales",
  "marketing.search.close": "Près de la première page",
  "marketing.search.closeLine": "Positions 8 à 20",
  "marketing.search.closeNone": "Aucune recherche juste après la première page.",
  "marketing.weekly.title": "Rapport hebdomadaire",
  "marketing.weekly.description":
    "Le rapport de chaque semaine sur votre site web et la recherche, avec trois actions suggérées.",
  "marketing.weekly.subtitle":
    "Ce qui a changé sur votre site web et dans la recherche, semaine après semaine.",
  "marketing.weekly.none": "Pas encore de rapport hebdomadaire",
  "marketing.weekly.noneLine":
    "Chaque lundi, nous écrivons un rapport sur la semaine passée. Le premier arrive après une semaine de chiffres.",
  "marketing.weekly.week": "Semaine du {period}",
  "marketing.weekly.sources": {
    one: "Chaque chiffre du rapport vient de {count} enregistrement de vos données.",
    other: "Chaque chiffre du rapport vient de {count} enregistrements de vos données.",
  },
  "marketing.weekly.changes": "Ce qui a changé",
  "marketing.weekly.causes": "Pourquoi, probablement",
  "marketing.weekly.unknown": "Ce que nous ne pouvons pas savoir",
  "marketing.weekly.actions": "Actions suggérées",
  "marketing.weekly.actionsLine": "Votre responsable Mezonas les passe en revue avec vous",
  "marketing.weekly.noActions": "Aucune action cette semaine.",
  "marketing.weekly.action.open": "À faire",
  "marketing.weekly.action.done": "Fait",
  "marketing.weekly.action.not_now": "Pas maintenant",
  "marketing.weekly.past": "Rapports",
  "marketing.weekly.new": "Nouveau",
  // B-6 (docs/plan.md §1.79): the Bookkeeping area's portal words. Fluent review: the whole block.
  "bookkeeping.transactions.title": "Opérations bancaires",
  "bookkeeping.transactions.description":
    "Les opérations de votre banque et de vos cartes, et où chacune a été enregistrée dans QuickBooks.",
  "bookkeeping.transactions.empty":
    "Aucune opération pour l'instant. Elles s'affichent ici une fois votre banque connectée.",
  "bookkeeping.transactions.date": "Date",
  "bookkeeping.transactions.account": "Compte",
  "bookkeeping.transactions.payee": "Payé à ou par",
  "bookkeeping.transactions.amount": "Montant",
  "bookkeeping.transactions.status": "État",
  "bookkeeping.transactions.bookedTo": "Enregistré dans",
  "bookkeeping.transactions.booked": "{count} enregistrées",
  "bookkeeping.transactions.waiting": "{count} vous attendent",
  "bookkeeping.status.pending": "En attente à la banque",
  "bookkeeping.status.new": "Nouvelle",
  "bookkeeping.status.matched": "Déjà dans QuickBooks",
  "bookkeeping.status.proposed": "Proposée",
  "bookkeeping.status.needs_review": "Vous attend",
  "bookkeeping.status.approved": "Approuvée",
  "bookkeeping.status.posted": "Enregistrée",
  "bookkeeping.status.excluded": "Écartée",
  "bookkeeping.status.removed": "Retirée par la banque",
  "bookkeeping.status.skipped": "Non enregistrée",
  "bookkeeping.review.loading": "Chargement des opérations…",
  "bookkeeping.review.suggested": "Nous suggérons {account}",
  "bookkeeping.review.noSuggestion": "Pas encore de suggestion",
  "bookkeeping.review.openBill":
    "Est-ce le paiement d'une facture fournisseur ouverte : {what} ? Si oui, imputez-le à cette facture dans QuickBooks, puis écartez-le ici.",
  "bookkeeping.review.openInvoice":
    "Est-ce l'encaissement d'une facture ouverte : {what} ? Si oui, imputez-le à cette facture dans QuickBooks, puis écartez-le ici.",
  "bookkeeping.review.openBillPaid":
    "QuickBooks indique cette facture fournisseur comme réglée : {what}. Si c'est ce paiement, écartez-le ici.",
  "bookkeeping.review.openInvoicePaid":
    "QuickBooks indique cette facture comme encaissée : {what}. Si c'est cet encaissement, écartez-le ici.",
  "bookkeeping.review.pairHeld":
    "Opération {what} : peut être l'autre côté d'un virement qui n'a pas été enregistré ou a été écarté. Décidez des deux ensemble.",
  "bookkeeping.review.resent":
    "La banque a renvoyé cette opération après en avoir retiré une copie antérieure. Décidez ici : rien n'est enregistré avant votre décision.",
  "bookkeeping.review.approve": "Approuver",
  "bookkeeping.review.account": "Compte pour {payee}",
  "bookkeeping.review.why": "Pourquoi, en quelques mots (facultatif)",
  "bookkeeping.review.rule": "Enregistrer toujours ainsi ce bénéficiaire",
  "bookkeeping.review.book": "Enregistrer",
  "bookkeeping.review.exclude": "Écarter",
  "bookkeeping.review.done": "Terminé",
  "bookkeeping.review.left": "Il en reste {left} sur {count}",
  "bookkeeping.review.allDone": "Tout est décidé",
  "bookkeeping.review.decided": "Décidée",
  "bookkeeping.questions.loading": "Chargement des comptes…",
  "bookkeeping.questions.ask": "À quoi vous sert {account} ?",
  "bookkeeping.questions.examples": "Déjà enregistré ici : {payees}",
  "bookkeeping.questions.answered": "Répondu",
  "bookkeeping.questions.save": "Enregistrer",
  "bookkeeping.questions.done": "Terminé",
  // R-1 (docs/plan.md §1.80): reconciliation.
  "bookkeeping.recon.loading": "Chargement du rapprochement…",
  "bookkeeping.recon.difference": "Écart",
  "bookkeeping.recon.unexplainedBy": "{amount} non expliqué",
  "bookkeeping.recon.startGap":
    "Les soldes d'ouverture diffèrent de {amount}, et rien de reporté depuis la dernière validation ne l'explique. Ajoutez ce qui était en suspens au début de la période, comme un chèque émis avant et encaissé pendant celle-ci.",
  "bookkeeping.recon.asOf": "Au {day}",
  "bookkeeping.recon.outcome.balanced": "Équilibré",
  "bookkeeping.recon.outcome.explained": "Expliqué",
  "bookkeeping.recon.outcome.unexplained": "Non expliqué",
  "bookkeeping.recon.status.open": "Ouvert",
  "bookkeeping.recon.status.signed_off": "Validé",
  "bookkeeping.recon.status.superseded": "Remplacé",
  "bookkeeping.recon.suggestions": "Nos suggestions",
  "bookkeeping.recon.accept": "Accepter",
  "bookkeeping.recon.reject": "Refuser",
  "bookkeeping.recon.left": "Reste à expliquer",
  "bookkeeping.recon.nothingLeft": "Tout concorde.",
  "bookkeeping.recon.pick": "Choisir {item}",
  "bookkeeping.recon.carried": "De la dernière fois",
  "bookkeeping.recon.labelFor": "Libellé pour {item}",
  "bookkeeping.recon.label.none": "Sans libellé",
  "bookkeeping.recon.label.timing": "En transit",
  "bookkeeping.recon.label.missing": "D'un seul côté",
  "bookkeeping.recon.label.amount_differs": "Montant différent",
  "bookkeeping.recon.label.duplicate": "Doublon",
  "bookkeeping.recon.matchPicked": "Rapprocher les éléments choisis",
  "bookkeeping.recon.matched": "Rapprochés ({count})",
  "bookkeeping.recon.method.exact": "Même référence",
  "bookkeeping.recon.method.amount_date": "Même montant et date",
  "bookkeeping.recon.method.group": "Somme égale",
  "bookkeeping.recon.method.model": "Notre suggestion",
  "bookkeeping.recon.method.person": "Rapproché par vous",
  "bookkeeping.recon.unmatch": "Annuler",
  "bookkeeping.recon.add": "Ajouter ce qui manque d'un côté",
  "bookkeeping.recon.addSide": "Côté",
  "bookkeeping.recon.addDate": "Date",
  "bookkeeping.recon.addAmount": "Montant",
  "bookkeeping.recon.addWhat": "De quoi il s'agit",
  "bookkeeping.recon.addButton": "Ajouter",
  "bookkeeping.recon.note": "Note (facultative)",
  "bookkeeping.recon.cantSign":
    "Expliquez d'abord {amount} : rapprochez des éléments ou ajoutez ce qui manque.",
  "bookkeeping.recon.signOff": "Valider",
  "bookkeeping.recons.title": "Rapprochements",
  "bookkeeping.recons.description":
    "Chaque compte bancaire et carte comparé à QuickBooks, mois par mois.",
  "bookkeeping.recons.waiting": "{count} vous attendent",
  "bookkeeping.recons.empty": "Pas encore de rapprochement. Le premier se fait à la fin d'un mois.",
  "bookkeeping.recons.asOf": "Au",
  "bookkeeping.recons.compared": "Comparé",
  "bookkeeping.recons.unexplained": "Non expliqué",
  "bookkeeping.recons.result": "Résultat",
  "bookkeeping.recons.status": "Statut",

  // ── R8 : horaires d'ouverture, horaires des personnes, canaux, connexions par type ──
  "hours.title": "Horaires et absences",
  "hours.week": "Votre semaine",
  "hours.closed": "Fermé",
  "hours.dayRange": "{from} au {to}",
  "hours.stretch": "{from} à {to}",
  "hours.to": "à",
  "hours.opensOn": "{day} : ouvre à",
  "hours.closesOn": "{day} : ferme à",
  "hours.addStretch": "Ajouter une plage",
  "hours.removeStretch": "Retirer",
  "hours.zone": "Fuseau horaire : {zone}",
  "hours.usHolidays": "Fermé les jours fériés fédéraux américains",
  "hours.usHolidaysHelp": "Le jour de l'An, Thanksgiving, Noël et les autres.",
  "hours.usHolidaysOn": "Fermé les jours fériés fédéraux américains.",
  "hours.usHolidaysOff": "Ouvert les jours fériés fédéraux américains.",
  "hours.closedDates": "Jours de fermeture",
  "hours.closedDatesHelp":
    "Les jours où vous êtes fermé en plus de la semaine ci-dessus, comme une fermeture des bureaux.",
  "hours.closedDatesNone": "Aucun jour de fermeture.",
  "hours.date": "Date",
  "hours.addDate": "Ajouter la date",
  "hours.removeDate": "Retirer {date}",
  "hours.default": "Par défaut",
  "hours.useDefault": "Revenir au réglage par défaut : du lundi au vendredi, de 8 h à 18 h",
  "hours.saving": "Enregistrement…",
  "hours.change": "Modifier les horaires",
  "hours.away": "Absences",
  "hours.awayNone": "Aucune absence.",
  "hours.awayRange": "Du {from} au {to}",
  "hours.awayUntil": "Absent jusqu'au {date}",
  "hours.awayFrom": "Absent à partir du",
  "hours.awayTo": "Jusqu'au (facultatif)",
  "hours.awayAdd": "Ajouter une absence",
  "hours.awayHelp":
    "Pendant une absence, les approbations et les questions passent cette personne et vont à la suivante.",
  "hours.person.usesBusiness": "Horaires de l'entreprise",
  "hours.person.businessHelp": "Travaille quand l'entreprise est ouverte.",
  "hours.person.own": "Horaires propres",
  "hours.person.ownHelp": "Choisissez les jours et les heures ci-dessous.",
  "hours.person.businessShort": "Horaires de l'entreprise",
  "hours.person.ownShort": "Horaires propres",
  "hours.problem.order": "{day} : chaque heure de fermeture doit suivre son heure d'ouverture.",
  "hours.problem.overlap": "{day} : les plages se chevauchent.",
  "hours.problem.away": "La date de fin précède la date de début.",
  "hours.problem.none":
    "Indiquez les horaires d'au moins un jour : une semaine sans heures d'ouverture ne peut pas être enregistrée.",
  "hours.contactUnlisted":
    "Les horaires de ce contact ne peuvent pas être affichés ici, ils ne peuvent donc pas être modifiés depuis cette page.",
  "businessHours.subtitle":
    "Quand votre entreprise est ouverte. Un délai en heures ouvrées ne court que pendant les heures de travail de la personne sollicitée.",
  "businessHours.zoneNote":
    "Votre fuseau horaire est réglé avec les informations de votre entreprise. Pour le changer,",
  "businessHours.zoneLink": "demandez-nous.",
  "businessHours.zonePrompt": "Merci de changer le fuseau horaire de mon entreprise pour : ",
  "businessHours.readOnly": "Seul votre administrateur peut les modifier.",
  "settingsPage.hours": "Horaires d'ouverture",
  "settingsPage.channels": "Canaux",
  "channels.subtitle":
    "Le numéro et l'adresse e-mail depuis lesquels vos agents écrivent et répondent.",
  "channels.account": "Votre compte",
  "channels.accountHelp": "Tous les agents les utilisent, sauf ceux qui ont les leurs.",
  "channels.accountNone":
    "Votre compte n'a pas encore de numéro ni d'adresse e-mail. Nous les mettons en place pour vous.",
  "channels.agents": "Vos agents",
  "channels.agentsNone": "Aucun agent pour l'instant.",
  "channels.notSetUp": "Pas encore en place",
  "channels.own": "Le sien",
  "channels.fromAccount": "Celui de votre compte",
  "channels.agentUsesAccount": "Utilise le numéro et l'adresse e-mail de votre compte.",
  "channels.change": "Nous mettons en place les numéros et les adresses. Pour en changer un,",
  "channels.changeLink": "demandez-nous.",
  "channels.changePrompt":
    "Merci de changer le numéro ou l'adresse e-mail qu'utilisent mes agents : ",
  "teamPage.hours": "Horaires",
  "teamPage.yourHours": "Vos horaires",
  "teamPage.yourHoursHelp":
    "Quand vous travaillez, et les jours où vous êtes absent. Les approbations et les questions attendent vos horaires et vous passent pendant vos absences.",
  "accounts.group.money": "Comptabilité et argent",
  "accounts.group.email": "E-mail",
  "accounts.group.messages": "Messages et appels",
  "accounts.group.files": "Fichiers et feuilles de calcul",
  "accounts.group.sales": "Clients et ventes",
  "accounts.group.web": "Sites web et recherche",
  "accounts.group.other": "Autres outils",
  // docs/plan.md §1.98: signing up for texts. REVIEW: needs a fluent speaker (§1.18).
  "peoplePage.textInvite": "Les inviter à recevoir des SMS",
  "peoplePage.textInviteHint":
    "Nous envoyons à chacun une invitation par e-mail en votre nom. Les SMS ne commencent que s'ils s'inscrivent. Un rappel au plus.",
  "peoplePage.textInviteSend": "Envoyer les invitations",
  "peoplePage.textInviteDone": "Envoyées à {count}.",
  "peoplePage.textInviteSkipped":
    "{count} laissés de côté : pas d'e-mail, déjà inscrits, ont refusé ou ont été sollicités récemment.",
  "peoplePage.signupLink": "Lien d'inscription aux SMS",
  "peoplePage.signupLinkHint":
    "Partagez-le avec votre équipe. Chacun s'inscrit avec son propre numéro.",
  "peoplePage.signupLinkShow": "Afficher le lien",
  "peoplePage.signupLinkCopy": "Copier",
  "peoplePage.signupLinkCopied": "Copié",
  "peoplePage.signupLinkReplace": "Créer un nouveau lien",
  "peoplePage.signupLinkReplaceConfirm": "Le créer : l'ancien cesse de fonctionner",
  "peoplePage.signupLinkReplaceHint":
    "Personne ne pourra plus s'inscrire avec l'ancien lien. Les personnes déjà inscrites le restent.",
  // §1.100: the sign-in's second step.
  "error.wrong_code": "Ce code est incorrect ou a expiré.",
  "error.too_many_attempts": "Trop d'essais. Attendez 15 minutes et réessayez.",
  "error.code_service_failed": "Impossible d'envoyer ou de vérifier le code. Réessayez.",
  "error.second_factor_unavailable":
    "Les codes ne peuvent pas être vérifiés pour le moment. Réessayez dans quelques minutes.",
  "error.not_pending": "Cette connexion n'attend plus de code. Reconnectez-vous.",
  "error.already_set_up": "Vous avez déjà une méthode. Utilisez-la pour vous connecter.",
  "error.method_not_allowed": "L'équipe Mezonas utilise une application d'authentification.",
  "secondStep.eyebrow": "Se connecter",
  "secondStep.title": "Encore une étape",
  "secondStep.intro": "Saisissez le code reçu sur votre téléphone pour terminer la connexion.",
  "secondStep.setupTitle": "Configurez votre deuxième étape",
  "secondStep.setupIntro":
    "À chaque connexion, après votre mot de passe, nous demandons un code reçu sur votre téléphone. Choisissez comment le recevoir.",
  "secondStep.operatorOnly": "L'équipe Mezonas utilise une application d'authentification.",
  "secondStep.method.totp": "Application d'authentification",
  "secondStep.method.totpHint":
    "Google Authenticator, Microsoft Authenticator, 1Password ou similaire.",
  "secondStep.method.sms": "SMS",
  "secondStep.method.smsHint": "Nous vous envoyons un code par SMS.",
  "secondStep.method.whatsapp": "WhatsApp",
  "secondStep.method.whatsappHint": "Nous vous envoyons un code sur WhatsApp.",
  "secondStep.continue": "Continuer",
  "secondStep.totp.title": "Ajoutez Mezonas à votre application d'authentification",
  "secondStep.totp.step1":
    "Scannez ce code avec votre application d'authentification, ou ajoutez un compte et saisissez la clé ci-dessous. Sur ce téléphone, vous pouvez ouvrir l'application directement.",
  "secondStep.totp.qr": "Code QR pour ajouter Mezonas à votre application d'authentification",
  "secondStep.totp.openApp": "Ouvrir dans mon application d'authentification",
  "secondStep.totp.key": "Clé de configuration",
  "secondStep.totp.step2": "Saisissez ensuite le code à 6 chiffres affiché par l'application.",
  "secondStep.phone.country": "Pays",
  "secondStep.phone.number": "Numéro de mobile",
  "secondStep.phone.hint": "Nous envoyons un code à ce numéro maintenant.",
  "secondStep.phone.invalid": "Saisissez un numéro de mobile, chiffres uniquement.",
  "secondStep.phone.send": "Envoyer le code",
  "secondStep.code.label": "Code",
  "secondStep.code.hintApp": "Le code à 6 chiffres de votre application d'authentification.",
  "secondStep.code.hintSent": "Le code envoyé au {phone}.",
  "secondStep.code.invalid": "Saisissez le code : 6 à 8 chiffres.",
  "secondStep.verify": "Valider",
  "secondStep.remember": "Se souvenir de ce navigateur pendant 30 jours",
  "secondStep.resend": "Envoyer un nouveau code",
  "secondStep.sent": "Nous avons envoyé un nouveau code au {phone}.",
  "secondStep.otherMethod": "Utiliser une autre méthode",
  "secondStep.useRecovery": "Utiliser plutôt un code de récupération",
  "secondStep.recovery.title": "Utiliser un code de récupération",
  "secondStep.recovery.label": "Code de récupération",
  "secondStep.recovery.hint":
    "L'un des codes enregistrés lors de la configuration, par exemple ABCD-2345. Chacun ne sert qu'une fois.",
  "secondStep.recovery.use": "Se connecter avec ce code",
  "secondStep.recovery.back": "Retour au code",
  "secondStep.recovery.savedTitle": "Enregistrez vos codes de récupération",
  "secondStep.recovery.savedIntro":
    "Si vous perdez votre téléphone, chaque code permet une connexion. Nous ne les affichons qu'une seule fois. Conservez-les en lieu sûr, par exemple dans un gestionnaire de mots de passe.",
  "secondStep.recovery.download": "Télécharger en fichier",
  "secondStep.recovery.confirm": "Je les ai enregistrés : continuer",
  "secondStep.recoveryLow": {
    one: "Connecté. Il vous reste {count} code de récupération.",
    other: "Connecté. Il vous reste {count} codes de récupération.",
  },
  "secondStep.lost":
    "Téléphone et codes de récupération perdus ? Demandez à votre administrateur ou à votre contact Mezonas de réinitialiser votre connexion.",
  "secondStep.signOut": "Se déconnecter",
  "secondStep.failed": "Cela n'a pas fonctionné. Réessayez.",
  "setupLink.title": "Configurez votre connexion",
  "setupLink.intro":
    "Ajoutez un moyen de recevoir des codes pour {email}. Vous pouvez ajouter les deux.",
  "setupLink.setUp": "Configurer",
  "setupLink.done": "Terminé",
  "setupLink.back": "Retour",
  "setupLink.backToSignIn": "Retour à la connexion",
  "secondStep.emailLink.title": "Configurez votre connexion par e-mail",
  "secondStep.emailLink.intro":
    "Pour protéger votre compte, nous vous envoyons par e-mail un lien pour ajouter votre numéro de téléphone ou une application d'authentification.",
  "secondStep.emailLink.send": "M'envoyer le lien",
  "secondStep.emailLink.sent":
    "Nous avons envoyé un lien à {email}. Ouvrez-le, ajoutez votre téléphone ou une application d'authentification, puis revenez ici.",
  "secondStep.emailLink.check": "C'est fait",
  "secondStep.emailLink.notYet": "Rien n'est encore configuré. Ouvrez d'abord le lien de l'e-mail.",
  "secondStep.emailLink.again": "Renvoyer le lien",
  "error.setup_by_email": "Configurez votre connexion depuis le lien envoyé par e-mail.",
  "error.link_expired": "Ce lien a expiré. Reconnectez-vous pour en recevoir un nouveau.",
  "error.email_unavailable":
    "Nous ne pouvons pas envoyer d'e-mail pour le moment. Contactez votre responsable Mezonas.",
  "error.email_failed": "Nous n'avons pas pu envoyer l'e-mail. Réessayez.",
  "secondStep.phoneApprove.title": "Approuvez sur votre téléphone",
  "secondStep.phoneApprove.intro": "Ouvrez Mezonas sur votre téléphone et touchez ce nombre.",
  "secondStep.phoneApprove.number": "Le nombre à toucher sur votre téléphone",
  "secondStep.phoneApprove.waiting": "En attente de votre téléphone.",
  "secondStep.phoneApprove.denied":
    "Cette connexion a été refusée sur votre téléphone. Si ce n'était pas vous, changez votre mot de passe.",
  "secondStep.phoneApprove.expired": "Votre téléphone n'a pas répondu à temps.",
  "secondStep.phoneApprove.again": "Redemander à mon téléphone",
  "secondStep.phoneApprove.useCode": "Utiliser un code",
  "secondStep.phoneApprove.instead": "Approuver sur mon téléphone",
  "error.no_phone": "Aucun téléphone ne peut approuver cette connexion. Utilisez un code.",
  // §1.120: approving a Claude connection (the MCP server) from the browser.
  "connectClaude.title": "Connecter Claude",
  "connectClaude.subtitle":
    "Claude peut utiliser Mezonas en votre nom une fois que vous l'approuvez ici.",
  "connectClaude.card": "Connexion Claude",
  "connectClaude.status.waiting": "En attente de vous",
  "connectClaude.status.approved": "Approuvée",
  "connectClaude.status.expired": "Expirée",
  "connectClaude.waiting":
    "Claude demande à utiliser Mezonas en votre nom. Première demande à {time}. Approuvez-la seulement si vous venez de connecter Claude vous-même.",
  "connectClaude.lasts":
    "Ce lien fonctionne jusqu'à {time}. Une fois approuvée, elle dure jusqu'à la fin de cette connexion à Claude, 12 heures au plus.",
  "connectClaude.requested":
    "Claude vous a donné ce lien à {time}. Si vous ne venez pas de le demander à Claude, ne l'approuvez pas.",
  "connectClaude.client": "Qui le demande : {client}.",
  "connectClaude.place":
    "La demande vient de {place}. Claude sur le web demande depuis les serveurs d'Anthropic : c'est leur emplacement, pas le vôtre.",
  "connectClaude.confirm": "Le code que Claude vous a montré",
  "connectClaude.confirmHint":
    "Claude affiche un code à 6 chiffres avec ce lien. Saisissez celui que votre propre Claude vous montre, jamais un code envoyé par quelqu'un d'autre.",
  "connectClaude.approve": "Approuver",
  "connectClaude.approving": "Approbation…",
  "connectClaude.approved":
    "Approuvée. Claude peut utiliser Mezonas en votre nom jusqu'à {time}, ou jusqu'à ce que vous vous déconnectiez de Claude.",
  "connectClaude.expired": "Ce lien a expiré. Redemandez à Claude pour en obtenir un nouveau.",
  "connectClaude.unknown":
    "Ce lien ne correspond à aucune de vos connexions Claude. Redemandez à Claude pour en obtenir un nouveau.",
  // ── §1.124: Requests (issues and asks) and requirements forms ──
  "requests.title": "Demandes",
  "requests.lede":
    "Quelque chose ne marche pas, ou une idée pour nous : dites-le ici à votre responsable Mezonas.",
  "requests.new": "Nouvelle demande",
  "requests.empty": "Aucune demande pour l'instant.",
  "requests.state.on_it": "Nous nous en occupons",
  "requests.state.waiting_on_you": "En attente de votre réponse",
  "requests.state.fixed": "Corrigé",
  "requests.state.closed": "Fermé",
  "requests.kind.problem": "Quelque chose ne marche pas",
  "requests.kind.idea": "Une idée ou un changement",
  "requests.kindQuestion": "De quoi s'agit-il ?",
  "requests.service": "Concerne",
  "requests.serviceNone": "Rien de particulier",
  "requests.text": "Dites-nous ce qui s'est passé, ou ce que vous souhaitez",
  "requests.reply": "Écrire à votre responsable Mezonas",
  "requests.replySend": "Envoyer",
  "requests.confirm": "Confirmer que c'est corrigé",
  "requests.stillHappening": "Ça continue",
  "requests.back": "Toutes les demandes",
  "requests.lead": "Votre responsable Mezonas",
  "requests.you": "Vous",
  "requests.number": "Demande n° {n}",
  "requirements.title": "Questions pour votre nouvel agent",
  "requirements.save": "Enregistrer un brouillon",
  "requirements.submit": "Envoyer les réponses",
  "requirements.progress": "{answered} sur {total} répondues",
  "requirements.sent": "Envoyé. Merci : nous prenons le relais.",
  "requirements.due": "À rendre le {date}",
  // ── Access per person (docs/plan.md §1.122) ──
  "access.edit": "Accès",
  "access.title": "Ce que {name} peut faire",
  "access.canSign": "Approuve les changements",
  "access.canSignHelp": "Désactivé : voit le travail de ses agents et n'approuve rien.",
  "access.agents": "Agents avec lesquels la personne travaille",
  "access.allAgents": "Tous les agents",
  "access.someAgents": "Seulement les agents que je choisis",
  "access.noAgents": "Il n'y a pas encore d'agents à choisir.",
  "access.pickOne": "Choisissez au moins un agent, ou tous les agents.",
  "access.adminSeesAll":
    "Les admins travaillent avec tous les agents et approuvent les changements.",
  "access.seesAll": "Travaille avec tous les agents.",
  "access.sees": "Travaille avec {agents}.",
  "access.seesNone": "Ne travaille encore avec aucun agent.",
  "access.save": "Enregistrer",
  "access.cancel": "Annuler",
  "access.saved": "Enregistré. Cela s'applique d'ici 5 minutes.",
  "access.problem": "Nous n'avons pas pu l'enregistrer. Réessayez.",
  "access.problem.lastAdmin": "Votre entreprise a besoin d'au moins un admin.",
  "access.limitedHelp":
    "Les utilisateurs ne voient que les agents que vous leur donnez, avec leurs exécutions et leurs tâches.",
  // ── Getting started (docs/plan.md §1.149.2) ──
  "start.title": "Pour commencer",
  "start.subtitle": "{answered} sur {total} répondues",
  "start.none": "Rien à répondre pour l'instant",
  "start.noneBody": "Quand nous aurons des questions pour vous, elles seront ici.",
  "start.from": "De {name}, votre contact chez Mezonas",
  "start.talk": "Vous préférez en parler ?",
  "start.talk.button": "En parler",
  "start.talkSoon": "Bientôt",
  "start.never":
    "Nous ne demandons jamais de mots de passe, de numéros de carte ni d'accès bancaires.",
  "start.done": "Terminé",
  "start.cardProgress": "{answered} sur {total}",
  "start.more": { one: "Voir 1 question de plus", other: "Voir {count} questions de plus" },
  "start.askedIn": "(posée dans {card})",
  "start.laterNote": {
    one: "Nous poserons 1 autre question plus tard.",
    other: "Nous poserons {count} autres questions plus tard.",
  },
  "start.ask.button": "Demander à quelqu'un d'autre",
  "start.started": "Vous avez choisi de commencer par ceci.",
  "start.notNowChosen": "Pas maintenant. Vous pourrez y revenir.",
  "start.notNow": "Pas maintenant",
  "start.startThis": "Commencer par ceci",
  "start.weThink": "Nous pensons : {text}",
  "start.changed": "Modifié",
  "start.confirmed": "Confirmé",
  "start.save": "Enregistrer",
  "start.cancel": "Annuler",
  "start.yes": "Oui",
  "start.no": "Non",
  "start.change": "Modifier",
  "start.connected": "Connecté",
  "start.notSure": "Pas sûr",
  "start.connectHow": "Vous vous connectez vous-même. Nous ne voyons jamais votre mot de passe.",
  "start.enterKey": "Saisir sa clé",
  "start.adminConnects": "Votre admin connecte les outils.",
  "start.cantConnect": "Impossible pour l'instant",
  "start.answered": "Répondue",
  "start.invalid.number":
    "Nous n'avons pas pu lire ceci comme un nombre. Écrivez-le par exemple 340.",
  "start.invalid.money":
    "Nous n'avons pas pu lire ceci comme un montant. Écrivez-le par exemple 12500.",
  "start.choose": "Choisir…",
  "start.files.added": { one: "1 fichier ajouté", other: "{count} fichiers ajoutés" },
  "start.setup.title": "Configurer vos agents",
  "start.setup.intro":
    "Ce dont chaque agent a besoin de vous avant de commencer. Vos réponses deviennent ses réglages.",
  "start.setup.count": "{done} sur {total} faits",
  "start.setup.waiting": "En attente de vous",
  "start.setup.done": "Fait",
  "start.setup.holdsTrial": "L'essai commence quand les points avant l'essai sont faits.",
  "start.setup.holdsLive": "Il passe en production quand le reste est fait.",
  "start.setup.beforeTrial": "Avant l'essai",
  "start.setup.beforeLive": "Avant la mise en production",
  "start.setup.connect": "Connecter",
  "start.setup.connected": "Connecté",
  "start.setup.answer": "Votre réponse",
  "start.setup.note": "Une note (facultatif)",
  "start.setup.save": "Enregistrer",
  "start.setup.confirm": "Confirmer",
  "start.setup.change": "Modifier",
  "start.setup.addFile": "Ajouter un fichier",
  "start.setup.byName": "Fait par {name} le {date}",
  "start.setup.byUs": "Fait par nous le {date}",
  "start.setup.suggested": "Nous suggérons {value}",
  "start.setup.range": "Entre {min} et {max}",
  "start.setup.setsValue": "Votre réponse devient le réglage de cet agent.",
  "start.setup.adminOnly": "Votre administrateur répond à ces points.",
  "start.ask.who": "Qui",
  "start.ask.pick": "Choisir un collègue",
  "start.ask.new": "Quelqu'un de nouveau",
  "start.ask.name": "Son nom",
  "start.ask.email": "Son e-mail",
  "start.ask.onlyAdmin": "Seul votre admin peut inviter quelqu'un de nouveau.",
  "start.ask.what": "Quoi demander",
  "start.ask.wholeCard": "Toute cette carte",
  "start.ask.note": "Un mot pour cette personne (facultatif)",
  "start.ask.send": "Demander",
  "start.ask.sent": "Nous avons écrit à {name}.",
  "start.ask.added": "{name} s'en occupe maintenant.",
  "start.different.title": "Vous pensez à une autre façon de faire ?",
  "start.different.body":
    "Dites-nous comment vous préféreriez que ça marche. Ce sera transmis à {lead}.",
  "start.different.bodyNoLead":
    "Dites-nous comment vous préféreriez que ça marche. Ce sera transmis à votre contact chez Mezonas.",
  "start.different.sent": "Envoyé. Votre contact chez Mezonas vous répondra.",
  "start.different.send": "Envoyer",
  "start.form.title": "Toutes les questions dans un formulaire",
  "start.connect": "Connecter {name}",
  "start.section.general": "L'entreprise",
  "start.section.general.intro":
    "Quelques questions sur votre entreprise, pour que chaque agent parte de votre façon de travailler.",
  "start.area.purchasing": "Achats",
  "start.area.sales": "Ventes",
  "start.area.receivables": "Encaissements",
  "start.area.bookkeeping": "Comptabilité",
  "start.area.marketing": "Marketing",
  "start.area.intro": "Comment cette partie de votre entreprise fonctionne aujourd'hui.",
  "start.q.general.what": "Que fait votre entreprise, et où ?",
  "start.q.general.team": "Qui fait quoi ? Par exemple, qui tient les comptes et qui achète.",
  "start.q.general.approver": "Qui approuve les paiements et les changements ?",
  "start.q.general.approver.hint": "Un nom et son rôle suffisent.",
  "start.q.general.systems": "Quels outils utilisez-vous au quotidien ?",
  "start.q.general.systems.hint":
    "Par exemple QuickBooks, Gmail, un portail fournisseur, des tableurs.",
  "start.q.general.first":
    "Qu'est-ce qui prend trop de temps aujourd'hui, et que confieriez-vous en premier ?",
  "start.q.general.limits": "Y a-t-il quelque chose qu'un agent ne doit jamais faire ?",
  "start.q.general.limits.hint":
    "Par exemple, ne jamais payer une facture de plus de 5 000 $ sans vous.",
  "start.q.area.today": "Comment ça se passe aujourd'hui, du début à la fin ?",
  "start.q.area.who": "Qui s'en occupe aujourd'hui ?",
  "start.q.area.tools": "Quels outils utilisez-vous pour cela ?",
  "start.q.area.volume": "Combien environ, par mois ?",
  "start.q.area.volume.hint": "Un chiffre approximatif suffit, par exemple 300 factures.",
  "start.q.area.wrong": "Qu'est-ce qui coince, ou prend plus de temps que nécessaire ?",
  "start.fact.business": "L'entreprise",
  "start.fact.people": "Les personnes",
  "start.fact.systems": "Vos outils",
  "start.fact.volumes": "Les volumes",
  "start.fact.processes": "Comment ça marche aujourd'hui",
  "start.fact.pains": "Ce qui pourrait être mieux",
  "start.fact.limits": "Les limites",
  "start.fact.notes": "Autre",
  // ── Connectors C5 (docs/connectors-plan.md §3, §7): the portal's Connectors and a connector's page ──
  "connectors.subtitle":
    "Les outils dans lesquels vos agents travaillent. Vous vous connectez ; vous décidez de ce qu'ils peuvent lire et modifier.",
  "connectors.crumbs": "Où vous êtes",
  "connectors.beta": "Bêta",
  "connectors.mezonas": "Mezonas",
  "connectors.someone": "Quelqu'un de votre équipe",
  "connectors.needs.one": {
    one: "{agent} a besoin de {count} chose de votre part",
    other: "{agent} a besoin de {count} choses de votre part",
  },
  "connectors.needs.many": {
    one: "{count} agent a besoin de quelque chose de votre part",
    other: "{count} agents ont besoin de quelque chose de votre part",
  },
  "connectors.needs.requests": {
    one: "Mezonas demande à modifier {count} connexion.",
    other: "Mezonas demande à modifier {count} connexions.",
  },
  "connectors.needs.toInbox": "Répondez dans votre boîte de réception",
  "connectors.connected.title": "Connectés",
  "connectors.connected.none":
    "Rien n'est encore connecté. Connectez un outil depuis Parcourir, ci-dessous.",
  "connectors.usedByLine": "Utilisé par {names}",
  "connectors.summary.reads": { one: "Lit {count}", other: "Lit {count}" },
  "connectors.summary.ask": {
    one: "modifie {count}, en vous demandant d'abord",
    other: "modifie {count}, en vous demandant d'abord",
  },
  "connectors.summary.alone": { one: "{count} tout seul", other: "{count} tout seuls" },
  "connectors.summary.readsOnly": {
    one: "Lit {count}, ne modifie rien",
    other: "Lit {count}, ne modifie rien",
  },
  "connectors.summary.nothing": "Rien d'autorisé pour l'instant",
  "connectors.row.request": "Modification à approuver",
  "connectors.row.needsSomething": "Il manque quelque chose",
  "connectors.signInAgain": "Se reconnecter",
  "connectors.built.title": "Conçu pour vous",
  "connectors.built.meta": "Uniquement pour votre entreprise",
  "connectors.logins.title": "Identifiants de sites web",
  "connectors.logins.subtitle":
    "Les sites où un agent se connecte pour vous, avec ses propres identifiants",
  "connectors.ask.title": "Demander un connecteur",
  "connectors.ask.help":
    "Vous utilisez un outil absent de la liste ? Dites-nous lequel et ce que l'agent doit y faire.",
  "connectors.ask.lead": "Arrive à votre responsable Mezonas",
  "connectors.ask.tool": "Quel outil",
  "connectors.ask.what": "Que doit y faire l'agent ?",
  "connectors.ask.send": "Envoyer à votre responsable",
  "connectors.ask.sent": "Envoyé. Voir votre demande",
  "connectors.ask.subject": "Un connecteur pour {tool}",
  "connectors.browse.title": "Parcourir",
  "connectors.browse.search": "Rechercher des connecteurs",
  "connectors.browse.recommended": "Recommandés pour vous",
  "connectors.browse.noMatch": "Aucun connecteur ne correspond.",
  "connectors.browse.none": "Pas d'autres connecteurs à vous montrer pour l'instant.",
  "connectors.tile.connected": "Connecté",
  "connectors.how.signIn": "Vous vous connectez",
  "connectors.how.key": "Vous saisissez une clé",
  "connectors.how.none": "Aucune connexion requise",
  "connectors.level.on": "Activé",
  "connectors.level.off": "Désactivé",
  "connectors.level.ask": "Me demander d'abord",
  "connectors.level.alone": "Tout seul",
  "connectors.read.title": "Lire",
  "connectors.read.help": "Ce que les agents peuvent consulter. Lire ne modifie jamais rien.",
  "connectors.read.none": "Rien à lire ici.",
  "connectors.change.title": "Modifier",
  "connectors.change.help":
    "Ce que les agents peuvent écrire. Au départ, seulement ce qui se défait facilement.",
  "connectors.change.none": "Les agents ne modifient rien ici.",
  "connectors.change.deleteOff": "La suppression est toujours désactivée",
  "connectors.change.aloneNote":
    "« Tout seul » n'apparaît que là où votre responsable Mezonas l'a mis en place avec vous. Vous pouvez toujours revenir en arrière.",
  "connectors.row.tools": { one: "{count} outil", other: "{count} outils" },
  "connectors.row.scope": "Seulement : {scope}",
  "connectors.row.needs": "{names} en a besoin",
  "connectors.row.toolsTitle": "Outils",
  "connectors.row.noTools": "Aucun outil ne l'utilise encore.",
  "connectors.row.agentsTitle": "Agents",
  "connectors.row.noAgents": "Aucun agent ne l'utilise.",
  "connectors.row.uses": "l'utilise",
  "connectors.row.needsIt": "en a besoin",
  "connectors.connectAnother": "En connecter un autre",
  "connectors.connectedByYou": "Connecté par vous",
  "connectors.agentsCan": "Ce que les agents peuvent faire",
  "connectors.start.title": "Ce qu'il pourra faire une fois connecté",
  "connectors.start.admin": "Un administrateur de votre entreprise le connecte.",
  "connectors.start.personal": "Chacun dans votre équipe peut connecter le sien.",
  "connectors.start.later": "Vous pourrez tout modifier après la connexion.",
  "connectors.details.show": "Connexion et accès de chaque agent",
  "connectors.details.hide": "Masquer connexion et accès",
  "connectors.for.has": "{agent} a ce qu'il lui faut ici",
  "connectors.for.allowedSome": "Autorisé ce qui était possible pour {agent}",
  "connectors.for.unresolved": "Il faut encore une personne : {needs}",
  "connectors.for.allowedByYou":
    "Autorisé par vous à l'instant. Cela figure dans l'historique de ce connecteur.",
  "connectors.for.needsThis": "{agent} en a besoin",
  "connectors.for.needsMore": {
    one: "{agent} a besoin de {count} chose de plus ici",
    other: "{agent} a besoin de {count} choses de plus ici",
  },
  "connectors.for.connectTurnsOn":
    "La connexion active ce dont {agent} a besoin, en vous demandant d'abord.",
  "connectors.for.asks": "Chacune attend toujours votre approbation avant d'être écrite.",
  "connectors.for.ours": "Votre responsable Mezonas fait le reste : {words}",
  "connectors.for.adminAllows": "Un administrateur de votre entreprise peut l'autoriser.",
  "connectors.for.allow": "Autoriser ce dont {agent} a besoin",
  "connectors.usedBy.title": "Utilisé par",
  "connectors.usedBy.none": "Aucun agent n'utilise encore cette connexion.",
  "connectors.usedBy.ready": "A ce qu'il lui faut",
  "connectors.usedBy.needsCount": { one: "Il en manque {count}", other: "Il en manque {count}" },
  "connectors.usedBy.needs": "Il lui faut : {needs}",
  "connectors.history.title": "Historique",
  "connectors.history.none": "Aucune modification pour l'instant.",
  "connectors.history.system": "Configuration",
  "connectors.history.fromRequest": "approuvé à partir de la demande de Mezonas",
  "connectors.history.underGoAhead": "avec votre accord du {date}",
  "connectors.history.all": { one: "Tout afficher ({count})", other: "Tout afficher ({count})" },
  "connectors.history.fewer": "Afficher moins",
  "connectors.may.title": "Modifications par Mezonas",
  "connectors.may.help":
    "Ce que votre responsable Mezonas peut modifier ici sans vous demander à chaque fois.",
  "connectors.may.ask": "Me demander à chaque fois",
  "connectors.may.askHelp":
    "Chaque modification qui permet aux agents d'en faire plus arrive dans votre boîte de réception pour approbation.",
  "connectors.may.needs": "Autoriser ce dont les agents ont besoin",
  "connectors.may.needsHelp":
    "Mezonas peut activer ici ce dont vos agents ont besoin, en vous demandant avant chaque écriture. Tout le reste vous parvient toujours.",
  "connectors.may.any": "Autoriser toute modification",
  "connectors.may.anyHelp":
    "Mezonas peut modifier n'importe quelle ligne et la configuration de cet outil, jusqu'à « Me demander d'abord ».",
  "connectors.may.howLong": "Pour combien de temps",
  "connectors.may.untilOff": "Jusqu'à ce que je l'arrête",
  "connectors.may.days30": "Pendant 30 jours",
  "connectors.may.setUntil": "Défini par {name} le {date}, jusqu'au {until}.",
  "connectors.may.setUntilOff": "Défini par {name} le {date}, jusqu'à ce que vous l'arrêtiez.",
  "connectors.may.ended":
    "Ce que {name} avait autorisé a pris fin le {date} : Mezonas vous demande à nouveau à chaque fois.",
  "connectors.may.note":
    "Vous êtes informé de chaque modification et pouvez annuler chacune ici. « Tout seul » demande toujours votre accord.",
  "connectors.may.adminOnly": "Seul un administrateur de votre entreprise peut le modifier.",
  "connectors.request.title": "Mezonas demande à modifier l'accès à {tool}",
  "connectors.request.forAgent": "Pour {agent}",
  "connectors.request.askedBy": "demandé par {name}, votre responsable Mezonas",
  "connectors.request.why": "Pourquoi",
  "connectors.request.to": "devient",
  "connectors.request.approved": "Approuvé",
  "connectors.request.declined": "Refusé",
  "connectors.request.replaced": "Remplacé",
  "connectors.request.expired": "Expiré",
  "connectors.request.withdrawn": "Retiré",
  "connectors.request.answered": "Répondu",
  "connectors.request.outOfDate": "Plus à jour",
  "connectors.request.outOfDateWords":
    "Plus à jour : cette connexion a changé depuis la demande de Mezonas, l'approuver ne changerait donc rien. Votre responsable en enverra une nouvelle.",
  "connectors.request.nothingUntil": "Rien ne change tant que vous n'approuvez pas.",
  "connectors.request.ends": "Elle prend fin le {date} si personne ne répond.",
  "connectors.request.note": "Une note en retour (facultatif)",
  "connectors.request.addNote": "Ajouter une note",
  "connectors.request.approve": "Approuver",
  "connectors.request.decline": "Refuser",
  "connectors.request.approvedNow":
    "Approuvé par vous à l'instant. Cela figure dans l'historique de {tool} avec la demande.",
  "connectors.request.declinedNow":
    "Refusé par vous à l'instant. Rien n'a changé ; votre responsable est informé.",
  "connectors.request.closed": "Cette demande n'est plus ouverte.",
  "connectors.request.answeredBy": "Répondu par {name}",
  "connectors.request.adminAnswers": "Un administrateur de votre entreprise y répond.",
  "connectors.request.openPage": "Ouvrir {tool}",
  "connectors.notice.tightened": "{name} a rendu {tool} plus sûr. C'est appliqué tout de suite.",
  "connectors.notice.authorized": "{name} a modifié {tool} avec votre accord.",
  "connectors.notice.underNeeds":
    "Vous avez permis à Mezonas de faire les modifications dont les agents ont besoin sur {tool}, le {date}.",
  "connectors.notice.underAny":
    "Vous avez permis à Mezonas de faire toute modification sur {tool}, le {date}.",
  "connectors.notice.undo": "L'annuler ou le modifier sur la page de {tool}",
  "agent.reachReady": "Prêt",
  "agent.reachNeeds": "Il manque quelque chose",

  // ── setup: people ── Getting started: chapters and Your people (SU2)
  "setup.trial.title": "Avant l'essai de chaque agent",
  "setup.trial.hint": "Ce qui reste, et qui on attend",
  "setup.left": { one: "1 restant", other: "{count} restants" },
  "setup.ready": "Prêt pour son essai",
  "setup.who.you": "vous",
  "setup.minutes": {
    one: "Environ une minute restante. Vous pouvez vous arrêter et reprendre ici.",
    other: "Environ {count} minutes restantes. Vous pouvez vous arrêter et reprendre ici.",
  },
  "setup.chapters": "Chapitres",
  "setup.chapters.hint": "Dans l'ordre de votre choix",
  "setup.chapter.business": "Votre entreprise",
  "setup.chapter.tools": "Vos outils",
  "setup.chapter.people": "Votre équipe",
  "setup.chapter.see": "Voyez-le travailler",
  "setup.chapter.live": "Mise en service",
  "setup.chapter.business.about":
    "Les questions sur votre façon de travailler, et celles de chaque agent.",
  "setup.chapter.tools.about":
    "Connectez les outils où travaillent les agents. Vous vous connectez sur la page de chaque outil.",
  "setup.chapter.people.about": "Qui approuve, qui répond, et qui est informé.",
  "setup.chapter.see.about":
    "Lisez chaque étape avec vos propres noms, puis essayez-le sur un vrai document.",
  "setup.chapter.live.about":
    "Signez votre périmètre. Puis un essai de deux semaines où vous signez chaque changement.",
  "setup.state.done": "Terminé",
  "setup.state.open": "{done} sur {total}",
  "setup.state.notStarted": "Pas commencé",
  "setup.state.notNeeded": "Rien à faire",
  "setup.frame.eyebrow": "Chapitre {n} sur 5",
  "setup.frame.back": "Retour à Pour commencer",
  "setup.frame.next": "Ensuite : {chapter}",
  "setup.notBuilt": "Ce chapitre arrive bientôt",
  "setup.notBuiltBody": "En attendant, votre responsable vous accompagnera.",
  "setup.people.intro":
    "Nous avons rempli ce que vous nous avez dit ; vérifiez chacun. Les approbations restent actives : ceci décide qui signe, pas s'il faut signer.",
  "setup.people.kind.signs": "Signe",
  "setup.people.kind.answers": "Répond",
  "setup.people.kind.told": "Informé",
  "setup.people.kind.reached": "Contacté",
  "setup.people.checked": "Vérifié",
  "setup.people.toCheck": "À vérifier",
  "setup.people.weThink": "Nous pensons : {names}, d'après votre réponse « {from} ».",
  "setup.people.yes": "Oui",
  "setup.people.change": "Modifier",
  "setup.people.backup": "En cas d'absence",
  "setup.people.add": "Ajouter quelqu'un",
  "setup.people.addBackup": "Ajouter un remplaçant",
  "setup.people.remove": "Retirer {name}",
  "setup.people.choose": "Choisissez quelqu'un",
  "setup.people.signsIn": "Se connecte",
  "setup.people.notJoined": "Invité, pas encore connecté",
  "setup.people.viewer": "Lecture seule",
  "setup.people.byEmail": "Informé par e-mail",
  "setup.people.you": "Vous",
  "setup.people.nobody": "Personne pour l'instant. En attendant, votre administrateur le reçoit.",
  "setup.people.inviteNew": "Quelqu'un de nouveau ? Invitez-le d'abord dans Équipe.",
  "setup.people.adminOnly": "Votre administrateur remplit ces rôles.",
  "setup.people.matrix": "Voir qui fait quoi dans la procédure de {agent}",
  "setup.people.looksRight": "C'est bon",
  "setup.people.confirmed": "Vérifié par {name}",
  "setup.people.none": "Vos agents n'ont encore besoin de personne.",
  "setup.people.notSigner":
    "Cette personne ne peut que consulter, elle ne peut donc pas approuver. Modifiez cela dans Équipe.",
  // (end setup: people)

  // ── setup: tools ── Getting started: Your tools (SU3)
  "setup.tools.intro":
    "Les agents travaillent dans vos propres comptes. Vous vous connectez sur la page de chaque outil ; nous ne voyons jamais de mot de passe.",
  "setup.tools.none": "Vos agents n'ont encore besoin d'aucun outil.",
  "setup.tools.adminOnly": "Votre administrateur les connecte et les vérifie.",
  "setup.tools.usedBy": "Utilisé par {agents}",
  "setup.tools.connected": "Connecté",
  "setup.tools.waitingYou": "En attente de vous",
  "setup.tools.waitingOn": "En attente de {name}",
  "setup.tools.account":
    "Vous vous êtes connecté à {account}. Est-ce l'entreprise que les agents doivent utiliser ?",
  "setup.tools.accountChecked":
    "Vous vous êtes connecté à {account}. Les agents utilisent cette entreprise.",
  "setup.tools.yes": "Oui",
  "setup.tools.different": "Une autre entreprise",
  "setup.tools.checked": "Vérifié",
  "setup.tools.reads": "Nous lirons",
  "setup.tools.changes": "Nous pouvons modifier",
  "setup.tools.never": "Jamais",
  "setup.tools.nothing": "Rien",
  "setup.tools.asksFirst": "Nous vous demandons d'abord, à chaque fois.",
  "setup.tools.access": "Voir et régler ce que les agents peuvent faire dans {tool}",
  "setup.tools.whoSignsIn": "Qui se connecte à {tool} ?",
  "setup.tools.connect": "Moi : connecter {tool}",
  "setup.tools.someoneElse": "Quelqu'un d'autre",
  "setup.tools.sendTo": "Envoyer seulement cette carte à",
  "setup.tools.choose": "Choisissez quelqu'un",
  "setup.tools.send": "Envoyer",
  "setup.tools.asked": "Nous l'avons demandé à {name}. C'est dans sa boîte de réception.",
  "setup.tools.askedYou": "On vous a demandé de connecter celui-ci.",
  "setup.tools.adminConnects": "Votre administrateur le connecte.",
  "setup.tools.cannotConnect":
    "Seul un administrateur peut connecter {tool}. Nommez cette personne administrateur dans Équipe, ou connectez-le vous-même.",
  "setup.tools.noOne":
    "Il n'y a encore personne d'autre dans votre équipe. Invitez cette personne d'abord dans Équipe.",
  "setup.tools.lookTitle": "Ce que nous voyons dans {tool}",
  "setup.tools.lookHint":
    "Compté à partir de vos données, pas deviné. Vérifiez chaque ligne et les agents partent de là.",
  // (end setup: tools)

  // ── setup: see ── Getting started: See it work (SU4, SU5)
  "setup.see.none": "Aucun agent n'est en cours de configuration.",
  "setup.see.pick": "Choisissez un agent pour voir comment il travaille.",
  "setup.see.agents": "Agents en configuration",
  "setup.see.intro":
    "Comment {name} fera le travail, avec vos équipes et vos outils. Dites-nous à chaque étape qui ne correspond pas à votre façon de faire.",
  "setup.see.readOnly":
    "Vous pouvez lire comment il travaille. Une personne de votre équipe qui peut signer dit ce qui est juste et l'essaie.",
  "setup.see.steps": "Comment il travaille",
  "setup.see.noSteps": "Il n'y a pas encore d'étapes à lire.",
  "setup.see.person": "Personne",
  "setup.see.who": "Qui : {name}",
  "setup.see.asksFirst": "Demande d'abord à {names}",
  "setup.see.told": "Prévient {names}",
  "setup.see.otherwise": "Sinon",
  "setup.see.looksRight": "C'est juste",
  "setup.see.lookedRight": "C'est juste",
  "setup.see.lookedRightBy": "C'est juste · {name}",
  "setup.see.different": "Nous faisons autrement",
  "setup.see.differentLabel": "Comment faites-vous ?",
  "setup.see.differentHint":
    "Avec vos mots. Rien ne change avant que vous ayez vu la modification.",
  "setup.see.sendTo": "Envoyer à {lead}",
  "setup.see.youSaid": "Vous avez dit : « {text} »",
  "setup.see.withLead":
    "{lead} s'en occupe. Nous vous montrerons la modification avant qu'elle serve.",
  "setup.see.withUs":
    "Nous nous en occupons. Nous vous montrerons la modification avant qu'elle serve.",
  "setup.see.request": "Demande n° {number}",
  "setup.see.asked": "Envoyé",
  "setup.see.try.title": "Essayez-le sur un vrai cas",
  "setup.see.try.hint": "Un essai : rien n'est écrit dans vos outils et personne n'est sollicité",
  "setup.see.try.left": {
    one: "Il reste 1 essai sur {max}.",
    other: "Il reste {count} essais sur {max}.",
  },
  "setup.see.try.usedUp": "Demandez-nous si vous en voulez un autre.",
  "setup.see.try.usedUpLead": "Demandez à {lead} si vous en voulez un autre.",
  "setup.see.try.wait": "Un essai est en cours. Le suivant pourra démarrer une fois terminé.",
  "setup.see.try.none":
    "Il n'y a encore rien sur quoi l'essayer. Dès qu'un document qu'il traite arrive, il apparaît ici.",
  "setup.see.try.from": "De {from}, {when}",
  "setup.see.try.this": "Essayer celui-ci",
  "setup.see.try.badge": "Essai · rien d'écrit ni d'envoyé",
  "setup.see.try.status.running": "En cours",
  "setup.see.try.status.done": "Terminé",
  "setup.see.try.status.failed": "Arrêté",
  "setup.see.try.starting": "Démarrage. Les étapes s'affichent ici au fur et à mesure.",
  "setup.see.try.state.done": "Terminé",
  "setup.see.try.state.running": "En cours",
  "setup.see.try.state.waiting": "Attendrait ici",
  "setup.see.try.state.skipped": "Ignoré",
  "setup.see.try.state.failed": "N'a pas marché",
  "setup.see.try.right": "Juste",
  "setup.see.try.notRight": "Pas juste parce que…",
  "setup.see.try.because": "Qu'aurait-il dû faire ?",
  "setup.see.try.saidRight": "Vous avez dit : juste",
  "setup.see.try.saidNotRight": "Vous avez dit : pas juste.",
  // (end setup: see)

  // ── setup: live ── Getting started: Go live (SU6)
  "setup.live.none": "Aucun agent n'attend sa mise en service.",
  "setup.live.pick": "Choisissez un agent pour lire son périmètre.",
  "setup.live.signed": "Signé",
  "setup.live.toSign": "À signer",
  "setup.live.eyebrow": "Périmètre · {agent} · version {version}",
  "setup.live.does": "Ce qu'il fait",
  "setup.live.reads": "Ce qu'il lit",
  "setup.live.changes": "Ce qu'il peut modifier",
  "setup.live.signs": "Qui signe",
  "setup.live.answers": "Qui répond",
  "setup.live.choices": "Vos choix",
  "setup.live.open": "Encore ouvert",
  "setup.live.nothing": "Rien",
  "setup.live.waiting": "En attente de vous",
  "setup.live.waitingAdmin": "En attente de votre administrateur",
  "setup.live.yourScope": "Votre périmètre",
  "setup.live.ready": "Votre {agent} est prêt pour son essai.",
  "setup.live.signBody": "Signez le périmètre ci-dessus et {lead} lance l'essai.",
  "setup.live.adminSigns": "Votre administrateur signe le périmètre. Puis {lead} lance l'essai.",
  "setup.live.signedBy": "Signé par {name} le {date}. {lead} lance l'essai.",
  "setup.live.signedOlder":
    "La version {version} a été signée. Cette version a changé : il faut la signer à nouveau.",
  "setup.live.yourLead": "votre interlocuteur",
  "setup.live.checkedBy": "Vérifié par {lead}, votre interlocuteur",
  "setup.live.sign": "Signer",
  "setup.live.next": "La suite",
  "setup.live.next.today": "Aujourd'hui",
  "setup.live.next.todayBody": "Vous signez le périmètre.",
  "setup.live.next.start": "Ensuite",
  "setup.live.next.startBody": "{lead} lance l'essai. Il ne démarre jamais tout seul.",
  "setup.live.next.trial": "{days} jours",
  "setup.live.next.trialBody":
    "Vous signez chaque changement sur votre bureau avant qu'il soit fait. Si quelque chose ne va pas, dites-le sur l'élément.",
  "setup.live.next.checkin": "Jour 7",
  "setup.live.next.checkinBody": "Un point avec {lead}.",
  "setup.live.next.after": "Après l'essai",
  "setup.live.next.afterBody":
    "Vous décidez de ce qui peut se faire sans vous demander. Les approbations restent actives sauf si vous les changez.",
  "setup.live.fromCall": "De notre appel : merci de vérifier",
  // (end setup: live)
};
