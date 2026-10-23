/** Normalize GitHub's optional website field without accepting executable links. */
export function normalizeRepositoryWebsite(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\\]/.test(value)) return null;
  const input = value.trim();
  if (!input || /\s/.test(input)) return null;
  const explicit = /^https?:\/\//i.test(input);
  // A bare domain may include a port, but another URL scheme is never inferred.
  if (!explicit && /^[a-z][a-z\d+.-]*:/i.test(input)
    && !/^[^/?#:]+\.[^/?#:]+:\d+(?:[/?#]|$)/.test(input)) return null;
  const address = explicit ? input.replace(/^https?:\/\//i, '') : input.replace(/^\/\//, '');
  const authority = address.split(/[/?#]/)[0];
  if (!authority || authority.includes('@')) return null;
  try {
    const url = new URL(explicit ? input : `https://${address}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.replace(/\.$/, '');
    if (!host || (!explicit && !host.includes('.'))) return null;
    // URL parsing permits malformed DNS labels; exclude those while retaining
    // valid international domains (already punycoded by URL), IPs and local hosts.
    if (!host.startsWith('[') && (host.length > 253 || host.split('.').some(label =>
      !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)))) return null;
    return url.href;
  } catch { return null; }
}
