import { stripVTControlCharacters } from 'node:util';
import { emitKeypressEvents } from 'node:readline';

const names = new Map([['claude', 'Claude'], ['codex', 'Codex'], ['kiro', 'Kiro']]);
const labels = { blocked: 'NEEDS INPUT', working: 'WORKING', done: 'DONE', idle: 'IDLE', unknown: 'UNKNOWN' };
const priority = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
const filters = ['all', 'working', 'blocked', 'done', 'idle', 'unknown'];
const filterNames = ['All', 'Working', 'Needs input', 'Done', 'Idle', 'Unknown'];
const C = {
  canvas: '#111b19', panel: '#172420', card: '#1e2e28', border: '#35493e',
  ink: '#eef2e8', muted: '#a0b0a3', faint: '#81968a', orange: '#f09365',
  green: '#98d2a8', amber: '#f0cd87', blue: '#a6c4ee', purple: '#cbb5ed',
};
const statusColors = { working: C.green, blocked: C.amber, done: C.blue, idle: C.muted, unknown: C.faint };
// A 9×8 pixel shepherd: upright ears, square eyes, a muzzle, and short paws.
// Two square pixels share each terminal cell through the upper-half block.
const shepherd = [
  'DD.....DD',
  'DDDDWDDDD',
  'DD.DWD.DD',
  'DD.WWW.DD',
  '.DWW.WWD.',
  '.DDWWWDD.',
  '.DD...DD.',
  '.WW...WW.',
];
const fur = { '.': C.canvas, D: '#72767d', W: '#f2f1eb' };
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Host metadata is data, never terminal instructions (including OSC and newlines).
export function safeText(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, ' ');
}

