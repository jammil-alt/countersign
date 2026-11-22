// The OAuth scopes each connector asks for, in one place, for the assurance check "Sign-ins grant no
// more than we ask for" (docs/agent-assurance-plan.md §4b; §1.231.2). The check compares these
// with the scopes the provider granted, which the connectors keep beside the tokens
// (`OAuthTokens.scope`) when the provider reports them. A test holds this list to the registry:
// every connector that signs in with OAuth is here.
//
// Each list is what the connector asks for, plus the sign-in basics its callback already accepts
// beside them (Google's `userinfo.email` for `email`; Microsoft's `profile` and `User.Read`).

import { BANKFEED_CONNECTOR_ID } from "../bankfeed/index";
import { EXCEL_CONNECTOR_ID, EXCEL_SCOPES } from "../excel/index";
import { GCAL_CONNECTOR_ID, GCAL_SCOPES } from "../gcal/index";
import { GDRIVE_CONNECTOR_ID, GDRIVE_SCOPES } from "../gdrive/index";
import { GMAIL_CONNECTOR_ID, GMAIL_SCOPES } from "../gmail/index";
import { GSC_SCOPE } from "../gsc/index";
import { GSC_OAUTH_CONNECTOR_ID } from "../gsc/oauth";
import { GSHEETS_CONNECTOR_ID, GSHEETS_SCOPES } from "../gsheets/index";
import { HUBSPOT_CONNECTOR_ID, HUBSPOT_SCOPES } from "../hubspot/index";
import { LINKEDIN_CONNECTOR_ID, LINKEDIN_SCOPES } from "../linkedin/index";
import { graphScope, MICROSOFT_SIGN_IN_SCOPES } from "../microsoft/identity";
import { ONEDRIVE_CONNECTOR_ID, ONEDRIVE_GRAPH_SCOPE } from "../onedrive/index";
import { OUTLOOK_CONNECTOR_ID, OUTLOOK_SCOPES } from "../outlook/index";
import { CALENDARS_READWRITE, OUTLOOK_CALENDAR_CONNECTOR_ID } from "../outlook_calendar/index";
import { PODIO_CONNECTOR_ID } from "../podio/index";
import { QBO_SCOPE } from "../qbo/api";
import { QBO_CONNECTOR_ID } from "../qbo/index";
import { RAMP_CONNECTOR_ID, RAMP_SCOPES } from "../ramp/index";
import { SLACK_CONNECTOR_ID, SLACK_SCOPES } from "../slack/index";
import { WHATSAPP_META_CONNECTOR_ID } from "../whatsapp_meta/index";
import { META_SCOPES } from "../whatsapp_meta/signup";
import { ZOHO_CRM_CONNECTOR_ID, ZOHO_SCOPES } from "../zoho_crm/index";

const GOOGLE_EMAIL = "https://www.googleapis.com/auth/userinfo.email";
const MICROSOFT_BASICS = [...MICROSOFT_SIGN_IN_SCOPES, "profile", "User.Read"];

/**
 * By connector id: the scopes we ask for, or null when the sign-in asks for none to compare with
 * (the grant is then shown as not comparable).
 */
// DECISION (§1.231.2): Podio is null: it is signed in to with no `scope` parameter, so Podio grants
// what the person can do (its own DECISION); the permission matrix and the gate limit the agent.
// The bank feed is null: Plaid Link has no OAuth scopes.
export const DECLARED_OAUTH_SCOPES: Readonly<Record<string, readonly string[] | null>> = {
  [QBO_CONNECTOR_ID]: [QBO_SCOPE],
  [GMAIL_CONNECTOR_ID]: [...GMAIL_SCOPES, GOOGLE_EMAIL],
  [GCAL_CONNECTOR_ID]: [...GCAL_SCOPES, GOOGLE_EMAIL],
  [GDRIVE_CONNECTOR_ID]: GDRIVE_SCOPES,
  [GSHEETS_CONNECTOR_ID]: GSHEETS_SCOPES,
  [GSC_OAUTH_CONNECTOR_ID]: [GSC_SCOPE],
  [OUTLOOK_CONNECTOR_ID]: [...OUTLOOK_SCOPES, ...MICROSOFT_BASICS],
  [EXCEL_CONNECTOR_ID]: [...EXCEL_SCOPES, ...MICROSOFT_BASICS],
  [ONEDRIVE_CONNECTOR_ID]: [graphScope(ONEDRIVE_GRAPH_SCOPE), ...MICROSOFT_BASICS],
  [OUTLOOK_CALENDAR_CONNECTOR_ID]: [graphScope(CALENDARS_READWRITE), ...MICROSOFT_BASICS],
  [SLACK_CONNECTOR_ID]: SLACK_SCOPES,
  [LINKEDIN_CONNECTOR_ID]: LINKEDIN_SCOPES,
  [HUBSPOT_CONNECTOR_ID]: HUBSPOT_SCOPES,
  [ZOHO_CRM_CONNECTOR_ID]: ZOHO_SCOPES,
  [RAMP_CONNECTOR_ID]: RAMP_SCOPES,
  [WHATSAPP_META_CONNECTOR_ID]: META_SCOPES,
  [PODIO_CONNECTOR_ID]: null,
  [BANKFEED_CONNECTOR_ID]: null,
};

/** The scopes a connector asks for; undefined for a connector not listed (not OAuth). */
export function declaredOAuthScopes(connectorId: string): readonly string[] | null | undefined {
  return DECLARED_OAUTH_SCOPES[connectorId];
}
