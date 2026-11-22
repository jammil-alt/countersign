// Your tools (docs/setup-plan.md §5; docs/plan.md §1.206, SU3): one card per tool the agents being
// set up need. Connected or not; the account check ("You signed in to X. Is that the company the
// agents should use?"); what the agents read, may change (asking first, every time) and never do;
// a link to the tool's own access settings (the matrix lives there, not here); Connect through the
// connector's own page (Connectors C5: there is no second place to connect); Someone else, which
// puts just this card on a colleague's Desk; and for QuickBooks what we see in it, counted by code,
// each line with Yes. Only the client admin edits; everyone else reads. We never see a password.
import {
  gettingStartedRoutes,
  type SetupTool,
  type ToolConfirmBody,
  type ToolsChapterView,
} from "@countersign/core";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { isApiError } from "../../../api/client";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { ConnectorMark } from "../../../connections/ConnectorMark";
import { useI18n } from "../../../i18n/i18n";
import { useSession } from "../../../session/session";
import { Field, Select } from "../../../ui/forms";
import { Loaded } from "../../../ui/page";
import { Badge, Button, buttonClass, Card, ErrorNotice } from "../../../ui/primitives";
import { PORTAL_PATHS } from "../../paths";
import { ChapterFrame } from "./ChapterFrame";

export function ToolsChapterScreen() {
  const state = useApi(gettingStartedRoutes.portalSetupTools);
  return (
    <ChapterFrame chapter="tools">
      <Loaded state={state}>{(d) => <Tools initial={d} />}</Loaded>
    </ChapterFrame>
  );
}

function Tools({ initial }: { initial: ToolsChapterView }) {
  const { t } = useI18n();
  const api = useApiClient();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ connector: string; error: unknown } | null>(null);
  useEffect(() => setView(initial), [initial]);

  async function run(connector: string, key: string, call: () => Promise<ToolsChapterView>) {
    setBusy(key);
    setError(null);
    try {
      setView(await call());
      return true;
    } catch (e) {
      setError({ connector, error: e });
      return false;
    } finally {
      setBusy(null);
    }
  }

  const confirm = (connector: string, body: ToolConfirmBody) =>
    run(connector, `${connector}:${body.what === "line" ? body.key : "account"}`, () =>
      api.call(gettingStartedRoutes.portalSetupToolConfirm, { params: { connector }, body }),
    );
  const ask = (connector: string, userId: string) =>
    run(connector, `${connector}:ask`, () =>
      api.call(gettingStartedRoutes.portalSetupToolAsk, {
        params: { connector },
        body: { userId },
      }),
    );

  if (view.tools.length === 0) {
    return <p className="text-ink-muted">{t("setup.tools.none")}</p>;
  }
  return (
    <div className="flex flex-col gap-4" data-testid="start-tools">
      <p className="text-ink-muted">{t("setup.tools.intro")}</p>
      {view.canEdit ? null : <p className="text-sm text-ink-muted">{t("setup.tools.adminOnly")}</p>}
      {view.tools.map((tool) => (
        <ToolCard
          key={tool.connector}
          tool={tool}
          canEdit={view.canEdit}
          busy={busy}
          error={error?.connector === tool.connector ? error.error : null}
          onConfirm={(body) => void confirm(tool.connector, body)}
          onAsk={(userId) => ask(tool.connector, userId)}
        />
      ))}
    </div>
  );
}

