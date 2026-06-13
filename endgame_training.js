// Endgame Training — play vs Maia with a tablebase-perfect opponent.
//
// URL params:
//   ?player=white|black&startFen=FEN&objective=checkmate|draw
//
// Game loop:
//   1. user moves
//   2. check local user-success conditions (mate / trivial endgame / stalemate / 3fr / 50-move / insufficient material)
//   3. tablebase query on post-user-move FEN
//   4. fail check from root category
//   5. animate opponent's move (picked from tablebase best-category subset ∩ Maia policy)
//   6. loop

import { Chessground } from 'https://esm.sh/chessground@9';
import { Chess }       from 'https://esm.sh/chess.js@1.4';
import { MaiaEngine, loadVocab, restrictPolicy, samplePolicy } from './engine.js';
import { queryTablebase, classifyMoves, rootOutcome } from './tablebase.js';
import { askPromotion } from './promotion.js';

const $ = id => document.getElementById(id);
const MAIA_ELO = 2000;
const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ── State ────────────────────────────────────────────────────────────────────
let playerColor, startFen, objective;
let chess = new Chess();
let ground = null;
let gameOver = false;
let oppoThinking = false;
const moveHistorySan = [];

// ── Helpers ──────────────────────────────────────────────────────────────────
const turnColor = c => c.turn() === 'w' ? 'white' : 'black';
const userIsWhite = () => playerColor === 'white';
const userColor = () => playerColor;
const userTurn = () => turnColor(chess) === userColor();

function parseParams() {
  const params = new URLSearchParams(location.search);
  playerColor = (params.get('player') || 'white').toLowerCase() === 'black' ? 'black' : 'white';
  startFen    = (params.get('startFen') || '').trim();
  objective   = (params.get('objective') || '').toLowerCase() === 'draw' ? 'draw' : 'checkmate';
}

function updateTags() {
  $('tag-player').textContent = `Player: ${playerColor}`;
  $('tag-objective').textContent = `Objective: ${objective}`;
}

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
  const hist = chess.history({ verbose: true });
  const lastMove = hist.length > 0 ? [hist[hist.length - 1].from, hist[hist.length - 1].to] : undefined;
  ground.set({
    fen: chess.fen(),
    turnColor: turnColor(chess),
    check: chess.inCheck(),
    lastMove: lastMove
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
  let pgn = `[FEN "${startFen}"]\n\n`;

  moveHistorySan.forEach((m, _) => {
    pgn += ` ${m.san}`;
  });

  const encodedPgn = encodeURIComponent(pgn);
  $('lichess-analysis').href = `https://lichess.org/analysis/pgn/${encodedPgn}`;
}

// ── Material-based trivial-endgame detection (for objective=checkmate user-success) ─
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

// ── Local user-success / draw detection (no tablebase needed) ────────────────────
function checkUserWin() {
  const fen = chess.fen();
  const halfMove = parseInt(fen.split(' ')[4] || '0');
  if (chess.isCheckmate()) {
    // It's whoever-just-moved who delivered mate. If the person now to move
    // is NOT the user, then the user just delivered mate.
    if (!userTurn()) return { outcome: 'success', reason: 'Checkmate.' };
    return { outcome: 'fail', reason: 'You were checkmated.' };
  }
  if (objective === 'checkmate') {
    // Only check trivial-endgame conversion AFTER the opponent moves (i.e. when
    // it's the user's turn again), so the opponent has had a chance to capture a
    // hanging major piece.
    if (userTurn() && isTrivialEndgameFor(userIsWhite(), fen)) {
      return { outcome: 'success', reason: 'Converted to a winning endgame.' };
    }
    // Local draw checks are failures for the checkmate objective
    if (chess.isStalemate())           return { outcome: 'fail', reason: 'Stalemate.' };
    if (chess.isInsufficientMaterial())return { outcome: 'fail', reason: 'Insufficient material.' };
    if (chess.isThreefoldRepetition()) return { outcome: 'fail', reason: 'Threefold repetition.' };
    if (chess.isDrawByFiftyMoves())    return { outcome: 'fail', reason: '50 moves.' };
  } else { // objective === 'draw'
    if (chess.isStalemate())           return { outcome: 'success', reason: 'Stalemate.' };
    if (chess.isInsufficientMaterial())return { outcome: 'success', reason: 'Insufficient material.' };
    if (chess.isThreefoldRepetition()) return { outcome: 'success', reason: 'Threefold repetition.' };
    if (chess.isDrawByFiftyMoves())    return { outcome: 'success', reason: '50 moves.' };
  }
  return null;
}

// ── UI: result banner + move log ─────────────────────────────────────────────
function showResult(kind, text) {
  const el = $('result');
  el.style.display = 'block';
  el.className = 'result-overlay ' + (kind === 'success' ? 'result-success' : kind === 'fail' ? 'result-fail' : 'result-warn');
  const prefix = kind === 'success' ? '✓ Success!' : kind === 'fail' ? '✗ Failed.' : '⚠';
  el.textContent = `${prefix} ${text}`;
}
function hideResult() { $('result').style.display = 'none'; }

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
  $('download').disabled = e.detail !== 'no-cache';
  // When model is ready and it's the opponent's move at start, kick off opponent turn
  if (e.detail === 'ready' && !userTurn() && !gameOver) scheduleOpponentMove();
});
engine.addEventListener('progress', e => { $('progress').value = e.detail; });
engine.addEventListener('error', e => { $('maia-info').textContent = 'Worker error: ' + e.detail; });

