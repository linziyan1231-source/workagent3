import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
import {baseURL,login} from './smoke-dsh-helpers.mjs';
const out=resolve('.cache/group-agents/browser/production');await mkdir(out,{recursive:true});
const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}});
const report={checks:[],errors:[]};page.on('pageerror',e=>report.errors.push(e.message));
const inspect=project=>JSON.parse(execFileSync('ssh',['-o','BatchMode=yes','106.53.187.253','C:/WorkAgent3Test/tools/node-v24.20.0-win-x64/node.exe','C:/WorkAgent3Test/incoming/group-agents/inspect-sessions.cjs',project],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
async function api(path,method='GET',data){
 const response=await page.request.fetch(baseURL+'/api/portal/'+path,{method,headers:{Origin:baseURL},...(data?{data}:{})});
 const text=await response.text();assert(response.ok(),`${method} ${path}: ${response.status()} ${text.slice(0,200)}`);return text?JSON.parse(text):{};
}
try{
 await login(page);
 const deployed=await page.request.get(baseURL+'/plugins/@workagent/dsh-client/client.js');
 assert.equal(await deployed.text(),await readFile('.cache/group-agents/candidate/client.js','utf8'));
 report.checks.push('authenticated production DSH serves exact immutable candidate client');
 const {project,conversation}=await api('shared-projects','POST',{name:'多助手验收 '+new Date().toISOString().slice(0,16),operation_id:'group-agents-production-'+Date.now()});
 report.project=project.id;report.discussion=conversation.id;
 await writeFile(out+'/progress.json',JSON.stringify(report,null,2));
 const base=`shared-projects/${project.id}`;
 const {assistants:options}=await api(base+'/assistant-options');
 const agents=[options.find(a=>a.id==='builtin-codex'),options.find(a=>a.id==='builtin-kimi')];
 assert(agents.every(Boolean),'Both native assistants must be available');
 for(const agent of agents){const r=await api(base+'/assistant-invites','POST',{assistant_id:agent.id});assert.equal(r.invite.status,'accepted');}
 const link=`${baseURL}/?frontend=dsh&workagent=shared&project=${project.id}&discussion=${conversation.id}`;
 await page.goto(link);await page.getByLabel('共享消息',{exact:true}).waitFor();
 const before=await api(`shared-messages?conversation_id=${conversation.id}`);assert.equal(before.messages.length,0);
 report.checks.push('two actual assistants instantly joined without executing');
 const mentions=agents.map(a=>({kind:'assistant',id:a.id}));
 const sent=await api('shared-messages','POST',{conversation_id:conversation.id,client_message_id:'group-agents-first-'+Date.now(),mentions,body:'这是多助手会话连续性验收。请记住本群口令“青竹七号”。不要调用工具或创建文件，只回复：已记住青竹七号。'});
 assert.equal(sent.assistants.filter(a=>a.status==='started').length,2,JSON.stringify(sent.assistants));
 async function waitReplies(count){
  const deadline=Date.now()+240000;
  while(Date.now()<deadline){
   const state=await api(`shared-conversations?id=${conversation.id}`);
   const messages=(await api(`shared-messages?conversation_id=${conversation.id}`)).messages;
   if(state.conversation.state==='idle'){
    assert.equal(messages.filter(m=>m.kind==='assistant').length,count,JSON.stringify(messages.map(m=>({kind:m.kind,body:m.body}))));return messages;
   }
   await new Promise(r=>setTimeout(r,1500));
  }throw Error('Native assistant reply timed out');
 }
 await waitReplies(2);report.checks.push('Codex and Kimi executed independently from one message');
 report.firstSessions=inspect(project.id);
 const member=(await api(base+'/assistants')).assistants.find(a=>a.assistant_id===agents[0].id);
 const alternate=agents[0].models.find(m=>m.id!==member.model_id&&!m.id.endsWith('-native')&&(!member.model_id.endsWith('-native')||!m.isDefault));
 const updatedModel=alternate?.id||member.model_id;
 const capabilities=agents[0].models.find(m=>m.id===updatedModel);
 const updatedEffort=capabilities.reasoning.find(r=>r.id!==member.thinking_effort)?.id||capabilities.defaultReasoning;
 await api(base+'/assistants/'+agents[0].id,'PATCH',{model_id:updatedModel,thinking_effort:updatedEffort});
 const next=await api('shared-messages','POST',{conversation_id:conversation.id,client_message_id:'group-agents-next-'+Date.now(),mentions:[mentions[0]],body:'请只回复我们此前约定的本群口令，不要调用工具。'});
 assert.equal(next.assistants[0].status,'started');
 const messages=await waitReplies(3);
 assert(messages.filter(m=>m.kind==='assistant').at(-1).body.includes('青竹七号'),'assistant lost remembered group context');
 report.secondSessions=inspect(project.id);
 for(const before of report.firstSessions.sessions){
  const after=report.secondSessions.sessions.find(s=>s.assistantId===before.assistantId);
  assert.equal(after.key,before.key);assert.equal(after.nativeId,before.nativeId);
  if(before.assistantId===agents[1].id)assert.equal(after.cursor,before.cursor);
  else assert(after.cursor>before.cursor);
 }
 report.checks.push('real native IDs unchanged after settings update; unmentioned assistant cursor unchanged');
 report.checks.push('model and reasoning changes retained native conversational memory; second mention completed');
 await page.reload();await page.getByText('青竹七号',{exact:true}).first().waitFor().catch(()=>{});
 await page.screenshot({path:out+'/group-desktop.png'});
 await page.getByLabel('项目更多操作').click();await page.getByRole('button',{name:'助手设置',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'助手设置',exact:true});
 await dialog.getByLabel(`${agents[1].name} 模型`,{exact:true}).waitFor();
 assert.equal(await dialog.locator('select').count(),4);
 await page.screenshot({path:out+'/settings-desktop.png'});
 await dialog.getByLabel('关闭',{exact:true}).click();
 await page.getByLabel('共享消息',{exact:true}).fill('@');
 for(const a of agents)await page.getByRole('option',{name:new RegExp(a.name)}).waitFor();
 const candidateNames=await page.getByRole('listbox',{name:'提及对象'}).getByRole('option').allTextContents();report.mentionOptions=candidateNames;
 await page.getByLabel('共享消息',{exact:true}).fill('');
 report.checks.push('production settings and joined-only mention list rendered without errors');
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(e){report.status='failed';report.failure=e.stack;await page.screenshot({path:out+'/failure.png'});throw e;}
finally{await writeFile(out+'/report.json',JSON.stringify(report,null,2));await browser.close();}