function ToolCard({
  tool,
  canEdit,
  busy,
  error,
  onConfirm,
  onAsk,
}: {
  tool: SetupTool;
  canEdit: boolean;
  busy: string | null;
  error: unknown;
  onConfirm: (body: ToolConfirmBody) => void;
  onAsk: (userId: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const c = tool.connector;
  const forAgent = tool.agents[0]?.id ?? null;
  const page = PORTAL_PATHS.connector(c, forAgent);
  const nothing = t("setup.tools.nothing");
  const pill = tool.connected ? (
    <Badge tone="positive">{t("setup.tools.connected")}</Badge>
  ) : tool.askedOf && !tool.askedOf.me ? (
    <Badge tone="warning">{t("setup.tools.waitingOn", { name: tool.askedOf.name })}</Badge>
  ) : (
    <Badge tone="warning">{t("setup.tools.waitingYou")}</Badge>
  );

  return (
    <Card pad testId={`start-tool-${c}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3">
          <ConnectorMark name={tool.name} connector={c} />
          <span className="min-w-0">
            <h3 className="text-ink">{tool.name}</h3>
            {tool.agents.length ? (
              <p className="text-sm text-ink-muted">
                {t("setup.tools.usedBy", { agents: tool.agents.map((a) => a.name).join(", ") })}
              </p>
            ) : null}
          </span>
        </span>
        <span data-testid={`start-tool-${c}-state`}>{pill}</span>
      </div>

      {tool.connected && tool.account ? (
        <div
          className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface-subtle px-4 py-3"
          data-testid={`start-tool-${c}-account`}
        >
          <span className="min-w-0 flex-1 text-sm text-ink">
            {tool.accountConfirmed
              ? t("setup.tools.accountChecked", { account: tool.account })
              : t("setup.tools.account", { account: tool.account })}
          </span>
          {tool.accountConfirmed ? (
            <Badge tone="positive">{t("setup.tools.checked")}</Badge>
          ) : canEdit ? (
            <>
              <Button
                size="sm"
                variant="primary"
                working={busy === `${c}:account`}
                data-testid={`start-tool-${c}-account-yes`}
                onClick={() => onConfirm({ what: "account" })}
              >
                {t("setup.tools.yes")}
              </Button>
              <Link
                className={buttonClass("secondary", undefined, "sm")}
                data-testid={`start-tool-${c}-different`}
                to={page}
              >
                {t("setup.tools.different")}
              </Link>
            </>
          ) : null}
        </div>
      ) : null}

      <dl
        className="mt-3 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm max-sm:grid-cols-1"
        data-testid={`start-tool-${c}-words`}
      >
        <dt className="text-ink-muted">{t("setup.tools.reads")}</dt>
        <dd className="text-ink">{tool.reads.length ? tool.reads.join(", ") : nothing}</dd>
        <dt className="text-ink-muted">{t("setup.tools.changes")}</dt>
        <dd className="text-ink">
          {tool.changes.length ? (
            <>
              {tool.changes.join(", ")}{" "}
              <span className="font-medium">{t("setup.tools.asksFirst")}</span>
            </>
          ) : (
            nothing
          )}
        </dd>
        <dt className="text-ink-muted">{t("setup.tools.never")}</dt>
        <dd className="text-ink">{tool.never.join(", ")}</dd>
      </dl>
      <p className="mt-2 text-sm">
        <Link className="text-link" to={page} data-testid={`start-tool-${c}-access`}>
          {t("setup.tools.access", { tool: tool.name })}
        </Link>
      </p>

      {tool.connected ? null : (
        <div className="mt-4 flex flex-col gap-3" data-testid={`start-tool-${c}-who`}>
          {tool.askedOf ? (
            <p className="text-sm text-ink" data-testid={`start-tool-${c}-asked`}>
              {tool.askedOf.me
                ? t("setup.tools.askedYou")
                : t("setup.tools.asked", { name: tool.askedOf.name })}
            </p>
          ) : null}
          {canEdit || tool.askedOf?.me ? (
            <>
              <span className="ds-label">{t("setup.tools.whoSignsIn", { tool: tool.name })}</span>
              <span className="flex flex-wrap items-center gap-2">
                <Link
                  className={buttonClass("primary", undefined, "sm")}
                  data-testid={`start-tool-${c}-connect`}
                  to={page}
                >
                  {t("setup.tools.connect", { tool: tool.name })}
                </Link>
                {canEdit && !asking ? (
                  <Button
                    size="sm"
                    data-testid={`start-tool-${c}-ask`}
                    onClick={() => setAsking(true)}
                  >
                    {t("setup.tools.someoneElse")}
                  </Button>
                ) : null}
              </span>
            </>
          ) : (
            <p className="text-sm text-ink-muted">{t("setup.tools.adminConnects")}</p>
          )}
          {asking ? (
            <AskSomeone
              tool={tool}
              busy={busy === `${c}:ask`}
              onCancel={() => setAsking(false)}
              onSend={async (userId) => {
                if (await onAsk(userId)) setAsking(false);
              }}
            />
          ) : null}
        </div>
      )}

      {error ? (
        <div className="mt-3">
          {isApiError(error) && error.code === "cannot_connect" ? (
            <p className="rounded-md border border-line bg-signal-tint p-3 text-sm text-signal-ink">
              {t("setup.tools.cannotConnect", { tool: tool.name })}
            </p>
          ) : (
            <ErrorNotice error={error} />
          )}
        </div>
      ) : null}

      {tool.firstLook ? (
        <div className="mt-5 flex flex-col gap-2" data-testid={`start-tool-${c}-look`}>
          <span className="eyebrow text-ink-muted">
            {t("setup.tools.lookTitle", { tool: tool.name })}
          </span>
          <p className="text-sm text-ink-muted">{t("setup.tools.lookHint")}</p>
          {tool.firstLook.map((line) => (
            <div
              key={line.key}
              className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface-subtle px-4 py-3"
              data-testid={`start-tool-${c}-line-${line.key}`}
            >
              <span className="min-w-0 flex-1 text-sm text-ink">{line.text}</span>
              {line.confirmed ? (
                <Badge tone="positive">{t("setup.tools.checked")}</Badge>
              ) : canEdit ? (
                <Button
                  size="sm"
                  working={busy === `${c}:${line.key}`}
                  onClick={() => onConfirm({ what: "line", key: line.key })}
                >
                  {t("setup.tools.yes")}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/** Someone else signs in: pick a colleague; just this card goes to their Desk. */
function AskSomeone({
  tool,
  busy,
  onCancel,
  onSend,
}: {
  tool: SetupTool;
  busy: boolean;
  onCancel: () => void;
  onSend: (userId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const session = useSession();
  const team = useApi(apiRoutes.portalTeam);
  const [who, setWho] = useState("");
  const members = (team.data?.members ?? []).filter((m) => m.userId !== session.user.id);
  const c = tool.connector;
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-line px-4 py-3"
      data-testid={`start-tool-${c}-ask-box`}
    >
      {team.data && members.length === 0 ? (
        <p className="text-sm text-ink-muted">
          <Link className="text-link" to={PORTAL_PATHS.team}>
            {t("setup.tools.noOne")}
          </Link>
        </p>
      ) : (
        <Field label={t("setup.tools.sendTo")}>
          <Select
            value={who}
            data-testid={`start-tool-${c}-ask-who`}
            onChange={(e) => setWho(e.target.value)}
          >
            <option value="">{t("setup.tools.choose")}</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name ? `${m.name} (${m.email})` : m.email}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={who === ""}
          working={busy}
          data-testid={`start-tool-${c}-ask-send`}
          onClick={() => void onSend(who)}
        >
          {t("setup.tools.send")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
