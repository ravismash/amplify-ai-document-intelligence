// Postgres text/JSONB columns reject the NUL byte (0x00) outright, as an uncaught error from the
// driver - a single user-supplied NUL anywhere in a request body (a question, a title, a filename,
// a document id) crashes the whole process, not just that request. Every write path funnels
// through this before reaching a query, so no individual route can forget to sanitize.
export function stripNulls(value) {
  if (typeof value === 'string') return value.replace(/\u0000/g, '');
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, stripNulls(val)]));
  }
  return value;
}
