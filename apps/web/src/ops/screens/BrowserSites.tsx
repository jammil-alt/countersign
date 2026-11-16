// `/ops/browser-sites` (docs/plan.md §1.26 phase 3): the catalogue of websites agents may sign in
// to. Each site: its risk tier and what it means, the notes of who checked its terms, its current
// version (login page and origins, second factor, allowed and blocked pages) and how many client
// logins use it. Editing a profile saves a new version (client logins keep the one they pinned);
// the tier is set on its own, with a note, and applies to every login on the site at once.
// Drafted in the prototype's back-office style (no prototype screen; docs/ui-plan.md): the sites
// per tier as stat tiles, then each site as a card with its tier in the head and actions in the foot.
// R8: in the Library, beside the connectors (`/ops/library/browser-sites`): a site is a
// connector too (ARCHITECTURE §10.14), with a search over its name, address and pages.
import {
  BROWSER_DEFAULT_BLOCKED,
  BrowserSiteProfile,
  type BrowserSiteProfileInput,
  type BrowserTier,
} from "@countersign/core";
import { useState } from "react";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { StatTile } from "../../ui/figures";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import { Columns, Loaded, Page, Section } from "../../ui/page";
import { Badge, Button, Card, EmptyState, ErrorNotice, PageHeader } from "../../ui/primitives";
import { Notice } from "../agents/ui";
import { BankSearch } from "../library/LibraryFrame";
import { matches } from "../library/paths";
import { OpsScriptsSection } from "./BrowserScripts";

type Site = ResponseOf<typeof apiRoutes.opsBrowserSites>["sites"][number];

const TIERS: BrowserTier[] = ["low", "medium", "high", "blocked"];

export const TIER_MEANING: Record<BrowserTier, string> = {
  low: "Agents sign in on their own. Writes need approval by default; the matrix may allow auto.",
  medium: "Agents sign in on their own. Every write is approved.",
  high: "A person signs in through Browser Run's handoff (not built yet): agents can't use it.",
  blocked: "Agents never sign in: banks, payments, email accounts, identity providers.",
};

const TIER_TONE: Record<BrowserTier, "neutral" | "person" | "risk"> = {
  low: "neutral",
  medium: "neutral",
  high: "person",
  blocked: "risk",
};

const TEMPLATE: BrowserSiteProfileInput = {
  login: {
    url: "https://portal.example.com/login",
    origins: ["https://portal.example.com"],
    usernameField: "#username",
    passwordField: "#password",
    submitButton: "button[type=submit]",
    secondFactor: {
      kind: "email",
      sender: "@example.com",
      pattern: "code is (\\d{6})",
      codeField: "#code",
      codeButton: "button[type=submit]",
    },
    signedIn: { selector: "#account-menu" },
  },
  signOut: { url: "https://portal.example.com/logout" },
  allow: ["https://portal.example.com/invoices*"],
  block: [],
  session: { keep: false },
  notes: "",
};

/** The profile typed as JSON, checked with core's schema before anything is sent. */
function parseProfile(text: string): { ok: true; profile: unknown } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not valid JSON." };
  }
  const parsed = BrowserSiteProfile.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join(".") || "profile"}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, profile: parsed.data };
}

const tierName = (tier: BrowserTier) => tier.charAt(0).toUpperCase() + tier.slice(1);

function TierBadge({ tier }: { tier: BrowserTier }) {
  return (
    <Badge tone={TIER_TONE[tier]} testId="site-tier">
      {tierName(tier)}
    </Badge>
  );
}

/** How many sites sit in each tier, and the client logins on them. */
function TierFigures({ sites }: { sites: readonly Site[] }) {
  return (
    <Columns count={4}>
      {TIERS.map((tier) => {
        const inTier = sites.filter((s) => s.tier === tier);
        const logins = inTier.reduce((n, s) => n + s.connections, 0);
        return (
          <StatTile
            key={tier}
            testId={`site-tier-count-${tier}`}
            label={tierName(tier)}
            value={inTier.length}
            note={
              tier === "blocked" || tier === "high"
                ? "Agents can't sign in"
                : logins === 1
                  ? "1 client login"
                  : `${logins} client logins`
            }
          />
        );
      })}
    </Columns>
  );
}

