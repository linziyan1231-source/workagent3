// Cache data, not mounted conversations or subscriptions. Bound by sessions and
// serialized size so a handful of large transcripts cannot grow without limit.
export function createConversationCache(
  limit = 12,
  maxBytes = 16 * 1024 * 1024,
) {
  const sessions = new Map();
  let bytes = 0;
  function remove(id) {
    const entry = sessions.get(id);
    if (entry) bytes -= entry.bytes;
    sessions.delete(id);
  }
  function get(id, key) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    sessions.set(id, entry);
    return entry.values.get(key)?.value;
  }
  function set(id, key, value) {
    const size = JSON.stringify(value).length * 2;
    if (size > maxBytes) {
      remove(id);
      return;
    }
    const entry = sessions.get(id) || { values: new Map(), bytes: 0 };
    const change = size - (entry.values.get(key)?.bytes || 0);
    entry.bytes += change;
    bytes += change;
    entry.values.set(key, { value, bytes: size });
    sessions.delete(id);
    sessions.set(id, entry);
    while (sessions.size > limit || bytes > maxBytes)
      remove(sessions.keys().next().value);
  }
  return { get, set, remove };
}
