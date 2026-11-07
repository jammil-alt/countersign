// The supervisor's words for the client admin (docs/plan.md §1.28): each finding's title and the
// plain steps the client can take, in each language. The Worker writes them into the client
// admin's inbox item, so they live here beside the timeline and release words (§1.18), not in the
// portal's bundle. They name only what the client sees (an agent, a tool, a website): never an
// agent's version, step, error or anything a model wrote.
import type { FindingKind } from "../supervisor/health";
import type { Locale } from "./locale";

export interface FindingParams {
  /** The agent's name as the client sees it. */
  service?: string;
  /** The tool's name (`QuickBooks`, `Zoho CRM`). */
  connector?: string;
  /** A website's name or address. */
  site?: string;
  count?: number;
}

export interface FindingWords {
  title(p: FindingParams): string;
  steps(p: FindingParams): string[];
}

type Words = Record<FindingKind, FindingWords>;

const s = (p: FindingParams, key: keyof FindingParams, fallback: string) =>
  String(p[key] ?? fallback);

export const SUPERVISOR_WORDS: Record<Locale, Words> = {
  en: {
    run_failed: {
      title: (p) => `${s(p, "service", "An agent")} could not finish its work`,
      steps: (p) => [
        "Nothing for you to do yet: we have the details and are on it.",
        `To see what it did finish: Runs, ${s(p, "service", "the agent")}.`,
      ],
    },
    connection_signin: {
      title: (p) => `${s(p, "connector", "A tool")} needs you to sign in again`,
      steps: (p) => [
        "Go to Accounts.",
        `Find ${s(p, "connector", "the tool")}.`,
        "Choose Reconnect and follow the steps.",
      ],
    },
    connection_sync: {
      title: (p) => `${s(p, "connector", "A tool")} stopped updating`,
      steps: (p) => [
        `Go to Accounts and check that ${s(p, "connector", "the tool")} shows as connected.`,
        "If it doesn't, choose Reconnect and follow the steps.",
        "We are looking at it too.",
      ],
    },
    login_stopped: {
      title: (p) => `We stopped signing in to ${s(p, "site", "a website")}`,
      steps: () => [
        "Check that the agent account can still sign in to the website.",
        "Go to Accounts and enter its login again.",
      ],
    },
    code_alert: {
      title: () => "Someone may be trying an agent account",
      steps: () => [
        "Ask your team whether anyone tried to sign in with the agent account.",
        "If nobody did, change its password on the website, then enter it again on Accounts.",
      ],
    },
    waiting_long: {
      title: (p) =>
        p.count === 1
          ? "1 item is still waiting for you"
          : `${p.count ?? 0} items are still waiting for you`,
      steps: () => ["Go to Your Desk.", "Approve, answer or decline each one."],
    },
  },
  es: {
    run_failed: {
      title: (p) => `${s(p, "service", "Un agente")} no pudo terminar su trabajo`,
      steps: (p) => [
        "Por ahora no tiene que hacer nada: tenemos los detalles y nos ocupamos.",
        `Para ver lo que sí terminó: Ejecuciones, ${s(p, "service", "el agente")}.`,
      ],
    },
    connection_signin: {
      title: (p) => `${s(p, "connector", "Una herramienta")} necesita que inicie sesión de nuevo`,
      steps: (p) => [
        "Vaya a Cuentas.",
        `Busque ${s(p, "connector", "la herramienta")}.`,
        "Elija Volver a conectar y siga los pasos.",
      ],
    },
    connection_sync: {
      title: (p) => `${s(p, "connector", "Una herramienta")} dejó de actualizarse`,
      steps: (p) => [
        `Vaya a Cuentas y compruebe que ${s(p, "connector", "la herramienta")} aparece como conectada.`,
        "Si no es así, elija Volver a conectar y siga los pasos.",
        "Nosotros también lo estamos revisando.",
      ],
    },
    login_stopped: {
      title: (p) => `Dejamos de iniciar sesión en ${s(p, "site", "un sitio web")}`,
      steps: () => [
        "Compruebe que la cuenta del agente todavía puede iniciar sesión en el sitio web.",
        "Vaya a Cuentas e introduzca sus datos de acceso de nuevo.",
      ],
    },
    code_alert: {
      title: () => "Puede que alguien esté intentando entrar en una cuenta de agente",
      steps: () => [
        "Pregunte a su equipo si alguien intentó iniciar sesión con la cuenta del agente.",
        "Si nadie lo hizo, cambie su contraseña en el sitio web y vuelva a introducirla en Cuentas.",
      ],
    },
    waiting_long: {
      title: (p) =>
        p.count === 1
          ? "1 elemento sigue esperándole"
          : `${p.count ?? 0} elementos siguen esperándole`,
      steps: () => ["Vaya a Su escritorio.", "Apruebe, responda o rechace cada uno."],
    },
  },
  fr: {
    run_failed: {
      title: (p) => `${s(p, "service", "Un agent")} n'a pas pu terminer son travail`,
      steps: (p) => [
        "Rien à faire pour l'instant : nous avons les détails et nous nous en occupons.",
        `Pour voir ce qui a été terminé : Exécutions, ${s(p, "service", "l'agent")}.`,
      ],
    },
    connection_signin: {
      title: (p) => `${s(p, "connector", "Un outil")} vous demande de vous reconnecter`,
      steps: (p) => [
        "Allez dans Comptes.",
        `Trouvez ${s(p, "connector", "l'outil")}.`,
        "Choisissez Reconnecter et suivez les étapes.",
      ],
    },
    connection_sync: {
      title: (p) => `${s(p, "connector", "Un outil")} ne se met plus à jour`,
      steps: (p) => [
        `Allez dans Comptes et vérifiez que ${s(p, "connector", "l'outil")} apparaît comme connecté.`,
        "Sinon, choisissez Reconnecter et suivez les étapes.",
        "Nous regardons aussi de notre côté.",
      ],
    },
    login_stopped: {
      title: (p) => `Nous avons arrêté de nous connecter à ${s(p, "site", "un site web")}`,
      steps: () => [
        "Vérifiez que le compte de l'agent peut toujours se connecter au site web.",
        "Allez dans Comptes et saisissez à nouveau ses identifiants.",
      ],
    },
    code_alert: {
      title: () => "Quelqu'un essaie peut-être d'accéder à un compte d'agent",
      steps: () => [
        "Demandez à votre équipe si quelqu'un a essayé de se connecter avec le compte de l'agent.",
        "Si personne ne l'a fait, changez son mot de passe sur le site web, puis saisissez-le à nouveau dans Comptes.",
      ],
    },
    waiting_long: {
      title: (p) =>
        (p.count ?? 0) <= 1
          ? `${p.count ?? 0} élément vous attend toujours`
          : `${p.count} éléments vous attendent toujours`,
      steps: () => ["Allez dans Votre bureau.", "Approuvez, répondez ou refusez chacun."],
    },
  },
  "pt-BR": {
    run_failed: {
      title: (p) => `${s(p, "service", "Um agente")} não conseguiu terminar o trabalho`,
      steps: (p) => [
        "Nada a fazer por enquanto: temos os detalhes e estamos cuidando disso.",
        `Para ver o que foi concluído: Execuções, ${s(p, "service", "o agente")}.`,
      ],
    },
    connection_signin: {
      title: (p) => `${s(p, "connector", "Uma ferramenta")} precisa que você entre de novo`,
      steps: (p) => [
        "Vá para Contas.",
        `Encontre ${s(p, "connector", "a ferramenta")}.`,
        "Escolha Reconectar e siga os passos.",
      ],
    },
    connection_sync: {
      title: (p) => `${s(p, "connector", "Uma ferramenta")} parou de atualizar`,
      steps: (p) => [
        `Vá para Contas e confira se ${s(p, "connector", "a ferramenta")} aparece como conectada.`,
        "Se não aparecer, escolha Reconectar e siga os passos.",
        "Nós também estamos verificando.",
      ],
    },
    login_stopped: {
      title: (p) => `Paramos de entrar em ${s(p, "site", "um site")}`,
      steps: () => [
        "Confira se a conta do agente ainda consegue entrar no site.",
        "Vá para Contas e informe o login dela de novo.",
      ],
    },
    code_alert: {
      title: () => "Alguém pode estar tentando usar uma conta de agente",
      steps: () => [
        "Pergunte à sua equipe se alguém tentou entrar com a conta do agente.",
        "Se ninguém tentou, troque a senha no site e informe-a de novo em Contas.",
      ],
    },
    waiting_long: {
      title: (p) =>
        p.count === 1
          ? "1 item ainda espera por você"
          : `${p.count ?? 0} itens ainda esperam por você`,
      steps: () => ["Vá para Sua mesa.", "Aprove, responda ou recuse cada um."],
    },
  },
  it: {
    run_failed: {
      title: (p) => `${s(p, "service", "Un agente")} non è riuscito a finire il lavoro`,
      steps: (p) => [
        "Per ora non devi fare nulla: abbiamo i dettagli e ce ne stiamo occupando.",
        `Per vedere cosa ha completato: Esecuzioni, ${s(p, "service", "l'agente")}.`,
      ],
    },
    connection_signin: {
      title: (p) => `${s(p, "connector", "Uno strumento")} va ricollegato`,
      steps: (p) => [
        "Vai in Account.",
        `Trova ${s(p, "connector", "lo strumento")}.`,
        "Scegli Ricollega e segui i passaggi.",
      ],
    },
    connection_sync: {
      title: (p) => `${s(p, "connector", "Uno strumento")} non si aggiorna più`,
      steps: (p) => [
        `Vai in Account e controlla che ${s(p, "connector", "lo strumento")} risulti collegato.`,
        "Se non lo è, scegli Ricollega e segui i passaggi.",
        "Lo stiamo controllando anche noi.",
      ],
    },
    login_stopped: {
      title: (p) => `Abbiamo smesso di accedere a ${s(p, "site", "un sito")}`,
      steps: () => [
        "Controlla che l'account dell'agente possa ancora accedere al sito.",
        "Vai in Account e inserisci di nuovo le sue credenziali.",
      ],
    },
    code_alert: {
      title: () => "Qualcuno potrebbe provare ad accedere a un account di agente",
      steps: () => [
        "Chiedi al tuo team se qualcuno ha provato ad accedere con l'account dell'agente.",
        "Se nessuno l'ha fatto, cambia la password sul sito e poi inseriscila di nuovo in Account.",
      ],
    },
    waiting_long: {
      title: (p) =>
        p.count === 1
          ? "1 elemento ti sta ancora aspettando"
          : `${p.count ?? 0} elementi ti stanno ancora aspettando`,
      steps: () => ["Vai nella tua scrivania.", "Approva, rispondi o rifiuta ciascuno."],
    },
  },
  de: {
    run_failed: {
      title: (p) => `${s(p, "service", "Ein Agent")} konnte seine Arbeit nicht abschließen`,
      steps: (p) => [
        "Im Moment ist nichts zu tun: Wir haben die Details und kümmern uns darum.",
        `Was erledigt wurde, sehen Sie unter Abläufe, ${s(p, "service", "der Agent")}.`,
      ],
    },
    connection_signin: {
      title: (p) => `${s(p, "connector", "Ein Tool")} braucht eine neue Anmeldung`,
      steps: (p) => [
        "Gehen Sie zu Konten.",
        `Suchen Sie ${s(p, "connector", "das Tool")}.`,
        "Wählen Sie Neu verbinden und folgen Sie den Schritten.",
      ],
    },
    connection_sync: {
      title: (p) => `${s(p, "connector", "Ein Tool")} wird nicht mehr aktualisiert`,
      steps: (p) => [
        `Gehen Sie zu Konten und prüfen Sie, ob ${s(p, "connector", "das Tool")} als verbunden angezeigt wird.`,
        "Falls nicht, wählen Sie Neu verbinden und folgen Sie den Schritten.",
        "Wir sehen es uns ebenfalls an.",
      ],
    },
    login_stopped: {
      title: (p) => `Wir melden uns nicht mehr bei ${s(p, "site", "einer Website")} an`,
      steps: () => [
        "Prüfen Sie, ob sich das Agentenkonto noch auf der Website anmelden kann.",
        "Gehen Sie zu Konten und geben Sie die Zugangsdaten erneut ein.",
      ],
    },
    code_alert: {
      title: () => "Jemand versucht möglicherweise, ein Agentenkonto zu nutzen",
      steps: () => [
        "Fragen Sie Ihr Team, ob sich jemand mit dem Agentenkonto anmelden wollte.",
        "Wenn nicht, ändern Sie das Passwort auf der Website und geben Sie es unter Konten erneut ein.",
      ],
    },
    waiting_long: {
      title: (p) =>
        p.count === 1
          ? "1 Eintrag wartet noch auf Sie"
          : `${p.count ?? 0} Einträge warten noch auf Sie`,
      steps: () => [
        "Gehen Sie zu Ihrem Schreibtisch.",
        "Genehmigen, beantworten oder lehnen Sie jeden ab.",
      ],
    },
  },
};

/** A finding's title and steps for the client admin, in the client's language. */
export function findingText(
  locale: Locale,
  kind: FindingKind,
  params: FindingParams,
): { title: string; steps: string[] } {
  const w = SUPERVISOR_WORDS[locale][kind];
  return { title: w.title(params).slice(0, 200), steps: w.steps(params) };
}
