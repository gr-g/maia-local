// Endgame Training — play vs Maia with a tablebase-perfect opponent.
//
// URL params:
//   ?player=white|black&startFen=FEN&target=checkmate|draw
//
// Game loop:
//   1. user moves
//   2. check local user-win conditions (mate / trivial endgame / stalemate / 3fr / 50-move / insufficient material)
//   3. tablebase query on post-user-move FEN
//   4. fail check from root category
//   5. animate opponent's move (picked from tablebase best-category subset ∩ Maia policy)
//   6. loop

import { Chessground } from 'https://esm.sh/chessground@9';
import { Chess }       from 'https://esm.sh/chess.js@1.0.0-beta.8';
import { MaiaEngine, loadVocab, restrictPolicy, samplePolicy } from './engine.js';
import { queryTablebase, classifyMoves, rootOutcome } from './tablebase.js';

const $ = id => document.getElementById(id);
const MAIA_ELO = 2000;
const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ── URL params ───────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const playerColor = (params.get('player') || 'white').toLowerCase() === 'black' ? 'black' : 'white';
const startFen    = (params.get('startFen') || '').trim() || STARTPOS;
const target      = (params.get('target') || 'checkmate').toLowerCase() === 'draw' ? 'draw' : 'checkmate';

$('tag-player').textContent = `Player: ${playerColor}`;
$('tag-target').textContent = `Target: ${target}`;
$('parsed-params').textContent = `player=${playerColor}, target=${target}, startFen=${startFen}`;

// ── State ────────────────────────────────────────────────────────────────────
let chess = new Chess();
let ground = null;
let gameOver = false;
let oppoThinking = false;

// ── Helpers ──────────────────────────────────────────────────────────────────
const turnColor = c => c.turn() === 'w' ? 'white' : 'black';
const userIsWhite = () => playerColor === 'white';
const userColor = () => playerColor;
const userTurn = () => turnColor(chess) === userColor();

function legalDests(c) {
  const d = new Map();
  const board = c.board();
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = board[r][f];
    if (!p || p.color !== c.turn()) continue;
    const ms = c.moves({ square: p.square, verbose: true });
    if (ms.length) d.set(p.square, ms.map(m => m.to));
  }
  return d;
}

function setMovableOnlyForUser() {
  if (gameOver || !userTurn() || oppoThinking) {
    ground.set({ movable: { color: undefined, dests: new Map() } });
  } else {
    ground.set({ movable: { color: userColor(), dests: legalDests(chess) } });
  }
}

function syncBoard() {
  ground.set({
    fen: chess.fen(),
    turnColor: turnColor(chess),
    check: chess.inCheck(),
  });
  setMovableOnlyForUser();
  updateTurnIndicator();
  updateLichessLink();
}

function updateTurnIndicator() {
  if (gameOver) { $('turn-indicator').textContent = 'Game over'; return; }
  if (oppoThinking) { $('turn-indicator').textContent = 'Opponent thinking…'; return; }
  $('turn-indicator').textContent = userTurn() ? 'Your move' : "Opponent's move";
}

function updateLichessLink() {
  const fen = chess.fen().replace(/ /g, '_');
  $('lichess-analysis').href = `https://lichess.org/analysis/standard/${fen}`;
}

// ── Material-based trivial-endgame detection (for target=checkmate user-win) ─
function pieceCounts(fen) {
  const pos = fen.split(' ')[0];
  const c = { P:0,N:0,B:0,R:0,Q:0,K:0, p:0,n:0,b:0,r:0,q:0,k:0 };
  for (const ch of pos) if (c[ch] !== undefined) c[ch]++;
  return c;
}
function isTrivialEndgameFor(userIsWhiteSide, fen) {
  const c = pieceCounts(fen);
  // Both sides have exactly 1 king
  if (c.K !== 1 || c.k !== 1) return false;
  // Opponent must have nothing except the king.
  const oppoHasAnything = userIsWhiteSide
    ? (c.q || c.r || c.b || c.n || c.p)
    : (c.Q || c.R || c.B || c.N || c.P);
  if (oppoHasAnything) return false;
  // User must have at least one Queen or Rook (may also have other pieces).
  const userHasMajor = userIsWhiteSide ? (c.Q >= 1 || c.R >= 1) : (c.q >= 1 || c.r >= 1);
  return userHasMajor;
}

