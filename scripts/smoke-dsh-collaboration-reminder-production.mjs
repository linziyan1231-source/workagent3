import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {login,baseURL} from './smoke-dsh-helpers.mjs';
const out=resolve(process.env.WORKAGENT_COLLAB_EVIDENCE_DIR||'.cache/collab-im/production');await mkdir(out,{recursive:true});
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
 await login(page);
 const conversations=await (await page.request.get(`${baseURL}/api/portal/shared-conversations`)).json();
 const discussion=conversations.conversations.find(c=>c.kind==='discussion'&&!c.hidden);
 assert(discussion,'No existing discussion available for read-only smoke');
 const expected=process.env.WORKAGENT_COLLAB_CLIENT_DIR;
 for(const name of ['client.js','tokens.css']) {
  const bytes=await (await page.request.get(`${baseURL}/plugins/@workagent/dsh-client/${name}`)).body();
  if(expected)assert(bytes.equals(await readFile(resolve(expected,name))),`${name} differs from frozen candidate`);
 }
 await page.goto(`${baseURL}/?frontend=dsh&workagent=shared&project=${encodeURIComponent(discussion.project_id)}&discussion=${encodeURIComponent(discussion.id)}`);
 await page.getByLabel('消息提醒',{exact:true}).waitFor();
 for(const width of [1440,430,320]) {
  await page.setViewportSize({width,height:900});
  await page.getByLabel('消息提醒',{exact:true}).click();
  await page.getByLabel('当前会话接收聊天').waitFor();
  assert(await page.getByText('仅接收 Agent 完成提醒和产物文件。',{exact:true}).isVisible());
  const popup=await page.locator('.workagent-collab-reminder-popover').boundingBox();
  assert(popup.x>=0&&popup.x+popup.width<=width);
  await page.screenshot({path:`${out}/reminder-${width}.png`});
  await page.getByLabel('消息提醒',{exact:true}).click();
  await page.getByRole('button',{name:'文件',exact:true}).click();
  const files=await page.getByLabel('项目文件侧栏',{exact:true}).boundingBox();
  assert(files.x>=0&&Math.abs(files.x+files.width-width)<2);
  await page.screenshot({path:`${out}/files-${width}.png`});
  await page.getByRole('button',{name:'关闭文件侧栏',exact:true}).click();
 }
 assert.deepEqual(errors,[]);
 await writeFile(`${out}/report.json`,JSON.stringify({passed:true,checks:['authenticated DSH shell','frozen artifact byte equality','real collaboration reminder form','right-aligned mobile files','no page errors'],mode:'read only',errors},null,2));
}catch(error){await page.screenshot({path:`${out}/failure.png`});throw error;}finally{await browser.close();}
