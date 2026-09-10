import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { login } from './smoke-dsh-helpers.mjs';
const out = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
await mkdir(out, {recursive:true});
const browser = await chromium.launch();
try {
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  if (process.env.WORKAGENT_PREVIEW) {
    for (const [name,type] of [['client.js','text/javascript'],['tokens.css','text/css']]) {
      const body = await readFile(`packages/dsh-client-workagent/${name}`,'utf8');
      await page.route(`**/plugins/@workagent/dsh-client/${name}*`,r=>r.fulfill({body,contentType:type}));
    }
  }
  await login(page);
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const panel = page.locator('.workagent-quota-panel');
  await panel.getByText(/每日剩余/).first().waitFor();
  const text = await panel.innerText();
  assert.match(text,/每日剩余\s*\d+%/);
  assert.match(text,/每周剩余\s*\d+%/);
  assert.doesNotMatch(text,/\$|美元/);
  assert.match(text,/DSH 与 Codex/);
  assert.equal(await panel.getByRole('progressbar').count(),4);
  for (const bar of await panel.getByRole('progressbar').all()) {
    assert.equal(await bar.locator('span').evaluate(el=>el.style.width),`${await bar.getAttribute('aria-valuenow')}%`);
  }
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(300);
  assert(await panel.evaluate(el=>el.scrollWidth <= el.clientWidth + 1));
  for (const bar of await panel.getByRole('progressbar').all()) {
    const box = await bar.boundingBox();
    assert(box.width > 100 && box.height >= 4);
  }
  await page.screenshot({path:`${out}/quota-percent.png`,fullPage:true});
  await writeFile(`${out}/layout.json`,JSON.stringify({passed:true,text},null,2));
  console.log('User quota percentages verified');
} finally { await browser.close(); }
