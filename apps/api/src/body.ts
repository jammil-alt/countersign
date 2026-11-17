// Reading a request's body with a cap (audit 6.5). Every route that takes a body with no session
// (providers' webhooks, the public inbound route, the token-link pages, the sign-in steps) reads it
// through here: a declared length over the limit is refused without reading, and a body with no
// length, or a false one, is read in chunks and dropped as soon as it passes the limit. Nothing
// larger than the limit (and one chunk) is ever held.

/**
 * The body as bytes, read in chunks and never past `limit` (null when it is longer): the declared
 * length is checked first, and the count while reading.
 */
export async function readBodyLimited(req: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The body as UTF-8 text, at most `limit` bytes of it; null when it is longer. */
export async function readTextLimited(req: Request, limit: number): Promise<string | null> {
  const bytes = await readBodyLimited(req, limit);
  return bytes ? new TextDecoder().decode(bytes) : null;
}
