import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {login} from './smoke-dsh-helpers.mjs';
const engine=process.env.WORKAGENT_SMOKE_WEBKIT?'webkit':'chromium';
const out=process.env.WORKAGENT_SMOKE_EVIDENCE_DIR+'/'+engine;
await mkdir(out,{recursive:true});
const browser=await {chromium,webkit}[engine].launch();
const page=await browser.newPage();
await page.addInitScript(() => localStorage.setItem("workagent.files.open", "false"));
const report=[];
try {
 if(process.env.WORKAGENT_SMOKE_CSS) await page.route('**/plugins/@workagent/dsh-client/tokens.css*',async r=>r.fulfill({contentType:'text/css',body:await readFile(process.env.WORKAGENT_SMOKE_CSS,'utf8')}));
 await login(page);
 await page.locator(".workagent-agents button").first().waitFor();
 for(const [width,height] of [[390,844],[440,956],[320,568],[760,844],[1440,900]]) {
  await page.setViewportSize({width,height});
  await page.locator('.hHd-Xa_newSession').click();
  await page.waitForTimeout(450);
  const sidebar=page.locator('.hHd-Xa_root');
  if(width<=760 && !(await sidebar.getAttribute('class')).includes('hHd-Xa_collapsed')) await page.locator('.hHd-Xa_toggle').click();
  await page.locator('.hHd-Xa_newSession').hover();
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole('tooltip').filter({hasText:'New session'}).count(),0);
  const geometry=await page.locator('.wSkVaW_composerHero').evaluate(el=>({box:el.getBoundingClientRect().toJSON()}));
  if(width<=760) {
   const center=(geometry.box.y+geometry.box.height/2)/height;
   assert(center>0.38&&center<0.51,JSON.stringify({width,height,center,geometry}));
   assert(geometry.box.y>=64);
  }
  report.push({width,height,...geometry});
  await page.screenshot({path:`${out}/home-${width}.png`});
 }
 console.log(JSON.stringify(report));
} finally {
 await writeFile(out+'/report.json',JSON.stringify(report,null,2));
 await browser.close();
}
