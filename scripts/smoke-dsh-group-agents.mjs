import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {baseURL,login} from './smoke-dsh-helpers.mjs';
const fixturePath=resolve('.cache/group-agents/fixture.json');
const fixture=JSON.parse(await readFile(fixturePath,'utf8'));
assert.equal(new URL(fixture.url).hostname,'127.0.0.1');
const out=resolve('.cache/group-agents/candidate-browser');await mkdir(out,{recursive:true});
const report={checks:[],errors:[]};
const browser=await chromium.launch();
const api=async(actor,path,method='GET',data)=>{
 const r=await fetch(fixture.url+path,{method,headers:{Cookie:`workagent-session=${fixture[actor]}`,Origin:fixture.url,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
 return {status:r.status,body:await r.text(),headers:Object.fromEntries(r.headers)};
};
const setup=async(actor)=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/plugins/@workagent/dsh-client/client.js*',route=>route.fulfill({path:resolve('.cache/group-agents/candidate/client.js'),contentType:'text/javascript'}));
 await page.route(/\/api\/portal\/(shared-|me\/notifications)/,async route=>{
  const r=route.request(),u=new URL(r.url());
  if(u.pathname.endsWith('shared-events')||u.pathname.endsWith('/stream'))return route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'});
  await route.fulfill(await api(actor,u.pathname+u.search,r.method(),r.postData()?r.postDataJSON():undefined));
 });
 await login(page);return page;
};
let owner,member;
try{
 owner=await setup('owner');member=await setup('member');
 const created=await api('owner','/api/portal/shared-projects','POST',{name:'多助手群聊验收'});assert.equal(created.status,201,created.body);
 const {project,conversation}=JSON.parse(created.body),base=`/api/portal/shared-projects/${project.id}`;
 const invited=JSON.parse((await api('owner',base+'/invites','POST',{targetUsername:'bob'})).body);
 assert.equal((await api('member',`/api/portal/shared-invites/${invited.invite.id}/accept`,'POST',{})).status,200);
 const link=`${baseURL}/?frontend=dsh&workagent=shared&project=${project.id}&discussion=${conversation.id}`;
 await owner.goto(link);
 const input=owner.getByLabel('共享消息',{exact:true});await input.fill('@');
 await owner.getByRole('option',{name:/bob/}).waitFor();
 assert.equal(await owner.getByRole('option',{name:/Codex|Kimi|未加入助手/}).count(),0);
 await input.fill('');
 await owner.getByLabel('查看项目成员',{exact:true}).click();
 const dialog=owner.getByRole('dialog',{name:'项目成员',exact:true});
 for(const id of ['builtin-codex','builtin-kimi']){
  await dialog.getByLabel('邀请助手',{exact:true}).selectOption(id);
  await dialog.getByRole('button',{name:'发送助手邀请',exact:true}).click();
  await dialog.getByLabel(`移除助手 ${id==='builtin-codex'?'Codex':'Kimi'}`,{exact:true}).waitFor();
 }
 await owner.screenshot({path:out+'/members-desktop.png'});
 await dialog.getByLabel('关闭',{exact:true}).click();
 report.checks.push('only joined members offered; two assistants instantly accept invitations');
 await owner.getByLabel('项目更多操作').click();
 await owner.getByRole('button',{name:'助手设置',exact:true}).click();
 const settings=owner.getByRole('dialog',{name:'助手设置',exact:true});
 await settings.getByLabel('Kimi 思考强度',{exact:true}).selectOption('high');
 await settings.getByRole('form',{name:'Kimi 的设置',exact:true}).getByRole('button',{name:'保存',exact:true}).click();
 await settings.getByText('已保存，下次 @ 时生效。',{exact:true}).waitFor();
 assert.equal(await settings.locator('select').count(),4);
 assert.deepEqual(await settings.getByLabel('Kimi 模型',{exact:true}).locator('option').evaluateAll(rows=>rows.map(r=>r.value)),['kimi-2']);
 await owner.screenshot({path:out+'/settings-desktop.png'});
 await settings.getByLabel('关闭',{exact:true}).click();
 report.checks.push('settings contain only per-assistant model and reasoning; engine immutable');
 await input.fill('@');await owner.getByRole('option',{name:/Codex/}).click();
 await input.press('End');await input.pressSequentially('@');await owner.getByRole('option',{name:/Kimi/}).click();
 await input.press('End');await input.pressSequentially('@');await owner.getByRole('option',{name:/bob/}).click();
 await input.press('End');await input.pressSequentially(' 请一起讨论这个方案。');
 await owner.locator('.workagent-collab-chat').getByRole('button',{name:'发送消息',exact:true}).click();
 await owner.getByText('builtin-codex group reply',{exact:true}).waitFor();
 await owner.getByText('builtin-kimi group reply',{exact:true}).waitFor();
 const messages=JSON.parse((await api('owner',`/api/portal/shared-messages?conversation_id=${conversation.id}`)).body).messages;
 assert.equal(messages.filter(m=>m.kind==='assistant').length,2);
 const original=messages.find(m=>m.kind==='user');assert.equal(original.mentions.length,3);
 const notification=JSON.parse((await api('member','/api/portal/me/notifications')).body);
 const encoded=JSON.stringify(notification);assert(encoded.includes('message='+original.id));
 await member.goto(`${baseURL}/?frontend=dsh&workagent=notifications`);
 const notice=member.locator('.workagent-card').filter({hasText:'alice 在讨论中提到了你'});
 await notice.getByRole('button',{name:'打开并标记已读',exact:true}).click();
 await member.waitForFunction(id=>new URLSearchParams(location.search).get('message')===id,original.id);
 const target=member.locator(`[data-shared-message-id="${original.id}"]`);
 await target.waitFor();await member.waitForFunction(id=>document.querySelector(`[data-shared-message-id="${id}"]`)?.classList.contains('workagent-message-highlight'),original.id);
 await member.screenshot({path:out+'/mention-jump.png'});
 report.checks.push('single message mentions two assistants and a person; both replies attributed; notification opens highlighted original message');
 await owner.setViewportSize({width:390,height:844});await owner.waitForTimeout(400);
 const sidebar=owner.locator('.hHd-Xa_sidebar');
 if(await sidebar.count()&&!(await sidebar.getAttribute('class')).includes('hHd-Xa_collapsed')){await owner.locator('.hHd-Xa_toggle').click();await owner.waitForTimeout(400);}
 await owner.getByLabel('项目更多操作').click();await owner.getByRole('button',{name:'助手设置',exact:true}).click();
 await owner.screenshot({path:out+'/settings-mobile.png'});
 assert(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 report.checks.push('mobile settings fit viewport');
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(e){report.status='failed';report.failure=e.stack;await owner?.screenshot({path:out+'/failure.png'});throw e;}
finally{await writeFile(out+'/report.json',JSON.stringify(report,null,2));await browser.close();await writeFile(fixturePath+'.stop','done');}
