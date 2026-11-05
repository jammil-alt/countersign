// Logs keep metadata only: which identity, which channel, what happened. Never a code, a secret, a
// pattern's match or a message's text (ARCHITECTURE §6.9). The guard below drops any field whose
// name suggests content, as a second line of defence.

type Field = string | number | boolean | null | undefined;

const CONTENT_KEY = /code$|secret|token|otpauth|body|text|subject|html|raw/i;

export function logEvent(event: string, fields: Record<string, Field> = {}): void {
  const safe: Record<string, Field> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (CONTENT_KEY.test(k)) continue;
    safe[k] = v;
  }
  console.log(JSON.stringify({ service: "codes", event, ...safe }));
}