$('download').onclick = async () => {
  try { await engine.download(); await refreshStorageInfo(); if (!userTurn() && !gameOver) scheduleOpponentMove(); }
  catch (err) { $('maia-info').textContent = 'Download failed: ' + err.message; }
};

async function clearCache() {
  await engine.clearCache();
  $('maia-info').textContent = 'Cache cleared. Reload page to re-init.';
  await refreshStorageInfo();
}
$('clear-cache').onclick = clearCache;

async function refreshStorageInfo() {
  try {
    $('clear-cache').disabled = await engine.isCacheEmpty();
    const est = await navigator.storage?.estimate?.();
    if (est) $('storage-info').textContent =
      `IndexedDB usage: ${(est.usage/1e6).toFixed(1)} MB of ${(est.quota/1e6).toFixed(0)} MB quota`;
  } catch {}
}
refreshStorageInfo();

// ── Game lifecycle ───────────────────────────────────────────────────────────
function resetGame() {
  chess = new Chess();
  try { chess.load(startFen); } catch (err) {
    showResult('warn', `${err.message}`);
    chess = new Chess();
  }

  moveHistorySan.length = 0;
  $('move-log').innerHTML = '';
  $('tb-info').textContent = '–';
  $('maia-info').textContent = '';
  gameOver = false;
  hideResult();

  if (ground) {
    ground.set({
      fen: chess.fen(),
      orientation: playerColor,
      turnColor: turnColor(chess),
      lastMove: undefined
    });
  }
  syncBoard();
  // If the start position has the opponent to move, schedule their move
  if (!userTurn() && engine.ready) scheduleOpponentMove();
}

async function pickRandomEndgame(updateUrl = true) {
  try {
    const resp = await fetch('endgames.csv');
    const text = await resp.text();
    const lines = text.trim().split('\n').slice(1); // skip header
    if (lines.length === 0) return;
    const randomLine = lines[Math.floor(Math.random() * lines.length)];
    const [fen, obj] = randomLine.split(',');

    const fenParts = fen.split(' ');
    playerColor = fenParts[1] === 'w' ? 'white' : 'black';
    startFen = fen;
    objective = obj;

    if (updateUrl) {
      const url = new URL(window.location);
      url.searchParams.set('startFen', startFen);
      url.searchParams.set('objective', objective);
      url.searchParams.set('player', playerColor);
      window.history.pushState({}, '', url);
    }

    updateTags();
    resetGame();
  } catch (err) {
    console.error('Failed to load endgames:', err);
  }
}

