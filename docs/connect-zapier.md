# Connecting a Zap to Mezonas

For clients (and the Mezonas lead helping them). Works the same with Make, n8n or any tool that can
send or receive an HTTP POST. Only a client admin can do this, from the portal's **Connections** page.

First, ask us to offer **Webhooks** to you. It then shows under Available; press **Connect**.

## From your Zap into Mezonas

Use this when something in another tool should start work here, such as a new form entry or a paid order.

1. In Connections, under **Webhooks · set up**, type a name for the hook (e.g. "Website form entries")
   and press **Make hook**.
2. Press **Copy** next to the hook's URL. Keep it private: it carries the hook's secret.
3. In Zapier, add the action **Webhooks by Zapier → POST**.
   - **URL**: paste the hook's URL.
   - **Payload type**: `json` (a form works too).
   - **Data**: the fields to send, e.g. `email`, `name`, `order_id`.
   - Optional: under **Headers**, add `Idempotency-Key` with a value that is unique for each event
     (e.g. the order id). If the Zap retries, we keep the first copy and ignore the rest. Without it,
     identical payloads to the same hook count as one.
4. Test the step. Zapier should show `{"status":"accepted", …}`.
5. Tell us which hook should start which service. We set the service's trigger to "When
   webhook.received" for that hook. Each delivery shows in your runs like any other start.

Limits: 64 KB per delivery, 60 deliveries a minute per hook. What you send is treated as data. It
never changes what your agents are allowed to do.

To stop a hook, press **Remove**. Deliveries to it are refused from then on.

**For tools that can sign requests** (n8n, Make, code): instead of the token in the URL, send
`x-mezonas-timestamp` (unix seconds) and `x-mezonas-signature: sha256=<hex>`, the HMAC-SHA256 of
`<timestamp>.<body>` keyed with the hook's token (the `token=` part of its URL). We refuse signed
deliveries more than five minutes old, so a captured one can't be replayed.

## From Mezonas into your Zap

Use this when an agent should tell another tool something, such as "invoice flagged" or "lead qualified".

1. In Zapier, start a Zap with the trigger **Webhooks by Zapier → Catch Hook** and copy its URL.
2. In Connections, under **Out of Mezonas**, paste it into **Send events to** and press **Save**. We
   only accept `https` URLs to public hosts.
3. Each event arrives as JSON:

   ```json
   {
     "id": "<unique per event>",
     "event": "invoice.flagged",
     "data": { "invoice": "INV-1042", "total": "1250.00" },
     "sentAt": "2026-11-04T15:00:00.000Z",
     "source": "mezonas"
   }
   ```

   with headers `Idempotency-Key` (the same as `id`, and stable if we retry), `x-mezonas-timestamp`
   and `x-mezonas-signature` (HMAC-SHA256 of `<timestamp>.<body>` with the **signing secret** shown
   under the URL).
4. By default, every event waits for approval in your inbox before it is sent. Your permissions for
   Webhooks (the table on the same page) can only make this stricter. Each approved event is sent once.

Changing the URL issues a new signing secret. Clearing it stops all outbound events.
