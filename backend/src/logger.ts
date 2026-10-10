import { pino, type Logger } from "pino";

/**
 * No PHI in logs. Anything that could carry patient text, names or addresses is redacted at the
 * logger level so a careless log line cannot leak it. pino's `*` matches exactly one level, so the
 * top-level keys are listed as well as one nested level.
 */
const REDACT_PATHS = [
  "req.headers['x-provider-key']",
  "req.headers.authorization",
  "req.headers.cookie",
  "email",
  "*.email",
  "to",
  "*.to",
  "text",
  "*.text",
  "summary",
  "*.summary",
  "body",
  "*.body",
  "firstName",
  "lastName",
  "*.firstName",
  "*.lastName",
  "caregiverEmail",
  "*.caregiverEmail",
  "link",
  "*.link",
  "linkId",
  "*.linkId",
];

export function createLogger(level: string = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: "dischargeai-backend" },
  });
}

export type { Logger };
