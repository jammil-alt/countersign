# Calls: ElevenLabs and Twilio voice, notes to verify

Written 2026-11-04, overnight. Neither `elevenlabs.io`, `twilio.com` nor their docs could be
reached from the build environment, and there were no ElevenLabs or Twilio credentials. Everything
below comes from what we know of the two APIs. The tests run against fakes (`elevenlabs/fake.ts`,
`twilio/fake.ts`) built the same way, so **a mistake here is a mistake in the fakes too**. Check
each **UNCHECKED** item against the live docs and a test account before a client gets a real call.
The texting notes are in `../twilio/NOTES.md`.

## Setup to do in the morning

1. **ElevenLabs:** create Mezonas' workspace and an API key with Conversational AI access. Set the
   deployment secrets `ELEVENLABS_API_KEY` and `ELEVENLABS_WEBHOOK_SECRET`.
2. In ElevenLabs' settings, turn on the **post-call webhook** (transcription, not audio). Point it at
   `https://<APP_ORIGIN>/api/elevenlabs/post-call`, and paste its signing secret into
   `ELEVENLABS_WEBHOOK_SECRET`. The back office's Calls panel shows the URL.
3. **Twilio:** voice runs on the same subaccounts and numbers as texts. In the back office, turn
   calls on for a client: every number then takes calls (2026-11-13; "Stop taking its calls"
   undoes it for one number).
4. US: register the numbers' caller ID (**SHAKEN/STIR and CNAM**) in Twilio's Trust Hub so outbound
   calls aren't flagged as spam. UNCHECKED: whether subaccount numbers inherit the main account's
   Trust Hub profile.
5. Wire the two secrets into `deploy.yml` with the other secrets (`docs/operations.md`).

## ElevenLabs

