import { createHash } from "node:crypto";

const SECRET_KEY =
  /^(?:authorization|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)s?$/i;
const SECRET_TEXT = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
];

export function redactValue(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    return SECRET_TEXT.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED:CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(item, seen),
    ])
  );
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashEvidence(evidence) {
  return createHash("sha256")
    .update(canonical(redactValue(evidence)))
    .digest("hex");
}
