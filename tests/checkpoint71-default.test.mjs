import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {execFile} from 'node:child_process';
import {promisify,stripVTControlCharacters} from 'node:util';
import {fileURLToPath} from 'node:url';
import {renderToString} from 'ink';
import {createTuiModel} from '../src/tui-model.mjs';
import {TuiView} from '../src/tui.mjs';
import {createFakeRegistry} from './helpers/dispatch-fakes.mjs';

async function journey({columns,rows,color}) {
 const monitor={getSnapshot:()=>({mode:'live',updatedAt:new Date().toISOString(),source:{state:'connected'},agents:[]}),subscribe:()=>()=>{}};
 const calls=[];
 const controller={getProfiles:async()=>({providers:[{id:'codex',name:'Codex',available:false},{id:'claude',name:'Claude',available:true},{id:'grok',name:'Grok',available:true}],workspaces:[],defaultCwd:'/fixture/shep'}),dispatch:async(...args)=>{calls.push(args);throw new Error('Unexpected dispatch');}};
 const model=createTuiModel({monitor,controller,registry:createFakeRegistry()});
 try{
  await model.ready;
  const draw=()=>{const raw=renderToString(React.createElement(TuiView,{state:model.getSnapshot(),model,width:columns-1,height:rows-1}),{columns:columns-1});if(!color)assert.doesNotMatch(raw,/\x1b\[/);return stripVTControlCharacters(raw);};
  assert.equal(model.getSnapshot().draft.provider,'claude','Unavailable Codex must retain the actual composer fallback');
  assert.match(draw(),/Default: Claude ·/);
  model.action('new');
  if(columns===120)assert.match(draw(),/Default: Claude ·/);
  model.action('choice',1);assert.equal(model.getSnapshot().draft.provider,'grok');
  model.action('cancel');assert.match(draw(),/Default: Grok ·/);
  model.action('command');assert.match(draw(),/Default: Codex ·/,'Unprefixed slash dispatch keeps its frozen Codex default');
  assert.equal(model.getSnapshot().draft.provider,'grok','Rendering the slash default must not overwrite composer selection');
  model.action('cancel');assert.match(draw(),/Default: Grok ·/);
  const state=model.getSnapshot();const blank=renderToString(React.createElement(TuiView,{state:{...state,draft:{...state.draft,provider:''}},model,width:columns-1,height:rows-1}),{columns:columns-1});
  assert.match(stripVTControlCharacters(blank),/Default: Choose an agent/);
  assert.equal(calls.length,0);
 }finally{model.destroy();}
}
if(process.env.SHEP_CHECKPOINT71_DEFAULT_CASE){await journey(JSON.parse(process.env.SHEP_CHECKPOINT71_DEFAULT_CASE));}
else for(const [columns,rows] of [[120,40],[40,15]])for(const color of [true,false])test(`checkpoint71 default label reflects launch context at ${columns}x${rows} ${color?'color':'NO_COLOR'}`,async()=>{
 const env={...process.env,TERM:'xterm-256color',SHEP_CHECKPOINT71_DEFAULT_CASE:JSON.stringify({columns,rows,color})};if(color){delete env.NO_COLOR;env.FORCE_COLOR='3';}else{env.NO_COLOR='1';delete env.FORCE_COLOR;}
 await promisify(execFile)(process.execPath,[fileURLToPath(import.meta.url)],{env,maxBuffer:2e6});
});
