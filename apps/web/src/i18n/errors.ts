// API errors in the reader's language (docs/plan.md §1.18): by their code, with the server's own
// message as the fallback for codes we have no words for.
import { isApiError } from "../api/client";
import type { PlainKey } from "./catalog";
import type { I18n } from "./i18n";

/** The API's error codes (apps/api `HttpError`, packages/auth refusals, the client's own) we word. */
const CODE_KEYS: Record<string, PlainKey> = {
  network: "error.network",
  invalid_request: "error.invalid_request",
  invalid_response: "error.invalid_response",
  internal: "error.internal",
  unauthenticated: "error.unauthenticated",
  session_invalid: "error.unauthenticated",
  no_access: "error.no_access",
  forbidden: "error.forbidden",
  tenant_forbidden: "error.forbidden",
  not_found: "error.not_found",
  conflict: "error.conflict",
  no_op: "error.no_op",
  already_resolved: "error.already_resolved",
  expired: "error.expired",
  not_assignee: "error.not_assignee",
  not_connected: "error.not_connected",
  not_available: "error.not_available",
  unknown_connector: "error.not_available",
  too_large: "error.too_large",
  empty: "error.empty",
  invalid_state: "error.invalid_state",
  feedback_off: "error.feedback_off",
  not_configured: "error.not_configured",
  loosening: "error.loosening",
  invalid_credentials: "error.invalid_credentials",
  invalid_grant: "error.invalid_grant",
  adapter_disabled: "error.not_configured",
  misconfigured: "error.not_configured",
};

/**
 * What a failed call says to the reader. English keeps the server's own words (the back office
 * reads them, and they are often more precise), except for "not found" and "no access".
 */
// DECISION: in English the server message stays the text, as before languages; other languages
// show the code's words, or the status's, and the server message only for codes we don't word.
export function errorText(error: unknown, i18n: I18n): string {
  const { t } = i18n;
  if (!isApiError(error)) return error instanceof Error ? error.message : String(error);
  const key = CODE_KEYS[error.code];
  if (error.status === 404) return t("error.not_found");
  if (error.status === 403) return i18n.locale === "en" || !key ? t("error.forbidden") : t(key);
  if (i18n.locale === "en") return error.message;
  if (key) return t(key);
  if (error.status >= 500 || error.status === 0) return t("error.internal");
  return error.message;
}