| Fact | Status |
|---|---|
| API base `https://api.elevenlabs.io`, header `xi-api-key` | UNCHECKED (long-standing) |
| Create an agent: `POST /v1/convai/agents/create` → `{ agent_id }`. Body as in `voiceAgentBody()`: `conversation_config.agent.{first_message, language, prompt.{prompt, tools}}`, `conversation_config.tts.voice_id`, `conversation_config.conversation.max_duration_seconds`, `platform_settings.privacy.record_voice`, `platform_settings.data_collection` | UNCHECKED, mainly field names and nesting |
| Tools inline on the agent (`prompt.tools[]` with `type: "webhook"`, `api_schema.{url, method, request_headers, request_body_schema}`) | Schema **checked** 2026-11-12 ([create-agent reference](https://elevenlabs.io/docs/api-reference/agents/create)): the fields match, header values may be strings or dynamic variables, but `prompt.tools` is marked deprecated ("use tool_ids instead"). Still accepted; UNCHECKED live. If ElevenLabs stops taking it, `createVoiceAgent` makes the tools first (`POST /v1/convai/tools`) and passes `prompt.tool_ids` |
| `end_call` as a built-in tool: `prompt.built_in_tools.end_call` = `{name, description, params: {system_tool_type: "end_call"}}`. `params` is required on a system tool, so our first shape (`{type: "system", name: "end_call"}` in `tools`, no `params`) would have been refused | **Checked** 2026-11-12 against the [create-agent reference](https://elevenlabs.io/docs/api-reference/agents/create) (schema only, not yet a live call). The fake refuses a system tool without `params.system_tool_type` |
| `request_body_schema` takes our tools' JSON Schemas as they are | UNCHECKED. ElevenLabs may need every property to have a `description` and may not accept `default`, `pattern` or `format`. If it refuses, strip those in `voiceAgentConfig` |
| Dynamic variables (`{{call_id}}`) and secret dynamic variables (`{{secret__call_token}}`, never shown to the model) can be used in tool **request headers** | UNCHECKED. This is how the tool webhook knows the call and its token. If headers can't take them, send them as body fields filled from dynamic variables, and read them there in `routes/voice-hooks.ts` |
| Hand a Twilio call to an agent: `POST /v1/convai/twilio/register-call` with `agent_id`, `from_number`, `to_number`, `direction` (`inbound`/`outbound`), `conversation_initiation_client_data.dynamic_variables` → TwiML (`<Connect><Stream …/>`) | Path and body **checked** 2026-11-12 ([register-call reference](https://elevenlabs.io/docs/api-reference/twilio/register-call)). Its summary says it returns TwiML, its example answer is a JSON string: we accept either (`twimlOf`), and the fake answers a JSON string. UNCHECKED live which one comes. We don't import numbers into ElevenLabs: Twilio keeps asking us, so the approval and the inbound decision stay ours |
| ElevenLabs' language codes: `en`, `es`, `fr`, `pt` (for pt-BR), `it`, `de`, and whether a non-English agent needs a multilingual model or voice | UNCHECKED |
| `record_voice: false` keeps no audio, while transcripts are still sent in the post-call webhook | UNCHECKED |
| `data_collection` item `record_ok` (boolean) comes back in `analysis.data_collection_results.record_ok.value` | UNCHECKED |
| Post-call webhook: `ElevenLabs-Signature: t=<unix>,v0=<hex HMAC-SHA256 of "<t>.<raw body>">` under the webhook secret | UNCHECKED. Our check also refuses timestamps more than 30 minutes away |
| Post-call body: `{type: "post_call_transcription", data: {agent_id, conversation_id, status, transcript: [{role: "agent"\|"user", message, time_in_call_secs}], metadata.call_duration_secs, analysis.{transcript_summary, data_collection_results}, conversation_initiation_client_data.dynamic_variables}}` | UNCHECKED. Other types (`post_call_audio`, `call_initiation_failure`) are acknowledged and ignored |
| Whether secret dynamic variables come back in the post-call body (we don't rely on it: we use `call_id` and `tenant_id`) | UNCHECKED |
| Webhook retries: how often, and whether a non-2xx makes ElevenLabs switch the webhook off | UNCHECKED. We answer 200 for a repeat |
| Prices: per-minute price of Conversational AI (and the LLM's share), concurrency limits per plan | UNCHECKED. Not in code. Usage counts seconds (`usage_daily.call_seconds`) |
| Agent limits per workspace (we make one per client agent version and call settings) | UNCHECKED. Old agents are never deleted. Deleting agents nobody uses is a follow-up |
| Which LLM the voice agent uses (ElevenLabs' default unless set) | Not set. The owner may want to choose one per agent (`conversation_config.agent.prompt.llm`) |

## Twilio voice

| Fact | Status |
|---|---|
| Place a call: `POST /Accounts/{sid}/Calls.json` with `To`, `From`, `Url`, `Method=POST`, `StatusCallback`, `StatusCallbackMethod=POST`, `Timeout`, `TimeLimit` → 201 with `sid` (CA…), `status` | UNCHECKED |
| **No idempotency key on call create.** A crash after Twilio placed a call and before we recorded it could place it twice on retry | UNCHECKED whether Twilio accepts an idempotency header. We send none. The call's request (with its time) is recorded before the create, and a re-run with a request but no recorded call never creates again: it reconciles (below) or fails for the operator (docs/plan.md §1.23) |
| Reconciling an attempt: `GET /Accounts/{sid}/Calls.json?To=<to>&From=<our number>&PageSize=50` → `calls[]` with `sid` (CA…), `to`, `from` (E.164), `status`, `direction` (`outbound-api` for ours), `date_created`, `start_time`, newest first | UNCHECKED: that `To` and `From` filter together, the field names, and the order |
| A call just created is listed at once, while `queued` or `ringing`, with `date_created` set (RFC 2822) and `start_time` empty | UNCHECKED. We match on `date_created` (falling back to `start_time`), allowing Twilio's clock to be up to two minutes behind ours |
| The status callback by default fires only on `completed` (final), with `CallStatus` in `completed`, `busy`, `no-answer`, `failed`, `canceled` and `CallDuration` in seconds | UNCHECKED |
| Point a number's calls at us: `POST /Accounts/{sid}/IncomingPhoneNumbers/{PN}.json` with `VoiceUrl`, `VoiceMethod`, `StatusCallback`, `StatusCallbackMethod`; empty strings clear them | **Checked** on staging 2026-11-13: a number pointed at us from the back office took a real call |
| A number with no voice handler (no `VoiceUrl`, TwiML Bin, Studio flow or SIP trunk) | **Checked** 2026-11-13 (Twilio support): carriers refuse calls to it ("your call cannot be completed as dialed") and nothing reaches Twilio's logs. Hence numbers take calls by default once calls are on |
| Voice webhooks are signed like messaging ones (X-Twilio-Signature, HMAC-SHA1 over the URL as given, query string included, plus sorted POST params) | UNCHECKED for voice. Same algorithm as the texting check |
| Inbound call fields: `CallSid`, `AccountSid`, `From`, `To`, `CallStatus`, `Direction=inbound` | UNCHECKED |
| `<Record maxLength timeout playBeep recordingStatusCallback recordingStatusCallbackMethod>` posts `RecordingSid` (RE…), `RecordingDuration`, `RecordingStatus`, `CallSid` | UNCHECKED |
| `<Dial timeout callerId><Number>…</Number></Dial>`: showing the caller's number as caller ID on a forward is allowed | UNCHECKED. Twilio may require `callerId` to be one of our numbers. If so, use the client's number |
| `<Say language="es-US">` etc. with Twilio's built-in voices for each language | UNCHECKED: the codes and voice quality. Amazon Polly or Google voices can be chosen with `voice=` |
| Voicemail recordings are kept at Twilio (subaccount), and fetching one needs the subaccount's credentials | UNCHECKED. Playing voicemails in the portal is not built |
| Answering-machine detection (`MachineDetection`) is not used: a voicemail greeting talks to the agent, which hears it and ends the call | A decision. Turn it on per call if that wastes minutes |
| Prices: per-minute inbound and outbound rates, recording storage | UNCHECKED. Not in code |
| Rules for automated calls: TCPA prior express (written for marketing) consent for artificial-voice calls to mobiles, the FCC's 2024 ruling that AI voices are artificial voices, state rules on recording (two-party consent states), and calling hours (8am–9pm local) | To check with counsel. In code: calls need their own `voice` consent, quiet hours default to 21:00–08:00 in the client's timezone, every call opens with the disclosure, and nothing of what was said is kept unless the person says yes to a record |
