// The vault's parts (ARCHITECTURE §6.9, docs/plan.md §1.26), shown on the portal's Accounts page
// (C4): each way into the client's tools (a connection), whether its secret is stored (never the
// secret), and each agent that can use it with what. The client admin enters a login (write-only),
// sets a website login up, tightens or revokes an agent's access (never loosens: only we do), and
// disconnects; a client user sees all of it read-only. The API enforces the same rules.
import type { GrantLimits, PermissionLevel, Verb } from "@countersign/core";
import { type ReactNode, useState } from "react";
import type { ResponseOf } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApiClient } from "../api/useApi";
import { ConnectorMark } from "../connections/ConnectorMark";
import { isLooser, LEVEL_LABEL, LEVELS, levelTone, VERB_LABEL, VERBS } from "../connections/matrix";
import type { PlainKey } from "../i18n/catalog";
import { useI18n } from "../i18n/i18n";
import { ReleaseSection } from "../portal/screens/AccessRelease";
import { shortTime } from "../runs/format";
import { AgentBadge } from "../ui/badges";
import { Field, Select, TextInput } from "../ui/forms";
import { Badge, Button, ErrorNotice } from "../ui/primitives";
import { StatusChip } from "../ui/status";

export type VaultView = ResponseOf<typeof apiRoutes.portalAccess>;
export type VaultItem = VaultView["items"][number];
type View = VaultView;
type Item = VaultItem;
type Setup = View["setup"][number];
type SiteOffer = View["browserSites"][number];
type BrowserInfo = NonNullable<Item["browser"]>;
type Tier = SiteOffer["tier"];
type AgentAccess = Item["agents"][number];

const TIER_LABEL: Record<Tier, PlainKey> = {
  low: "vault.browser.tier.low",
  medium: "vault.browser.tier.medium",
  high: "vault.browser.tier.high",
  blocked: "vault.browser.tier.blocked",
};
const TIER_HELP: Record<Tier, PlainKey> = {
  low: "vault.browser.tierHelp.low",
  medium: "vault.browser.tierHelp.medium",
  high: "vault.browser.tierHelp.high",
  blocked: "vault.browser.tierHelp.blocked",
};
// Copper is people (a person signs in at high tier); blocked is a risk; the rest is plain.
const TIER_TONE: Record<Tier, "neutral" | "person" | "risk"> = {
  low: "neutral",
  medium: "neutral",
  high: "person",
  blocked: "risk",
};

export function TierBadge({ tier }: { tier: Tier }) {
  const { t } = useI18n();
  return (
    <Badge tone={TIER_TONE[tier]} testId="vault-browser-tier">
      {t(TIER_LABEL[tier])}
    </Badge>
  );
}

const KIND_LABEL: Record<Item["kind"], PlainKey> = {
  oauth: "vault.kind.oauth",
  api_key: "vault.kind.api_key",
  browser: "vault.kind.browser",
  built_in: "vault.kind.built_in",
};

/**
 * Whether a vault item waits on the client: a website login that stopped, or a login nobody has
 * entered yet. A signed-in tool's trouble shows on its connection instead.
 */
export function vaultItemNeedsYou(item: Item): boolean {
  if (item.kind !== "browser" && item.kind !== "api_key") return false;
  return Boolean(item.browser?.stopped) || (item.credentialForm && !item.secret.set);
}

/** A vault item's state in words: working, needs you, or the connection's own status. */
function VaultStateChip({ item }: { item: Item }) {
  const { t } = useI18n();
  if (item.browser?.stopped) {
    return (
      <StatusChip state="waiting" testId="vault-item-state">
        {t("accounts.vault.needsYou")}
      </StatusChip>
    );
  }
  if (vaultItemNeedsYou(item)) {
    return (
      <StatusChip state="waiting" testId="vault-item-state">
        {t("accounts.vault.needsLogin")}
      </StatusChip>
    );
  }
  return item.status === "connected" ? (
    <StatusChip state="done" testId="vault-item-state">
      {t("accounts.vault.working")}
    </StatusChip>
  ) : (
    <StatusChip state="idle" testId="vault-item-state">
      {t("accounts.vault.notInUse")}
    </StatusChip>
  );
}

/**
 * "Your vault" (C4's right rail): the logins for sites without a connection, each with its state
 * and the agents that use it, and (for the client admin) the sites a login can be set up on.
 */
