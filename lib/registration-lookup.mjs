// Read-only lookup calls are rate-limited by the directory, but must not inherit
// the registration form's age. Never retry registration submission here.
export async function lookupInstitution(endpoint, payload, {fetchImpl = fetch, timeoutMs = 20_000} = {}) {
  if (!['search', 'details'].includes(payload.action)) throw new Error('invalid_action');
  const body = payload.action === 'search'
    ? {action: 'search', query: payload.query}
    : {action: 'details', accountId: payload.accountId};
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt === 0) continue;
      throw new Error(['TimeoutError', 'AbortError'].includes(error?.name) ? 'lookup_timeout' : 'lookup_connection_failed');
    }
    const value = await response.json().catch(() => ({}));
    if (response.ok && value.ok === true) return value;
    if (attempt === 0 && response.status >= 500) continue;
    throw new Error(value.error || 'service_unavailable');
  }
}
