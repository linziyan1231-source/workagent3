// Read-only browser acceptance. Credentials are supplied by the caller from the
// server-side secrets store via environment variables, never a local secret file.
// No installation, policy save, MCP invocation or upstream query is performed.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export function smokeConfig(env = process.env) {
  const config = {
    base: env.WORKAGENT_SMOKE_URL?.replace(/\/$/, ""),
    employee: env.WORKAGENT_SMOKE_USERNAME,
    password: env.WORKAGENT_SMOKE_PASSWORD,
    admin: env.WORKAGENT_SMOKE_ADMIN_USERNAME,
    adminPassword: env.WORKAGENT_SMOKE_ADMIN_PASSWORD,
    evidence: env.WORKAGENT_SMOKE_EVIDENCE_DIR,
    name: env.WORKAGENT_SMOKE_PROFESSIONAL_DATABASE_NAME || "专业数据库",
    simulatedStates:
      env.WORKAGENT_SMOKE_PROFESSIONAL_DATABASE_UI_STATES === "1",
  };
  if (
    Object.entries(config).some(
      ([key, value]) => !["simulatedStates"].includes(key) && !value,
    )
  ) {
    throw new Error(
      "Set WORKAGENT_SMOKE_URL, WORKAGENT_SMOKE_USERNAME, WORKAGENT_SMOKE_PASSWORD, WORKAGENT_SMOKE_ADMIN_USERNAME, WORKAGENT_SMOKE_ADMIN_PASSWORD and WORKAGENT_SMOKE_EVIDENCE_DIR.",
    );
  }
  return config;
}

