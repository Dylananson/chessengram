/**
 * Headless browser smoke test for apps/web using puppeteer-core + system
 * Chromium. Verifies the shell boots, the train screen renders a queue, a
 * puzzle is selected, navigation works, the solution stays hidden until
 * revealed, navigation has no visible Skip action, and the Puzzles screen can
 * create/import/remove puzzles.
 *
 * Usage from repo root: npm run smoke
 * Set CHROMIUM_PATH if Chromium is not found on PATH.
 */

import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const root = require.resolve('@chessreps/web/package.json').replace('/package.json', '');

const PORT = 5317;
const BASE = `http://localhost:${PORT}`;
const PROMOTION_FEN = '7k/1P6/8/8/8/8/8/K7 w - - 0 1';

const findChromium = () =>
  process.env.CHROMIUM_PATH ||
  ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => p);

function startPreview() {
  return spawn('npm', ['run', 'preview', '--workspace', '@chessreps/web', '--', '--port', String(PORT)], {
    cwd: root,
    stdio: 'ignore',
  });
}

async function waitForServer(url, timeoutMs = 20000) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hash(page, id) {
  await page.evaluate((target) => { window.location.hash = `#/${target}`; }, id);
  await sleep(350);
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
  page.on('dialog', (d) => void d.accept());

  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 20000 });

  check('no page errors on boot', pageErrors.length === 0, pageErrors.join(' | '));

  const headerStyle = await page.$eval('.app-header', (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      position: style.position, top: style.top, left: rect.left, right: rect.right,
      height: rect.height, zIndex: style.zIndex, background: style.backgroundColor,
      navWrap: getComputedStyle(el.querySelector('.nav')).flexWrap,
    };
  });
  check(
    'app header is fixed, full-width, compact, opaque, and below overlays',
    headerStyle.position === 'fixed' && headerStyle.top === '0px' && headerStyle.left === 0 && headerStyle.right === await page.evaluate(() => innerWidth) && headerStyle.height <= 80 && Number(headerStyle.zIndex) > 0 && Number(headerStyle.zIndex) < 900 && headerStyle.background !== 'rgba(0, 0, 0, 0)' && headerStyle.navWrap === 'nowrap',
    JSON.stringify(headerStyle),
  );

  const navIds = await page.$$eval('#nav .nav-item', (els) =>
    els.map((el) => el.getAttribute('data-nav')),
  );
  check(
    'nav has all five screens',
    JSON.stringify(navIds) === JSON.stringify(['train', 'puzzles', 'collections', 'settings', 'history']),
    `got [${navIds}]`,
  );

  const queueText = await page.$eval('#queue', (el) => el.textContent).catch(() => '');
  check('queue summary rendered', /puzzles/.test(queueText), queueText.trim());
  const detailsSections = await page.$$eval('.controls-left > .train-section', (els) =>
    els.map((el) => el.querySelector('h2')?.textContent?.trim()),
  );
  check('details column has Training Status and Puzzle sections', JSON.stringify(detailsSections) === JSON.stringify(['Training Status', 'Puzzle']), JSON.stringify(detailsSections));
  check('standalone solution panel is absent', !(await page.$('#solution')));

  check('train board mounted', await page.$('#board').then(Boolean));

  await page.setViewport({ width: 1280, height: 900 });
  const desktopTrainLayout = await page.evaluate(() => {
    const board = document.querySelector('.board-wrap');
    const left = document.querySelector('.controls-left');
    const right = document.querySelector('.controls-right');
    if (!board || !left || !right) return { board: Boolean(board), left: Boolean(left), right: Boolean(right) };
    const b = board.getBoundingClientRect();
    const l = left.getBoundingClientRect();
    const r = right.getBoundingClientRect();
    return { boardLeft: b.left, boardRight: b.right, boardTop: b.top, leftRight: l.right, leftTop: l.top, rightLeft: r.left, rightTop: r.top, boardWidth: b.width };
  });
  check(
    'desktop Train has left details, centered board with actions, and right solve panel',
    Boolean(desktopTrainLayout && desktopTrainLayout.leftRight < desktopTrainLayout.boardLeft && desktopTrainLayout.boardLeft < desktopTrainLayout.rightLeft && Math.abs(desktopTrainLayout.boardTop - desktopTrainLayout.leftTop) < 8 && Math.abs(desktopTrainLayout.boardTop - desktopTrainLayout.rightTop) < 8 && desktopTrainLayout.boardWidth >= 300),
    JSON.stringify(desktopTrainLayout),
  );

  await page.setViewport({ width: 390, height: 844 });
  await sleep(100);
  const mobileTrainLayout = await page.evaluate(() => {
    const board = document.querySelector('.board-wrap');
    const left = document.querySelector('.controls-left');
    const right = document.querySelector('.controls-right');
    if (!board || !left || !right) return { board: Boolean(board), left: Boolean(left), right: Boolean(right) };
    const b = board.getBoundingClientRect();
    const l = left.getBoundingClientRect();
    const r = right.getBoundingClientRect();
    return { boardTop: b.top, boardBottom: b.bottom, leftTop: l.top, leftBottom: l.bottom, rightTop: r.top, boardWidth: b.width, leftWidth: l.width, rightWidth: r.width };
  });
  check(
    'mobile Train stacks board/actions, solve panel, then details',
    Boolean(mobileTrainLayout && mobileTrainLayout.boardBottom <= mobileTrainLayout.rightTop && mobileTrainLayout.rightTop < mobileTrainLayout.leftTop && Math.abs(mobileTrainLayout.boardWidth - mobileTrainLayout.leftWidth) < 2 && Math.abs(mobileTrainLayout.boardWidth - mobileTrainLayout.rightWidth) < 2),
    JSON.stringify(mobileTrainLayout),
  );
  await page.setViewport({ width: 1280, height: 900 });

  const statusText = await page.$eval('#status', (el) => el.textContent).catch(() => '');
  check('an attempt started', statusText.length > 0 && !statusText.includes('Loading'), statusText.trim());
  check('timer is in the right-side feedback panel', await page.$eval('#solve-timer', (el) => {
    const rect = el.getBoundingClientRect();
    return el.closest('.controls-right .status-panel') !== null &&
      getComputedStyle(el).position === 'static' && rect.width > 0 && rect.height > 0;
  }));

  check('Reveal action is available without a solution text panel', Boolean(await page.$('#reveal-btn')) && !(await page.$('#solution')));

  // Reveal starts on-board playback and abandons the attempt without scoring.
  await page.click('#reveal-btn');
  await sleep(250);
  check('reveal keeps solution text panel absent', !(await page.$('#solution')));
  const revealedStatus = await page.$eval('#status', (el) => el.textContent).catch(() => '');
  check('reveal reports no score recorded', /no score recorded/.test(revealedStatus), revealedStatus.trim());

  // Reload to start a fresh attempt, then confirm Skip is absent. If a puzzle
  // is available, Reveal followed by Next advances without a Skip action.
  await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
  await page.waitForSelector('#board', { timeout: 10000 });
  const idBefore = await page.$eval('#puzzle-id', (el) => el.textContent);
  check('Skip action is not visible', !(await page.$('#skip-btn')));
  if (await page.$('#next-btn')) {
    await page.click('#reveal-btn');
    await sleep(250);
    await page.click('#next-btn');
    await page.waitForFunction(
      (before) => document.querySelector('#puzzle-id')?.textContent !== before,
      { timeout: 10000 },
      idBefore,
    );
    const idAfter = await page.$eval('#puzzle-id', (el) => el.textContent);
    check('Next moves to a different puzzle after reveal', idAfter !== idBefore, `${idBefore} -> ${idAfter}`);
  }

  // --- Puzzles screen: creator -------------------------------------------------
  await hash(page, 'puzzles');
  const packVisible = await page.$eval('#screen .panel h3', (el) => el.textContent).catch(() => '');
  check('puzzles screen shows the pack panel', /Pack/.test(packVisible), packVisible);

  const rowsBefore = await page.$$eval('#puzzles-list tbody tr', (r) => r.length);
  check('library lists the bundled pack', rowsBefore === 100, `${rowsBefore} rows`);

  await page.click('#puzzles-new-btn');
  await page.waitForSelector('#pc-save', { timeout: 5000 });
  await page.type('#pc-fen', PROMOTION_FEN);
  await page.type('#pc-solution', 'b7b8q');
  await page.type('#pc-rating', '1234');
  await page.type('#pc-themes', 'endgame promotion');
  await page.click('#pc-save');
  await sleep(400);

  const saveMessage = await page.$eval('#puzzles-message', (el) => el.textContent).catch(() => '');
  check('creator reports a saved puzzle', /Saved/.test(saveMessage), saveMessage.trim());
  const createdId = (saveMessage.match(/Saved\s+(\S+)/) || [])[1];
  check('creator produced an id', Boolean(createdId), createdId);

  const rowsAfterCreate = await page.$$eval('#puzzles-list tbody tr', (r) => r.length);
  check('created puzzle appears in the library', rowsAfterCreate === 101, `${rowsAfterCreate} rows`);
  const createdInList = createdId
    ? await page.$$eval('#puzzles-list tbody tr td:first-child', (cells, id) =>
        cells.some((c) => c.textContent === id), createdId)
    : false;
  check('created puzzle is present by id', createdInList, createdId);

  // Persistence: reload and confirm the created puzzle survives.
  await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
  await page.waitForSelector('#nav', { timeout: 10000 });
  await hash(page, 'puzzles');
  const survived = createdId
    ? await page.$$eval('#puzzles-list tbody tr td:first-child', (cells, id) =>
        cells.some((c) => c.textContent === id), createdId)
    : false;
  check('created puzzle survives reload', survived, createdId);

  // --- Puzzles screen: JSONL import -------------------------------------------
  const dir = mkdtempSync(join(tmpdir(), 'chessreps-smoke-'));
  const importPath = join(dir, 'smoke-import.jsonl');
  writeFileSync(
    importPath,
    `${JSON.stringify({
      id: 'smokeimp',
      solverFen: '7k/1P6/8/8/8/8/8/K7 w - - 0 1',
      solution: ['b7b8q'],
      rating: 1450,
      themes: ['endgame'],
      source: 'smoke',
    })}\n`,
  );
  const fileInput = await page.$('#puzzles-import-file');
  await fileInput.uploadFile(importPath);
  await page.click('#puzzles-import-btn');
  await sleep(400);
  const importMessage = await page.$eval('#puzzles-message', (el) => el.textContent).catch(() => '');
  check('JSONL import reports a result', /added/.test(importMessage), importMessage.trim());
  const imported = await page.$$eval('#puzzles-list tbody tr td:first-child', (cells) =>
    cells.some((c) => c.textContent === 'smokeimp'));
  check('imported puzzle is present', imported);

  // --- Puzzles screen: Lichess CSV import -------------------------------------
  const csvPath = join(dir, 'smoke-import.csv');
  writeFileSync(
    csvPath,
    'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags\n' +
      'smokecsv,5r1k/pp4pp/8/3B4/1P2pRQ1/P5PP/3q4/6K1 b - - 2 33,f8f4 g4c8 f4f8 c8f8,905,80,91,1855,endgame mate,https://lichess.org/x,\n',
  );
  const csvInput = await page.$('#puzzles-import-csv-file');
  await csvInput.uploadFile(csvPath);
  await page.click('#puzzles-import-csv-btn');
  await sleep(400);
  const csvMessage = await page.$eval('#puzzles-message', (el) => el.textContent).catch(() => '');
  check('CSV import reports a result', /added/.test(csvMessage), csvMessage.trim());
  const csvImported = await page.$$eval('#puzzles-list tbody tr td:first-child', (cells) =>
    cells.some((c) => c.textContent === 'smokecsv'));
  check('CSV-imported puzzle is present', csvImported);

  // --- Puzzles screen: PGN preview + import -----------------------------------
  const pgnPath = join(dir, 'smoke-import.pgn');
  writeFileSync(
    pgnPath,
    '[Event "Smoke"]\n[Site "https://lichess.org/pgn1"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 *\n',
  );
  const pgnInput = await page.$('#puzzles-pgn-file');
  await pgnInput.uploadFile(pgnPath);
  await page.click('#puzzles-pgn-preview-btn');
  await page.waitForSelector('#puzzles-pgn-confirm', { timeout: 5000 });
  const previewText = await page.$eval('#screen', (el) => el.textContent);
  check('PGN preview lists the game', /Game 1/.test(previewText));

  const rowsBeforePgn = await page.$$eval('#puzzles-list tbody tr', (r) => r.length);
  await page.click('#puzzles-pgn-confirm');
  await sleep(400);
  const pgnMessage = await page.$eval('#puzzles-message', (el) => el.textContent).catch(() => '');
  check('PGN import reports a result', /Imported/.test(pgnMessage), pgnMessage.trim());
  const rowsAfterPgn = await page.$$eval('#puzzles-list tbody tr', (r) => r.length);
  check('PGN import adds a puzzle', rowsAfterPgn === rowsBeforePgn + 1, `${rowsBeforePgn} -> ${rowsAfterPgn}`);

  // --- Puzzles screen: remove --------------------------------------------------
  await page.click('#puzzles-list [data-remove="smokeimp"]');
  await sleep(400);
  const removed = await page.$$eval('#puzzles-list tbody tr td:first-child', (cells) =>
    cells.some((c) => c.textContent === 'smokeimp'));
  check('removed puzzle disappears from the library', !removed);
  const rowsBeforeImport = await page.$$eval('#puzzles-list tbody tr', (r) => r.length);

  // --- Settings: data safety (export/import/restore) --------------------------
  await hash(page, 'settings');
  check('settings shows the data safety panel', await page.$('#settings-export').then(Boolean));

  // --- Settings: scheduler preferences persist ---------------------------------
  await page.$eval('#set-new-per-day', (el) => {
    el.value = '5';
  });
  await page.click('#settings-save-prefs');
  await sleep(300);
  const prefsMessage = await page.$eval('#settings-message', (el) => el.textContent).catch(() => '');
  check('preferences save', /Preferences saved/.test(prefsMessage), prefsMessage.trim());
  await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
  await sleep(400);
  const savedPerDay = await page.$eval('#set-new-per-day', (el) => el.value).catch(() => '');
  check('preferences persist across reload', savedPerDay === '5', savedPerDay);

  const puzzle = {
    contentSchemaVersion: '1.0.0',
    rating: 1000,
    source: 'lichess',
    sourceId: 'smokedata',
    themes: [],
    sourceFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    solverFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    solverColor: 'white',
    solution: ['e2e4'],
    originalFields: {},
  };
  const exported = {
    format: 'chessreps-export',
    formatVersion: '1.0.0',
    exportedAt: Date.now(),
    backendKind: 'indexeddb',
    collections: {
      content: { smokedata: { schemaVersion: '1.0.0', savedAt: Date.now(), data: puzzle } },
      schedules: {},
      attempts: {},
      sessions: {},
      meta: {},
    },
  };
  const exportPath = join(dir, 'smoke-export.json');
  writeFileSync(exportPath, JSON.stringify(exported));
  const settingsFile = await page.$('#settings-import-file');
  await settingsFile.uploadFile(exportPath);
  await page.click('#settings-import-preview');
  await page.waitForSelector('#settings-import-confirm', { timeout: 5000 });
  const importPreview = await page.$eval('#screen', (el) => el.textContent);
  check('import preview shows the file summary', /Export from/.test(importPreview));

  await page.click('#settings-import-confirm');
  await sleep(500);
  const settingsMessage = await page.$eval('#settings-message', (el) => el.textContent).catch(() => '');
  check('import reports success', /Imported/.test(settingsMessage), settingsMessage.trim());
  check('import created a recovery snapshot', await page.$('[data-restore]').then(Boolean));

  // Restore the pre-import snapshot; this must bring the library back.
  await page.click('[data-restore]');
  await sleep(500);
  const restoredMessage = await page.$eval('#settings-message', (el) => el.textContent).catch(() => '');
  check('restore reports success', /Restored/.test(restoredMessage), restoredMessage.trim());
  await hash(page, 'puzzles');
  const rowsAfterRestore = await page.$$eval('#puzzles-list tbody tr', (r) => r.length);
  check('restore brings the library back', rowsAfterRestore === rowsBeforeImport, `${rowsAfterRestore} vs ${rowsBeforeImport}`);

  // --- Offline startup via the service worker ---------------------------------
  const swState = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const ready = await Promise.race([
      navigator.serviceWorker.ready.then(() => 'ready'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000)),
    ]);
    return ready;
  });
  check('service worker is active', swState === 'ready', swState);

  // Warm the cache under SW control, then boot with the network disabled.
  await hash(page, 'train');
  await page.waitForSelector('#board', { timeout: 10000 });
  await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
  await page.waitForSelector('#board', { timeout: 10000 });
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  const cacheKeys = await page.evaluate(async () => {
    const c = await caches.open('chessreps-shell-v1');
    return (await c.keys()).map((k) => k.url.replace(location.origin, ''));
  });
  check('page controlled by service worker', controlled);
  check(
    'service worker cache holds the shell and hashed bundle',
    cacheKeys.includes('/index.html') && cacheKeys.some((k) => k.startsWith('/assets/')),
    `${cacheKeys.length} keys`,
  );
  // REL-001: versioned-cache discipline — activate must leave exactly one
  // chessreps-shell-* cache so a version bump can never strand a stale shell.
  const shellCaches = await page.evaluate(async () =>
    (await caches.keys()).filter((k) => k.startsWith('chessreps-shell-')));
  check(
    'single versioned shell cache (no stale shell)',
    shellCaches.length === 1 && shellCaches[0] === 'chessreps-shell-v1',
    shellCaches.join(', '),
  );
  await page.setOfflineMode(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('#board', { timeout: 10000 });
    check('app boots offline from the service worker', await page.$('#puzzle-id').then(Boolean));
  } finally {
    await page.setOfflineMode(false);
  }

  check('no page errors across the whole run', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser?.close().catch(() => {});
  preview?.kill('SIGTERM');
}

if (failures.length > 0) {
  console.error(`\nsmoke test FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nsmoke test passed');
