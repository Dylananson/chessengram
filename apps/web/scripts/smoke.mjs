/**
 * Headless browser smoke test for apps/web using puppeteer-core + system
 * Chromium. Verifies the shell boots, the train screen renders a queue, a
 * puzzle is selected, navigation between screens works, and the solution stays
 * hidden until revealed.
 *
 * Usage from repo root: npm run smoke
 * Set CHROMIUM_PATH if Chromium is not found on PATH.
 */

import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const root = require.resolve('@chessreps/web/package.json').replace('/package.json', '');

const PORT = 5317;
const BASE = `http://localhost:${PORT}`;
const findChromium = () =>
  process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => p);

function startPreview() {
  const child = spawn('npm', ['run', 'preview', '--workspace', '@chessreps/web', '--', '--port', String(PORT)], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'ignore',
  });
  return child;
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

let browser;
let preview;
try {
  preview = startPreview();
  await waitForServer(BASE);

  const executablePath = findChromium();
  if (!executablePath) throw new Error('no chromium binary found; set CHROMIUM_PATH');
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });

  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 20000 });

  check('no page errors on boot', pageErrors.length === 0, pageErrors.join(' | '));

  const navIds = await page.$$eval('#nav .nav-item', (els) =>
    els.map((el) => el.getAttribute('data-nav')),
  );
  check('nav has all five screens', JSON.stringify(navIds) === JSON.stringify(['train', 'puzzles', 'collections', 'settings', 'history']), `got [${navIds}]`);

  const queueText = await page.$eval('#queue', (el) => el.textContent).catch(() => '');
  check('queue summary rendered', /puzzles/.test(queueText), queueText.trim());

  const boardMounted = await page.$('#board').then(Boolean);
  check('train board mounted', boardMounted);

  const statusText = await page.$eval('#status', (el) => el.textContent).catch(() => '');
  check('an attempt started (status not just loading)', statusText.length > 0 && !statusText.includes('Loading'), statusText.trim());

  const solutionVisible = await page.$eval('#solution', (el) => !el.classList.contains('hidden')).catch(() => true);
  check('solution hidden by default (no spoiler)', solutionVisible === false);

  // Reveal: shows the solution and abandons the active attempt without scoring.
  await page.click('#reveal-btn');
  await new Promise((r) => setTimeout(r, 250));
  const revealedVisible = await page.$eval('#solution', (el) => !el.classList.contains('hidden')).catch(() => false);
  check('reveal shows the solution', revealedVisible);
  const revealedStatus = await page.$eval('#status', (el) => el.textContent).catch(() => '');
  check('reveal reports no score recorded', /no score recorded/.test(revealedStatus), revealedStatus.trim());

  // Reload to start a fresh attempt, then Skip moves to a different puzzle.
  await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
  await page.waitForSelector('#board', { timeout: 10000 });
  const idBefore = await page.$eval('#puzzle-id', (el) => el.textContent);
  await page.click('#skip-btn');
  await page.waitForFunction(
    (before) => document.querySelector('#puzzle-id')?.textContent !== before,
    { timeout: 10000 },
    idBefore,
  );
  const idAfter = await page.$eval('#puzzle-id', (el) => el.textContent);
  check('skip moves to a different puzzle', idAfter !== idBefore, `${idBefore} -> ${idAfter}`);
  const skippedStatus = await page.$eval('#status', (el) => el.textContent).catch(() => '');
  check('skip resumes with a fresh attempt', /solve the puzzle/.test(skippedStatus), skippedStatus.trim());

  await page.evaluate(() => { window.location.hash = '#/puzzles'; });
  await new Promise((r) => setTimeout(r, 300));
  const puzzlesBody = await page.$eval('#screen .info p', (el) => el.textContent).catch(() => '');
  check('puzzles screen navigates', puzzlesBody.length > 0, puzzlesBody.slice(0, 60));

  await page.evaluate(() => { window.location.hash = '#/train'; });
  await new Promise((r) => setTimeout(r, 500));
  const boardBack = await page.$('#board').then(Boolean);
  check('returning to train remounts the board', boardBack);

  await page.evaluate(() => { window.location.hash = '#/settings'; });
  await new Promise((r) => setTimeout(r, 300));
  const settingsBody = await page.$eval('#screen .info p', (el) => el.textContent).catch(() => '');
  check('settings screen navigates', settingsBody.length > 0, settingsBody.slice(0, 60));
} finally {
  await browser?.close().catch(() => {});
  preview?.kill('SIGTERM');
}

if (failures.length > 0) {
  console.error(`\nsmoke test FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nsmoke test passed');