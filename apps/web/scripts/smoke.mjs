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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const root = require.resolve('@chessengram/web/package.json').replace('/package.json', '');

const PORT = 5317;
const BASE = `http://localhost:${PORT}`;
const PROMOTION_FEN = '7k/1P6/8/8/8/8/8/K7 w - - 0 1';

const findChromium = () =>
  process.env.CHROMIUM_PATH ||
  ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => p);

// The suite below asserts the *unconfigured* app (ONL-003/ONL-009b: Sync reports
// `local-only`, Enable is disabled, zero network). `vite preview` serves whatever
// is in `dist/`, and a configured build is a legitimate artifact — `infra/deploy.sh`
// and `infra/write-env.sh` deliberately bake `VITE_SYNC_*` (from `.env.local` /
// `.env.production.local`) into one. So build the bundle here with those vars
// explicitly emptied: process env wins over `.env*` files in Vite, which makes
// this suite independent of the machine's sync configuration.
const SYNC_ENV_KEYS = [
  'VITE_SYNC_API_BASE',
  'VITE_SYNC_PROXY_TARGET',
  'VITE_SYNC_AUTH_AUTHORITY',
  'VITE_SYNC_AUTH_CLIENT_ID',
  'VITE_SYNC_AUTH_REDIRECT_URI',
];

async function buildUnconfiguredBundle() {
  const env = { ...process.env };
  for (const key of SYNC_ENV_KEYS) env[key] = '';
  await new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build', '--workspace', '@chessengram/web'], {
      cwd: root,
      env,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`unconfigured build failed (exit ${code})`)),
    );
  });
}

