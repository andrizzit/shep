// Optional visual check of the actual ANSI frame, not a screenshot of the host app.
import { writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boardLines } from '../src/terminal.mjs';
import { readDemoSnapshot } from '../src/herdr.mjs';

const {chromium} = await import(process.env.SHEP_PLAYWRIGHT_MODULE || 'playwright');
const demo = await readDemoSnapshot();
const frame = boardLines({mode:'demo',source:{state:'connected',scope:'Sample agents'},updatedAt:new Date().toISOString(),agents:demo.agents}, {width:117,height:67,url:'http://localhost:4317'});
const escape = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
// Browsers add font leading around block glyphs; a terminal fills the full cell.
// Paint half-block cells directly so the preview preserves the pixel mascot.
const paint = (text, style) => {
  const fg=style.match(/(?:^|;)color:([^;]+)/)?.[1]??'#eef2e8';
  const bg=style.match(/(?:^|;)background:([^;]+)/)?.[1]??'#111b19';
  return `<span style="${style}">${escape(text).replaceAll('▀',`<span style="color:transparent;background:linear-gradient(${fg} 50%,${bg} 50%)">▀</span>`)}</span>`;
};
const rows = frame.styledLines.map(line => {
  let style = '';
  let result = '';
  let previous = 0;
  for (const match of line.matchAll(/\x1b\[([\d;]+)m/g)) {
    result += paint(line.slice(previous,match.index),style);
    const codes = match[1].split(';').map(Number);
    style = '';
    for (let i=0;i<codes.length;i++) {
      if (codes[i]===1) style += 'font-weight:700;';
      if ((codes[i]===38 || codes[i]===48) && codes[i+1]===2) {
        style += `${codes[i]===38?'color':'background'}:rgb(${codes.slice(i+2,i+5).join(',')});`;
        i+=4;
      }
    }
    previous=match.index+match[0].length;
  }
  result += escape(line.slice(previous));
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
