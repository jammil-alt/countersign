// The frame of a connect flow (UI-3a): the pages a tool's sign-in, the Sheets picker or WhatsApp
// signup open on. A narrow column under "Accounts", the title and what is happening, and the flow
// itself on one card. Only the look: each flow keeps its own behaviour.
import type { ReactNode } from "react";
import { useI18n } from "../../i18n/i18n";
import { Page } from "../../ui/page";
import { Card, PageHeader } from "../../ui/primitives";

export function ConnectFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Page width="narrow" testId="portal-connect-frame">
      <div>
        {/* Words, not a link: a flow half done shouldn't be left by accident; each has its own way back. */}
        <p className="eyebrow mb-2 text-ink-muted">{t("nav.accounts")}</p>
        <PageHeader title={title} subtitle={subtitle} />
        <Card pad>{children}</Card>
      </div>
    </Page>
  );
}