// ── User move handling ──────────────────────────────────────────────────────
async function onUserMove(orig, dest) {
  if (gameOver) return;
  const piece = chess.get(orig);
  const isPromo = piece && piece.type === 'p' &&
                  ((piece.color === 'w' && dest[1] === '8') ||
                   (piece.color === 'b' && dest[1] === '1'));

  let promo = 'q';
  if (isPromo) {
    // Freeze the board while the overlay is up.
    ground.set({ movable: { color: undefined, dests: new Map() } });
    promo = await askPromotion($('board').parentElement, dest, piece.color, ground.state.orientation);
    if (!promo) { syncBoard(); return; }
  }

  const mv = chess.move({ from: orig, to: dest, promotion: promo });
  if (!mv) { syncBoard(); return; }
  logMove(mv.san, 'user');
  syncBoard();

  // 1. Local user-success check
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
      $('maia-info').textContent = 'Waiting for Maia model… click "Download model" if idle.';
      oppoThinking = false; updateTurnIndicator();
      return;
    }

    const fen = chess.fen();

    // Parallel: tablebase query and Maia inference
    const tbStart = performance.now();
    const tbP    = queryTablebase(fen)
      .then(res => ({ res, dt: performance.now() - tbStart }))
      .catch(err => ({ __err: err, dt: performance.now() - tbStart }));
    const maiaStart = performance.now();
    const maiaP  = engine.infer(fen, MAIA_ELO, MAIA_ELO)
      .then(res => ({ res, dt: performance.now() - maiaStart }));

    const [tbWrap, maiaWrap] = await Promise.all([tbP, maiaP]);
    const tb = tbWrap.res || { __err: tbWrap.__err };
    const tbDt = tbWrap.dt.toFixed(0);
    const maia = maiaWrap.res;
    const maiaDt = maiaWrap.dt.toFixed(0);

    let classification = { bestMoves: [], summary: null, allMoves: [] };
    let tbError = null;
    if (tb && !tb.__err) {
      classification = classifyMoves(tb);
      const oppOutcome = rootOutcome(tb); // from opp POV (since opp is STM)
      if (classification.summary) {
        $('tb-info').textContent = `Tablebase queried in ${tbDt} ms. Maia has a ${classification.summary} position.`;
      } else {
        $('tb-info').textContent = `Tablebase queried in ${tbDt} ms. No information available.`;
      }

      // Fail check from Q.category (opponent POV). User's POV is inverted:
      //   opp=win  → user is losing     → fail always
      //   opp=draw → user is drawing    → fail only if objective=checkmate
      //   opp=loss → user is winning    → no fail
      let userFail = null;
      if (oppOutcome === 'win')  userFail = 'You are in a losing position.';
      else if (oppOutcome === 'draw' && objective === 'checkmate') userFail = 'Opponent can force a draw.';
      if (userFail) showResult('fail', userFail);
      else hideResult();
    } else {
      tbError = tb?.__err?.message || 'query failed';
      $('tb-info').textContent = `Tablebase unavailable (${tbError}).`;
    }

    // Pick opponent's move
    const oppMoveUci = await pickOpponentMove(classification, maia, maiaDt);
    if (!oppMoveUci) { endGame('warn', 'Opponent has no legal moves — unusual position.'); return; }
    applyOpponentMove(oppMoveUci);

    // After opponent moves, check local user conditions that can fire on opp turn (e.g. opp stalemates user-objective-draw)
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

async function pickOpponentMove(classification, maia, maiaDt) {
  const legal = chess.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || ''));
  if (!legal.length) return null;

  // Restrict Maia policy to best moves (which is all moves when losing)
  const subset = (classification.bestMoves && classification.bestMoves.length)
    ? classification.bestMoves.map(m => m.uci)
    : legal;

  let restricted = restrictPolicy(maia.policy, subset);

  if (classification.summary === 'losing' && classification.bestMoves && classification.bestMoves.length) {
    // Tweak the move selection for losing moves to exclude bad moves (which allow the user
    // to win too quickly) and to boost resilient moves.
    restricted = excludeBadMoves(restricted, classification.bestMoves);
    restricted = boostResilientMoves(restricted, classification.bestMoves, 0.3);
  }

  const r = Math.random();
  const picked = samplePolicy(restricted, r);
  if (picked && legal.includes(picked)) {
    // Show moves from restricted policy for transparency
    const top = Object.entries(restricted)
      .filter(([uci, p]) => p > 0.0001)
      .sort((a,b) => b[1]-a[1])
      .map(([uci,p]) => {
        const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
        const san = move ? move.san : uci;
        if (move) chess.undo();
        return `${san} ${(p*100).toFixed(1)}%`;
      }).join(' · ');
    const activeMovesCount = Object.values(restricted).filter(p => p > 0.0001).length;
    $('maia-info').textContent = `Model inference run in ${maiaDt} ms. Maia chose among ${activeMovesCount} ${classification.summary || 'legal'} move(s): ${top}`;
    //$('maia-info').textContent = `${r} ${top}; ${JSON.stringify(classification.bestMoves)}`;
    return picked;
  }
  // Fallback: uniform-random over legal
  return legal[Math.floor(Math.random() * legal.length)];
}

