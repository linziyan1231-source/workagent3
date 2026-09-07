import { chromium } from "playwright";

const baseURL = process.env.WORKAGENT_SMOKE_URL;
const username = process.env.WORKAGENT_SMOKE_USERNAME;
const password = process.env.WORKAGENT_SMOKE_PASSWORD;
if (!baseURL || !username || !password) {
  throw new Error(
    "WORKAGENT_SMOKE_URL, WORKAGENT_SMOKE_USERNAME and WORKAGENT_SMOKE_PASSWORD are required",
  );
}

const browser = await chromium.launch();
let restoreAssistant;
try {
  const page = await browser.newPage();
  const anonymous = await page.request.get(`${baseURL}/api/session.search`);
  if (anonymous.status() !== 401)
    throw new Error(`anonymous dsh API returned ${anonymous.status()}`);
  const login = await page.request.post(`${baseURL}/api/auth/login`, {
    data: { username, password },
    headers: { Origin: new URL(baseURL).origin },
  });
  if (!login.ok()) throw new Error(`login returned ${login.status()}`);
  const presetURL = `${baseURL}/api/runtime/v1/presets/builtin-general`;
  const presetResponse = await page.request.get(presetURL);
  if (!presetResponse.ok())
    throw new Error("Could not read DSH assistant state");
  const originalPreset = await presetResponse.json();
  if (!originalPreset.enabled) {
    const setEnabled = async (enabled) => {
      const result = await page.request.patch(presetURL, {
        data: { enabled },
        headers: { Origin: new URL(baseURL).origin },
      });
      if (!result.ok())
        throw new Error(`DSH switch returned ${result.status()}`);
    };
    restoreAssistant = () => setEnabled(false);
    await setEnabled(true);
  }
  const response = await page.goto(`${baseURL}/?frontend=dsh`);
  if (!response?.ok())
    throw new Error(`dsh SPA returned ${response?.status()}`);
  await page.waitForSelector("text=WorkAgent");
  const initialBackground = await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);
  const initialWasDark = await page
    .locator("body")
    .evaluate((body) => body.hasAttribute("data-ds-dark-theme"));
  await page.getByRole("button", { name: /Settings|设置/ }).click();
  await page
    .getByRole("button", {
      name: initialWasDark ? "云瓷白" : "石墨黑",
    })
    .click();
  await page.waitForFunction(
    (before) => getComputedStyle(document.body).backgroundColor !== before,
    initialBackground,
  );
  const switchedBackground = await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);
  await page.reload();
  await page.waitForSelector("text=WorkAgent");
  const restoredBackground = await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);
  if (restoredBackground !== switchedBackground)
    throw new Error(
      `theme preference was not restored (${switchedBackground} -> ${restoredBackground})`,
    );
  if ((await page.locator("body").innerText()).includes("AionUi"))
    throw new Error("retired brand is visible");
  const round = await page.evaluate(async () => {
    const unique = `dsh-smoke-${Date.now()}`;
    const json = async (path, init) => {
      const response = await fetch(path, {
        credentials: "same-origin",
        ...init,
        headers:
          init?.body === undefined
            ? init?.headers
            : { "Content-Type": "application/json", ...init.headers },
      });
      if (!response.ok)
        throw new Error(
          `${path} returned ${response.status}: ${await response.text()}`,
        );
      return response.status === 204 ? undefined : response.json();
    };
    const workspace = await json("/api/runtime/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: unique }),
    });
    const session = await json("/api/runtime/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        engine: "harness",
        title: unique,
        workspace: workspace.id,
      }),
    });
    const delta = new Promise((resolve, reject) => {
      const stream = new EventSource(
        `/api/runtime/v1/sessions/${encodeURIComponent(session.id)}/events`,
      );
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error("streaming delta timeout"));
      }, 90_000);
      stream.onmessage = (event) => {
        const value = JSON.parse(event.data);
        if (value.type !== "assistant.delta") return;
        clearTimeout(timer);
        stream.close();
        resolve(value.delta);
      };
      stream.onerror = () => {
        clearTimeout(timer);
        stream.close();
        reject(new Error("session event stream failed"));
      };
    });
    await json(
      `/api/runtime/v1/sessions/${encodeURIComponent(session.id)}/turns`,
      {
        method: "POST",
        body: JSON.stringify({
          content: `Reply with ${unique}, then keep counting slowly.`,
        }),
      },
    );
    const firstDelta = await delta;
    await json(
      `/api/runtime/v1/sessions/${encodeURIComponent(session.id)}/cancel`,
      { method: "POST" },
    );
    const search = await json(
      `/api/runtime/v1/messages/search?keyword=${encodeURIComponent(unique)}&page=0&page_size=20`,
    );
    if (!search.items?.some((item) => item.session?.id === session.id))
      throw new Error("created session was not searchable");
    return {
      firstDelta,
      sessionId: session.id,
      workspaceId: workspace.id,
      messageId: search.items.find(
        (item) =>
          item.session?.id === session.id && item.message?.role === "user",
      ).message.id,
      unique,
    };
  });
  if (!round.firstDelta) throw new Error("empty streaming delta");
  await page.goto(
    `${baseURL}/?session=${encodeURIComponent(round.sessionId)}&message=${encodeURIComponent(round.messageId)}&frontend=dsh`,
  );
  await page.locator(".workagent-message-highlight").waitFor();
  await page.getByLabel("继续对话", { exact: true }).waitFor();
  const edited = `${round.unique}-edited`;
  const forkResponse = await page.request.post(
    `${baseURL}/api/runtime/v1/sessions/${encodeURIComponent(round.sessionId)}/fork`,
    {
      data: { messageId: round.messageId, replacementContent: edited },
      headers: { Origin: new URL(baseURL).origin },
    },
  );
  if (!forkResponse.ok())
    throw new Error(
      `message fork failed: ${forkResponse.status()} ${await forkResponse.text()}`,
    );
  const forkSession = (await forkResponse.json()).id;
  await page.goto(
    `${baseURL}/?session=${encodeURIComponent(forkSession)}&frontend=dsh`,
  );
  await page.waitForFunction(
    async ({ forkSession, edited }) => {
      const response = await fetch(
        `/api/runtime/v1/messages/search?keyword=${encodeURIComponent(edited)}&session_id=${encodeURIComponent(forkSession)}&page_size=20`,
      );
      const value = await response.json();
      return value.items?.some((item) => item.session.id === forkSession);
    },
    { forkSession, edited },
    { timeout: 90_000 },
  );
  console.log(
    `dsh client smoke passed (${initialBackground} -> ${restoredBackground})`,
  );
  for (const path of [
    `sessions/${encodeURIComponent(forkSession)}`,
    `sessions/${encodeURIComponent(round.sessionId)}`,
    `workspaces/${encodeURIComponent(round.workspaceId)}`,
  ]) {
    const removed = await page.request.delete(
      `${baseURL}/api/runtime/v1/${path}`,
      {
        headers: { Origin: new URL(baseURL).origin },
      },
    );
    if (!removed.ok())
      throw new Error(`smoke cleanup returned ${removed.status()}`);
  }
} finally {
  try {
    await restoreAssistant?.();
  } finally {
    await browser.close();
  }
}