export function VaultCard({
  view,
  items,
  adding,
  onAdding,
  onChanged,
}: {
  view: View;
  /** The items this card lists (the page shows signed-in tools on their own cards). */
  items: Item[];
  adding: boolean;
  onAdding: (open: boolean) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const offers = view.canEdit ? view.browserSites : [];
  const setups = view.canEdit ? view.setup : [];
  return (
    <div className="ds-card" data-testid="vault-card">
      <div className="ui-card__head">
        <div className="min-w-0">
          <h2 className="type-subheading text-ink">{t("accounts.vault.title")}</h2>
          <p className="text-sm text-ink-muted">{t("accounts.vault.subtitle")}</p>
        </div>
        {view.canEdit ? (
          <Button
            size="sm"
            data-testid="vault-add"
            aria-expanded={adding}
            onClick={() => onAdding(!adding)}
          >
            {adding ? t("accounts.vault.closeAdd") : t("accounts.vault.add")}
          </Button>
        ) : null}
      </div>
      <p className="ui-card__body text-sm text-ink-muted">{t("accounts.vault.note")}</p>
      {adding && view.canEdit ? (
        <div
          className="flex flex-col gap-5 border-t border-line px-6 py-4"
          data-testid="vault-add-panel"
        >
          {offers.length > 0 ? (
            <section data-testid="vault-browser-setup" className="flex flex-col gap-3">
              <h3 className="eyebrow text-ink-muted">{t("vault.browser.setupTitle")}</h3>
              <p className="text-sm text-ink-muted">{t("vault.browser.setupHint")}</p>
              {offers.map((s) => (
                <BrowserSetupCard key={s.slug} site={s} onSaved={onChanged} />
              ))}
            </section>
          ) : null}
          {setups.length > 0 ? (
            <section data-testid="vault-setup" className="flex flex-col gap-3">
              <h3 className="eyebrow text-ink-muted">{t("vault.setupTitle")}</h3>
              <p className="text-sm text-ink-muted">{t("vault.setupHint")}</p>
              {setups.map((s) => (
                <SetupCard key={s.connector} setup={s} onSaved={onChanged} />
              ))}
            </section>
          ) : null}
          {offers.length === 0 && setups.length === 0 ? (
            <p className="text-sm text-ink-muted" data-testid="vault-no-offers">
              {t("accounts.vault.noOffers")}
            </p>
          ) : null}
        </div>
      ) : null}
      {items.length === 0 ? (
        <p
          className="border-t border-line px-6 py-4 text-sm text-ink-muted"
          data-testid="vault-empty"
        >
          {t("accounts.vault.empty")}
        </p>
      ) : (
        <div data-testid="vault-items">
          {items.map((item) => (
            <VaultLogin
              key={item.connectionId}
              item={item}
              canEdit={view.canEdit}
              people={view.people}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One login in the vault: what it is, its state, who uses it; its details on request. */
function VaultLogin({
  item,
  canEdit,
  people,
  onChanged,
}: {
  item: Item;
  canEdit: boolean;
  people: View["people"];
  onChanged: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [open, setOpen] = useState(false);
  const identity = item.browser?.identity?.email;
  return (
    <div
      className="flex flex-col gap-2 border-t border-line px-6 py-4"
      data-testid={
        item.browser
          ? `vault-item-browser-${item.browser.site.slug}`
          : `vault-item-${item.connector}`
      }
    >
      <div className="flex items-start gap-3">
        <ConnectorMark
          name={item.name}
          // A website login is the site's, not the browser connector's: its initials.
          connector={item.browser ? undefined : item.connector}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="font-medium text-ink">{item.name}</p>
            <VaultStateChip item={item} />
          </div>
          <p className="text-sm break-words text-ink-muted">
            {identity
              ? t("accounts.vault.agentLogin", { email: identity })
              : t(KIND_LABEL[item.kind])}
          </p>
        </div>
      </div>
      {item.browser?.stopped ? (
        <p className="text-sm ui-tone-risk" data-testid="vault-browser-stopped">
          {t("vault.browser.stopped", { reason: item.browser.stopped.reason })}
        </p>
      ) : null}
      <AgentsLine names={item.agents.filter((a) => !a.revoked).map((a) => a.name)} />
      {item.secret.updatedAt ? (
        <p className="text-sm text-ink-muted">
          {t("vault.updated", { time: shortTime(item.secret.updatedAt, undefined, i18n) })}
        </p>
      ) : null}
      <LoginEditor item={item} canEdit={canEdit} onChanged={onChanged}>
        <Button
          size="sm"
          variant="ghost"
          data-testid="vault-item-open"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t("accounts.vault.hideDetails") : t("accounts.vault.details")}
        </Button>
      </LoginEditor>
      {open ? (
        <VaultDetails
          item={item}
          canEdit={canEdit}
          people={people}
          onChanged={onChanged}
          withDisconnect
        />
      ) : null}
    </div>
  );
}

/** "PI Pia · IR Iris": the agents that use a connection, by name. */
export function AgentsLine({ names }: { names: string[] }) {
  const { t } = useI18n();
  if (names.length === 0) {
    return <p className="text-sm text-ink-muted">{t("vault.noAgents")}</p>;
  }
  return (
    <ul
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
      aria-label={t("vault.agentsTitle")}
    >
      {names.map((name) => (
        <li key={name} className="flex items-center gap-1.5 text-sm text-ink">
          <AgentBadge name={name} size="sm" />
          {name}
        </li>
      ))}
    </ul>
  );
}

/**
 * Enter or replace a login (every field, each time; nothing is shown back), with any other
 * buttons of the row beside it.
 */
export function LoginEditor({
  item,
  canEdit,
  onChanged,
  children,
}: {
  item: Item;
  canEdit: boolean;
  onChanged: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const [replacing, setReplacing] = useState(false);
  const canReplace = canEdit && item.credentialForm;
  return (
    <>
      {(canReplace && !replacing) || children ? (
        <div className="flex flex-wrap gap-2">
          {canReplace && !replacing ? (
            <Button size="sm" data-testid="vault-replace" onClick={() => setReplacing(true)}>
              {item.secret.set ? t("vault.replaceKey") : t("vault.enterKey")}
            </Button>
          ) : null}
          {children}
        </div>
      ) : null}
      {replacing ? (
        <CredentialForm
          connector={item.connector}
          {...(item.browser ? { connectionId: item.connectionId } : {})}
          fields={item.secret.fields}
          onSaved={() => {
            setReplacing(false);
            onChanged();
          }}
          onCancel={() => setReplacing(false)}
        />
      ) : null}
    </>
  );
}

export function SetupCard({ setup, onSaved }: { setup: Setup; onSaved: () => void }) {
  return (
    <div
      data-testid={`vault-setup-${setup.connector}`}
      className="rounded-md border border-line p-4"
    >
      <div className="mb-3 flex items-start gap-3">
        <ConnectorMark name={setup.name} connector={setup.connector} />
        <div className="min-w-0">
          <p className="font-medium text-ink">{setup.name}</p>
          <p className="text-sm text-ink-muted">{setup.description}</p>
        </div>
      </div>
      <CredentialForm
        connector={setup.connector}
        fields={setup.fields.map((f) => ({ ...f, hint: f.hint ?? null, value: null }))}
        onSaved={onSaved}
      />
    </div>
  );
}

/**
 * A website the client may set a login up on: its tier and what that means, the confirmation that
 * the client owns the account and the site's terms allow automated access, and for sites with an
 * authenticator app its setup link (sent on to the code service, never kept or shown).
 */
export function BrowserSetupCard({ site, onSaved }: { site: SiteOffer; onSaved: () => void }) {
  const { t } = useI18n();
  const api = useApiClient();
  const [confirmed, setConfirmed] = useState(false);
  const [authenticator, setAuthenticator] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const needsAuthenticator = site.secondFactor === "totp";
  const ready = confirmed && (!needsAuthenticator || authenticator.trim().length > 0);

  async function setUp() {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.portalSetUpBrowser, {
        body: {
          site: site.slug,
          ...(needsAuthenticator ? { authenticator: authenticator.trim() } : {}),
        },
      });
      setAuthenticator("");
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid={`vault-browser-offer-${site.slug}`}
      className="rounded-md border border-line p-4"
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <ConnectorMark name={site.name} />
          <p className="font-medium text-ink">{site.name}</p>
        </div>
        <TierBadge tier={site.tier} />
      </div>
      <p className="mb-3 text-sm text-ink-muted">{t(TIER_HELP[site.tier])}</p>
      {needsAuthenticator ? (
        <Field label={t("vault.browser.authenticator")} hint={t("vault.browser.authenticatorHint")}>
          <TextInput
            data-testid="vault-browser-authenticator"
            type="password"
            autoComplete="off"
            value={authenticator}
            onChange={(e) => setAuthenticator(e.target.value)}
          />
        </Field>
      ) : null}
      <label className="mt-2 flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-slate"
          data-testid="vault-browser-confirm"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        {t("vault.browser.confirm")}
      </label>
      {error ? (
        <div className="mt-3">
          <ErrorNotice error={error} />
        </div>
      ) : null}
      <div className="mt-3">
        <Button
          data-testid="vault-browser-setup-submit"
          variant="primary"
          disabled={!ready || busy}
          onClick={() => void setUp()}
        >
          {t("vault.browser.setUp")}
        </Button>
      </div>
    </div>
  );
}

/** A browser login's site, tier, agent identity, today's sign-ins, a stop, and stricter settings. */
function BrowserDetails({
  item,
  browser,
  canEdit,
  onChanged,
}: {
  item: Item;
  browser: BrowserInfo;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [editing, setEditing] = useState(false);
  const [noWrites, setNoWrites] = useState(browser.stricter.noWrites);
  const [personSignIn, setPersonSignIn] = useState(browser.stricter.personSignIn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.portalSetBrowserStricter, {
        params: { connectionId: item.connectionId },
        body: { noWrites, personSignIn },
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="vault-browser">
      <div className="flex flex-wrap items-center gap-2">
        <TierBadge tier={browser.effectiveTier} />
        <span className="text-sm text-ink-muted">{t(TIER_HELP[browser.effectiveTier])}</span>
      </div>
      {browser.identity ? (
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
          data-testid="vault-browser-identity"
        >
          <dt className="text-ink-muted">{t("vault.browser.identity")}</dt>
          <dd className="text-ink">{browser.identity.email}</dd>
          {browser.identity.phone ? (
            <>
              <dt className="text-ink-muted">{t("vault.browser.identityPhone")}</dt>
              <dd className="text-ink">{browser.identity.phone}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {browser.identity && !item.secret.set ? (
        <p className="text-sm text-ink-muted">{t("vault.browser.identityHint")}</p>
      ) : null}
      <p className="text-sm text-ink-muted" data-testid="vault-browser-signins">
        {t("vault.browser.signIns", {
          count: browser.signInsToday,
          limit: browser.signInsPerDay,
        })}
        {browser.siteVersion !== null
          ? ` · ${t("vault.browser.version", { version: browser.siteVersion })}`
          : ""}
      </p>
      {/* Why it stopped is on the login's row (VaultLogin), always in view. */}
      {editing ? (
        <div className="flex flex-col gap-2" data-testid="vault-browser-stricter">
          {(
            [
              ["noWrites", noWrites, setNoWrites, "vault.browser.noWrites"],
              ["personSignIn", personSignIn, setPersonSignIn, "vault.browser.personSignIn"],
            ] as const
          ).map(([key, value, set, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="size-4 accent-slate"
                data-testid={`vault-browser-${key}`}
                checked={value}
                // Only stricter: what is on stays on.
                disabled={browser.stricter[key]}
                onChange={(e) => set(e.target.checked)}
              />
              {t(label)}
            </label>
          ))}
          <p className="text-sm text-ink-muted">{t("vault.browser.stricterNote")}</p>
          {error ? <ErrorNotice error={error} /> : null}
          <div className="flex gap-2">
            <Button
              data-testid="vault-browser-stricter-save"
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void save()}
            >
              {t("vault.browser.saveStricter")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : canEdit && !(browser.stricter.noWrites && browser.stricter.personSignIn) ? (
        <div>
          <Button
            data-testid="vault-browser-stricter-open"
            size="sm"
            onClick={() => setEditing(true)}
          >
            {t("vault.browser.stricter")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Every field, each time: secrets are entered, never shown back (write-only). */
function CredentialForm({
  connector,
  connectionId,
  fields,
  onSaved,
  onCancel,
}: {
  connector: string;
  /** For connectors a client has several of (website logins): which connection. */
  connectionId?: string;
  fields: {
    name: string;
    label: string;
    secret: boolean;
    hint: string | null;
    value: string | null;
  }[];
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.secret ? "" : (f.value ?? "")])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const complete = fields.every((f) => (values[f.name] ?? "").trim().length > 0);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.portalSetCredentials, {
        params: { connector },
        body: { values, ...(connectionId ? { connectionId } : {}) },
      });
      // Nothing entered stays in the page once it is stored.
      setValues(Object.fromEntries(fields.map((f) => [f.name, ""])));
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      data-testid={`vault-form-${connector}`}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (complete && !busy) void save();
      }}
    >
      {fields.map((f) => (
        <Field key={f.name} label={f.label} hint={f.hint ?? undefined}>
          <TextInput
            data-testid={`vault-field-${f.name}`}
            type={f.secret ? "password" : "text"}
            autoComplete={f.secret ? "new-password" : "off"}
            value={values[f.name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
          />
        </Field>
      ))}
      <p className="text-sm text-ink-muted">{t("vault.keyNote")}</p>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex gap-2">
        <Button
          data-testid="vault-form-save"
          type="submit"
          variant="primary"
          disabled={!complete || busy}
        >
          {t("vault.saveKey")}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * A vault item's details: for a website login its site, tier and agent identity; whether each
 * login field is set (a secret's value never); each agent's access, which the client admin may
 * tighten or revoke; human release; and, where asked, Disconnect.
 */
export function VaultDetails({
  item,
  canEdit,
  people,
  onChanged,
  withDisconnect,
}: {
  item: Item;
  canEdit: boolean;
  people: View["people"];
  onChanged: () => void;
  /** The connection's own card has its Disconnect; a vault row shows one here. */
  withDisconnect?: boolean;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const connected = item.status === "connected";

  async function disconnect() {
    setError(null);
    try {
      await api.call(apiRoutes.portalDisconnect, { params: { id: item.connectionId } });
      setConfirming(false);
      onChanged();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="vault-details">
      {item.browser ? (
        <BrowserDetails
          item={item}
          browser={item.browser}
          canEdit={canEdit}
          onChanged={onChanged}
        />
      ) : null}

      {item.kind !== "built_in" ? (
        <div className="flex flex-col gap-2">
          <div>
            <Badge testId="vault-secret-state" tone={item.secret.set ? "positive" : "neutral"}>
              {item.secret.set ? t("vault.secretSet") : t("vault.secretNotSet")}
            </Badge>
          </div>
          {item.secret.fields.length > 0 ? (
            <dl
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm"
              data-testid="vault-fields"
            >
              {item.secret.fields.map((f) => (
                <div key={f.name} className="contents">
                  <dt className="text-ink-muted">{f.label}</dt>
                  <dd className="break-words text-ink">
                    {f.value ?? (f.set ? t("vault.fieldSet") : t("vault.fieldNotSet"))}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}

      <div>
        <h4 className="eyebrow mb-2 text-ink-muted">{t("vault.agentsTitle")}</h4>
        {item.agents.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("vault.noAgents")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {item.agents.map((a) => (
              <AgentRow
                key={a.agentId}
                item={item}
                access={a}
                canEdit={canEdit}
                onChanged={onChanged}
              />
            ))}
          </div>
        )}
      </div>

      <ReleaseSection item={item} people={people} canEdit={canEdit} onChanged={onChanged} />

      {error ? <ErrorNotice error={error} /> : null}
      {withDisconnect && canEdit && connected && !confirming ? (
        <div>
          <Button
            data-testid="vault-disconnect"
            size="sm"
            variant="ghost"
            onClick={() => setConfirming(true)}
          >
            {t("connections.disconnect")}
          </Button>
        </div>
      ) : null}
      {confirming ? (
        <div className="ds-banner block">
          <p>{t("connections.disconnectWarning", { tool: item.name })}</p>
          <div className="mt-2 flex gap-2">
            <Button
              data-testid="vault-disconnect-confirm"
              variant="primary"
              onClick={() => void disconnect()}
            >
              {t("connections.disconnect")}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t("connections.keepIt")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
function AgentRow({
  item,
  access,
  canEdit,
  onChanged,
}: {
  item: Item;
  access: AgentAccess;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [editing, setEditing] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [verbs, setVerbs] = useState<Record<Verb, PermissionLevel>>(() => ({
    ...access.effective,
  }));
  const allowedTools = access.tools ?? item.tools.map((x) => x.id);
  const [tools, setTools] = useState<string[]>(allowedTools);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(limits: GrantLimits) {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.portalSetGrant, {
        params: { agentId: access.agentId, connectionId: item.connectionId },
        body: { limits },
      });
      setEditing(false);
      setRevoking(false);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  /** Only what is tighter than the grant becomes a limit; the rest stays as it is. */
  function tightened(): GrantLimits {
    const next: GrantLimits = { ...access.limits };
    const out: NonNullable<GrantLimits["verbs"]> = { ...(access.limits.verbs ?? {}) };
    for (const v of VERBS) {
      if (verbs[v] !== access.effective[v]) out[v] = verbs[v];
    }
    if (Object.keys(out).length > 0) next.verbs = out;
    const narrowed = tools.length !== allowedTools.length;
    if (narrowed || access.tools) next.tools = tools;
    return next;
  }

  const revoked: GrantLimits = {
    ...access.limits,
    verbs: { read: "off", create: "off", update: "off", delete: "off" },
  };

  return (
    <div
      className="rounded-md border border-line p-3"
      data-testid={`vault-agent-${access.agentId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-ink">{access.name}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {access.revoked ? (
            <Badge testId="vault-agent-revoked">{t("vault.revoked")}</Badge>
          ) : (
            VERBS.map((v) => (
              <Badge key={v} tone={levelTone(access.effective[v])} testId={`vault-agent-${v}`}>
                {t(VERB_LABEL[v])} · {t(LEVEL_LABEL[access.effective[v]])}
              </Badge>
            ))
          )}
        </div>
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        {access.tools === null
          ? t("vault.allTools")
          : t("vault.someTools", { count: access.tools.length, total: item.tools.length })}
      </p>

      {editing ? (
        <div className="mt-3 flex flex-col gap-3" data-testid="vault-agent-editor">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {VERBS.map((v) => {
              const options = LEVELS.filter((l) => !isLooser(l, access.effective[v]));
              return (
                <Field key={v} label={t(VERB_LABEL[v])}>
                  <Select
                    data-testid={`vault-agent-level-${v}`}
                    value={verbs[v]}
                    disabled={options.length < 2}
                    onChange={(e) =>
                      setVerbs((s) => ({ ...s, [v]: e.target.value as PermissionLevel }))
                    }
                  >
                    {options.map((l) => (
                      <option key={l} value={l}>
                        {t(LEVEL_LABEL[l])}
                      </option>
                    ))}
                  </Select>
                </Field>
              );
            })}
          </div>
          {item.tools.length > 1 ? (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-sm font-medium text-ink">{t("vault.tools")}</legend>
              {item.tools
                .filter((x) => allowedTools.includes(x.id))
                .map((x) => (
                  <label key={x.id} className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      className="size-4 accent-slate"
                      data-testid={`vault-agent-tool-${x.id}`}
                      checked={tools.includes(x.id)}
                      onChange={(e) =>
                        setTools((ts) =>
                          e.target.checked ? [...ts, x.id] : ts.filter((id) => id !== x.id),
                        )
                      }
                    />
                    {x.description}
                  </label>
                ))}
            </fieldset>
          ) : null}
          <p className="text-sm text-ink-muted">{t("vault.tightenNote")}</p>
          {error ? <ErrorNotice error={error} /> : null}
          <div className="flex gap-2">
            <Button
              data-testid="vault-agent-save"
              variant="primary"
              disabled={busy}
              onClick={() => void save(tightened())}
            >
              {t("vault.saveAccess")}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {revoking ? (
        <div className="ds-banner mt-3 block">
          <p>{t("vault.revokeWarning", { agent: access.name, tool: item.name })}</p>
          {error ? <ErrorNotice error={error} /> : null}
          <div className="mt-2 flex gap-2">
            <Button
              data-testid="vault-agent-revoke-confirm"
              variant="primary"
              disabled={busy}
              onClick={() => void save(revoked)}
            >
              {t("vault.revoke")}
            </Button>
            <Button variant="ghost" onClick={() => setRevoking(false)}>
              {t("vault.keepAccess")}
            </Button>
          </div>
        </div>
      ) : null}

      {canEdit && !access.revoked && !editing && !revoking ? (
        <div className="mt-2 flex gap-2">
          <Button data-testid="vault-agent-tighten" size="sm" onClick={() => setEditing(true)}>
            {t("vault.tighten")}
          </Button>
          <Button
            data-testid="vault-agent-revoke"
            size="sm"
            variant="ghost"
            onClick={() => setRevoking(true)}
          >
            {t("vault.revoke")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
