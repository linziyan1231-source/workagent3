const apiRoot = "/api/runtime/v1";

async function request(path, init) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers:
      init?.body === undefined
        ? init?.headers
        : { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return undefined;
  const type = response.headers.get("content-type") || "";
  return type.includes("json") ? response.json() : response.text();
}

async function mutate(refresh, setError, path, method, value) {
  try {
    setError("");
    await request(path, {
      method,
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    await refresh();
    return true;
  } catch (error) {
    setError(error.message);
    return false;
  }
}

export { apiRoot, request, mutate };
