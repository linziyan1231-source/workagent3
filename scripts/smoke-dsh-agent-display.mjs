import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {baseURL,login} from './smoke-dsh-helpers.mjs';
const out=resolve(process.env.WORKAGENT_AGENT_EVIDENCE_DIR||'.cache/agent-display/candidate-browser');
const candidate=resolve(process.env.WORKAGENT_AGENT_CLIENT_DIR||'.cache/agent-display/client');
await mkdir(out,{recursive:true});
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const report={checks:[],errors:[]};
page.on('pageerror',error=>report.errors.push(error.message));
const names=['Codex','Kimi','写作助手','市场研究助手','财务分析助手','设计评审助手','资料整理助手','项目协作助手','这是一个特别长的助手名称用于手机布局验证'];
const presets=names.map((name,index)=>({id:'agent-fixture-'+index,name,engine:'codex',enabled:true,source:'builtin',description:'',avatar:null,modelId:null,systemPrompt:'',workspacePolicy:'optional',skillIds:[],mcpServerIds:[],toolAllowlist:[],approvalPolicy:'on_risk'}));
if(!process.env.WORKAGENT_AGENT_PUBLISHED) for(const name of ['client.js','tokens.css']) await page.route(`**/plugins/@workagent/dsh-client/${name}*`,route=>route.fulfill({path:resolve(candidate,name),contentType:name.endsWith('css')?'text/css':'text/javascript'}));
await page.route('**/api/runtime/v1/presets',route=>{
  assert.equal(route.request().method(),'GET','fixture must never mutate production presets');
  return route.fulfill({contentType:'application/json',body:JSON.stringify(presets)});
});
try {
  await login(page);
  const picker=page.getByRole('radiogroup',{name:'选择 Agent',exact:true});
  await picker.getByRole('radio',{name:'Codex',exact:true}).waitFor();
  assert.equal(await picker.getByRole('radio').count(),3);
  await picker.getByRole('button',{name:'更多 Agent，6 个'}).click();
  const menu=picker.getByRole('group',{name:'更多 Agent',exact:true});
  assert.equal(await menu.getByRole('radio').count(),6);
  await page.screenshot({path:resolve(out,'desktop-more.png')});
  await menu.getByRole('radio',{name:'资料整理助手',exact:true}).click();
  assert.equal(await picker.getByRole('radio').count(),3);
  assert.equal(await picker.getByRole('radio',{name:'资料整理助手',exact:true}).getAttribute('aria-checked'),'true');
  await picker.getByRole('button',{name:'更多 Agent，6 个'}).click();
  await page.keyboard.press('Escape');
  assert.equal(await picker.getByRole('button',{name:'更多 Agent，6 个'}).getAttribute('aria-expanded'),'false');
  report.checks.push('three visible agents; remaining agents collapse; chosen extra stays visible; Escape closes');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'设置',exact:true});
  await settings.getByRole('button',{name:'助手',exact:true}).click();
  const order=settings.getByRole('region',{name:'Agent 显示顺序',exact:true});
  await order.getByRole('button',{name:'上移 Kimi',exact:true}).click();
  assert.equal(await order.locator('li').first().locator('.workagent-agent-order-name').textContent(),'Kimi');
  await page.screenshot({path:resolve(out,'settings-order.png')});
  await page.keyboard.press('Escape');
  await page.reload();
  await picker.getByRole('radio',{name:'Kimi',exact:true}).waitFor();
  assert.equal(await picker.getByRole('radio').first().getAttribute('data-agent-id'),'agent-fixture-1');
  report.checks.push('settings move updates the homepage immediately and survives reload');
  const closeFiles=page.getByRole('button',{name:'收起文件侧栏',exact:true});
  if(await closeFiles.count()) await closeFiles.click();
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    await page.waitForTimeout(350);
    const strip=await picker.locator('.workagent-agent-strip').boundingBox();
    assert(strip.x>=0&&strip.x+strip.width<=width+1,'agent strip fits mobile');
    await picker.getByRole('button',{name:'更多 Agent，6 个'}).click();
    const box=await menu.boundingBox();assert(box.x>=0&&box.x+box.width<=width+1,'more menu fits mobile');
    await page.screenshot({path:resolve(out,`mobile-${width}.png`)});
    await menu.getByRole('radio',{name:names[8],exact:true}).click();
    const selected=picker.getByRole('radio',{name:names[8],exact:true});await selected.waitFor();
    const activeBox=await selected.boundingBox();assert(activeBox.x>=0&&activeBox.x+activeBox.width<=width+1,'long selected label fits');
    await picker.getByRole('radio',{name:'Kimi',exact:true}).click();
  }
  report.checks.push('390px/320px strip, menu and long names fit');
  if(process.env.WORKAGENT_AGENT_PUBLISHED) {
    for(const name of ['client.js','tokens.css']) {
      const url=await page.evaluate(name=>performance.getEntriesByType('resource').map(row=>row.name).find(url=>url.includes(`/plugins/@workagent/dsh-client/${name}`)),name);
      assert.equal(await (await page.request.get(url)).text(),await readFile(resolve(candidate,name),'utf8'));
    }
    report.checks.push('published assets equal immutable candidate');
  }
  assert.deepEqual(report.errors,[]);report.status='passed';
} catch(error) {report.status='failed';report.failure=error.stack;await page.screenshot({path:resolve(out,'failure.png')});process.exitCode=1;}
finally {await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));await browser.close();}