export async function runProfessionalDatabaseMarketSmoke(config) {
  const privateValues = [
    config.employee,
    config.password,
    config.admin,
    config.adminPassword,
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const redact = (text) =>
    privateValues.reduce(
      (value, secret) =>
        value
          .replaceAll(secret, "[redacted]")
          .replaceAll(encodeURIComponent(secret), "[redacted]"),
      String(text),
    );
  const report = {
    status: "running",
    readOnly: true,
    checks: [],
    simulatedChecks: [],
    blockedWrites: [],
    errors: [],
  };
  const evidence = resolve(config.evidence);
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch();
  const origin = new URL(config.base).origin;
  const marketPath = "/api/portal/marketplace";
  const usersPath = "/api/portal/admin/users";
  let phase = "authentication";
  let activeSurface;
  let activePage;

  async function context() {
    const current = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: "block",
    });
    // Route browser traffic through an explicit read-only gate. Login is done
    // separately with APIRequestContext; all UI-initiated writes are rejected.
    await current.route("**/*", (route) => {
      const request = route.request();

      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        report.blockedWrites.push({
          method: request.method(),
          path: redact(new URL(request.url()).pathname),
        });
        return route.fulfill({ json: {} });
      }
      return route.continue();
    });
    return current;
  }

  async function authenticate(current, username, password) {
    const response = await current.request.post(
      `${config.base}/api/auth/login`,
      {
        headers: { Origin: origin },
        data: { username, password },
      },
    );
    assert(response.ok(), `Authentication returned HTTP ${response.status()}`);
  }

  function observe(page) {
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => report.errors.push(redact(error.message)));
  }

  async function snapshot(surface, page, filename) {
    // Capture only the relevant dialog. Mask account/password text if a title
    // or publisher contains it; do not save cookies, storage state or traces.
    // Playwright overlay masks can sit below a native top-layer dialog. Replace
    // matching visible text in the browser for the capture, then restore it.
    const changes = await surface.evaluateHandle((element, secrets) => {
      const changed = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const previous = node.nodeValue;
        const next = secrets.reduce(
          (value, secret) => value.replaceAll(secret, "[已隐藏]"),
          previous,
        );
        if (previous !== next) {
          changed.push({ node, previous });
          node.nodeValue = next;
        }
      }
      return changed;
    }, privateValues);
    try {
      await surface.screenshot({
        path: join(evidence, filename),
        animations: "disabled",
      });
    } finally {
      await changes.evaluate((items) => {
        for (const { node, previous } of items)
          if (node.isConnected) node.nodeValue = previous;
      });
      await changes.dispose();
    }
  }

  const detailResponse = (page) =>
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.origin === origin &&
        url.pathname === marketPath &&
        !!url.searchParams.get("id") &&
        response.request().method() === "GET"
      );
    });
  const usersResponse = (page) =>
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.origin === origin &&
        url.pathname === usersPath &&
        response.request().method() === "GET"
      );
    });

  async function parse(response) {
    assert(response.ok(), `Read returned HTTP ${response.status()}`);
    const value = await response.json();
    for (const user of value.users || []) {
      for (const name of [
        user.username,
        user.windows_username,
        user.windows_sid,
      ]) {
        if (name && !privateValues.includes(name)) privateValues.push(name);
      }
    }
    if (
      value.entry?.publisher &&
      !privateValues.includes(value.entry.publisher)
    )
      privateValues.push(value.entry.publisher);
    privateValues.sort((a, b) => b.length - a.length);
    return value;
  }

  async function checkMarket(surface, quota) {
    assert(quota, "Professional database detail is missing account usage");
    assert.equal(quota.timezone, "Asia/Shanghai");
    await surface
      .getByRole("heading", { name: "我的调用次数", exact: true })
      .waitFor();
    if (quota.configured && quota.upstream_ready === false) {
      await surface.getByText("服务待授权", { exact: true }).waitFor();
      await surface.getByText(/管理员尚需完成 Kimi 服务授权/).waitFor();
      await surface.getByText(/授权完成前无法查询，不扣调用次数/).waitFor();
    }
    if (!quota.configured) {
      await surface
        .getByText("尚未配置调用额度，请联系管理员。", { exact: true })
        .waitFor();
      assert.equal(
        await surface
          .getByRole("region", { name: "今日调用次数", exact: true })
          .count(),
        0,
      );
      return;
    }
    for (const [name, key] of [
      ["今日", "daily"],
      ["本月", "monthly"],
    ]) {
      const region = surface.getByRole("region", {
        name: `${name}调用次数`,
        exact: true,
      });
      await region
        .getByText("剩余调用次数 / 总可调用次数", { exact: true })
        .waitFor();
      await region
        .getByText(`${quota[`${key}_remaining`]} / ${quota[`${key}_limit`]}`, {
          exact: true,
        })
        .waitFor();
      await region
        .getByText(`已用 ${quota[`${key}_used`]} 次`, { exact: true })
        .waitFor();
    }
    if (!quota.enabled)
      await surface
        .getByText("未开通，当前不可调用。请联系管理员开通专业数据库。", {
          exact: true,
        })
        .waitFor();
    if (quota.enabled && (!quota.daily_remaining || !quota.monthly_remaining))
      await surface.getByText(/当前可用次数为 0，暂时无法调用/).waitFor();
    await surface.getByText(quota.counting_rule, { exact: true }).waitFor();
  }

  async function openMarket(page) {
    await page.goto(`${config.base}/?frontend=dsh&workagent=marketplace`);
    const market = page.locator('[data-workagent-section="市场"]');
    await market.waitFor();
    await market.getByRole("button", { name: "MCP", exact: true }).click();
    const card = market
      .locator("article")
      .filter({ has: page.getByText(config.name, { exact: true }) });
    await card.waitFor();
    const response = detailResponse(page);
    await card.getByRole("button", { name: "详情", exact: true }).click();
    const data = await parse(await response);
    const surface = page.getByRole("dialog", {
      name: `${config.name} · 详情`,
      exact: true,
    });
    activeSurface = surface;
    activePage = page;
    await checkMarket(surface, data.professionalDatabase);
    assert.equal(
      await surface.locator('input[type="password"]').count(),
      0,
      "Managed database details must not request a personal token",
    );
    return { surface, data };
  }

  async function openAdmin(page) {
    const response = usersResponse(page);
    await page.goto(`${config.base}/admin/accounts`);
    await page
      .getByRole("heading", { name: "账户与额度", exact: true })
      .waitFor();
    const data = await parse(await response);
    const employee = data.users.find(
      (user) => user.username === config.employee,
    );
    assert(
      employee,
      "Target employee was not found in the administrator directory",
    );
    assert(
      data.kimi_datasource_sources?.length,
      "Professional database source list is empty",
    );
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(config.employee, { exact: true }) });
    await row.getByRole("button", { name: "管理", exact: false }).click();
    const surface = page.getByRole("dialog", {
      name: config.employee,
      exact: true,
    });
    await surface.getByRole("tab", { name: "专业数据库", exact: true }).click();
    activeSurface = surface;
    activePage = page;
    await checkAdmin(surface, employee.kimi_datasource);
    return { surface, data };
  }

  async function checkAdmin(surface, grant) {
    const policy = grant || {
      enabled: false,
      daily_limit: 0,
      monthly_limit: 0,
      daily_used: 0,
      monthly_used: 0,
    };
    await surface
      .getByRole("region", { name: "专业数据库调用管理", exact: true })
      .waitFor();
    assert.equal(
      await surface
        .getByRole("checkbox", { name: "允许使用专业数据库", exact: true })
        .isChecked(),
      policy.enabled,
    );
    for (const [period, label, key] of [
      ["今日", "每日", "daily"],
      ["本月", "每月", "monthly"],
    ]) {
      const region = surface.getByRole("region", {
        name: `${period}调用次数`,
        exact: true,
      });
      await region
        .getByText(
          `剩余调用次数 ${Math.max(0, policy[`${key}_limit`] - policy[`${key}_used`])} / 总可调用次数 ${policy[`${key}_limit`]}`,
          { exact: true },
        )
        .waitFor();
      await region
        .getByText(`已用 ${policy[`${key}_used`]} 次`, { exact: true })
        .waitFor();
      assert.equal(
        await surface
          .getByRole("spinbutton", {
            name: `${label}总可调用次数`,
            exact: true,
          })
          .inputValue(),
        String(policy[`${key}_limit`]),
      );
    }
    await surface
      .getByRole("button", { name: "保存调用权限与次数", exact: true })
      .waitFor();
  }

  try {
    const employeeContext = await context();
    await authenticate(employeeContext, config.employee, config.password);
    const employeePage = await employeeContext.newPage();
    observe(employeePage);
    activePage = employeePage;
    await employeePage.goto(`${config.base}/?frontend=dsh`);
    await employeePage.getByText("WorkAgent", { exact: true }).waitFor();
    phase = "marketplace detail";
    const { surface: market, data: originalDetail } =
      await openMarket(employeePage);
    report.checks.push(
      "Authenticated DSH entry and professional database marketplace detail",
    );
    await snapshot(market, employeePage, "market-detail-desktop.png");
    const nextDetail = detailResponse(employeePage);
    await market
      .getByRole("button", { name: "刷新详情与调用次数", exact: true })
      .click();
    const refreshedDetail = await parse(await nextDetail);
    await checkMarket(market, refreshedDetail.professionalDatabase);
    report.checks.push(
      "Market refresh displays the latest returned daily/monthly remaining, total and used calls",
    );
    await employeePage.setViewportSize({ width: 390, height: 844 });
    assert(
      await market.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
      "Market detail has horizontal overflow",
    );
    await snapshot(market, employeePage, "market-detail-phone.png");
    report.checks.push("Phone marketplace detail has no horizontal overflow");

    phase = "administrator policy";
    const adminContext = await context();
    await authenticate(adminContext, config.admin, config.adminPassword);
    const adminPage = await adminContext.newPage();
    observe(adminPage);
    const { surface: adminSurface, data: originalUsers } =
      await openAdmin(adminPage);
    await snapshot(adminSurface, adminPage, "admin-database-desktop.png");
    const nextUsers = usersResponse(adminPage);
    await adminSurface
      .getByRole("button", { name: "刷新调用次数", exact: true })
      .click();
    const refreshedUsers = await parse(await nextUsers);
    const employee = refreshedUsers.users.find(
      (user) => user.username === config.employee,
    );
    assert(employee, "Target employee disappeared during the refresh");
    await checkAdmin(adminSurface, employee.kimi_datasource);
    await adminSurface.getByText("调用次数已刷新。", { exact: true }).waitFor();
    report.checks.push(
      "Administrator source permissions and daily/monthly controls match the refreshed account policy",
    );
    await adminPage.setViewportSize({ width: 390, height: 844 });
    assert(
      await adminSurface.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
      "Administrator panel has horizontal overflow",
    );
    const sizes = await adminSurface
      .locator('input[type="number"]')
      .evaluateAll((elements) =>
        elements.map((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        ),
      );
    assert(
      sizes.every((size) => size >= 16),
      "Phone editable quota controls must be at least 16px",
    );
    await snapshot(adminSurface, adminPage, "admin-database-phone.png");
    report.checks.push(
      "Phone administrator quota inputs remain readable and within the dialog",
    );

    if (config.simulatedStates) {
      phase = "simulated read-only states";
      const quota = originalDetail.professionalDatabase;
      assert(quota, "A quota response is needed to preview simulated states");
      let preview = {
        ...originalDetail,
        professionalDatabase: { ...quota, configured: true, enabled: false },
      };
      const detailMatch = (url) =>
        url.origin === origin &&
        url.pathname === marketPath &&
        !!url.searchParams.get("id");
      await employeeContext.route(detailMatch, (route) =>
        route.request().method() === "GET"
          ? route.fulfill({ json: preview })
          : route.fallback(),
      );
      await market.getByRole("button", { name: "关闭", exact: true }).click();
      let opened = await openMarket(employeePage);
      await snapshot(
        opened.surface,
        employeePage,
        "simulated-market-disabled.png",
      );
      report.simulatedChecks.push(
        "Disabled account is visibly unavailable; response substituted only in this browser",
      );
      preview = {
        ...originalDetail,
        professionalDatabase: {
          ...quota,
          configured: true,
          enabled: true,
          daily_limit: 0,
          monthly_limit: 0,
          daily_remaining: 0,
          monthly_remaining: 0,
        },
      };
      await opened.surface
        .getByRole("button", { name: "关闭", exact: true })
        .click();
      opened = await openMarket(employeePage);
      await snapshot(opened.surface, employeePage, "simulated-market-zero.png");
      report.simulatedChecks.push(
        "Zero allowance displays 0 / 0 and prevents an unlimited interpretation; browser response only",
      );
      await employeeContext.unroute(detailMatch);

      const simulatedUsers = {
        ...originalUsers,
        users: originalUsers.users.map((user) =>
          user.username === config.employee
            ? {
                ...user,
                kimi_datasource: {
                  allowed_sources: [],
                  daily_used: 0,
                  monthly_used: 0,
                  ...user.kimi_datasource,
                  enabled: false,
                  daily_limit: 0,
                  monthly_limit: 0,
                },
              }
            : user,
        ),
      };
      const userMatch = (url) =>
        url.origin === origin && url.pathname === usersPath;
      await adminContext.route(userMatch, (route) =>
        route.request().method() === "GET"
          ? route.fulfill({ json: simulatedUsers })
          : route.fallback(),
      );
      const disabled = await openAdmin(adminPage);
      await snapshot(
        disabled.surface,
        adminPage,
        "simulated-admin-disabled-zero.png",
      );
      report.simulatedChecks.push(
        "Administrator disabled and zero controls render without saving any policy",
      );
      await adminContext.unroute(userMatch);
    }
    assert.deepEqual(
      report.blockedWrites.filter((item) => item.path.startsWith("/api/portal/")),
      [],
      "Browser attempted a state-changing request",
    );
    assert.deepEqual(report.errors, [], "Browser runtime errors occurred");
    report.checks.push(
      "No UI writes, installations, employee changes or upstream data calls",
    );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.phase = phase;
    report.failure = redact(error.message);

    if (activeSurface && activePage)
      await snapshot(activeSurface, activePage, "failure-redacted.png").catch(
        () => {},
      );
  } finally {
    await browser.close();
    await writeFile(
      join(evidence, "report.json"),
      JSON.stringify(report, null, 2),
    );
  }
  return report;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const report = await runProfessionalDatabaseMarketSmoke(smokeConfig());
    console.log(
      JSON.stringify({
        status: report.status,
        readOnly: report.readOnly,
        checks: report.checks.length,
        simulatedChecks: report.simulatedChecks.length,
        blockedWrites: report.blockedWrites.length,
      }),
    );
    if (report.status !== "passed") process.exitCode = 1;
  } catch {
    // Do not echo a config object, auth response, URL or Playwright call log.
    console.error(
      "Professional database browser smoke could not start; check required environment variables and browser availability.",
    );
    process.exitCode = 1;
  }
}
