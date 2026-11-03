// Cookie reading and writing, without a framework. Adapters hand back `Set-Cookie` strings; the API
// appends them to its response.

export interface CookieOptions {
  readonly maxAgeSec: number;
  /** Off only for the dev adapter on plain http. */
  readonly secure?: boolean;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const maxAge = Math.max(0, Math.floor(options.maxAgeSec));
  const secure = options.secure === false ? "" : "; Secure";
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly${secure}; SameSite=Lax`;
}

export function clearCookie(name: string, options: { secure?: boolean } = {}): string {
  return serializeCookie(name, "", { maxAgeSec: 0, ...options });
}

/** One cookie from a `Cookie` header, without trusting its shape. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null;
  }
  return null;
}

export function requestCookie(request: Request, name: string): string | null {
  return readCookie(request.headers.get("cookie"), name);
}