// ── Local user-win / draw detection (no tablebase needed) ────────────────────
function checkUserWin() {
  const fen = chess.fen();
  const halfMove = parseInt(fen.split(' ')[4] || '0');
  if (target === 'checkmate') {
    if (chess.isCheckmate()) {
      // It's whoever-just-moved who delivered mate. If the person now to move
      // is NOT the user, then the user just delivered mate.
      if (!userTurn()) return { outcome: 'win', reason: 'Checkmate!' };
      return { outcome: 'fail', reason: 'You were checkmated.' };
    }
    // Only check trivial-endgame conversion AFTER the opponent moves (i.e. when
    // it's the user's turn again), so the opponent has had a chance to capture a
    // hanging major piece.
    if (userTurn() && isTrivialEndgameFor(userIsWhite(), fen)) {
      return { outcome: 'win', reason: 'Converted to a winning endgame.' };
    }
    // Local draw checks are failures for the checkmate target
    if (chess.isStalemate())           return { outcome: 'fail', reason: 'Stalemate.' };
    if (chess.isInsufficientMaterial())return { outcome: 'fail', reason: 'Insufficient material.' };
    if (chess.isThreefoldRepetition()) return { outcome: 'fail', reason: 'Threefold repetition.' };
    if (halfMove >= 100)               return { outcome: 'fail', reason: '50-move rule.' };
  } else { // target === 'draw'
    if (chess.isCheckmate()) {
      if (!userTurn()) return { outcome: 'fail', reason: 'You delivered checkmate — not a draw.' };
      return { outcome: 'fail', reason: 'You were checkmated.' };
    }
    if (chess.isStalemate())           return { outcome: 'win', reason: 'Stalemate.' };
    if (chess.isInsufficientMaterial())return { outcome: 'win', reason: 'Insufficient material.' };
    if (chess.isThreefoldRepetition()) return { outcome: 'win', reason: 'Threefold repetition.' };
    if (halfMove >= 100)               return { outcome: 'win', reason: '50-move rule.' };
  }
  return null;
}

// ── UI: result banner + move log ─────────────────────────────────────────────
function showResult(kind, text) {
  const el = $('result');
  el.style.display = 'block';
  el.className = 'result-overlay ' + (kind === 'win' ? 'result-win' : kind === 'fail' ? 'result-fail' : 'result-warn');
  el.textContent = text;
}
function hideResult() { $('result').style.display = 'none'; }

const moveHistorySan = [];
function logMove(san, by) {
  moveHistorySan.push({ san, by });
  const log = $('move-log');
  log.innerHTML = '';
  for (let i = 0; i < moveHistorySan.length; i += 2) {
    const pair = document.createElement('div');
    pair.className = 'pair';
    const num = Math.floor(i/2) + 1;
    const a = moveHistorySan[i];
    const b = moveHistorySan[i+1];
    pair.innerHTML = `<span class="num">${num}.</span><span>${a.san}</span>${b ? `<span>${b.san}</span>` : ''}`;
    log.appendChild(pair);
  }
  log.scrollTop = log.scrollHeight;
}

// ── Engine + vocab init ──────────────────────────────────────────────────────
await loadVocab();
const engine = new MaiaEngine();
engine.addEventListener('status', e => {
  $('status').textContent = e.detail;
  $('status').className = 'pill ' + e.detail;
  // When model is ready and it's the opponent's move at start, kick off opponent turn
  if (e.detail === 'ready' && !userTurn() && !gameOver) scheduleOpponentMove();
});
engine.addEventListener('progress', e => { $('progress').value = e.detail; });
engine.addEventListener('error', e => { $('maia-info').textContent = 'Worker error: ' + e.detail; });

$('download').onclick = async () => {
  try { await engine.download(); await refreshStorageInfo(); }
  catch (err) { $('maia-info').textContent = 'Download failed: ' + err.message; }
};
async function refreshStorageInfo() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) $('storage-info').textContent =
      `IndexedDB usage: ${(est.usage/1e6).toFixed(1)} MB of ${(est.quota/1e6).toFixed(0)} MB quota`;
  } catch {}
}
refreshStorageInfo();

// ── Ground + initial position ────────────────────────────────────────────────
try { chess.load(startFen); }
catch (err) {
  showResult('fail', `Invalid startFen: ${err.message}`);
  // Fall back to startpos so user sees something
  chess = new Chess();
}

ground = Chessground($('board'), {
  fen: chess.fen(),
  orientation: playerColor,
  turnColor: turnColor(chess),
  movable: {
    free: false,
    color: userColor(),
    dests: legalDests(chess),
    events: { after: onUserMove },
  },
  draggable: { showGhost: true },
  highlight: { lastMove: true, check: true },
  animation: { duration: 200 },
  drawable: { enabled: true },
});
syncBoard();

// ── User move handling ──────────────────────────────────────────────────────
async function onUserMove(orig, dest) {
  if (gameOver) return;
  const mv = chess.move({ from: orig, to: dest, promotion: 'q' });
  if (!mv) { syncBoard(); return; }
  logMove(mv.san, 'user');
  syncBoard();

  // 1. Local user-win check
  const localOutcome = checkUserWin();
  if (localOutcome) {
    endGame(localOutcome.outcome, localOutcome.reason);
    return;
  }

  // 2. Opponent's turn
  scheduleOpponentMove();
}

function scheduleOpponentMove() {
  if (gameOver || userTurn()) return;
  oppoThinking = true;
  setMovableOnlyForUser();
  updateTurnIndicator();
  // Defer to next tick so UI updates first
  setTimeout(doOpponentMove, 50);
}

