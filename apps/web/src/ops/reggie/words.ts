// What Reggie looked at, in words: the reads behind an answer, by what they read rather than by
// tool name. A change tool shows as its card, so it has no words here.

const LOOKED_AT: Record<string, string | null> = {
  whoami: null,
  clients_list: "clients",
  client_get: "the client",
  client_review: "the client's account",
  feedback_list: "feedback",
  feedback_get: "feedback",
  runs_list: "runs",
  run_get: "runs",
  inbox_list: "the inbox",
  connections_list: "connections",
  records_search: "records",
  ops_health: "health checks",
  marketing_report: "the marketing report",
  texting_get: "texting",
  lead_messages: "lead messages",
  lead_requests: "lead requests",
  templates_list: "templates",
  people_list: "people",
  texting_numbers_available: "phone numbers",
  texting_signup_link: "the texting sign-up link",
  texting_registration_check: "the texting registration",
  // Changes: their cards say what they are.
  feedback_resolve: null,
  lead_message_post: null,
  lead_request_create: null,
  client_create: null,
  texting_setup: null,
  texting_number_buy: null,
  texting_registration_request: null,
  texting_registration_submit: null,
  agent_add: null,
  texting_invitations_send: null,
};

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "Looked at clients and runs", or null when it read nothing worth naming. */
export function lookedAt(tools: readonly string[]): string | null {
  const words: string[] = [];
  for (const tool of tools) {
    const word = tool in LOOKED_AT ? LOOKED_AT[tool] : tool.replace(/_/g, " ");
    if (word && !words.includes(word)) words.push(word);
  }
  return words.length ? `Looked at ${joinWords(words)}` : null;
}
