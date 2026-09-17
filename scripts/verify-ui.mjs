// Optional browser acceptance runner. Supply an installed Playwright module path
// with SHEP_PLAYWRIGHT_MODULE; no browser tooling is needed to run Shep itself.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createMonitor } from '../src/monitor.mjs';
import { readDemoSnapshot } from '../src/herdr.mjs';
import { startServer } from '../src/server.mjs';

const { chromium } = await import(process.env.SHEP_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let monitor;
let server;
const evidence = [];
const check = (message) => { evidence.push(message); console.log(`PASS ${message}`); };
async function text(selector, expected) {
  await page.locator(selector).filter({hasText:expected}).waitFor();
}
async function count(selector, expected) {
  await page.waitForFunction(({selector,expected}) => document.querySelectorAll(selector).length === expected, {selector,expected});
}
try {
  if (process.env.SHEP_LIVE_URL) {
    await page.goto(process.env.SHEP_LIVE_URL);
    await text('#connection-text', 'Live connection');
    const snapshot = await (await page.request.get(`${process.env.SHEP_LIVE_URL}/api/snapshot`)).json();
    assert.equal(snapshot.mode, 'live');
    assert.equal(snapshot.source.state, 'connected');
    await count('.agent-card', snapshot.agents.length);
    for (const item of snapshot.agents) {
      const card = page.locator('.agent-card').filter({has:page.getByRole('heading', {name:item.name,exact:true})});
      assert.equal(await card.count(), 1);
      if (item.workspace.path) assert.ok((await card.innerText()).includes(item.workspace.path));
    }
    check(`actual Herdr browser read: ${snapshot.agents.length} live agent(s), matching workspace paths`);
  } else {
    const sample = await readDemoSnapshot();
    let outcome = sample;
    monitor = createMonitor({ mode:'demo', intervalMs:100, read: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    } });
    await monitor.start();
    server = await startServer({ monitor, port:0 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await count('.agent-card', sample.agents.length);
    await text('#connection-text', 'Demo mode');
    assert.ok(await page.locator('#mode-banner').isVisible());
    await text('#total-count', '7');
    check('all seven sample sessions render with an explicit Demo label');

    await page.getByRole('searchbox').fill('atlas');
    await count('.agent-card', 3);
    await page.getByRole('button', {name:'Needs input',exact:true}).click();
    await count('.agent-card', 1);
    await page.getByRole('searchbox').fill('no-matching-workspace');
    await text('#empty-title', 'No sessions match your filters');
    await page.getByRole('button', {name:'Clear filters',exact:true}).click();
    await count('.agent-card', 7);
    assert.equal(await page.getByRole('searchbox').inputValue(), '');
    check('search, status filter, zero-result state and clear filters');

    outcome = structuredClone(sample);
    outcome.agents[0].name = 'Changed live without reload';
    await monitor.refresh();
    await page.getByRole('heading', {name:'Changed live without reload',exact:true}).waitFor();
    assert.equal(await page.getByRole('searchbox').evaluate(element => element === document.activeElement), true);
    check('snapshot changes appear automatically and preserve input focus');

    outcome = new Error('simulated host unavailable');
    await monitor.refresh();
    await text('#notice-title', 'Connection interrupted');
    await count('.agent-card', 7);
    assert.ok((await page.locator('#notice-message').innerText()).includes('stale'));
    check('host failure retains seven cards and marks stale data');

    outcome = {version:'0.9.1',agents:[]};
    await monitor.refresh();
    await text('#connection-text', 'Demo mode');
    await count('.agent-card', 0);
    await text('#empty-title', 'No agents found yet');
    check('recovery with an empty host snapshot clears obsolete cards');

    outcome = structuredClone(sample);
    outcome.agents.push({ ...sample.agents[0], id:'odd-provider', provider:'__proto__', name:'<img src=x onerror=alert(1)>', status:'future', workspace:{id:null,name:'Workspace unavailable',path:null} });
    await monitor.refresh();
    await count('.agent-card', 8);
    const hostile = page.getByRole('heading', {name:'<img src=x onerror=alert(1)>',exact:true});
    await hostile.waitFor();
    assert.equal(await hostile.locator('img').count(), 0);
    check('unknown provider/status, missing workspace, and HTML text remain safe and visible');

    outcome = sample;
    await monitor.refresh();
    await count('.agent-card', 7);
    await page.route('**/api/snapshot', route => route.abort());
    await text('#connection-text', 'Connection lost');
    await count('.agent-card', 7);
    await page.unroute('**/api/snapshot');
    await page.getByRole('button', {name:/Retry connection/}).click();
    await text('#connection-text', 'Demo mode');
    check('browser transport failure preserves cards; Retry recovers');

    if (process.env.SHEP_AXE_MODULE) {
      const { default: AxeBuilder } = await import(process.env.SHEP_AXE_MODULE);
      const result = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      assert.deepEqual(result.violations.map(v => ({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)})), []);
      check('automated WCAG A/AA accessibility scan');
    }
    await mkdir('docs/images', {recursive:true});
    await page.screenshot({path:'docs/images/shep-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({path:'docs/images/shep-mobile.png',fullPage:true});
    await page.getByRole('searchbox').fill('kiro');
    await count('.agent-card', 2);
    await page.getByRole('searchbox').press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BUTTON');
    check('390px layout has no horizontal overflow; mobile search and keyboard focus work');

    const unavailable = await context.newPage();
    await unavailable.route('**/api/snapshot', route => route.abort());
    await unavailable.goto(`http://127.0.0.1:${server.address().port}`);
    await unavailable.getByText('Unable to connect to your agents.',{exact:true}).waitFor();
    assert.equal(await unavailable.locator('#total-count').innerText(), '—');
    assert.equal(await unavailable.locator('#empty-state').isVisible(), false);
    await unavailable.close();
    check('initial failure is distinct from a healthy empty session');
  }
  assert.deepEqual(errors, []);
  console.log(`Completed ${evidence.length} browser acceptance checks with no page errors.`);
} finally {
  await browser.close();
  monitor?.stop();
  if (server) await new Promise(resolve => server.close(resolve));
}