async function doOpponentMove() {
  try {
    // Wait for engine ready, or fallback to random legal if it never comes
    if (!engine.ready) {
      $('maia-info').textContent = 'Waiting for Maia model… click "Download / load model" if idle.';
      oppoThinking = false; updateTurnIndicator();
      return;
    }

    const fen = chess.fen();

    // Parallel: tablebase query and Maia inference
    const tbP    = queryTablebase(fen).catch(err => ({ __err: err }));
    const maiaP  = engine.infer(fen, MAIA_ELO, MAIA_ELO);
    const [tb, maia] = await Promise.all([tbP, maiaP]);

    let classification = { bestMoves: [], bestCategory: null, allMoves: [] };
    let tbError = null;
    if (tb && !tb.__err) {
      classification = classifyMoves(tb);
      const oppOutcome = rootOutcome(tb); // from opp POV (since opp is STM)
      $('tb-info').textContent = `Tablebase: opponent-to-move outcome = ${oppOutcome}, best-move category = ${classification.bestCategory || 'n/a'}, ${classification.allMoves.length} legal moves covered.`;

      // Fail check from Q.category (opponent POV). User's POV is inverted:
      //   opp=win  → user is losing     → fail always
      //   opp=draw → user is drawing    → fail only if target=checkmate
      //   opp=loss → user is winning    → no fail
      let userFail = null;
      if (oppOutcome === 'win')  userFail = 'You are in a losing position.';
      else if (oppOutcome === 'draw' && target === 'checkmate') userFail = 'Opponent can force a draw — no checkmate possible from here.';
      if (userFail) {
        // Animate opponent's move before showing fail overlay
        const oppMoveUci = await pickOpponentMove(classification, maia);
        if (oppMoveUci) applyOpponentMove(oppMoveUci);
        endGame('fail', userFail);
        return;
      }
    } else {
      tbError = tb?.__err?.message || 'outside 7-piece coverage';
      $('tb-info').textContent = `Tablebase unavailable (${tbError}); opponent falls back to plain Maia sampling, fail detection disabled.`;
    }

    // Pick opponent's move
    const oppMoveUci = await pickOpponentMove(classification, maia);
    if (!oppMoveUci) { endGame('warn', 'Opponent has no legal moves — unusual position.'); return; }
    applyOpponentMove(oppMoveUci);

    // After opponent moves, check local user conditions that can fire on opp turn (e.g. opp stalemates user-target-draw)
    const post = checkUserWin();
    if (post) { endGame(post.outcome, post.reason); return; }
  } catch (err) {
    $('maia-info').textContent = 'Opponent-move error: ' + err.message;
  } finally {
    oppoThinking = false;
    updateTurnIndicator();
    setMovableOnlyForUser();
  }
}

async function pickOpponentMove(classification, maia) {
  const legal = chess.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
  if (!legal.length) return null;

  const subset = (classification.bestMoves && classification.bestMoves.length) ? classification.bestMoves : legal;
  // Restrict Maia policy to subset and sample
  const restricted = restrictPolicy(maia.policy, subset);
  const picked = samplePolicy(restricted);
  if (picked && legal.includes(picked)) {
    // Show top-5 from restricted policy for transparency
    const top = Object.entries(restricted).sort((a,b) => b[1]-a[1]).slice(0,5)
      .map(([m,p]) => `${m} ${(p*100).toFixed(1)}%`).join(' · ');
    $('maia-info').textContent = `Maia restricted to ${subset.length} ${classification.bestCategory || 'legal'} move(s): ${top}`;
    return picked;
  }
  // Fallback: uniform-random over legal
  return legal[Math.floor(Math.random() * legal.length)];
}

function applyOpponentMove(uci) {
  const promo = uci.length > 4 ? uci[4] : undefined;
  const mv = chess.move({ from: uci.slice(0,2), to: uci.slice(2,4), promotion: promo });
  if (mv) { logMove(mv.san, 'opp'); syncBoard(); }
  else    { console.warn('Opponent returned illegal move?', uci); }
}

function endGame(kind, reason) {
  gameOver = true;
  setMovableOnlyForUser();
  updateTurnIndicator();
  const prefix = kind === 'win' ? '✓ Success!' : kind === 'fail' ? '✗ Failed.' : '⚠';
  showResult(kind, `${prefix} ${reason}`);
}

// ── Controls ────────────────────────────────────────────────────────────────
$('retry').onclick = () => {
  chess = new Chess();
  try { chess.load(startFen); } catch { /* invalid start already warned */ }
  moveHistorySan.length = 0;
  $('move-log').innerHTML = '';
  $('tb-info').textContent = '–';
  $('maia-info').textContent = '';
  gameOver = false;
  hideResult();
  ground.set({ fen: chess.fen(), turnColor: turnColor(chess), lastMove: undefined });
  syncBoard();
  // If the start position has the opponent to move, schedule their move
  if (!userTurn() && engine.ready) scheduleOpponentMove();
};
$('flip').onclick = () => ground.toggleOrientation();

// If startFen has opponent to move and engine is already ready when load settles:
if (!userTurn() && engine.ready) scheduleOpponentMove();
