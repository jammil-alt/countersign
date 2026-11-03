/**
 * The logger tool handlers and connectors get. Fields are structured data; handlers never pass
 * credentials, tokens or document text in them.
 */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type LogLevel = keyof Logger;

export interface LogEntry {
  level: LogLevel;
  message: string;
  fields?: Record<string, unknown>;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** A logger that keeps entries in memory, for tests. */
export function memoryLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at =
    (level: LogLevel) =>
    (message: string, fields?: Record<string, unknown>): void => {
      entries.push(fields === undefined ? { level, message } : { level, message, fields });
    };
  return {
    entries,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}

/** A logger whose entries all carry the given fields (connector, connection, tool). */
export function childLogger(parent: Logger, fields: Record<string, unknown>): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, more?: Record<string, unknown>): void =>
      parent[level](message, { ...fields, ...more });
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
