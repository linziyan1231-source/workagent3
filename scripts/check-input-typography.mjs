import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { bundleStyles } from "../packages/dsh-client-workagent/build.mjs";

// CSS regression checks only: desktop browser engines cannot reproduce UIKit's
// keyboard focus zoom. Release acceptance also requires the real iPhone checks.
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [{ code: employeeCSS }, appearanceCSS, webCSS] = await Promise.all([
  bundleStyles(),
  read("packages/dsh-client-appearance/tokens.css"),
  Promise.all(
    [
      "apps/web/src/styles.css",
      "apps/web/src/features/auth/LoginPage.css",
      "apps/web/src/features/admin/AdminPortal.css",
      "apps/web/src/shared/ui/typography.css",
    ].map(read),
  ).then((styles) => styles.join("\n")),
]);

const employeeMarkup = `
  <form class="workagent-form">
    <label class="workagent-field">Project<input id="metric-project" class="workagent-control"></label>
    <label>Detail<textarea id="metric-detail" class="workagent-control"></textarea></label>
    <select id="metric-form-select" class="workagent-control"><option>Option</option></select>
    <button id="primary-form" type="submit" class="workagent-button is-primary">Save</button>
  </form>
  <div class="workagent-collab-project-title"><select id="metric-discussion"><option>Discussion</option></select></div>
  <div class="workagent-dialog-surface"><input id="metric-collab" class="workagent-control"><button id="primary-collab" class="workagent-button is-primary">Create</button></div>
  <div class="workagent-message-editor"><textarea id="metric-edit"></textarea></div>
  <form class="workagent-conversation-composer workagent-compact-composer"><div id="metric-composer" class="workagent-composer-input" contenteditable="true">Message</div></form>
  <div class="VOzbGW_options"><input id="metric-plugin" class="At1oFq_input"></div>
  <div class="ima-modal"><label class="ima-field"><input id="metric-im"></label></div>
  <div class="ima-chip-dialog"><input id="metric-im-portal"></div>
  <div><input id="metric-unscoped" style="font: 12px sans-serif"></div>
  <div id="metric-editor-portal" contenteditable="plaintext-only" style="font: 12px sans-serif">Text</div>
  <div class="workagent-agents"><button class="workagent-agent">Agent</button><button class="workagent-agent-more">More</button></div>
  <button class="workagent-switch" role="switch" aria-checked="true" aria-label="Enabled"></button>
`;
const webMarkup = `
  <div class="login-page"><input id="metric-login" class="login-page__input"><input id="metric-password" class="login-page__input" type="password"></div>
  <main class="admin-app">
    <div class="admin-table-toolbar"><input id="metric-search"></div>
    <form class="admin-form"><label>Name<input id="metric-admin-name"></label><select id="metric-admin-select"><option>Version</option></select></form>
    <section class="admin-market-confirm"><label>Reason<textarea id="metric-reason"></textarea></label></section>
  </main>
  <dialog open class="admin-dialog"><form class="admin-form"><label>Password<input id="metric-admin-dialog" type="password"></label></form></dialog>
`;
const phoneSizes = new Map([
  ["13", 16],
  ["14", 16],
  ["16", 18],
  ["18", 20],
]);
const viewports = [
  { name: "phone-portrait", width: 440, height: 956, touch: true },
  { name: "phone-landscape", width: 956, height: 440, touch: true },
  { name: "small-phone-landscape", width: 874, height: 402, touch: true },
  { name: "desktop", width: 1440, height: 1000, touch: false },
];
const checks = [];

for (const [engineName, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await engine.launch({ headless: true });
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.touch,
        isMobile: viewport.touch,
        colorScheme: "dark",
      });
      try {
        for (const [size, expected] of phoneSizes) {
          for (const [surface, css, markup] of [
            ["employee", employeeCSS + appearanceCSS, employeeMarkup],
            ["portal", webCSS, webMarkup],
          ]) {
            const page = await context.newPage();
            await page.setContent(
              `<!doctype html><html data-workagent-font-size="${size}" data-workagent-theme="graphite" style="--workagent-font-scale:${Number(size) / 14}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body data-workagent-theme="graphite">${markup}</body></html>`,
            );
            const metrics = await page
              .locator('[id^="metric-"]')
              .evaluateAll((fields) =>
                fields.map((field) => {
                  const before = Number.parseFloat(
                    getComputedStyle(field).fontSize,
                  );
                  field.focus();
                  const after = Number.parseFloat(
                    getComputedStyle(field).fontSize,
                  );
                  return { id: field.id, before, after };
                }),
              );
            for (const field of metrics) {
              assert.equal(
                field.after,
                field.before,
                `${engineName}/${viewport.name}/${size}/${field.id}: focus changed the font`,
              );
              if (viewport.touch)
                assert.equal(
                  field.before,
                  expected,
                  `${engineName}/${viewport.name}/${size}/${field.id}: wrong phone input size`,
                );
            }
            if (surface === "employee") {
              const theme = await page
                .locator('[id^="primary-"]')
                .evaluateAll((buttons) =>
                  buttons.map((button) => {
                    const style = getComputedStyle(button);
                    return {
                      color: style.color,
                      background: style.backgroundColor,
                    };
                  }),
                );
              for (const button of theme) {
                assert.equal(button.color, "rgb(27, 34, 64)");
                assert.equal(button.background, "rgb(197, 207, 250)");
              }
              const agents = await page
                .locator(".workagent-agent, .workagent-agent-more")
                .evaluateAll((buttons) =>
                  buttons.map((button) => getComputedStyle(button).fontSize),
                );
              assert.equal(
                agents[0],
                agents[1],
                "Agent and More must share their type role",
              );
            } else {
              const formStyles = await page
                .locator("#metric-admin-select, #metric-reason")
                .evaluateAll((fields) =>
                  fields.map((field) => {
                    const style = getComputedStyle(field);
                    return {
                      background: style.backgroundColor,
                      color: style.color,
                      family: style.fontFamily,
                      radius: style.borderRadius,
                    };
                  }),
                );
              assert.deepEqual(
                formStyles[0],
                formStyles[1],
                "Admin textarea must share select theme and type family",
              );
            }
            checks.push({
              engine: engineName,
              viewport: viewport.name,
              size,
              surface,
              controls: metrics.length,
            });
            await page.close();
          }
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
console.log(
  JSON.stringify(
    {
      passed: checks.length,
      controls: checks.reduce((count, check) => count + check.controls, 0),
      engines: ["chromium", "webkit"],
      viewports: viewports.map((viewport) => viewport.name),
      phoneMinimums: Object.fromEntries(phoneSizes),
    },
    null,
    2,
  ),
);
