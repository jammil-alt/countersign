// The WHATWG URL every runtime this package runs in has; the package has no DOM or Node types.

export interface WebUrl {
  origin: string;
  host: string;
  hostname: string;
  pathname: string;
  searchParams: { get(name: string): string | null };
}

const WebURL = (globalThis as unknown as { URL: new (url: string) => WebUrl }).URL;

export function webUrl(value: string): WebUrl {
  return new WebURL(value);
}
