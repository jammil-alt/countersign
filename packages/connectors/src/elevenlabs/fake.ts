// A fake ElevenLabs for tests (re-exported by @countersign/connectors/testing; never imported by the
// Worker): voice agents made, calls handed over (answering TwiML that would stream the call), and
// signed post-call webhooks. Shaped like ElevenLabs as far as we know it (NOTES.md lists what is
// unverified), so a mistake in the notes is a mistake here too.

import type { FetchLike, HttpResponseLike } from "../http";
import { parseUrl } from "../http";
import { ELEVENLABS_API, elevenLabsSignature, RECORD_OK_ITEM } from "./index";

export const FAKE_ELEVENLABS = {
  apiKey: "fake-elevenlabs-key-000000000000",
  webhookSecret: "fake-elevenlabs-webhook-secret-0000",
};

function json(status: number, body?: unknown): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
  };
}

function xml(body: string): HttpResponseLike {
  return {
    status: 200,
    ok: true,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "text/xml" : null) },
    text: async () => body,
  };
}

export interface FakeRegisteredCall {
  agentId: string;
  from: string;
  to: string;
  direction: string;
  dynamicVariables: Record<string, string>;
  conversationId: string;
}

export function fakeElevenLabs() {
  let counter = 1;
  const agents = new Map<string, Record<string, unknown>>();
  const calls: FakeRegisteredCall[] = [];
  let failNextRegister = false;

  const fetch: FetchLike = async (url, init = {}) => {
    const u = parseUrl(url);
    if (!u || !url.startsWith(ELEVENLABS_API)) return json(404, { detail: "unknown host" });
    if (init.headers?.["xi-api-key"] !== FAKE_ELEVENLABS.apiKey) {
      return json(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } });
    }
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (u.pathname === "/v1/convai/agents/create" && method === "POST") {
      const id = `agent_${String(counter++).padStart(8, "0")}`;
      agents.set(id, body);
      return json(200, { agent_id: id });
    }
    if (u.pathname === "/v1/convai/twilio/register-call" && method === "POST") {
      if (failNextRegister) {
        failNextRegister = false;
        return json(500, { detail: "internal error" });
      }
      const agentId = String(body.agent_id ?? "");
      if (!agents.has(agentId)) return json(404, { detail: "agent not found" });
      const init = (body.conversation_initiation_client_data ?? {}) as {
        dynamic_variables?: Record<string, string>;
      };
      const conversationId = `conv_${String(counter++).padStart(8, "0")}`;
      calls.push({
        agentId,
        from: String(body.from_number ?? ""),
        to: String(body.to_number ?? ""),
        direction: String(body.direction ?? ""),
        dynamicVariables: init.dynamic_variables ?? {},
        conversationId,
      });
      return xml(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://api.elevenlabs.io/v1/convai/conversation/twilio?conversation=${conversationId}"/></Connect></Response>`,
      );
    }
    return json(404, { detail: "not found" });
  };

  return {
    fetch,
    agents,
    calls,
    failNextRegister() {
      failNextRegister = true;
    },
    /**
     * The post-call webhook ElevenLabs would send for a registered call, and its signature header.
     * `recordOk` is what the agent collected; `at` signs with another time (for replay tests).
     */
    async postCall(input: {
      call: FakeRegisteredCall;
      transcript: { role: "agent" | "user"; message: string; time_in_call_secs?: number }[];
      summary: string;
      durationSecs: number;
      recordOk: boolean;
      at?: Date;
      type?: string;
    }) {
      const payload = {
        type: input.type ?? "post_call_transcription",
        event_timestamp: Math.floor((input.at ?? new Date()).getTime() / 1000),
        data: {
          agent_id: input.call.agentId,
          conversation_id: input.call.conversationId,
          status: "done",
          transcript: input.transcript,
          metadata: { call_duration_secs: input.durationSecs, start_time_unix_secs: 0 },
          analysis: {
            transcript_summary: input.summary,
            call_successful: "success",
            data_collection_results: {
              [RECORD_OK_ITEM]: { data_collection_id: RECORD_OK_ITEM, value: input.recordOk },
            },
          },
          conversation_initiation_client_data: { dynamic_variables: input.call.dynamicVariables },
        },
      };
      const body = JSON.stringify(payload);
      const t = Math.floor((input.at ?? new Date()).getTime() / 1000);
      return { body, signature: await elevenLabsSignature(FAKE_ELEVENLABS.webhookSecret, t, body) };
    },
  };
}
export type FakeElevenLabs = ReturnType<typeof fakeElevenLabs>;
