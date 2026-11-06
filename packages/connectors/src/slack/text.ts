// v0.14 W4-C: what `slack.message.post` sends, built by us from plain text (docs/plan.md §1.56). The
// model gives words only; it never gives blocks, formatting or mentions. The visible message is one
// `plain_text` section (Slack shows it as written: no mrkdwn, no links, no mentions), and the `text`
// Slack uses for notifications is the same words with Slack's three escapes, so no `<!channel>`,
// `<!here>`, `<@U…>`, `<#C…>`, `<!subteam^…>` or `<url|label>` can form in it. Bare `@channel`,
// `@here` and `@everyone` get a word joiner after the `@` as well, in case Slack ever links names.
// Index loops only: nothing here can backtrack on the model's text.

/** Slack's limit for a `plain_text` section's text (NOTES.md). */
export const SLACK_TEXT_MAX = 3000;

/** U+2060 WORD JOINER: invisible, and breaks `@channel` as a word. */
const WORD_JOINER = "⁠";
const BROADCASTS = ["channel", "here", "everyone"] as const;

/**
 * Plain text as we keep it: line breaks as `\n`, tabs kept, every other control character
 * (and the BOM) dropped. Characters beyond the limit are refused by the tool's input schema.
 */
export function cleanSlackText(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    const c = input.charCodeAt(i);
    if (ch === "\r") {
      // \r\n and a lone \r both become \n.
      if (input[i + 1] !== "\n") out += "\n";
      continue;
    }
    if (ch === "\n" || ch === "\t") {
      out += ch;
      continue;
    }
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xfeff) continue;
    out += ch;
  }
  return out;
}

function startsWithAt(text: string, at: number, word: string): boolean {
  if (text.length - at < word.length) return false;
  for (let k = 0; k < word.length; k++) {
    if (text[at + k]?.toLowerCase() !== word[k]) return false;
  }
  // A whole word only: `@channels` and `@herein` are not broadcasts.
  const next = text.charCodeAt(at + word.length);
  return !(
    (next >= 0x30 && next <= 0x39) ||
    (next >= 0x41 && next <= 0x5a) ||
    (next >= 0x61 && next <= 0x7a) ||
    next === 0x5f
  );
}

/** `@channel`, `@here` and `@everyone` (any case) with a word joiner after the `@`. */
export function breakBroadcasts(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    out += ch;
    if (ch === "@" && BROADCASTS.some((w) => startsWithAt(text, i + 1, w))) out += WORD_JOINER;
  }
  return out;
}

/** Slack's escapes for message text: `&`, `<` and `>` (and nothing else). */
export function escapeSlackText(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else out += ch;
  }
  return out;
}

/** What we post: the words as a plain-text section, and the escaped words for notifications. */
export interface SlackMessageBody {
  text: string;
  blocks: { type: "section"; text: { type: "plain_text"; text: string; emoji: boolean } }[];
}

export function slackMessage(input: string): SlackMessageBody {
  const words = breakBroadcasts(cleanSlackText(input));
  return {
    text: escapeSlackText(words),
    blocks: [{ type: "section", text: { type: "plain_text", text: words, emoji: true } }],
  };
}
