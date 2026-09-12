import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const plugin=process.argv[2];
const {handleWorkagentCommand}=await import(pathToFileURL(resolve(plugin,'lib/engine/workagent-commands.js')));
const { createWorkagentHost } = await import(pathToFileURL(resolve(plugin, 'lib/engine/workagent-host.js')));
const key='weixin:dm:chat',id='discussion_fixture_001';
let saved={sessionId:'task-previous',lastInputAt:new Date().toISOString(),collaboration:{conversationId:id}};
let binding={key,sessionId:saved.sessionId,handle:{workagent:true,dispose:async()=>{}}};
const rows=[{id:'task-previous',title:'Previous task',workspaceName:'Project',updatedAt:new Date().toISOString()}];
let messages=Array.from({length:5},(_,i)=>({seq:i+1,kind:i%2?'assistant':'user',author_name:i%2?'Codex':'Human',body:`speech-${i+1}`}));
const controls=[],inputs=[],historyCalls=[];
const service={
 handles:()=>true,history:()=>rows,projects:()=>[{id:'default',name:'Default',cwd:'C:/fixture'}],
 configuration:()=>({provider:'workagent-codex'}),
 steer:async(...args)=>controls.push(['steer',...args]),cancel:async(...args)=>controls.push(['stop',...args]),
 open:async()=>{rows.push({id:'task-new',title:'New task'});return {sessionId:'task-new',workagent:true,dispose:async()=>{}}},
 collaboration:{
  access:async()=>({project:{name:'Shared'},conversation:{name:'Discussion'}}),
  history:async(conversation,limit,head,before)=>{historyCalls.push({conversation,limit,head,before});const latest=messages.at(-1)?.seq || 0;if(head!==latest||!before)before=latest+1;return {head:latest,messages:messages.filter(m=>m.seq<before).slice(-limit)}},
 },
};
const engine={ctx:{get:()=>service},resolveConfig:()=>({provider:'workagent-codex'}),store:{get:()=>saved,upsert:(_key,value)=>saved=value},router:{getOrCreate:async()=>binding,live:{set:(_key,value)=>binding=value}},questions:new Set(),broker:new Set(),inject:async(_channel,msg)=>inputs.push(msg)};
const replies=[],channel={id:'weixin',send:async(_chat,text)=>replies.push(text)};
const command=(text,userId='owner')=>handleWorkagentCommand(createWorkagentHost(engine),channel,{text,userId,chatId:'chat',kind:'dm'});
const first=await command('/历史');assert.match(first,/speech-4/);assert.match(first,/speech-5/);assert.match(first,/Agent · Codex/);assert.match(first,/成员 · Human/);
const second=await command('/历史');assert.match(second,/speech-2/);assert.match(second,/speech-3/);assert.doesNotMatch(second,/speech-4/);
assert.match(await command('/历史'),/speech-1/);assert.match(await command('/历史'),/没有更早/);assert.match(await command('/历史'),/没有更早/);
messages.push({seq:6,kind:'user',author_name:'Human',body:'new speech'});assert.match(await command('/历史 1'),/new speech/);assert.equal(historyCalls.at(-1).limit,1);
for(const text of ['/历史 0','/历史 -1','/历史 1.5','/历史 101','/历史 abc'])assert.match(await command(text),/用法/);
assert.match(await command('/补充 更详细'),/请去网页/);assert.match(await command('/停'),/请去网页/);assert.equal(controls.length,0);
const timestamp=saved.lastInputAt;
assert.match(await command('ordinary reply'),/不支持直接发消息/);assert.match(await command('1','outsider'),/发送待续接消息的用户/);assert.equal(inputs.length,0);assert.equal(saved.lastInputAt,timestamp);
await command('1');assert.equal(inputs[0].text,'ordinary reply');assert.equal(saved.collaboration,null);
assert.match(await command('/补充'),/用法/);assert.match(await command('/补 更详细'),/已补充/);assert.deepEqual(controls.at(-1),['steer',key,'task-previous','更详细']);
assert.match(await command('/停'),/已请求停止/);assert.deepEqual(controls.at(-1),['stop',key,'task-previous']);
saved={...saved,collaboration:{conversationId:id},lastInputAt:new Date(Date.now()-31*60000).toISOString()};rows[0].updatedAt=saved.lastInputAt;
assert.match(await command('new request'),/已超时/);assert.match(await command('1'),/已超时/);assert.equal(inputs.length,1);await command('2');assert.equal(inputs[1].text,'new request');assert.equal(binding.sessionId,'task-new');assert.equal(saved.collaboration,null);
saved={...saved,collaboration:{conversationId:id},lastInputAt:timestamp};
await command('do not lose');await command('3');assert.equal(saved.pendingInput,null);assert.equal(saved.lastInputAt,timestamp);assert.ok(saved.collaboration);
console.log(JSON.stringify({passed:true,checks:['AI and human history','backward pagination and exhaustion','new speech resets cursor','custom limit and validation','steer and stop','normal replies require explicit choice','pending message owner','notification leaves task timeout unchanged','expired reply creates new task','cancel preserves timeout']}));