export function OpsBrowserSitesScreen() {
  const sites = useApi(apiRoutes.opsBrowserSites);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  return (
    <Page testId="ops-browser-sites">
      <PageHeader
        title="Websites"
        subtitle="Sites agents may sign in to as a client's agent account. We sign in by code; the agent never sees a password or a code."
        actions={
          adding ? null : (
            <Button data-testid="site-add" variant="primary" onClick={() => setAdding(true)}>
              Add a site
            </Button>
          )
        }
      />
      <Notice tone="neutral" testId="site-default-blocked">
        Always blocked on every site: settings, password, users and permissions, billing and
        payment, and delete pages ({BROWSER_DEFAULT_BLOCKED.join(", ")}).
      </Notice>
      {adding ? (
        <NewSiteForm
          onDone={() => {
            setAdding(false);
            sites.reload();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      <Loaded state={sites}>
        {(data) => (
          <>
            {data.sites.length > 0 ? <TierFigures sites={data.sites} /> : null}
            <Section
              title="Sites"
              meta={data.sites.length === 1 ? "1 site" : `${data.sites.length} sites`}
              action={
                data.sites.length > 0 ? (
                  <BankSearch
                    value={search}
                    onChange={setSearch}
                    label="Search sites"
                    testId="sites-search"
                  />
                ) : null
              }
            >
              {data.sites.length === 0 && !adding ? <EmptyState>No sites yet.</EmptyState> : null}
              <div className="flex flex-col gap-4">
                {data.sites
                  .filter((s) =>
                    matches(
                      search,
                      s.name,
                      s.slug,
                      s.current.profile.login.url,
                      ...s.current.profile.allow,
                    ),
                  )
                  .map((s) => (
                    <SiteCard key={s.slug} site={s} onChanged={sites.reload} />
                  ))}
              </div>
            </Section>
          </>
        )}
      </Loaded>
      {/* Wave 4 (docs/plan.md §1.86): the clients' recorded scripts on these sites. */}
      <OpsScriptsSection />
    </Page>
  );
}

function TierFields({
  tier,
  notes,
  onTier,
  onNotes,
}: {
  tier: BrowserTier;
  notes: string;
  onTier: (t: BrowserTier) => void;
  onNotes: (n: string) => void;
}) {
  return (
    <>
      <Field label="Risk tier" hint={TIER_MEANING[tier]}>
        <Select
          data-testid="site-tier-select"
          value={tier}
          onChange={(e) => onTier(e.target.value as BrowserTier)}
        >
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Notes"
        hint="Who checked the site's terms allow automated access, and when; why this tier."
      >
        <TextArea
          data-testid="site-notes"
          rows={2}
          value={notes}
          onChange={(e) => onNotes(e.target.value)}
        />
      </Field>
    </>
  );
}

function NewSiteForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const api = useApiClient();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [tier, setTier] = useState<BrowserTier>("low");
  const [notes, setNotes] = useState("");
  const [text, setText] = useState(JSON.stringify(TEMPLATE, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const check = parseProfile(text);
  const ready = slug.trim() && name.trim() && notes.trim().length >= 3 && check.ok;

  async function save() {
    if (!check.ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.opsCreateBrowserSite, {
        body: {
          slug: slug.trim(),
          name: name.trim(),
          tier,
          notes: notes.trim(),
          profile: check.profile as BrowserSiteProfileInput,
        },
      });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card testId="site-new" title="New site" pad>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            label="Slug"
            hint="Lowercase letters, digits and dashes; agents bind it as browser:<slug>."
          >
            <TextInput
              data-testid="site-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
          </Field>
          <Field label="Name">
            <TextInput
              data-testid="site-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>
        <TierFields tier={tier} notes={notes} onTier={setTier} onNotes={setNotes} />
        <ProfileField text={text} onText={setText} error={check.ok ? undefined : check.error} />
        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex gap-2">
          <Button
            data-testid="site-create"
            variant="primary"
            disabled={!ready || busy}
            onClick={() => void save()}
          >
            Add the site
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

const SECOND_WORDS: Record<string, string> = {
  none: "None",
  totp: "Authenticator app code",
  sms: "Code by text",
  email: "Code by email",
};

/** A profile being edited: what the form reads and writes, before core's schema checks it. */
interface Draft {
  login?: {
    url?: string;
    origins?: string[];
    usernameField?: string;
    passwordField?: string;
    submitButton?: string;
    secondFactor?: {
      kind?: string;
      sender?: string;
      pattern?: string;
      codeField?: string;
      codeButton?: string;
    };
    signedIn?: { url?: string | undefined; selector?: string | undefined };
    stopSelectors?: string[];
  };
  signOut?: { url?: string | undefined; selector?: string | undefined };
  allow?: string[];
  block?: string[];
  hosts?: string[];
  session?: { keep?: boolean };
  notes?: string;
}

/** The form's words for a schema path, so a problem reads by the field's label. */
const FIELD_WORDS: Record<string, string> = {
  "login.url": "Sign-in page",
  "login.origins": "Typed only on",
  "login.usernameField": "Username box",
  "login.passwordField": "Password box",
  "login.submitButton": "Sign-in button",
  "login.secondFactor": "Second step",
  "login.secondFactor.sender": "Codes come from",
  "login.secondFactor.pattern": "The code in the message",
  "login.secondFactor.codeField": "Code box",
  "login.secondFactor.codeButton": "Code button",
  "login.signedIn": "Signed in when",
  signOut: "Sign out",
  "signOut.url": "Sign-out page",
  allow: "Pages agents may open",
  block: "Pages agents never open",
  hosts: "Other hosts",
};

/** Core's problems with the profile, by the form's labels. */
function formProblems(text: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = BrowserSiteProfile.safeParse(json);
  if (parsed.success) return undefined;
  return parsed.error.issues
    .map((i) => {
      const path = i.path.filter((x) => typeof x === "string").join(".");
      return `${FIELD_WORDS[path] ?? (path || "The profile")}: ${i.message}`;
    })
    .join("; ");
}

const lines = (list: readonly string[] | undefined) => (list ?? []).join("\n");
const fromLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
/** An optional text: left out of the profile when empty (core refuses an empty selector). */
const opt = (v: string) => (v.trim() ? v : undefined);

/**
 * Feedback (2026-11-10): the site's profile as a form, not JSON: the sign-in page and its boxes,
 * the second step, how to tell it signed in and out, and the pages agents may and may not open.
 * It edits the same JSON (core's schema checks it before anything is sent); "Edit as JSON" stays
 * for what the form doesn't hold. The agent account's username and password are never here: the
 * client admin enters them in their portal's Vault, encrypted with the client's key.
 */
function ProfileField({
  text,
  onText,
  error,
}: {
  text: string;
  onText: (t: string) => void;
  error: string | undefined;
}) {
  const [json, setJson] = useState(false);
  let draft: Draft | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) draft = parsed as Draft;
  } catch {
    draft = null;
  }
  const asForm = !json && draft !== null;
  const shownError = asForm ? (formProblems(text) ?? error) : error;
  return (
    <div className="flex flex-col gap-3" data-testid="site-profile">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-ink">How agents sign in</span>
        <button
          type="button"
          className="ds-btn ds-btn--link text-sm"
          data-testid="site-profile-json"
          disabled={json && draft === null}
          title={json && draft === null ? "Fix the JSON first" : undefined}
          onClick={() => setJson((j) => !j)}
        >
          {json ? "Back to the form" : "Edit as JSON"}
        </button>
      </div>
      <p className="text-sm text-ink-muted" data-testid="site-profile-vault">
        No username or password goes here. The client admin enters the agent account's login in
        their portal's Vault; it is encrypted with the client's key and we never see it.
      </p>
      {asForm && draft ? (
        <ProfileForm draft={draft} onChange={(next) => onText(JSON.stringify(next, null, 2))} />
      ) : (
        <TextArea
          data-testid="site-profile-text"
          aria-label="Profile as JSON"
          className="font-mono text-sm"
          rows={18}
          spellCheck={false}
          value={text}
          invalid={error !== undefined}
          onChange={(e) => onText(e.target.value)}
        />
      )}
      {shownError ? (
        <p className="ds-error text-sm" data-testid="site-profile-error">
          {shownError}
        </p>
      ) : null}
    </div>
  );
}

function ProfileForm({ draft, onChange }: { draft: Draft; onChange: (next: Draft) => void }) {
  const login = draft.login ?? {};
  const second = login.secondFactor ?? { kind: "none" };
  const setLogin = (patch: Partial<NonNullable<Draft["login"]>>) =>
    onChange({ ...draft, login: { ...login, ...patch } });
  const setSecond = (patch: Partial<NonNullable<NonNullable<Draft["login"]>["secondFactor"]>>) =>
    setLogin({ secondFactor: { ...second, ...patch } });
  const kind = second.kind ?? "none";
  const setKind = (next: string) => {
    // Each kind keeps only its own fields (core's schema is strict).
    const code = { codeField: second.codeField ?? "", codeButton: second.codeButton ?? "" };
    setLogin({
      secondFactor:
        next === "none"
          ? { kind: "none" }
          : next === "totp"
            ? { kind: next, ...code }
            : { kind: next, sender: second.sender ?? "", pattern: second.pattern ?? "", ...code },
    });
  };
  const text = (
    label: string,
    value: string | undefined,
    set: (v: string) => void,
    testId: string,
    hint?: string,
  ) => (
    <Field label={label} hint={hint}>
      <TextInput data-testid={testId} value={value ?? ""} onChange={(e) => set(e.target.value)} />
    </Field>
  );
  const list = (
    label: string,
    value: string[] | undefined,
    set: (v: string[]) => void,
    testId: string,
    hint: string,
  ) => (
    <Field label={label} hint={hint}>
      <TextArea
        data-testid={testId}
        rows={3}
        spellCheck={false}
        value={lines(value)}
        onChange={(e) => set(fromLines(e.target.value))}
      />
    </Field>
  );
  return (
    <div className="flex flex-col gap-5" data-testid="site-profile-form">
      <fieldset className="flex flex-col gap-3">
        <legend className="eyebrow mb-2 text-ink-muted">The sign-in page</legend>
        {text(
          "Sign-in page",
          login.url,
          (url) => setLogin({ url }),
          "site-form-url",
          "Its full address, such as https://portal.example.com/login.",
        )}
        {list(
          "Typed only on",
          login.origins,
          (origins) => setLogin({ origins }),
          "site-form-origins",
          "The only sites the login and codes are ever typed into, one per line: https://portal.example.com.",
        )}
        <div className="grid gap-3 md:grid-cols-3">
          {text(
            "Username box",
            login.usernameField,
            (usernameField) => setLogin({ usernameField }),
            "site-form-username",
            "The page element, such as #username.",
          )}
          {text(
            "Password box",
            login.passwordField,
            (passwordField) => setLogin({ passwordField }),
            "site-form-password",
            "Such as #password.",
          )}
          {text(
            "Sign-in button",
            login.submitButton,
            (submitButton) => setLogin({ submitButton }),
            "site-form-submit",
            "Such as button[type=submit].",
          )}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="eyebrow mb-2 text-ink-muted">The second step</legend>
        <Field label="Second step" hint="Codes are read by our code service, never by the agent.">
          <Select
            data-testid="site-form-second"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {Object.entries(SECOND_WORDS).map(([k, words]) => (
              <option key={k} value={k}>
                {words}
              </option>
            ))}
          </Select>
        </Field>
        {kind === "sms" || kind === "email" ? (
          <div className="grid gap-3 md:grid-cols-2">
            {text(
              "Codes come from",
              second.sender,
              (sender) => setSecond({ sender }),
              "site-form-sender",
              kind === "sms"
                ? "The number codes come from."
                : "The address or domain, such as @example.com.",
            )}
            {text(
              "The code in the message",
              second.pattern,
              (pattern) => setSecond({ pattern }),
              "site-form-pattern",
              "A pattern with the code in brackets, such as code is (\\d{6}).",
            )}
          </div>
        ) : null}
        {kind !== "none" ? (
          <div className="grid gap-3 md:grid-cols-2">
            {text(
              "Code box",
              second.codeField,
              (codeField) => setSecond({ codeField }),
              "site-form-code-field",
              "Such as #code.",
            )}
            {text(
              "Code button",
              second.codeButton,
              (codeButton) => setSecond({ codeButton }),
              "site-form-code-button",
              "Such as button[type=submit].",
            )}
          </div>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="eyebrow mb-2 text-ink-muted">Signed in, and signing out</legend>
        <div className="grid gap-3 md:grid-cols-2">
          {text(
            "Signed in when the address is",
            login.signedIn?.url,
            (url) => setLogin({ signedIn: { ...login.signedIn, url: opt(url) } }),
            "site-form-signed-in-url",
            "Optional, such as https://portal.example.com/home*.",
          )}
          {text(
            "Or when the page shows",
            login.signedIn?.selector,
            (selector) => setLogin({ signedIn: { ...login.signedIn, selector: opt(selector) } }),
            "site-form-signed-in-selector",
            "Optional, such as #account-menu. One of the two at least.",
          )}
          {text(
            "Sign-out page",
            draft.signOut?.url,
            (url) => onChange({ ...draft, signOut: { ...draft.signOut, url: opt(url) } }),
            "site-form-sign-out-url",
            "Optional.",
          )}
          {text(
            "Or the sign-out button",
            draft.signOut?.selector,
            (selector) =>
              onChange({ ...draft, signOut: { ...draft.signOut, selector: opt(selector) } }),
            "site-form-sign-out-selector",
            "Optional. One of the two at least.",
          )}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="eyebrow mb-2 text-ink-muted">Pages</legend>
        {list(
          "Pages agents may open",
          draft.allow,
          (allow) => onChange({ ...draft, allow }),
          "site-form-allow",
          "One per line; * matches the rest: https://portal.example.com/invoices*.",
        )}
        {list(
          "Pages agents never open",
          draft.block,
          (block) => onChange({ ...draft, block }),
          "site-form-block",
          "Beside the pages always blocked (settings, passwords, users, billing, delete).",
        )}
        {list(
          "Other hosts its pages load from",
          draft.hosts,
          (hosts) => onChange({ ...draft, hosts }),
          "site-form-hosts",
          "Optional, one per line, such as cdn.example.com. Nothing is typed or read there.",
        )}
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="size-4 accent-slate"
            data-testid="site-form-keep"
            checked={draft.session?.keep ?? false}
            onChange={(e) => onChange({ ...draft, session: { keep: e.target.checked } })}
          />
          Keep the session between sign-ins (low tier only; kept encrypted in the client's Vault)
        </label>
      </fieldset>
    </div>
  );
}

function SiteCard({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const api = useApiClient();
  const [mode, setMode] = useState<"view" | "edit" | "tier">("view");
  const [text, setText] = useState(() => JSON.stringify(site.current.profile, null, 2));
  const [changeNote, setChangeNote] = useState("");
  const [tier, setTier] = useState<BrowserTier>(site.tier);
  const [notes, setNotes] = useState(site.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const check = parseProfile(text);
  const profile = site.current.profile;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode("view");
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      testId={`site-${site.slug}`}
      title={
        <span className="flex min-w-0 flex-col">
          <span>{site.name}</span>
          <span className="text-sm font-normal text-ink-muted">
            <span className="reference">browser:{site.slug}</span> · version {site.current.version}{" "}
            of {site.versions} ·{" "}
            {site.connections === 1 ? "1 client login" : `${site.connections} client logins`}
          </span>
        </span>
      }
      meta={<TierBadge tier={site.tier} />}
      footer={
        mode === "view" ? (
          <>
            <Button data-testid="site-edit" size="sm" onClick={() => setMode("edit")}>
              Edit
            </Button>
            <Button
              data-testid="site-set-tier"
              size="sm"
              variant="ghost"
              onClick={() => setMode("tier")}
            >
              Set the tier
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="ui-card__body">
        <p className="text-sm text-ink-muted">{TIER_MEANING[site.tier]}</p>
        {site.notes ? (
          <p className="mt-1 text-sm text-ink" data-testid="site-notes-text">
            {site.notes}
          </p>
        ) : null}
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm [&_dd]:break-words">
          <dt className="text-ink-muted">Login</dt>
          <dd className="text-ink">{profile.login.url}</dd>
          <dt className="text-ink-muted">Typed only on</dt>
          <dd className="text-ink">{profile.login.origins.join(", ")}</dd>
          <dt className="text-ink-muted">Second factor</dt>
          <dd className="text-ink">{SECOND_WORDS[profile.login.secondFactor.kind]}</dd>
          <dt className="text-ink-muted">Allowed pages</dt>
          <dd className="text-ink">{profile.allow.join(", ")}</dd>
          <dt className="text-ink-muted">Blocked pages</dt>
          <dd className="text-ink">
            {profile.block.length ? profile.block.join(", ") : "Only the defaults"}
          </dd>
          <dt className="text-ink-muted">Keeps the session</dt>
          <dd className="text-ink">{profile.session.keep ? "Yes (low tier only)" : "No"}</dd>
        </dl>

        {mode === "edit" ? (
          <div className="mt-3 flex flex-col gap-3">
            <ProfileField text={text} onText={setText} error={check.ok ? undefined : check.error} />
            <Field label="What changed">
              <TextInput
                data-testid="site-change-note"
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
              />
            </Field>
            <p className="text-sm text-ink-muted">
              Saved as version {site.versions + 1}. Client logins keep the version they were set up
              on.
            </p>
            <div className="flex gap-2">
              <Button
                data-testid="site-save-version"
                variant="primary"
                disabled={!check.ok || busy}
                onClick={() =>
                  check.ok &&
                  void run(() =>
                    api.call(apiRoutes.opsNewBrowserSiteVersion, {
                      params: { slug: site.slug },
                      body: {
                        profile: check.profile as BrowserSiteProfileInput,
                        ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}),
                      },
                    }),
                  )
                }
              >
                Save as a new version
              </Button>
              <Button variant="ghost" onClick={() => setMode("view")}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {mode === "tier" ? (
          <div className="mt-3 flex flex-col gap-3">
            <TierFields tier={tier} notes={notes} onTier={setTier} onNotes={setNotes} />
            <p className="text-sm text-ink-muted">
              The tier applies to every client login on this site at once.
            </p>
            <div className="flex gap-2">
              <Button
                data-testid="site-save-tier"
                variant="primary"
                disabled={notes.trim().length < 3 || busy}
                onClick={() =>
                  void run(() =>
                    api.call(apiRoutes.opsSetBrowserSiteTier, {
                      params: { slug: site.slug },
                      body: { tier, notes: notes.trim() },
                    }),
                  )
                }
              >
                Set the tier
              </Button>
              <Button variant="ghost" onClick={() => setMode("view")}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="mt-3">
            <ErrorNotice error={error} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
