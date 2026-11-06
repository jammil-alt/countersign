import { z } from "zod";
import { redactCardNumbers } from "../compliance/card-numbers";

// Voice samples (ARCHITECTURE v0.12 §6.4, §5.5 migration 0025): examples of how one of the client's
// people writes, which the client pastes into its knowledge base or forwards to its forwarding
// address with the `+voice` tag. Each is a `knowledge_entry` of kind `voice_sample` whose versions
// carry `meta {personUserId, channel}`. Agents read them only as tool results
// (`knowledge.voice_samples`): data about style, never instructions (invariant 9), and only the
// client's own (invariant 1). Gmail stays send-only: samples never come from a mailbox.

export const VOICE_SAMPLE_KIND = "voice_sample" as const;

/** The channels a sample can show a voice for. */
// DECISION: no `voice` (calls) channel: a call's opening is spoken by the voice agent, not written
// in a person's words, so samples are for email, texts and WhatsApp only.
export const VOICE_SAMPLE_CHANNELS = ["email", "sms", "whatsapp"] as const;
export const VoiceSampleChannel = z.enum(VOICE_SAMPLE_CHANNELS);
export type VoiceSampleChannel = z.infer<typeof VoiceSampleChannel>;

/** At most this many characters of a sample are kept (§6.4). */
export const VOICE_SAMPLE_MAX = 4000;

/** `knowledge_entry_version.meta` of a voice sample: whose voice, on which channel. */
export const VoiceSampleMeta = z
  .strictObject({
    /** One of the client's own users (client admin or client user). */
    personUserId: z.uuid(),
    channel: VoiceSampleChannel,
  })
  .meta({ id: "VoiceSampleMeta" });
export type VoiceSampleMeta = z.infer<typeof VoiceSampleMeta>;

/** A stored meta read leniently: null when it is not a voice sample's. */
export function readVoiceSampleMeta(value: unknown): VoiceSampleMeta | null {
  const r = VoiceSampleMeta.safeParse(value);
  return r.success ? r.data : null;
}

/**
 * The line mail apps put above quoted history, in the portal's six languages: "On … wrote:",
 * "El … escribió:", "Le … a écrit :", "Em … escreveu:", "Il … ha scritto:", "Am … schrieb …:".
 */
const ATTRIBUTION = [
  /^(on|el|le|em|il) .+ (wrote|escribió|a écrit|escreveu|ha scritto)\s*:\s*$/i,
  /^am .+ schrieb .+:\s*$/i,
];
const ORIGINAL = /^-{2,}\s*(original message|mensaje original|message d'origine)\s*-{2,}$/i;
const FORWARDED = [
  /^-{2,}\s*(forwarded message|mensaje reenviado|message transféré|mensagem encaminhada|messaggio inoltrato|weitergeleitete nachricht)\s*-{2,}$/i,
  /^begin forwarded message:\s*$/i,
];
/** Header lines of a forwarded block: `From:`, `Date:`, `Subject:`, `To:`, `Cc:`, `Sent:`. */
const FORWARD_HEADER =
  /^(from|de|von|da|date|fecha|datum|data|sent|enviado|subject|asunto|objet|assunto|oggetto|betreff|to|para|à|a|an|cc)\s*:/i;

/** The new words above any quoted history (`>` lines, "On … wrote:", "Original Message"). */
function aboveQuoted(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith(">")) break;
    if (ATTRIBUTION.some((r) => r.test(t))) break;
    if (ORIGINAL.test(t)) break;
    out.push(line);
  }
  return out;
}

/**
 * A sample's text as it is kept: the person's own words (when a message was forwarded with
 * nothing written above it, the forwarded message's text without its header lines), quoted
 * history cut, card numbers redacted (§16), at most VOICE_SAMPLE_MAX characters.
 */
// DECISION: a forward with words of its own above the forwarded block keeps those words (the
// person wrote them); a bare forward keeps the forwarded message's body, since that is what the
// person chose to show as their writing. Whose voice it is never comes from the forwarded
// headers: it is the person who sent it to the `+voice` address (see receiveVoiceSampleEmail).
export function voiceSampleText(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const marker = lines.findIndex((l) => FORWARDED.some((r) => r.test(l.trim())));
  let body = lines;
  if (marker >= 0) {
    const above = aboveQuoted(lines.slice(0, marker)).join("\n").trim();
    if (above) {
      body = lines.slice(0, marker);
    } else {
      let i = marker + 1;
      while (
        i < lines.length &&
        (FORWARD_HEADER.test((lines[i] as string).trim()) || !(lines[i] as string).trim())
      )
        i++;
      body = lines.slice(i);
    }
  }
  const text = aboveQuoted(body)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return redactCardNumbers(text).slice(0, VOICE_SAMPLE_MAX).trim();
}

/** The `+voice` tag on a forwarding address's local part (`label-…-secret+voice@domain`). */
export const VOICE_SAMPLE_TAG = "voice";

/** Whether an address carries the `+voice` tag; the address without it otherwise. */
export function voiceTagged(address: string): { tagged: boolean; address: string } {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 0) return { tagged: false, address: a };
  const [base, ...tags] = a.slice(0, at).split("+");
  const tagged = tags.length === 1 && tags[0] === VOICE_SAMPLE_TAG;
  return { tagged, address: tagged ? `${base}${a.slice(at)}` : a };
}