/**
 * Sets the probability of bad moves (dtz <= maxDtz - 5 && dtm <= maxDtm - 5) to zero
 * and renormalizes the remaining probabilities.
 */
function excludeBadMoves(policy, moves) {
  const maxDtz = Math.max(...moves.map(m => m.dtz));
  const maxDtm = Math.max(...moves.map(m => m.dtm));

  // Good moves are those with dtz > maxDtz - 5 || dtm > maxDtm - 5.
  // Bad moves are the rest.
  const goodUcis = new Set(
    moves.filter(m => m.dtz > maxDtz - 5 || m.dtm > maxDtm - 5).map(m => m.uci)
  );

  const updated = {};
  let sum = 0;

  for (const [uci, prob] of Object.entries(policy)) {
    if (goodUcis.has(uci)) {
      updated[uci] = prob;
      sum += prob;
    } else {
      updated[uci] = 0;
    }
  }

  if (sum === 0) {
    // Fallback: uniform over good moves
    const u = 1 / (goodUcis.size || 1);
    for (const uci of Object.keys(policy)) {
      updated[uci] = goodUcis.has(uci) ? u : 0;
    }
  } else {
    // Renormalize
    for (const uci of Object.keys(updated)) {
      updated[uci] /= sum;
    }
  }

  return updated;
}

/**
 * Ensures that most resilient moves (both dtz=maxDtz and dtm=maxDtm)
 * have an aggregate probability of at least minProb.
 */
function boostResilientMoves(policy, moves, minProb) {
  const maxDtz = Math.max(...moves.map(m => m.dtz));
  const maxDtm = Math.max(...moves.map(m => m.dtm));
  const resilientMoves = moves.filter(m => m.dtz === maxDtz && m.dtm === maxDtm);
  if (resilientMoves.length === 0) {
    return policy;
  }

  const resilientUcis = new Set(resilientMoves.map(m => m.uci));

  // Ensure all resilient moves are in the policy (even if with 0 prob)
  const updated = { ...policy };
  for (const uci of resilientUcis) {
    if (!(uci in updated)) {
      updated[uci] = 0;
    }
  }

  // Calculate current aggregate probability of resilient moves
  let resilientSum = 0;
  let nonResilientSum = 0;
  for (const [uci, prob] of Object.entries(updated)) {
    if (resilientUcis.has(uci)) {
      resilientSum += prob;
    } else {
      nonResilientSum += prob;
    }
  }

  if (resilientSum < minProb) {
    const targetResilientSum = minProb;
    const targetNonResilientSum = 1 - targetResilientSum;

    // Adjust resilient moves
    if (resilientSum === 0) {
      // Distribute targetResilientSum uniformly among resilient moves in policy
      const count = Object.keys(updated).filter(uci => resilientUcis.has(uci)).length;
      if (count > 0) {
        const share = targetResilientSum / count;
        for (const uci of resilientUcis) {
          if (uci in updated) {
            updated[uci] = share;
          }
        }
      }
    } else {
      // Scale existing resilient probabilities
      const scale = targetResilientSum / resilientSum;
      for (const uci of resilientUcis) {
        if (uci in updated) {
          updated[uci] *= scale;
        }
      }
    }

    // Adjust non-resilient moves
    if (nonResilientSum > 0) {
      const scale = targetNonResilientSum / nonResilientSum;
      for (const uci of Object.keys(updated)) {
        if (!resilientUcis.has(uci)) {
          updated[uci] *= scale;
        }
      }
    }
  }

  return updated;
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
  showResult(kind, reason);
}

// ── Initialization ───────────────────────────────────────────────────────────
parseParams();
if (!startFen) {
  await pickRandomEndgame(true);
} else {
  updateTags();
}

try { chess.load(startFen || STARTPOS); }
catch (err) {
  showResult('warn', `${err.message}`);
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

// ── Controls ────────────────────────────────────────────────────────────────
$('retry').onclick = resetGame;
$('random-endgame').onclick = () => pickRandomEndgame(true);
$('flip').onclick = () => ground.toggleOrientation();
