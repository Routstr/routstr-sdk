/**
 * Remove credentials from a returned human-readable diagnostic, not caller input
 * or documentation URLs. Known values are literal, case-sensitive credentials.
 * Match only original text and union spans before inserting markers: replacing
 * a known prefix first must not expose the rest of a Cashu/Bearer credential,
 * and a known value must never match a marker inserted by this function.
 *
 * Work depends only on the diagnostic and known credentials, never request size.
 * No whole-field suppression or arbitrary diagnostic length limit is applied.
 */
export function redactCredentials(
  value: string,
  knownCredentials: readonly (string | undefined)[] = []
): string {
  const spans: Array<[number, number]> = [];
  for (const match of value.matchAll(/cashu[AB][A-Za-z0-9_-]+|Bearer\s+\S+/gi)) {
    spans.push([match.index!, match.index! + match[0].length]);
  }
  for (const credential of new Set(knownCredentials)) {
    if (!credential) continue;
    let start = value.indexOf(credential);
    while (start !== -1) {
      spans.push([start, start + credential.length]);
      // Include overlapping occurrences, e.g. "aba" within "ababa".
      start = value.indexOf(credential, start + 1);
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const result: string[] = [];
  let cursor = 0;
  for (let i = 0; i < spans.length; i++) {
    const [start, firstEnd] = spans[i];
    let end = firstEnd;
    while (i + 1 < spans.length && spans[i + 1][0] <= end) {
      end = Math.max(end, spans[++i][1]);
    }
    result.push(value.slice(cursor, start), "[REDACTED]");
    cursor = end;
  }
  result.push(value.slice(cursor));
  return result.join("");
}
