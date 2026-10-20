const REDACTIONS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<REDACTED>'],
  [/\b(?:gh[pousr]_|github_pat_|npm_)[A-Za-z0-9_]{20,}/gi, '<REDACTED>'],
  [/\bAKIA[A-Z0-9]{16}\b/g, '<REDACTED>'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/gi, '<REDACTED>'],
  [/(Bearer|Basic)\s+\S+/gi, '$1 <REDACTED>'],
  [/(Cookie|Set-Cookie):\s*[^\r\n]+/gi, '$1: <REDACTED>'],
  [/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|COOKIE|DATABASE_URL)[A-Z0-9_]*)\s*[:=]\s*\S+/gi, '$1=<REDACTED>'],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1<REDACTED>@'],
];

/** Redacts common credential shapes, then keeps the last `limit` characters (failures print last). */
export function evidence(value: string, limit = 6_000) {
  const redacted = REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
  return redacted.length <= limit ? redacted : `...[truncated]\n${redacted.slice(-limit)}`;
}
