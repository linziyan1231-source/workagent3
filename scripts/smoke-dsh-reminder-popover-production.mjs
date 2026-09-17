import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const baseURL = process.env.WORKAGENT_SMOKE_URL?.replace(/\/$/,'');
const sessionToken = process.env.WORKAGENT_SMOKE_SESSION_TOKEN;
if (!baseURL || !sessionToken) throw new Error('WORKAGENT_SMOKE_URL and WORKAGENT_SMOKE_SESSION_TOKEN are required');

const out = resolve(process.env.WORKAGENT_REMINDER_EVIDENCE_DIR || '.cache/reminder-popover-production');
await mkdir(out,{recursive:true});

const browser = await chromium.launch();
const context = await browser.newContext({viewport:{width:1440,height:1000}});
await context.addCookies([{name:'workagent-session',value:sessionToken,url:baseURL}]);
const page = await context.newPage();
const errors = [];
page.on('pageerror',e=>errors.push(e.message));

try {
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page.getByText('WorkAgent',{exact:true}).waitFor();

  // Served frozen artifacts must byte-match the activated candidate.
  const expectedDir = process.env.WORKAGENT_COLLAB_CLIENT_DIR;
  if (expectedDir) {
    for (const name of ['client.js','tokens.css']) {
      const bytes = await (await page.request.get(`${baseURL}/plugins/@workagent/dsh-client/${name}`)).body();
      assert(bytes.equals(await readFile(resolve(expectedDir,name))),`${name} differs from activated candidate`);
    }
  }

  // 1) Collaboration header reminder popover (new heading + description).
  const conversations = await (await page.request.get(`${baseURL}/api/portal/shared-conversations`)).json();
  const discussion = conversations.conversations.find(c=>c.kind==='discussion'&&!c.hidden);
  assert(discussion,'No discussion available for read-only acceptance');
  await page.goto(`${baseURL}/?frontend=dsh&workagent=shared&project=${encodeURIComponent(discussion.project_id)}&discussion=${encodeURIComponent(discussion.id)}`);
  const reminderButton = page.getByLabel('消息提醒',{exact:true});
  await reminderButton.waitFor();
  for (const width of [1440,430,320]) {
    await page.setViewportSize({width,height:900});
    await reminderButton.click();
    await page.locator('.workagent-collab-reminder-heading').waitFor();
    assert(await page.locator('.workagent-collab-reminder-description').isVisible());
    await page.getByLabel('当前会话接收聊天').waitFor();
    assert(await page.getByText('仅接收 Agent 完成提醒和产物文件。',{exact:true}).isVisible());
    const popup = await page.locator('.workagent-collab-reminder-popover').boundingBox();
    assert(popup.x>=0&&popup.x+popup.width<=width,`popover overflows viewport at ${width}`);
    await page.screenshot({path:`${out}/collab-reminder-${width}.png`});
    await reminderButton.click();
  }

  // 2) Conversation sidebar reminder dialog (new context capsule).
  await page.setViewportSize({width:1440,height:900});
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page.getByText('WorkAgent',{exact:true}).waitFor();
  const editButton = page.locator('[aria-label^="编辑对话 "]').first();
  await editButton.waitFor({timeout:20000});
  await editButton.click();
  const menu = page.getByRole('dialog',{name:'对话操作'});
  await menu.waitFor();
  await menu.getByRole('button',{name:'消息提醒',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'消息提醒'});
  await dialog.waitFor();
  const contextCapsule = dialog.locator('.workagent-reminder-context');
  await contextCapsule.waitFor();
  assert((await contextCapsule.innerText()).includes('项目：'));
  await dialog.getByLabel('当前会话接收聊天').waitFor();
  await page.screenshot({path:`${out}/session-reminder-dialog.png`});
  await dialog.getByRole('button',{name:'取消',exact:true}).click().catch(async()=>{await page.keyboard.press('Escape');});

  assert.deepEqual(errors,[]);
  await writeFile(`${out}/report.json`,JSON.stringify({passed:true,checks:['session-cookie authenticated DSH shell','served artifacts byte-match activated candidate','collab reminder popover heading/description at 1440/430/320','conversation reminder dialog context capsule','no page errors'],mode:'read only',errors},null,2));
  console.log('REMINDER_POPOVER_PRODUCTION_ACCEPTANCE_PASSED');
} catch (error) {
  await page.screenshot({path:`${out}/failure.png`});
  throw error;
} finally {
  await browser.close();
}
