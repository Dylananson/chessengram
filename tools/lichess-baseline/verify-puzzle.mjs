// Drives the UNCHANGED lila puzzle route /training/abcde headlessly.
// Milestones: initial solve position -> wrong move -> failure feedback + revert
// -> correct move -> win feedback -> completion POST -> advance.
// Evidence: per-step JSON state, feedback HTML, completion network logs, PNG shots.
import { createRequire } from 'module';
const PWROOT = '/tmp/opencode/lichess-baseline/lila/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/';
const require = createRequire(PWROOT);
const { chromium } = require('playwright-core');

const base = 'http://localhost:9663';
const ev = '/home/dtans/code/chessengram/tools/lichess-baseline/evidence';
const out = { steps: [], completePosts: [], console: [], errors: [] };
const step = (n, data) => { out.steps.push({ n, ...data }); console.log(`\n=== STEP ${n} ===\n${JSON.stringify(data, null, 1)}`); };

const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', m => out.console.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => out.errors.push(e.message));
page.on('request', req => {
  if (req.method() === 'POST' && req.url().includes('/training/complete/')) {
    out.completePosts.push({ url: req.url(), postData: req.postData(), encoded: req.headers()['content-type'] });
  }
});

await page.goto(`${base}/training/abcde`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('.cg-wrap', { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll('.cg-wrap piece').length >= 32, { timeout: 20000 });
await page.waitForTimeout(3500); // let setup animation settle

const readFeedback = () => page.evaluate(() => {
  const fb = document.querySelector('.puzzle__feedback');
  const mv = document.querySelector('.puzzle__moves') || document.querySelector('ol.moves');
  return {
    feedback: fb ? fb.outerHTML : null,
    feedbackText: fb ? fb.textContent.replace(/\s+/g, ' ').trim() : null,
    bodyClass: document.body.className,
    moveList: mv ? mv.textContent.replace(/\s+/g, ' ').trim() : null,
    useNodeCount: document.querySelectorAll('#advice-glyphs use, .puzzle__menu').length,
    pieceCount: document.querySelectorAll('.cg-wrap piece').length,
  };
});

const cgMetrics = () => page.evaluate(() => {
  const w = document.querySelector('.cg-wrap');
  const r = w.getBoundingClientRect();
  const size = r.width / 8;
  const byKey = {};
  document.querySelectorAll('.cg-wrap piece').forEach(p => {
    const m = /color-?(\w+)/y; // piece class is like "white king"
    const cls = p.className.split(' ');
    const color = cls[0], role = cls[1];
    const t = new DOMParser().parseFromString(p.style.transform, 'text/html'); // noop
    const mm = p.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    if (mm) {
      const col = Math.round(parseFloat(mm[1]) / size);
      const row = Math.round(parseFloat(mm[2]) / size);
      const key = `${color} ${role}`;
      byKey[key] = { color, role, col, row, x: parseFloat(mm[1]), y: parseFloat(mm[2]) };
    }
  });
  return { size, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, pieces: byKey };
});

const centerOf = async (col, row) => {
  const m = await cgMetrics();
  return { x: m.rect.left + (col + 0.5) * m.size + 2, y: m.rect.top + (row + 0.5) * m.size + 2, size: m.size };
};

const drag = async (from, to) => {
  const a = await centerOf(from.col, from.row);
  const b = await centerOf(to.col, to.row);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + (b.x - a.x) * 0.4, a.y + (b.y - a.y) * 0.4, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(1800);
};

// STEP 1: initial solve position (white to move, queen on h5)
let met = await cgMetrics();
let qh = met.pieces['white queen'];
let nf6 = met.pieces['black knight'];
step(1, { title: await page.title(), queenOnH5: pet(qh), blackKnights: Object.values(met.pieces).filter(p => /black knight/.test(p.color + p.role)).map(p => [p.color, p.role, p.col, p.row]), feedback: (await readFeedback()).feedbackText });

// STEP 2: wrong move — queen h5->h4 (legal, but never the mate)
if (qh && qh.col === 7 && qh.row === 3) {
  await drag(qh, { col: 7, row: 4 }); // h4 (row index: rank7?) verify below via feedback
} else {
  step('2-skip', { reason: 'queen not found on h5', met });
}

// STEP 3: wrong-move feedback
const postWrong = await readFeedback();
const capture = await page.evaluate(() => {
  const fb = document.querySelector('.puzzle__feedback');
  const msgs = [...document.querySelectorAll('.puzzle__feedback .player, .puzzle__feedback .instruction')].map(e => e.textContent.replace(/\s+/g, ' ').trim());
  const cgcl = document.querySelector('.cg-wrap').className;
  return { msgs, cgWrapClass: cgcl };
});
const wrongFile = `${ev}/wrong-move.html`;
await page.content().then(c => require('fs').writeFileSync(wrongFile, c));
await page.screenshot({ path: `${ev}/wrong-move.png` });
step(3, { feedbackText: postWrong.feedbackText, msgs: capture.msgs, cgWrapClass: capture.cgWrapClass, bodyClass: postWrong.bodyClass });

// STEP 4: continue — correct move after the failure: queen h5->f7 (Qxf7#)
// f7 => col f=5, row 1 (rank 7 => row index 1 in white orientation)
const redo = await cgMetrics();
const q0 = redo.pieces['white queen'];
if (q0) {
  await drag(q0, { col: 5, row: 1 }); // h5->f7
} else {
  step('4-skip2', { reason: 'still no queen', met: Object.keys(redo.pieces) });
}

// STEP 5: win / advance
const postWin = await readFeedback();
await page.waitForTimeout(2500);
const afterAdvance = await readFeedback();
const winFile = `${ev}/win-advance.html`;
await page.content().then(c => require('fs').writeFileSync(winFile, c));
const sh = await page.evaluate(() => {
  const st = document.querySelector('.puzzle__session');
  const preview = document.querySelector('main');
  return { sessionText: st ? st.textContent.replace(/\s+/g, ' ').trim() : null };
});
await page.screenshot({ path: `${ev}/win-advance.png` });
step(5, { postWinFeedback: postWin.feedbackText, postWinBody: postWin.bodyClass, afterAdvance: afterAdvance.feedbackText, session: sh.sessionText, completePosts: out.completePosts });

require('fs').writeFileSync(`${ev}/summary.json`, JSON.stringify(out, null, 2));

// STEP 6: clean first-attempt solve in a fresh page -> auto-advance to next puzzle
page.on('response', async resp => {
  if (resp.url().includes('/training/complete/')) {
    let body = '';
    try { body = await resp.text(); } catch {}
    out.completeResponses = out.completeResponses || [];
    out.completeResponses.push({ url: resp.url(), status: resp.status(), body: body.slice(0, 600) });
  }
});
await page.goto(`${base}/training/abcde`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('.cg-wrap', { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll('.cg-wrap piece').length >= 32, { timeout: 20000 });
await page.waitForTimeout(3500);
let m = await cgMetrics();
let q = m.pieces['white queen'];
await drag(q, { col: 5, row: 1 }); // h5->f7, Qxf7# on first attempt
await page.waitForTimeout(1200);
const win1 = await readFeedback();
// Auto-next is off by default: the success feedback offers a "Continue training" button.
const clicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find(bb => bb.textContent.replace(/\s+/g, ' ').includes('Continue'));
  if (b) { b.click(); return b.textContent.replace(/\s+/g, ' ').trim(); }
  return null;
});
await page.waitForTimeout(4000);
const advanced = await readFeedback();
step(6, {
  winFeedback: win1.feedbackText,
  clickedButton: clicked,
  afterAdvance: advanced.feedbackText,
  afterAdvanceBody: advanced.bodyClass,
  completeResponses: out.completeResponses,
  completePostsTotal: out.completePosts,
});
await page.screenshot({ path: `${ev}/clean-solve-advance.png` });
require('fs').writeFileSync(`${ev}/summary.json`, JSON.stringify(out, null, 2));
await browser.close();

function pet(o) { return o ? `${o.color} ${o.role} @col=${o.col} row=${o.row}` : 'none'; }