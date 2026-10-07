/** Additional detection only: scope + omission of tool/system records is the privacy boundary.
 * Arbitrary previously pasted secrets cannot be reliably classified; never call this a DLP guarantee. */
export function redactDesktopText(input: string): { text: string; redacted: boolean } {
  let text = input.replace(/-----BEGIN [^\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^\r\n]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]');
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|\d{6,12}:[A-Za-z0-9_-]{25,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED TOKEN]');
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '[REDACTED AUTHORIZATION]');
  text = text.replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization|session[_-]?string|api[_-]?hash)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]');
  text = text.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[REDACTED]@');
  return { text, redacted: text !== input };
}