function glyphWidth(glyph) {
  if (/^[\p{Mark}\u200b-\u200f\ufeff]+$/u.test(glyph)) return 0;
  const cp = glyph.codePointAt(0);
  if (/\p{Emoji_Presentation}/u.test(glyph) || glyph.includes('\ufe0f') || cp >= 0x1f000 ||
      (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
       (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
       (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
       (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
       (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)))) return 2;
  return 1;
}
function glyphs(value) { return [...segments.segment(safeText(value))].map(item => item.segment); }
export function displayWidth(value) { return glyphs(value).reduce((total, glyph) => total + glyphWidth(glyph), 0); }
function fit(value, width) {
  if (width <= 0) return '';
  const text = safeText(value);
  if (displayWidth(text) <= width) return text;
  let result = '';
  let used = 0;
  for (const glyph of glyphs(text)) {
    const size = glyphWidth(glyph);
    if (used + size > width - 1) break;
    result += glyph;
    used += size;
  }
  return `${result}…`;
}
function wrap(value, width, limit = 2) {
  const chunks = [];
  let current = '';
  let used = 0;
  const input = glyphs(value);
  for (let index = 0; index < input.length; index += 1) {
    const size = glyphWidth(input[index]);
    if (used + size > width) {
      chunks.push(current);
      current = '';
      used = 0;
      if (chunks.length === limit - 1) {
        chunks.push(fit(input.slice(index).join(''), width));
        return chunks;
      }
    }
    current += input[index];
    used += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

class Frame {
  constructor(width, height, background = C.canvas, start=0, visibleHeight=height) {
    this.width = width;
    this.height = height;
    this.start = start;
    this.end = Math.min(height,start+visibleHeight);
    this.rows = Array.from({length:this.end-start}, () => Array.from({length:width}, () => ({char:' ',fg:C.ink,bg:background,bold:false})));
  }
  put(x, y, text, {fg=C.ink,bg=C.canvas,bold=false,plain} = {}, maxWidth=this.width-x) {
    if (y < this.start || y >= this.end) return;
    for (const glyph of glyphs(fit(text,maxWidth))) {
      const size = glyphWidth(glyph);
      if (!size) continue;
      if (x < 0 || x + size > this.width) break;
      this.rows[y-this.start][x] = {char:glyph,fg,bg,bold,plain};
      if (size === 2) this.rows[y-this.start][x+1] = {char:'',fg,bg,bold};
      x += size;
    }
  }
  fill(x,y,width,height,bg) {
    for (let row=Math.max(y,this.start);row<Math.min(y+height,this.end);row+=1) this.put(x,row,' '.repeat(width),{bg});
  }
  box(x,y,width,height,{bg=C.panel,fg=C.border}={}) {
    this.fill(x,y,width,height,bg);
    this.put(x,y,`╭${'─'.repeat(width-2)}╮`,{fg,bg});
    this.put(x,y+height-1,`╰${'─'.repeat(width-2)}╯`,{fg,bg});
    for (let row=Math.max(y+1,this.start);row<Math.min(y+height-1,this.end);row+=1) {
      this.put(x,row,'│',{fg,bg});
      this.put(x+width-1,row,'│',{fg,bg});
    }
  }
  plain() { return this.rows.map(row=>row.map(cell=>cell.plain??cell.char).join('')); }
  ansi() {
    const rgb=hex=>hex.slice(1).match(/../g).map(part=>Number.parseInt(part,16)).join(';');
    return this.rows.map(row=>{
      let output='';
      let previous='';
      for (const cell of row) {
        if (!cell.char) continue;
        const key=`${cell.fg}/${cell.bg}/${cell.bold}`;
        if (key!==previous) {
          output+=`\x1b[0;${cell.bold?'1;':''}38;2;${rgb(cell.fg)};48;2;${rgb(cell.bg)}m`;
          previous=key;
        }
        output+=cell.char;
      }
      return `${output}\x1b[0m`;
    });
  }
}
function drawShepherd(frame, x, y) {
  for (let row=0;row<shepherd.length;row+=2) {
    for (let col=0;col<shepherd[row].length;col+=1) {
      const top=shepherd[row][col];
      const bottom=shepherd[row+1][col];
      if (top==='.'&&bottom==='.') continue;
      // Keep the face legible in NO_COLOR and redirected output as well.
      const plain=top==='.'?'▄':bottom==='.'?'▀':'█';
      frame.put(x+col,y+row/2,'▀',{fg:fur[top],bg:fur[bottom],plain});
    }
  }
}
function drawCompactShepherd(frame, x, y) {
  frame.put(x,y,'▟▀',{fg:fur.D});
  frame.put(x+2,y,'ᴥ',{fg:fur.W});
  frame.put(x+3,y,'▀▙',{fg:fur.D});
}
function knownStatus(agent) { return Object.hasOwn(labels,agent.status)?agent.status:'unknown'; }
function providerName(provider) { return names.get(provider)??provider; }
function brandColor(provider) { return provider==='claude'?C.orange:provider==='kiro'?C.purple:C.green; }

function providerPanel(frame,x,y,width,height,provider,agents,ready,filtered) {
  frame.box(x,y,width,height);
  frame.put(x+2,y+1,`${providerName(provider)}  (${ready?agents.length:'…'})`,{fg:brandColor(provider),bg:C.panel,bold:true},width-4);
  frame.put(x+2,y+2,'─'.repeat(width-4),{fg:C.border,bg:C.panel});
  if (!agents.length) {
    frame.put(x+3,y+5,ready?filtered?'No matching sessions':'No sessions yet':'Waiting for Herdr',{fg:C.muted,bg:C.panel},width-6);
    frame.put(x+3,y+7,ready&&!filtered?'Appears when running in Herdr.':'Your agents will appear here.',{fg:C.faint,bg:C.panel},width-6);
    return;
  }
  for (let i=0;i<agents.length;i+=1) {
    const a=agents[i];
    const cy=y+4+i*9;
    if (cy+8<=frame.start||cy>=frame.end) continue;
    const cx=x+2;
    const cw=width-4;
    const status=knownStatus(a);
    frame.fill(cx,cy,cw,8,C.card);
    frame.put(cx,cy+1,'▎',{fg:statusColors[status],bg:C.card});
    const badge=`● ${labels[status]}`;
    if (cw>=42) {
      frame.put(cx+2,cy+1,a.name,{bg:C.card,bold:true},cw-displayWidth(badge)-5);
      frame.put(cx+cw-displayWidth(badge)-1,cy+1,badge,{fg:statusColors[status],bg:C.card});
    } else {
      frame.put(cx+2,cy,a.name,{bg:C.card,bold:true},cw-4);
      frame.put(cx+2,cy+1,badge,{fg:statusColors[status],bg:C.card},cw-4);
    }
    frame.put(cx+2,cy+3,`▱ ${a.workspace?.name||'Workspace unavailable'}`,{fg:C.ink,bg:C.card},cw-4);
    wrap(a.workspace?.path??'Working directory unavailable',cw-4).forEach((line,n)=>frame.put(cx+2,cy+4+n,line,{fg:C.muted,bg:C.card},cw-4));
    frame.put(cx+2,cy+6,a.paneId,{fg:C.faint,bg:C.card},cw-4);
  }
}

export function boardLines(snapshot,{width=100,height=28,url='',offset=0,filter='all',query='',searching=false}={}) {
  width=Math.max(1,Math.min(Math.floor(width),400));
  height=Math.max(1,Math.min(Math.floor(height),160));
  const frame=new Frame(width,height);
  if (width<40||height<10) {
    ['','Enlarge this pane to see the board.',`Browser: ${url}`,'q close · r refresh'].slice(0,height).forEach((line,row)=>frame.put(0,row,line));
    drawCompactShepherd(frame,0,0);
    frame.put(6,0,'SHEP');
    return {lines:frame.plain(),styledLines:frame.ansi(),maxOffset:0,offset:0};
  }
  const agents=snapshot.agents??[];
  const ready=Boolean(snapshot.updatedAt);
  const connected=snapshot.source.state==='connected';
  const stale=!connected&&ready;
  const demo=snapshot.mode==='demo';
  const compact=height<24||width<88;
  const tight=height<18;
  const boardWidth=Math.min(width-4,156);
  const left=Math.floor((width-boardWidth)/2);
  const scope=demo?'Demo · sample agents':snapshot.source.scope;
  const health=connected?demo?'DEMO':'LIVE':stale?'STALE':snapshot.source.state==='connecting'?'CONNECTING':'UNAVAILABLE';
  const healthColor=connected?demo?C.amber:C.green:C.amber;
  const updated=ready?new Date(snapshot.updatedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'waiting for first snapshot';
  const workspaces=new Set(agents.map(a=>a.workspace?.id??a.workspace?.path).filter(Boolean)).size;
  const working=agents.filter(a=>a.status==='working').length;
  const blocked=agents.filter(a=>a.status==='blocked').length;
  const brandX=left+(compact?0:12);
  if (!compact) drawShepherd(frame,left,1);
  if (compact) drawCompactShepherd(frame,left,tight?0:1);
  frame.put(brandX+(compact?6:0),tight?0:1,'shep.',{fg:C.orange,bold:true});
  frame.put(left+boardWidth-displayWidth(`● ${health}`),tight?0:1,`● ${health}`,{fg:healthColor,bold:true});
  let bodyStart;
  const activeFilter=filterNames[Math.max(0,filters.indexOf(filter))];
  if (tight) {
    frame.put(left,1,`${ready?agents.length:'—'} agents · ${working} working · ${blocked} need input`,{fg:C.muted},boardWidth);
    const filterLabel=`Filter: ${activeFilter}`;
    frame.put(left,2,filterLabel,{fg:C.orange},boardWidth);
    if (query||searching) frame.put(left+displayWidth(filterLabel)+2,2,`/ ${query}${searching?'▏':''}`,{fg:C.orange},boardWidth-displayWidth(filterLabel)-2);
    frame.put(left,3,stale||snapshot.source.message?`! ${stale?'STALE: ':''}${snapshot.source.message||'Showing last known status'}`:scope,{fg:stale?C.amber:C.faint},boardWidth);
    bodyStart=5;
  } else if (compact) {
    frame.put(left,3,`${ready?agents.length:'—'} agents   ${working} working   ${blocked} need input`,{fg:C.muted},boardWidth);
    frame.put(left,4,stale?`Stale · last success ${updated}`:scope,{fg:stale?C.amber:C.faint},boardWidth);
    frame.put(left,5,`Filter: ${activeFilter}  [f]`,{fg:C.orange},boardWidth);
    bodyStart=7;
  } else {
    frame.put(brandX,3,'Your agents, together.',{fg:C.ink,bold:true});
    const stamp=`Updated ${updated}`;
    frame.put(brandX,4,scope,{fg:C.muted},Math.max(0,boardWidth-(brandX-left)-displayWidth(stamp)-3));
    frame.put(left+boardWidth-displayWidth(stamp),4,stamp,{fg:C.muted});
    const metrics=[['TOTAL AGENTS',agents.length,C.ink],['WORKING',working,C.green],['NEEDS INPUT',blocked,C.amber],['WORKSPACES',workspaces,C.purple]];
    const metricWidth=Math.floor((boardWidth-6)/4);
    metrics.forEach(([label,value,color],i)=>{
      const mx=left+i*(metricWidth+2);
      frame.box(mx,6,metricWidth,4);
      frame.put(mx+2,7,label,{fg:C.muted,bg:C.panel},metricWidth-4);
      frame.put(mx+2,8,ready?String(value):'—',{fg:color,bg:C.panel,bold:true},metricWidth-4);
    });
    frame.put(left,11,'AGENT OVERVIEW',{fg:C.muted,bold:true});
    const filterLabel=`Filter: ${activeFilter}  [f]`;
    frame.put(left+boardWidth-displayWidth(filterLabel),11,filterLabel,{fg:C.orange});
    bodyStart=13;
  }
  if (!tight&&(stale||snapshot.source.message)) {
    frame.put(left,bodyStart,`! ${snapshot.source.message||'Connection interrupted. Showing last known status.'}`,{fg:C.amber},boardWidth);
    bodyStart+=2;
  }
  if (!tight&&(query||searching)) {
    frame.put(left,bodyStart,`/ ${query}${searching?'▏':''}`,{fg:C.orange},boardWidth);
    bodyStart+=2;
  }
  const footerHeight=compact?2:4;
  const capacity=Math.max(1,height-bodyStart-footerHeight);
  const columns=boardWidth>=140?3:boardWidth>=92?2:1;
  const columnWidth=Math.floor((boardWidth-(columns-1)*2)/columns);
  const providers=['claude','codex','kiro',...Array.from(new Set(agents.map(a=>a.provider))).filter(p=>!names.has(p)).sort()];
  const search=safeText(query).trim().toLocaleLowerCase();
  const matches=agents.filter(a=>(filter==='all'||knownStatus(a)===filter)&&(!search||[a.name,a.provider,a.workspace?.name,a.workspace?.path,a.paneId].join(' ').toLocaleLowerCase().includes(search)));
  const groupAgents=new Map(providers.map(provider=>[provider,[]]));
  for (const agent of matches) groupAgents.get(agent.provider).push(agent);
  for (const group of groupAgents.values()) group.sort((a,b)=>priority[knownStatus(a)]-priority[knownStatus(b)]||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  const rows=[];
  for (let i=0;i<providers.length;i+=columns) {
    const members=providers.slice(i,i+columns);
    rows.push({members,height:Math.max(11,...members.map(p=>5+groupAgents.get(p).length*9))});
  }
  const contentHeight=rows.reduce((total,row)=>total+row.height+1,0)-1;
  const maxOffset=Math.max(0,contentHeight-capacity);
  offset=Math.max(0,Math.min(offset,maxOffset));
  // Only materialize visible rows, even with thousands of agents.
  const content=new Frame(boardWidth,contentHeight,C.canvas,offset,capacity);
  let rowY=0;
  for (const row of rows) {
    row.members.forEach((p,i)=>providerPanel(content,i*(columnWidth+2),rowY,columnWidth,row.height,p,groupAgents.get(p),ready,filter!=='all'||Boolean(search)));
    rowY+=row.height+1;
  }
  for (let row=0;row<capacity&&row+offset<contentHeight;row+=1) {
    for (let col=0;col<boardWidth;col+=1) frame.rows[bodyStart+row][left+col]=content.rows[row][col];
  }
  const footer=height-footerHeight;
  if (!compact) {
    frame.put(left,footer,'─'.repeat(boardWidth),{fg:C.border});
    const shown=`${matches.length}/${agents.length} shown${maxOffset?` · row ${offset+1}/${maxOffset+1}`:''}`;
    frame.put(left,footer+1,url,{fg:C.muted},boardWidth-displayWidth(shown)-3);
    frame.put(left+boardWidth-displayWidth(shown),footer+1,shown,{fg:C.faint});
  }
  frame.put(left,height-2,searching?'Type to search   Enter keep   Esc clear   Ctrl+C close':'/ search   f filter   ↑↓ scroll   r refresh   q close',{fg:C.muted},boardWidth);
  if (compact) frame.put(left,height-1,url,{fg:C.faint},boardWidth);
  return {lines:frame.plain(),styledLines:frame.ansi(),maxOffset,offset};
}

export function startTerminal({monitor,url,onQuit,input=process.stdin,output=process.stdout}) {
  let offset=0;
  let ended=false;
  let latest=monitor.getSnapshot();
  let query='';
  let searching=false;
  let filterIndex=0;
  let previous=[];
  const interactive=Boolean(input.isTTY&&output.isTTY);
  const color=interactive&&process.env.TERM!=='dumb'&&!Object.hasOwn(process.env,'NO_COLOR');
  const draw=()=>{
    if (ended) return;
    const board=boardLines(latest,{width:Math.max(1,(output.columns??100)-1),height:output.rows??28,offset,url,filter:filters[filterIndex],query,searching});
    offset=board.offset;
    const lines=color?board.styledLines:board.lines;
    if (interactive) {
      // Changed rows only: avoid clearing and repainting the whole pane every poll.
      let changes='';
      lines.forEach((line,row)=>{
        if (line!==previous[row]) changes+=`\x1b[${row+1};1H${line}${color?'\x1b[48;2;17;27;25m':''}\x1b[K\x1b[0m`;
      });
      output.write(changes);
      previous=lines;
    } else output.write(`${board.lines.join('\n')}\n`);
  };
  const resize=()=>{previous=[];output.write('\x1b[2J');draw();};
  const handleKey=(text,key={})=>{
    if ((key.ctrl&&(key.name==='c'||key.name==='d'))||(!searching&&text==='q')) {onQuit();return;}
    if (searching) {
      if (key.name==='escape') {query='';searching=false;}
      else if (key.name==='return') searching=false;
      else if (key.name==='backspace') query=glyphs(query).slice(0,-1).join('');
      else if (text&&!key.ctrl&&!key.meta&&!/[\x00-\x1f\x7f]/.test(text)) query=glyphs(query+text).slice(0,120).join('');
      offset=0;
    } else if (text==='/') searching=true;
    else if (text==='f') {filterIndex=(filterIndex+1)%filters.length;offset=0;}
    else if (/^[1-6]$/.test(text??'')) {filterIndex=Number(text)-1;offset=0;}
    else if (text==='j'||key.name==='down') offset+=1;
    else if (text==='k'||key.name==='up') offset-=1;
    else if (key.name==='pagedown'||text===' ') offset+=10;
    else if (key.name==='pageup') offset-=10;
    else if (key.name==='home') offset=0;
    else if (key.name==='end') offset=Number.MAX_SAFE_INTEGER;
    else if (key.name==='escape') {query='';filterIndex=0;offset=0;}
    else if (text==='r') void monitor.refresh();
    draw();
  };
  if (interactive) {
    output.write('\x1b[?1049h\x1b[?25l\x1b[2J');
    input.setRawMode(true);
    emitKeypressEvents(input);
    input.resume();
    input.on('keypress',handleKey);
    output.on('resize',resize);
  }
  const unsubscribe=monitor.subscribe(snapshot=>{latest=snapshot;draw();});
  draw();
  return ()=>{
    ended=true;
    unsubscribe();
    if (interactive) {
      input.off('keypress',handleKey);
      output.off('resize',resize);
      input.setRawMode(false);
      input.pause();
      output.write('\x1b[0m\x1b[?25h\x1b[?1049l');
    }
  };
}
