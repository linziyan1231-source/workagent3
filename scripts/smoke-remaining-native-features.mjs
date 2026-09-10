import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {baseURL,json,withPage} from './smoke-dsh-helpers.mjs';
const evidence=process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;await mkdir(evidence,{recursive:true});
const report={checks:[],sessions:[]};
const body=(value,method='POST')=>({method,body:JSON.stringify(value)});
await withPage(async page=>{
 const rpc=async(method,payload)=>{const r=await json(page,`/api/${method}`,body({type:'client-request',rpcId:crypto.randomUUID(),method,payload}));assert.equal(r.result?.ok,true,JSON.stringify(r));return r.result.value;};
 const wait=async(read,done,timeout=180000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(done(value))return value;await page.waitForTimeout(1000);}throw new Error('Native feature acceptance timed out');};
 try{
 const workspace=await json(page,'/api/runtime/v1/workspaces',body({name:`原生能力验收-${Date.now()}`}));report.workspace=workspace.id;
 const number=String(Math.floor(1000+Math.random()*9000));
 await page.evaluate(async({number,id})=>{const canvas=document.createElement('canvas');canvas.width=480;canvas.height=180;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,480,180);ctx.fillStyle='black';ctx.font='bold 100px Arial';ctx.fillText(number,80,125);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const r=await fetch(`/api/runtime/v1/workspaces/${id}/content?path=vision.png`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:blob});if(!r.ok)throw new Error('image upload failed');},{number,id:workspace.id});
 for(const engine of ['codex','kimi']){
  const session=await json(page,'/api/runtime/v1/sessions',body({engine,title:`原生图片-${engine}`,workspace:workspace.id,presetId:`builtin-${engine}`,modelId:engine==='codex'?'gpt-6-astra':'kimi-code/kimi-k3',thinkingEffort:'low',permissionMode:'workspace_write'}));report.sessions.push(session.id);
  await rpc('session.prompt',{sessionId:session.id,mode:'queue',content:[{type:'text',text:'项目文件："vision.png"\n直接识别随消息提供的图片，只回复图中的四位数字。不要使用文件或 shell 工具。'}]});
  const finished=await wait(()=>json(page,`/api/runtime/v1/sessions/${session.id}`),row=>row.lastTurn&&row.activity?.state==='idle');assert.equal(finished.lastTurn.status,'completed');
  const messages=await json(page,`/api/runtime/v1/sessions/${session.id}/messages`);assert.ok(messages.some(row=>row.role==='assistant'&&row.text.includes(number)),JSON.stringify(messages));
  report.checks.push(`${engine} 原生图片识别`);
  await json(page,`/api/runtime/v1/sessions/${session.id}/configuration`,body({permissionMode:'read_only'},'PATCH'));
  await json(page,`/api/runtime/v1/sessions/${session.id}/configuration`,body({permissionMode:'workspace_write'},'PATCH'));report.checks.push(`${engine} 当前权限更新`);
 }
 const prior=JSON.parse(await readFile(join(evidence,'remaining-capabilities.json'),'utf8'));
 const automation=await json(page,'/api/runtime/v1/automations',body({name:'技能执行验收',enabled:false,schedule:{kind:'interval',everyMinutes:60},presetId:'builtin-codex',engine:'codex',workspaceId:workspace.id,input:'执行绑定技能中的回复要求，只输出口令，不使用工具。',notificationPolicy:'none',executionMode:'existing',conversationId:report.sessions[0],skillId:prior.skill}));
 report.automation=automation.id;
 const run=await json(page,`/api/runtime/v1/automations/${automation.id}/run`,body({}));
 const completed=await wait(()=>json(page,`/api/runtime/v1/automations/${automation.id}/runs`),rows=>rows.some(row=>row.id===run.id&&!['pending','running'].includes(row.status)));
 const outcome=completed.find(row=>row.id===run.id);assert.equal(outcome.status,'succeeded',JSON.stringify(outcome));assert.match(outcome.result,/REMAINING_SKILL_BOUND/);report.checks.push('定时任务实际执行绑定技能');
 await json(page,`/api/runtime/v1/automations/${automation.id}`,{method:'DELETE'});
 let team=await json(page,'/api/runtime/v1/teams',body({name:`团队工作台-${Date.now()}`,workspaceId:workspace.id,lead:{name:'负责人',engine:'codex',presetId:'builtin-codex',modelId:'gpt-6-astra',thinkingEffort:'low',permissionMode:'workspace_write'}}));report.team=team.id;
 team=await json(page,`/api/runtime/v1/teams/${team.id}/members`,body({name:'执行成员',engine:'kimi',presetId:'builtin-kimi'}));
 const member=team.members.find(row=>row.role==='member');
 await json(page,`/api/runtime/v1/teams/${team.id}/members/${member.id}`,body({name:'验收成员'},'PATCH'));
 const task=await json(page,`/api/runtime/v1/teams/${team.id}/tasks`,body({memberId:member.id,title:'独立成员任务',input:'只回复 TEAM_TASK_ACCEPTED，不使用工具。'}));
 const tasks=await wait(()=>json(page,`/api/runtime/v1/teams/${team.id}/tasks`),rows=>rows.some(row=>row.id===task.id&&!['queued','running'].includes(row.status)));
 const outcomeTask=tasks.find(row=>row.id===task.id);assert.equal(outcomeTask.status,'succeeded',JSON.stringify(outcomeTask));assert.match(outcomeTask.result,/TEAM_TASK_ACCEPTED/);
 await page.goto(`${baseURL}/?frontend=dsh&workagent=teams`);await page.getByText(team.name,{exact:true}).first().waitFor();await page.screenshot({path:join(evidence,'remaining-teams.png'),animations:'disabled'});report.checks.push('团队成员独立执行及任务结果');
 report.complete=true;
 }finally{await writeFile(join(evidence,'remaining-native-features.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
});
