import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const plugin = process.argv[2];
if (!plugin) throw new Error('Pass the installed dsh-im-connect plugin directory');
const { handleWorkagentCommand, checkWorkagentIdle } = await import(pathToFileURL(resolve(plugin, 'lib/engine/workagent-commands.js')));
const key = 'weixin:dm:chat';
const records = new Map([[key, { sessionId:'session-channel-one', lastInputAt:new Date(Date.now()-3600000).toISOString() }]]);
let current = { key, sessionId:'session-channel-one', handle:{workagent:true,dispose:async()=>{}} };
const sessions = [{id:current.sessionId,title:'Original',updatedAt:new Date(Date.now()-3600000).toISOString(),active:false},{id:'session-channel-two',title:'History',active:false}];
const inputs=[], replies=[];
const service = {
 handles:()=>true,
 history:(scope)=>{assert.equal(scope,key);return sessions;},
 projects:()=>[{id:'project',name:'Project',cwd:'C:/fixture'}],
 configuration:()=>({provider:'workagent-codex',model:'fixture'}),
 resume:async(scope,id)=>{assert.equal(scope,key);return {sessionId:id,workagent:true,dispose:async()=>{}};},
 open:async(config,_id,_title,scope)=>{assert.equal(scope,key);assert.equal(config.cwd,'C:/fixture');sessions.push({id:'session-channel-new',title:'New'});return {sessionId:'session-channel-new',workagent:true,dispose:async()=>{}};},
 rename:async()=>{throw new Error('rename rejected');},
};
const engine={ctx:{get:()=>service},resolveConfig:()=>({provider:'workagent-codex',model:'fixture'}),store:{get:(k)=>records.get(k),upsert:(k,v)=>records.set(k,v)},questions:new Set(),broker:new Set(),router:{getOrCreate:async()=>current,live:{set:(_k,v)=>{current=v;}},rename:()=>{throw new Error('must not rename after rejection');}},inject:async(_channel,msg)=>inputs.push(msg)};
const channel={id:'weixin',send:async(_id,text)=>replies.push(text)};
const msg={chatId:'chat',userId:'owner',text:'continue my task',kind:'dm'};
const command=(text,userId='owner')=>handleWorkagentCommand(engine,channel,{...msg,text,userId});
assert.match(await command('/历史'),/Original/);
assert.match(await command('/切换 session-channel-other-chat'),/没有找到/);
assert.equal(await checkWorkagentIdle(engine,channel,msg,current),false);
assert.equal(records.get(key).pendingInput.text,msg.text);
assert.match(await command('/继续','different-person'),/发送待续接消息的用户/);
assert.equal(inputs.length,0);
engine.inject=async()=>{throw new Error('temporary failure');};
await assert.rejects(command('/继续'),/temporary failure/);
assert.equal(records.get(key).pendingInput.text,msg.text);
engine.inject=async(_channel,value)=>inputs.push(value);
await command('/继续');
assert.equal(inputs[0].text,msg.text);
assert.equal(records.get(key).pendingInput,null);
await assert.rejects(command('/重命名 New'),/rename rejected/);
assert.match(await command('/切换 2'),/已切换/);
assert.equal(current.sessionId,'session-channel-two');
assert.match(await command('/新对话 1'),/已新建/);
assert.equal(current.sessionId,'session-channel-new');
await command('/空闲 0');
assert.equal(await checkWorkagentIdle(engine,channel,msg,current),true);
console.log(JSON.stringify({passed:true,checks:['chat-scoped history','cross-chat switch rejected','idle pending message','pending owner','retry preserves input','native rename failure','resume/new project','idle disabled']}));