function startPreview() {
  return spawn('npm', ['run', 'preview', '--workspace', '@chessengram/web', '--', '--port', String(PORT)], {
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
  await buildUnconfiguredBundle();
  preview = startPreview();
  await waitForServer(BASE);

  const executablePath = findChromium();
  if (!executablePath) throw new Error('no chromium binary found; set CHROMIUM_PATH');
  browser = await puppeteer.launch({
    executablePath,
    userDataDir: mkdtempSync(join(tmpdir(), 'chessengram-browser-')),
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

  // Start from a known-empty store so stale browser state cannot make the
  // bundled collection appear empty or skew row-count assertions. Boot straight
  // onto the board (`#/train/session`); the hub is exercised below.
  await page.goto(`${BASE}?reset=1#/train/session`, { waitUntil: 'networkidle0', timeout: 20000 });
  // The reset flag is only for first boot; remove it so page reload assertions
  // below verify persistence instead of intentionally clearing the store.
  await page.evaluate(() => history.replaceState(null, '', `${location.pathname}${location.hash}`));

  check('no page errors on boot', pageErrors.length === 0, pageErrors.join(' | '));

  // Boot is asynchronous (IndexedDB open, content seed, session start) and
  // `networkidle0` does not imply it finished: the shell renders before the nav
  // module runs. Wait for the shell to actually populate before asserting on it,
  // otherwise the early checks race the boot and fail intermittently.
  await page.waitForSelector('#nav .nav-item', { timeout: 15000 });

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
    'nav has all nine screens (analysis added in AN-002)',
    JSON.stringify(navIds) === JSON.stringify(['dashboard', 'woodpecker', 'train', 'puzzles', 'collections', 'settings', 'history', 'stats', 'analysis']),
    `got [${navIds}]`,
  );
  check('normal training tab is labeled Spaced Repetition', await page.$eval('[data-nav="train"]', (el) => el.textContent) === 'Spaced Repetition');

  const queueText = await page.$eval('#queue', (el) => el.textContent).catch(() => '');
  check('queue summary rendered', /puzzles/.test(queueText), queueText.trim());
  const detailsSections = await page.$$eval('.controls-left > .train-section', (els) =>
    els.map((el) => el.querySelector('h2')?.textContent?.trim()),
  );
  check('details column has Training Status and Puzzle sections', JSON.stringify(detailsSections) === JSON.stringify(['Training Status', 'Puzzle']), JSON.stringify(detailsSections));
  const leftCardPadding = await page.$eval('.controls-left > .train-section', (el) => getComputedStyle(el).paddingLeft);
  check('Train left-column cards have breathing room inside their borders', parseFloat(leftCardPadding) >= 14, leftCardPadding);
  check('standalone solution panel is absent', !(await page.$('#solution')));

  check('train board mounted', await page.$('#board').then(Boolean));

  // PZL-004: starting a puzzle shows the opponent's setup move with an
  // animation; its squares stay highlighted as the last move once it settles.
  await sleep(700);
  const setupHighlights = await page.$$eval('cg-board square.last-move', (els) => els.length);
  check(
    'starting a puzzle animates the opponent setup move (last-move highlight)',
    setupHighlights >= 2,
    `last-move squares: ${setupHighlights}`,
  );
  const currentMoves = await page.$$eval('.move-list .moves-move.current .moves-san', (els) =>
    els.map((el) => el.textContent?.trim()),
  );
  check(
    'the current move is highlighted in the move list',
    currentMoves.length === 1,
    JSON.stringify(currentMoves),
  );

  // Reload resumes the in-progress attempt; the setup move and the stepper must
  // survive it (regression guard, user report 2026-10-16: a reload dropped both).
  await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
  await page.waitForSelector('#board', { timeout: 10000 });
  await sleep(700);
  const resumedBoard = await page.evaluate(() => ({
    lastMoveSquares: document.querySelectorAll('cg-board square.last-move').length,
    navHidden: document.querySelector('.review-nav')?.classList.contains('hidden') ?? true,
    backDisabled: document.querySelector('#review-back')?.hasAttribute('disabled') ?? true,
    currentCells: document.querySelectorAll('.move-list .current').length,
  }));
  check(
    'a reload keeps the setup move and a usable stepper (◀ back)',
    resumedBoard.lastMoveSquares >= 2
      && resumedBoard.navHidden === false
      && resumedBoard.backDisabled === false
      && resumedBoard.currentCells === 1,
    JSON.stringify(resumedBoard),
  );

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
  // UX-010: on a phone the status/feedback panel leads and the move list is
  // below it; on desktop the move list stays at the top of the column.
  const mobileOrder = await page.evaluate(() => {
    const right = document.querySelector('.controls-right');
    if (!right) return null;
    const top = (selector) => right.querySelector(selector)?.getBoundingClientRect().top ?? null;
    return { status: top('.status-panel'), moves: top('.move-list') };
  });
  check(
    'phone Train puts feedback before the move list (UX-010)',
    Boolean(mobileOrder && mobileOrder.status !== null && mobileOrder.moves !== null && mobileOrder.status < mobileOrder.moves),
    JSON.stringify(mobileOrder),
  );

  check(
    'mobile Train stacks board/actions, solve panel, then details',
    Boolean(mobileTrainLayout && mobileTrainLayout.boardBottom <= mobileTrainLayout.rightTop && mobileTrainLayout.rightTop < mobileTrainLayout.leftTop && Math.abs(mobileTrainLayout.boardWidth - mobileTrainLayout.leftWidth) < 2 && Math.abs(mobileTrainLayout.boardWidth - mobileTrainLayout.rightWidth) < 2),
    JSON.stringify(mobileTrainLayout),
  );

  // --- UX-006: the phone navigation is a drawer, not a sideways strip --------
  const drawer = await page.evaluate(() => {
    const toggle = document.getElementById('nav-toggle');
    const nav = document.getElementById('nav');
    if (!toggle || !nav) return null;
    const header = document.querySelector('.app-header');
    const visible = getComputedStyle(toggle).display !== 'none';
    const scrollsSideways = nav.scrollWidth > nav.clientWidth + 1 && getComputedStyle(nav).display !== 'none';
    const firstChild = header ? header.firstElementChild === toggle : false;
    const text = (toggle.textContent ?? '').trim();
    const label = toggle.getAttribute('aria-label') ?? '';
    toggle.click();
    const opened = {
      expanded: toggle.getAttribute('aria-expanded'),
      open: nav.classList.contains('nav-open'),
      display: getComputedStyle(nav).display,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { visible, scrollsSideways, firstChild, text, label, opened, closed: toggle.getAttribute('aria-expanded') };
  });
  check(
    'phone nav is an icon-only drawer at the top left that opens, names the screen and closes on Escape',
    Boolean(
      drawer &&
        drawer.visible === true &&
        drawer.firstChild === true &&
        /^[^A-Za-z]*$/.test(drawer.text) &&
        /Spaced Repetition/.test(drawer.label) &&
        drawer.opened.expanded === 'true' &&
        drawer.opened.open === true &&
        drawer.opened.display === 'flex' &&
        drawer.closed === 'false' &&
        drawer.scrollsSideways === false,
    ),
    JSON.stringify(drawer),
  );

  // The signed-in status chip is gone: the shell only ever offers sign-in.
  check(
    'the header carries no signed-in status chip',
    (await page.$('#auth-status')) === null,
  );

  // --- UX-007: no sign-in entry point without sync configuration ------------
  check(
    'unconfigured build renders no sign-in entry point (zero-network promise)',
    (await page.$('#auth-sign-in')) === null && (await page.$('#auth-status')) === null,
  );

  await page.setViewport({ width: 1280, height: 900 });
  const desktopOrder = await page.evaluate(() => {
    const right = document.querySelector('.controls-right');
    if (!right) return null;
    const top = (selector) => right.querySelector(selector)?.getBoundingClientRect().top ?? null;
    return { status: top('.status-panel'), moves: top('.move-list') };
  });
  check(
    'desktop Train keeps the move list at the top of the review column',
    Boolean(desktopOrder && desktopOrder.moves !== null && desktopOrder.status !== null && desktopOrder.moves < desktopOrder.status),
    JSON.stringify(desktopOrder),
  );

  const statusText = await page.$eval('#status', (el) => el.textContent).catch(() => '');
  check('an attempt started', statusText.length > 0 && !statusText.includes('Loading'), statusText.trim());
  check('timer is in the right-side feedback panel', await page.$eval('#solve-timer', (el) => {
    const rect = el.getBoundingClientRect();
    return el.closest('.controls-right .status-panel') !== null &&
      getComputedStyle(el).position === 'static' && rect.width > 0 && rect.height > 0;
  }));

  check('Reveal action is available without a solution text panel', Boolean(await page.$('#reveal-btn')) && !(await page.$('#solution')));

  // Hint highlights the next solver source square (green circle). It must also
  // work after a reload, where the open attempt is resumed and the ctrl's
  // `currentPuzzle` fallback kicks in.
  const hintCircles = () => page.$$eval('.cg-shapes circle', (els) => els.length);
  await page.click('#hint-btn');
  await sleep(150);
  check('Hint draws a source-square shape', (await hintCircles()) >= 1, `circles: ${await hintCircles()}`);
  await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
  await page.waitForSelector('#board', { timeout: 10000 });
  await sleep(500);
  await page.click('#hint-btn');
  await sleep(150);
  check('Hint still draws after a reload resumes the attempt', (await hintCircles()) >= 1, `circles: ${await hintCircles()}`);

  // Reveal starts on-board playback and abandons the attempt without scoring.
  await page.click('#reveal-btn');
  await sleep(250);
  check('reveal keeps solution text panel absent', !(await page.$('#solution')));
  const revealedMoves = await page.evaluate(() => {
    const root = document.querySelector('.controls-right .move-list');
    if (!root) return null;
    const rows = [...root.querySelectorAll('ol.moves-list > li.moves-row')];
    return {
      heading: root.querySelector('h2')?.textContent?.trim(),
      indexes: rows.map((row) => row.querySelector('.moves-index')?.textContent?.trim() ?? ''),
      san: rows.flatMap((row) =>
        [...row.querySelectorAll('.moves-move:not(.empty)')].map(
          (cell) => cell.querySelector('.moves-san')?.textContent?.trim() ?? '',
        ),
      ),
      glyphs: rows.flatMap((row) =>
        [...row.querySelectorAll('.moves-move:not(.empty) .moves-piece')].map(
          (piece) => piece.textContent?.trim() ?? '',
        ),
      ),
    };
  });
  check(
    'move list renders Lichess-style numbered rows with SAN and piece glyphs',
    Boolean(
      revealedMoves &&
        revealedMoves.heading === 'Moves' &&
        revealedMoves.indexes.length > 0 &&
        revealedMoves.indexes.every((index) => /^\d+$/.test(index)) &&
        revealedMoves.san.length > 0 &&
        revealedMoves.san.every(Boolean) &&
        revealedMoves.glyphs.length === revealedMoves.san.length &&
        revealedMoves.glyphs.every(Boolean),
    ),
    JSON.stringify(revealedMoves),
  );
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

  // --- Collections create shared content and Woodpecker set --------------------
  await hash(page, 'collections');
  await page.waitForSelector('.collections-screen', { timeout: 5000 });
  const bandSummaries = await page.$$eval(
    '[data-collection^="lichess-bands-v1-"] > p',
    (els) => els.map((el) => el.textContent),
  );
  check(
    'Collections includes five bundled rating bands of 500 varied puzzles',
    bandSummaries.length === 5 && bandSummaries.every((text) => /500 puzzles/.test(text)),
    JSON.stringify(bandSummaries),
  );
  const bandThemes = await page.evaluate(async () => {
    const response = await fetch('/data/puzzles/lichess-bands-v1/bands.json');
    const document = await response.json();
    return document.bands.map((band) => new Set(band.puzzleIds).size);
  });
  check(
    'each bundled band has 500 distinct puzzles',
    bandThemes.length === 5 && bandThemes.every((size) => size === 500),
    JSON.stringify(bandThemes),
  );
  check('Collections renders a responsive grid of cards', (await page.$('.collections-grid')) !== null);
  check('Collections cards omit the add-puzzle input', (await page.$('.collections-grid input[id^="add-"]')) === null);
  await page.click('.collections-grid [data-collection] [id^="collection-view-"]');
  await page.waitForSelector('[data-collection-detail]', { timeout: 5000 });
  check('Collection card opens a detail page', (await page.$('[data-collection-detail]')) !== null);
  check('Collection detail collapses puzzle members by default', (await page.$('.member-list')) === null);
  await page.click('[id^="members-toggle-"]');
  await page.waitForSelector('.member-list li', { timeout: 5000 });
  check('Collection detail expands puzzle members on toggle', (await page.$$('.member-list li')).length > 0);
  // Back to the grid for the Woodpecker start check below.
  await hash(page, 'collections');
  await page.waitForSelector('.collections-grid', { timeout: 5000 });

  // --- Woodpecker starts from a collection (no user-facing "set") --------------
  check('Collections starts Woodpecker directly without a set form', (await page.$('input[id^="woodpecker-name-"]')) === null);
  await page.click('.collections-screen [data-collection] .woodpecker-create-from-collection button');
  await page.waitForSelector('.woodpecker-mode', { timeout: 5000 });
  const woodpeckerMode = await page.$eval('.woodpecker-mode', (el) => el.textContent);
  check('Starting Woodpecker from a collection opens the trainer', /Woodpecker cycle/.test(woodpeckerMode), woodpeckerMode);
  check('Woodpecker trainer identifies collection and cycle position', await page.$eval('.woodpecker-context', (el) => /Default/.test(el.textContent) && /Cycle 1/.test(el.textContent) && /Puzzle 1 of 100/.test(el.textContent)));
  check('Woodpecker trainer shows cycle progress as a bar', await page.$eval('.woodpecker-context progress.progress-bar', (el) => el.max === 100 && el.value === 0));
  check('Woodpecker trainer offers Previous/Next review controls', (await page.$('#woodpecker-prev-btn')) !== null && (await page.$('#woodpecker-next-btn')) !== null);
  // At the start of the cycle (puzzle 1, nothing covered) neither direction may
  // move: Next must never skip ahead of real progress.
  check('Woodpecker review cannot skip ahead of progress', await page.$eval('#woodpecker-next-btn', (el) => el.disabled) && await page.$eval('#woodpecker-prev-btn', (el) => el.disabled));
  check('Woodpecker trainer hides ordinary schedule and collection controls', !(await page.$('#queue')) && !(await page.$('#collection-picker')) && !(await page.$('.training-status-section')));
  check('Woodpecker solver selects the Woodpecker menu tab', await page.$eval('[data-nav="woodpecker"]', (el) => el.getAttribute('aria-current') === 'page') && await page.$eval('[data-nav="train"]', (el) => el.getAttribute('aria-current') === 'false'));

  // --- Woodpecker overview lists collections, not sets -------------------------
  await hash(page, 'woodpecker');
  await page.waitForSelector('.woodpecker-page', { timeout: 5000 });
  check('Woodpecker overview lists collections instead of sets', (await page.$('[data-woodpecker-collection]')) !== null && (await page.$('[data-woodpecker-set]')) === null && (await page.$('#woodpecker-create')) === null);
  const wpSize = await page.$eval('[data-woodpecker-collection] > p', (el) => el.textContent);
  check('Woodpecker collection card names the collection snapshot', /100 puzzles/.test(wpSize), wpSize);
  check('Woodpecker collection overview shows accumulated progress', await page.$eval('[data-woodpecker-collection] .woodpecker-set-progress', (el) => /Progress/.test(el.textContent) && /0 scored attempts/.test(el.textContent)));
  check('Woodpecker overview shows cycle progress as a bar', await page.$eval('[data-woodpecker-collection] .woodpecker-set-progress progress.progress-bar', (el) => el.max === 100 && el.value === 0) && await page.$eval('[data-woodpecker-collection] .woodpecker-cycles progress.progress-bar', (el) => el.max === 100));

  await page.click('[data-nav="train"]');
  await page.waitForSelector('.spaced-page', { timeout: 5000 });
  check('Spaced Repetition tab opens the hub and is selected', await page.$eval('[data-nav="train"]', (el) => el.getAttribute('aria-current') === 'page') && (await page.$('.spaced-collection')) !== null);
  await page.click('.spaced-collection button');
  await page.waitForSelector('#queue', { timeout: 5000 });
  check('Spaced Repetition hub start opens normal training', (await page.$('#board')) !== null && !(await page.$('.woodpecker-mode')));
  await page.click('[data-nav="woodpecker"]');
  await page.waitForSelector('.woodpecker-page', { timeout: 5000 });
  check('Woodpecker tab returns to the collection overview', await page.$eval('[data-nav="woodpecker"]', (el) => el.getAttribute('aria-current') === 'page'));
  await page.click('[data-woodpecker-collection] button');
  await page.waitForSelector('.woodpecker-mode', { timeout: 5000 });
  check('Woodpecker cycle resumes from the collection card', await page.$eval('.woodpecker-mode', (el) => /Woodpecker cycle/.test(el.textContent)));

  // --- F01: the isolated Failed-review queue is reachable and correctly routed ---
  const failedSetId = await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('setId'));
  await page.evaluate((setId) => {
    window.location.hash = `/train/woodpecker?mode=failed&setId=${encodeURIComponent(setId)}`;
  }, failedSetId);
  await page.waitForSelector('.woodpecker-mode', { timeout: 5000 });
  const failedReview = await page.evaluate(() => ({
    mode: document.querySelector('.woodpecker-mode')?.textContent ?? '',
    heading: document.querySelector('.woodpecker-context h2')?.textContent ?? '',
    status: document.querySelector('#status')?.textContent ?? '',
  }));
  check(
    'Failed review route opens the isolated queue in its own mode',
    /failed review/i.test(failedReview.mode) && failedReview.heading === 'Woodpecker · Failed review',
    JSON.stringify(failedReview),
  );
  check(
    'an empty Failed-review queue reports the empty state without crashing',
    /No puzzles available/.test(failedReview.status),
    failedReview.status,
  );
  await page.click('[data-nav="dashboard"]');
  await page.waitForSelector('.dashboard-page', { timeout: 5000 });
  check('Dashboard shows spaced repetition and Woodpecker progress', await page.$('[data-dashboard-mode="spaced-repetition"]') !== null && await page.$('[data-dashboard-woodpecker]') !== null);
  check('Dashboard identifies in-progress Woodpecker work', await page.$eval('[data-dashboard-woodpecker]', (el) => /Currently solving/.test(el.textContent)));
  check('Dashboard shows Woodpecker cycle progress as a bar', await page.$eval('[data-dashboard-woodpecker] progress.progress-bar', (el) => el.max === 100 && el.value === 0));

  // --- STAT-001: statistics screen ---------------------------------------------
  await page.click('[data-nav="stats"]');
  await page.waitForSelector('.stats-page', { timeout: 5000 });
  const statsView = await page.evaluate(() => ({
    cards: document.querySelectorAll('.stats-card').length,
    modeRows: document.querySelectorAll('[data-stats-mode]').length,
    collectionRows: document.querySelectorAll('[data-stats-collection]').length,
    totalRow: Boolean(document.querySelector('[data-stats-total-row]')),
    scoredHook: document.querySelector('[data-stats-scored]') !== null,
    practiceHook: document.querySelector('[data-stats-practice]') !== null,
  }));
  check(
    'Stats screen shows summary cards, per-mode and per-collection breakdowns',
    statsView.cards >= 6 && statsView.modeRows >= 4 && statsView.collectionRows >= 1 && statsView.totalRow && statsView.scoredHook && statsView.practiceHook,
    JSON.stringify(statsView),
  );
  await page.click('#stats-range-7d');
  await sleep(200);
  const ranged = await page.evaluate(() => ({
    selected: document.querySelector('#stats-range-7d')?.className ?? '',
    other: document.querySelector('#stats-range-all')?.className ?? '',
    collectionRows: document.querySelectorAll('[data-stats-collection]').length,
    definitions: document.querySelector('.stats-definitions')?.textContent ?? '',
  }));
  check(
    'Stats range filter switches and keeps the breakdown + counting rules visible',
    !/button-secondary/.test(ranged.selected)
      && /button-secondary/.test(ranged.other)
      && ranged.collectionRows >= 1
      && /Active solving time only/.test(ranged.definitions),
    JSON.stringify({ selected: ranged.selected, other: ranged.other, rows: ranged.collectionRows }),
  );

  // --- Puzzles screen: creator -------------------------------------------------
  await hash(page, 'puzzles');
  const packVisible = await page.$eval('#screen .panel h3', (el) => el.textContent).catch(() => '');
  check('puzzles screen shows the pack panel', /Pack/.test(packVisible), packVisible);

  const rowsBefore = await page.$$eval('#puzzles-list tbody tr', (r) => r.length);
  check('library lists the starter and bundled band packs', rowsBefore === 2600, `${rowsBefore} rows`);

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
  check('created puzzle appears in the library', rowsAfterCreate === 2601, `${rowsAfterCreate} rows`);
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
  const dir = mkdtempSync(join(tmpdir(), 'chessengram-smoke-'));
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

  // --- ONL-003: Settings → Sync is visible and honestly unconfigured ----------
  const syncPanelState = await page.evaluate(() => {
    const panel = document.querySelector('.sync-panel');
    const mode = document.querySelector('#sync-mode');
    const enable = document.querySelector('#sync-enable');
    return {
      panel: panel !== null,
      mode: mode?.getAttribute('data-sync-mode') ?? null,
      text: panel?.textContent ?? '',
      enableDisabled: enable instanceof HTMLButtonElement ? enable.disabled : null,
    };
  });
  check('Settings shows the Sync panel', syncPanelState.panel, String(syncPanelState.mode));
  check(
    'Sync reports local-only without VITE_SYNC_* config',
    syncPanelState.mode === 'local-only',
    String(syncPanelState.mode),
  );
  check(
    'Sync says it is not configured and keeps training on the device',
    /not configured/i.test(syncPanelState.text) && /stays on this device/i.test(syncPanelState.text),
  );
  check(
    'Sync enable is visibly disabled while unconfigured',
    syncPanelState.enableDisabled === true,
    String(syncPanelState.enableDisabled),
  );
  check('no page errors after the Sync panel renders', pageErrors.length === 0, pageErrors.join(' | '));

  // --- APP-001: installable + offline-ready PWA --------------------------------
  const manifest = await page.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest');
    return response.json();
  });
  const iconInfo = (manifest.icons ?? []).map((icon) => `${icon.sizes}:${icon.purpose ?? 'any'}`);
  check(
    'manifest is installable (name, standalone, root start_url/scope, 192+512 + maskable icons)',
    manifest.id === '/'
      && Boolean(manifest.name) && Boolean(manifest.short_name)
      && manifest.display === 'standalone'
      && manifest.start_url === '/' && manifest.scope === '/'
      && iconInfo.includes('192x192:any')
      && iconInfo.includes('512x512:any')
      && iconInfo.some((entry) => entry.includes('maskable')),
    JSON.stringify({ name: manifest.name, display: manifest.display, icons: iconInfo }),
  );
  await page.waitForFunction(
    () => (document.querySelector('#pwa-offline-state')?.textContent ?? '').includes('Offline ready'),
    { timeout: 20000 },
  ).catch(() => {});
  const pwaPanelState = await page.evaluate(() => ({
    installed: document.querySelector('[data-pwa-installed]')?.getAttribute('data-pwa-installed') ?? null,
    offline: document.querySelector('#pwa-offline-state')?.textContent ?? '',
    storage: document.querySelector('#pwa-storage')?.textContent ?? '',
  }));
  check(
    'Settings reports the app and its puzzles are saved for offline use',
    /Offline ready/.test(pwaPanelState.offline) && /Storage used: \d/.test(pwaPanelState.storage),
    JSON.stringify(pwaPanelState),
  );

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
    format: 'chessengram-export',
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
  // Restoring rewrites the whole (now larger) library, so wait for the result
  // rather than a fixed delay.
  await page
    .waitForFunction(
      () => /Restored/.test(document.querySelector('#settings-message')?.textContent ?? ''),
      { timeout: 20000 },
    )
    .catch(() => {});
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
  await hash(page, 'train/session');
  await page.waitForSelector('#board', { timeout: 10000 });
  await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
  await page.waitForSelector('#board', { timeout: 10000 });
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  // --- AN-002: the analysis screen runs the engine continuously ---------------
  // Proves the whole feature in the real app: navigate to #/analysis, and the
  // eval bar/score appear without pressing anything, then a board move re-runs
  // the engine on the new position.
  await hash(page, 'analysis');
  await page.waitForSelector('#analysis-eval-bar', { timeout: 15000 });
  const analysisFirst = await page
    .waitForFunction(
      () => {
        const score = document.querySelector('#analysis-score')?.textContent ?? '';
        const depth = document.querySelector('#analysis-depth')?.textContent ?? '';
        return /[0-9]/.test(score) && /d\d+/.test(depth) ? { score, depth } : false;
      },
      { timeout: 40000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  check(
    'analysis screen auto-analyses: an eval bar, a score and a depth appear with no button press',
    Boolean(analysisFirst && /[0-9]/.test(analysisFirst.score) && /d\d+/.test(analysisFirst.depth)),
    JSON.stringify(analysisFirst),
  );
  const analysisLines = await page.$$eval('#analysis-lines .analysis-line', (rows) =>
    rows.map((row) => row.textContent ?? ''),
  );
  check(
    'analysis screen shows engine lines in SAN',
    analysisLines.length > 0 && analysisLines.some((line) => /[a-h][1-8]|O-O|[KQRBN]/.test(line)),
    JSON.stringify(analysisLines.slice(0, 2)),
  );

  // chessground adds `cg-wrap` to the element it was given, so the board is
  // `#analysis.cg-wrap`, not a child of it.
  check('analysis screen renders a free board', Boolean(await page.$('#analysis.cg-wrap')));

  // Continuous means the same position keeps climbing with no further input.
  const startDepth = Number(/d(\d+)/.exec(analysisFirst?.depth ?? '')?.[1] ?? 0);
  const climbed = await page
    .waitForFunction(
      (from) => {
        const match = /d(\d+)/.exec(document.querySelector('#analysis-depth')?.textContent ?? '');
        return match ? Number(match[1]) > from : false;
      },
      { timeout: 30000 },
      startDepth,
    )
    .then(() => true)
    .catch(() => false);
  check('analysis keeps deepening on its own (continuous search)', climbed, `from d${startDepth}`);

  // The score feeds the bar (not a static 50%).
  const barFill = await page.$eval('#analysis-eval-bar', (el) => el.getAttribute('style') ?? '');
  check('analysis eval bar reflects the score', /--analysis-fill:\s*\d/.test(barFill), barFill);

  // A real (trusted) drag on the free board: e2-e4 must extend the line and
  // restart the search on the new position — the interaction the owner asked for.
  await page.$eval('#analysis', (el) => el.scrollIntoView({ block: 'center' }));
  const rect = await page.$eval('#analysis cg-board', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  const squarePoint = (file, rank) => ({
    x: rect.left + ((file + 0.5) * rect.width) / 8,
    y: rect.top + ((7 - rank + 0.5) * rect.height) / 8,
  });
  const e2 = squarePoint(4, 1);
  const e4 = squarePoint(4, 3);
  await page.mouse.move(e2.x, e2.y);
  await page.mouse.down();
  await page.mouse.move(e4.x, e4.y, { steps: 6 });
  await page.mouse.up();
  const movedLine = await page
    .waitForFunction(
      () => /(^|\s)1\.\s*e4(\s|$)/.test(document.querySelector('#analysis-moves')?.textContent ?? ''),
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false);
  check('analysis board accepts a free move and records the line', movedLine);
  const reanalysed = await page
    .waitForFunction(
      () => /d(\d+)/.test(document.querySelector('#analysis-depth')?.textContent ?? ''),
      { timeout: 30000 },
    )
    .then(() => true)
    .catch(() => false);
  check('the new position is analysed automatically', reanalysed);

  // Sign convention (owner report): the displayed score is from White's side,
  // so a Black-to-move position where Black is winning must read negative and
  // fill the bar for Black, and vice versa. This is the exact inconsistency
  // that was reported.
  const openCustom = async (fen) => {
    await page.evaluate((f) => {
      window.location.hash = `#/analysis?fen=${encodeURIComponent(f)}`;
    }, fen);
    await page.waitForSelector('#analysis-eval-bar', { timeout: 15000 });
  };
  const readSigned = async (kind) =>
    page
      .waitForFunction(
        (want) => {
          const score = document.querySelector('#analysis-score')?.textContent ?? '';
          const depth = document.querySelector('#analysis-depth')?.textContent ?? '';
          const looksRight =
            want === 'negative'
              ? /^[−-]/.test(score)
              : /^[+#]/.test(score);
          return looksRight && /d\d+/.test(depth) ? score : false;
        },
        { timeout: 40000 },
        kind,
      )
      .then((handle) => handle.jsonValue())
      .catch(() => '');

  await openCustom('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR b KQkq - 0 1'); // Black to move, up a queen
  const blackScore = await readSigned('negative');
  const blackFill = Number(/--analysis-fill:([\d.]+)%/.exec(await page.$eval('#analysis-eval-bar', (el) => el.getAttribute('style') ?? ''))?.[1] ?? 50);
  check(
    'a Black-winning position shows a negative (White-POV) score and a Black bar',
    blackScore.startsWith('−') || blackScore.startsWith('-'),
    `${blackScore} / ${blackFill}%`,
  );
  check('the bar agrees with the negative score', blackFill < 40, `${blackFill}% white`);

  await openCustom('rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'); // White to move, up a queen
  const whiteScore = await readSigned('positive');
  const whiteFill = Number(/--analysis-fill:([\d.]+)%/.exec(await page.$eval('#analysis-eval-bar', (el) => el.getAttribute('style') ?? ''))?.[1] ?? 50);
  check(
    'a White-winning position shows a positive/mate score and a White bar',
    whiteScore.startsWith('+') || whiteScore.startsWith('#'),
    `${whiteScore} / ${whiteFill}%`,
  );
  check('the bar agrees with the positive score', whiteFill > 60, `${whiteFill}% white`);

  // Put the app back on the trainer: the offline block below reloads and expects
  // `#board`, and the hash (not the router) is what survives a reload.
  await hash(page, 'train/session');
  await page.waitForSelector('#board', { timeout: 10000 });

  // --- AN-001b: the vendored engine really runs in this app's browser ---------
  // Proves the risky part: the lite-single wasm loads from `/engine/` with no
  // COOP/COEP headers and answers UCI, in the same serving path the phone uses.
  const engineRun = await page.evaluate(async () => {
    const lines = [];
    const worker = new Worker('/engine/stockfish-19-lite-single.js');
    worker.addEventListener('message', (event) => {
      if (typeof event.data === 'string') lines.push(event.data);
    });
    const waitFor = (predicate, timeoutMs) =>
      new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (lines.some(predicate) || Date.now() - started > timeoutMs) {
            clearInterval(timer);
            resolve(lines.some(predicate));
          }
        }, 25);
      });
    try {
      worker.postMessage('uci');
      const identified = await waitFor((line) => line.startsWith('uciok'), 30000);
      const name = lines.find((line) => line.startsWith('id name')) ?? '';
      if (!identified) return { identified, name, best: '', error: 'no uciok' };
      worker.postMessage('position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
      worker.postMessage('go nodes 20000');
      await waitFor((line) => line.startsWith('bestmove'), 30000);
      const best = lines.find((line) => line.startsWith('bestmove')) ?? '';
      return { identified, name, best };
    } catch (error) {
      return { identified: false, name: '', best: '', error: String(error) };
    } finally {
      worker.terminate();
    }
  });
  check(
    'Stockfish (lite-single wasm) loads from /engine and returns a best move',
    engineRun.identified === true && /^bestmove [a-h][1-8][a-h][1-8]/.test(engineRun.best),
    JSON.stringify(engineRun),
  );

  // REL-001: versioned-cache discipline — activate must leave exactly one
  // chessengram-shell-* cache so a version bump can never strand a stale shell.
  const shellCaches = await page.evaluate(async () =>
    (await caches.keys()).filter((k) => k.startsWith('chessengram-shell-')));
  check(
    'single versioned shell cache (no stale shell)',
    shellCaches.length === 1 && /^chessengram-shell-v\d+$/.test(shellCaches[0] ?? ''),
    shellCaches.join(', ') || 'none',
  );
  const shellCacheName = shellCaches[0];
  const cacheKeys = await page.evaluate(async (name) => {
    const c = await caches.open(name);
    return (await c.keys()).map((k) => k.url.replace(location.origin, ''));
  }, shellCacheName);
  check('page controlled by service worker', controlled);
  check(
    'service worker cache holds the shell and hashed bundle',
    cacheKeys.includes('/index.html') && cacheKeys.some((k) => k.startsWith('/assets/')),
    `${cacheKeys.length} keys`,
  );
  // APP-001: a real offline install needs the bundled puzzle content cached too.
  check(
    'service worker precaches the bundled puzzles for offline play',
    cacheKeys.includes('/data/puzzles/lichess-900-1099-v1/pack.jsonl')
      && cacheKeys.includes('/data/puzzles/lichess-bands-v1/pack.jsonl')
      && cacheKeys.includes('/data/puzzles/lichess-bands-v1/bands.json')
      && cacheKeys.includes('/icons/maskable-512.png')
      && cacheKeys.includes('/manifest.webmanifest'),
    JSON.stringify(cacheKeys.filter((k) => k.startsWith('/data/'))),
  );
  await page.setOfflineMode(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('#board', { timeout: 10000 });
    check('app boots offline from the service worker', await page.$('#puzzle-id').then(Boolean));
  } finally {
    await page.setOfflineMode(false);
  }

  // --- REL-001: a new deploy activates and drops the old shell cache ----------
  // Simulate the next release the way it really happens: bump the served
  // worker's CACHE_VERSION and change the shell, then let the running page pick
  // it up. This exercises the old-worker -> new-worker handover headlessly
  // (previously real-device only), and proves a bump replaces the stale shell.
  const swPath = join(root, 'dist', 'sw.js');
  const indexPath = join(root, 'dist', 'index.html');
  if (!existsSync(swPath) || !existsSync(indexPath)) {
    check('a new deploy activates and replaces the stale shell', false, 'dist/sw.js or dist/index.html missing');
  } else {
    const originalSw = readFileSync(swPath, 'utf8');
    const originalIndex = readFileSync(indexPath, 'utf8');
    try {
      // Bump whatever version is currently served, so this test does not need
      // updating every time the cache version changes.
      const match = /chessengram-shell-v(\d+)/.exec(originalSw);
      if (!match) throw new Error('CACHE_VERSION not found in dist/sw.js');
      const nextVersion = `chessengram-shell-v${Number(match[1]) + 1}`;
      writeFileSync(swPath, `${originalSw.replace(match[0], nextVersion)}\n// REL-001 smoke marker\n`);
      writeFileSync(indexPath, originalIndex.replace('</body>', '<!-- rel-001-new-bundle -->\n</body>'));
      const handover = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) return 'no-registration';
        const changed = new Promise((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve('controllerchange'), { once: true });
          setTimeout(() => resolve('timeout'), 10000);
        });
        await registration.update();
        return changed;
      });
      check('a new deploy takes over the open page', handover === 'controllerchange', handover);
      await page.reload({ waitUntil: 'networkidle0', timeout: 20000 });
      await page.waitForSelector('#board', { timeout: 10000 });
      const afterKeys = await page.evaluate(async () =>
        (await caches.keys()).filter((k) => k.startsWith('chessengram-shell-')));
      check(
        'the version bump replaced the old shell cache (no stale shell)',
        afterKeys.length === 1 && afterKeys[0] === nextVersion,
        `${afterKeys.join(', ') || 'none'} (expected ${nextVersion})`,
      );
      const servedNewBundle = await page.evaluate(() => document.documentElement.outerHTML.includes('rel-001-new-bundle'));
      check('the updated shell serves the new bundle', servedNewBundle);
    } finally {
      writeFileSync(swPath, originalSw);
      writeFileSync(indexPath, originalIndex);
    }
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
