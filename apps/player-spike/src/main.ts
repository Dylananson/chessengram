import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import { parseUci } from 'chessops/util';
import type { NormalizedPuzzle } from './types.js';
import { gradeMove, createInitialGradingState, type GradingState } from './grading.js';
import { TrainingAdapter } from './training-adapter.js';

let ground: Api;
let puzzle: NormalizedPuzzle | null = null;
let gradingState: GradingState = createInitialGradingState();
let trainingAdapter: TrainingAdapter;
let setupPlayed = false;
let puzzleIndex = 0;
let cachedPuzzles: NormalizedPuzzle[] = [];
let attemptStartedAt = 0;
let scoredCommitted = false;

async function init() {
  const boardEl = document.getElementById('board')!;
  ground = Chessground(boardEl, {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    orientation: 'white',
    coordinates: true,
    movable: {
      free: false,
      color: 'both',
      showDests: true,
    },
  });

  trainingAdapter = new TrainingAdapter();
  await trainingAdapter.startSession();

  const nextBtn = document.getElementById('next-btn') as HTMLButtonElement;
  nextBtn.addEventListener('click', loadNextPuzzle);

  await loadNextPuzzle();
}

async function loadNextPuzzle() {
  if (cachedPuzzles.length === 0) {
    cachedPuzzles = await loadPuzzlesFromPublic();
  }
  puzzle = cachedPuzzles[puzzleIndex % cachedPuzzles.length];
  puzzleIndex++;

  await trainingAdapter.startAttempt(puzzle);

  gradingState = createInitialGradingState();
  setupPlayed = false;
  scoredCommitted = false;
  attemptStartedAt = Date.now();

  document.getElementById('puzzle-id')!.textContent = `ID: ${puzzle.id}`;
  document.getElementById('rating')!.textContent = `Rating: ${puzzle.rating}`;
  document.getElementById('themes')!.textContent = `Themes: ${puzzle.themes.slice(0, 4).join(', ')}`;
  document.getElementById('solver-color')!.textContent = `Solver: ${puzzle.solverColor}`;
  document.getElementById('solution')!.textContent = puzzle.solution.join(' ');
  updateStatus('Playing setup...');

  setupBoardAndInitialize();
}

async function loadPuzzlesFromPublic(): Promise<NormalizedPuzzle[]> {
  const response = await fetch('/data/puzzles/lichess-900-1099-v1/pack.jsonl');
  const text = await response.text();
  const lines = text.trim().split('\n');
  const puzzles: NormalizedPuzzle[] = [];
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    try {
      puzzles.push(JSON.parse(lines[i]));
    } catch (e) {
      console.warn(e);
    }
  }
  return puzzles;
}

function setupBoardAndInitialize() {
  if (!puzzle) return;

  if (puzzle.setupMove && !setupPlayed) {
    setupPlayed = true;
    ground.set({ fen: puzzle.sourceFen });
    const setupUci = puzzle.setupMove;
    const moveObj = parseUci(setupUci);
    if (moveObj && 'from' in moveObj && 'to' in moveObj) {
      (ground as any).move(moveObj.from, moveObj.to);
      setTimeout(() => {
        ground.set({
          fen: puzzle!.solverFen,
          orientation: puzzle!.solverColor === 'white' ? 'white' : 'black',
          movable: {
            free: false,
            color: puzzle!.solverColor === 'white' ? 'white' : 'black',
            showDests: true,
          },
        });
        updateStatus(`Your turn (${puzzle!.solverColor}) - solve the puzzle`);
        (ground as any).set({ events: { move: onUserMove } });
      }, 500);
    } else {
      ground.set({
        fen: puzzle.solverFen,
        orientation: puzzle.solverColor === 'white' ? 'white' : 'black',
        movable: {
          free: false,
          color: puzzle.solverColor === 'white' ? 'white' : 'black',
          showDests: true,
        },
      });
      updateStatus(`Your turn (${puzzle.solverColor})`);
      (ground as any).set({ events: { move: onUserMove } });
    }
  } else {
    ground.set({
      fen: puzzle.solverFen,
      orientation: puzzle.solverColor === 'white' ? 'white' : 'black',
      movable: {
        free: false,
        color: puzzle.solverColor === 'white' ? 'white' : 'black',
        showDests: true,
      },
    });
    updateStatus(`Your turn (${puzzle.solverColor})`);
    (ground as any).set({ events: { move: onUserMove } });
  }
}

function elapsedSeconds(): number {
  return Math.max(0, Math.round((Date.now() - attemptStartedAt) / 1000));
}

async function onUserMove(from: any, to: any, promotion?: any) {
  if (!puzzle) return;

  const uci = from + to + (promotion || '');
  await trainingAdapter.recordMove(uci);

  const wasFailed = gradingState.failed;
  const result = gradeMove(puzzle, gradingState, uci);
  gradingState = result.state;

  if (result.verdict === 'wrong') {
    await trainingAdapter.recordWrongMove(uci);
    if (!wasFailed && !scoredCommitted) {
      scoredCommitted = true;
      await trainingAdapter.commitFailure(puzzle, elapsedSeconds());
    }
    updateStatus('Wrong move - but keep solving the same puzzle', 'wrong');
    (ground as any).undo();
    return;
  } else if (result.verdict === 'correct') {
    if (gradingState.completed) {
      await completePuzzle();
    } else {
      updateStatus('Correct! Keep going...', 'correct');
      playOpponentMove();
    }
  }
}

async function completePuzzle() {
  if (!puzzle) return;
  if (gradingState.failed) {
    await trainingAdapter.finishCorrection(elapsedSeconds());
  } else if (!scoredCommitted) {
    scoredCommitted = true;
    await trainingAdapter.commitSuccess(puzzle, elapsedSeconds());
  }
  updateStatus(
    gradingState.failed ? 'Solved after a mistake (correction complete)' : 'Puzzle completed!',
    'completed'
  );
  (document.getElementById('next-btn') as HTMLButtonElement).disabled = false;
  ground.set({ movable: { color: undefined } });
}

function playOpponentMove() {
  if (!puzzle || gradingState.solutionIndex >= puzzle.solution.length) {
    return;
  }
  const oppMoveUci = puzzle.solution[gradingState.solutionIndex];
  gradingState.solutionIndex++;
  const moveObj = parseUci(oppMoveUci);
  if (moveObj && 'from' in moveObj && 'to' in moveObj) {
    setTimeout(() => {
      (ground as any).move(moveObj.from, moveObj.to);
      if (gradingState.solutionIndex >= puzzle!.solution.length) {
        void completePuzzle();
      }
    }, 300);
  }
}

function updateStatus(text: string, className?: string) {
  const statusEl = document.getElementById('status')!;
  statusEl.textContent = text;
  statusEl.className = 'status';
  if (className) {
    statusEl.classList.add(className);
  }
  if (gradingState.failed && !gradingState.completed) {
    statusEl.classList.add('failed-but-solving');
  }
}

init();
