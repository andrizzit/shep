// Optional visual check of the actual ANSI frame, not a screenshot of the host app.
import { writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { createTuiModel } from '../src/tui-model.mjs';
import { readDemoSnapshot } from '../src/herdr.mjs';

process.env.FORCE_COLOR = '3';
const [{renderToString}, {TuiView}] = await Promise.all([import('ink'), import('../src/tui.mjs')]);
const {chromium} = await import(process.env.SHEP_PLAYWRIGHT_MODULE || 'playwright');
const demo = await readDemoSnapshot();
const snapshot = {mode:'demo',source:{state:'connected',scope:'Sample agents'},updatedAt:new Date().toISOString(),agents:demo.agents};
const monitor = {getSnapshot:() => snapshot, subscribe:() => () => {}};
const controller = {getProfiles:async () => ({
  providers:[{id:'codex',name:'Codex',available:true},{id:'claude',name:'Claude',available:true},{id:'grok',name:'Grok',available:true}],
  workspaces:[{id:'w1',name:'shep',path:'/projects/shep'}],defaultWorkspaceId:'w1',defaultCwd:'/projects/shep',ownPaneId:'preview',
})};
const model = createTuiModel({monitor,controller});
await model.ready;
const ansi = renderToString(React.createElement(TuiView, {state:model.getSnapshot(),model,width:118,height:40,url:'http://localhost:4317'}), {columns:118});
model.destroy();
const escape = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
// Browsers add font leading around block glyphs; a terminal fills the full cell.
// Paint half-block cells directly so the preview preserves the pixel mascot.
const paint = (text, style) => {
  const fg=style.match(/(?:^|;)color:([^;]+)/)?.[1]??'#eef2e8';
  const bg=style.match(/(?:^|;)background:([^;]+)/)?.[1]??'#111b19';
  return `<span style="${style}">${escape(text).replaceAll('▀',`<span style="color:transparent;background:linear-gradient(${fg} 50%,${bg} 50%)">▀</span>`)}</span>`;
};
const palette = ['#111b19','#f18b89','#93cd95','#e5c86e','#8bb8db','#c4a3df','#7fd3c7','#eef2e8','#829889','#f18b89','#93cd95','#e5c86e','#8bb8db','#c4a3df','#7fd3c7','#ffffff'];
const ansiColor = index => index < 16 ? palette[index] : index >= 232 ? `rgb(${Array(3).fill(8 + (index - 232) * 10).join(',')})` : `rgb(${[Math.floor((index-16)/36),Math.floor((index-16)%36/6),(index-16)%6].map(value => value ? 55 + value * 40 : 0).join(',')})`;
const rows = ansi.split('\n').map(line => {
  let styles = {};
  const css = () => Object.entries(styles).map(([key,value]) => `${key}:${value}`).join(';');
  let result = '';
  let previous = 0;
  for (const match of line.matchAll(/\x1b\[([\d;]+)m/g)) {
    result += paint(line.slice(previous,match.index),css());
    const codes = match[1].split(';').map(Number);
    for (let i=0;i<codes.length;i++) {
      const code = codes[i];
      if (code === 0) styles = {};
      if (code === 1) styles['font-weight'] = '700';
      if (code === 22) delete styles['font-weight'];
      if (code === 2) styles.opacity = '.7';
      if (code === 22) delete styles.opacity;
      if (code === 39) delete styles.color;
      if (code === 49) delete styles.background;
      if (code >= 30 && code <= 37) styles.color = palette[code-30];
      if (code >= 40 && code <= 47) styles.background = palette[code-40];
      if (code >= 90 && code <= 97) styles.color = palette[code-90+8];
      if (code >= 100 && code <= 107) styles.background = palette[code-100+8];
      if ((codes[i]===38 || codes[i]===48) && codes[i+1]===2) {
        styles[codes[i]===38?'color':'background'] = `rgb(${codes.slice(i+2,i+5).join(',')})`;
        i+=4;
      } else if ((code===38 || code===48) && codes[i+1]===5) {
        styles[code===38?'color':'background'] = ansiColor(codes[i+2]);
        i+=2;
      }
    }
    previous=match.index+match[0].length;
  }
  result += paint(line.slice(previous),css());
  return `<div>${result}</div>`;
});
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#111b19;color:#eef2e8}main{display:inline-block;font:13px/19px Menlo,monospace;white-space:pre}main>div{height:19px}span{display:inline-block;height:19px;vertical-align:top}</style><main>${rows.join('')}</main>`;
const directory = await mkdtemp(join(tmpdir(),'shep-terminal-preview-'));
const htmlPath = join(directory,'preview.html');
await writeFile(htmlPath,html);
await mkdir('docs/images',{recursive:true});
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({viewport:{width:960,height:1300}});
  await page.goto(pathToFileURL(htmlPath).href);
  await page.locator('main').screenshot({path:'docs/images/shep-terminal.png'});
  console.log('Rendered ANSI preview: docs/images/shep-terminal.png');
} finally { await browser.close(); }
