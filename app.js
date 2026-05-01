// Play page — uses shared engine module.
import { Chessground } from 'https://esm.sh/chessground@9';
import { Chess }       from 'https://esm.sh/chess.js@1.0.0-beta.8';
import { MaiaEngine, loadVocab } from './engine.js';

const $ = (id) => document.getElementById(id);
const chess = new Chess();
let ground = null;

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
const turnColor = c => c.turn() === 'w' ? 'white' : 'black';

function syncBoard() {
  ground.set({
    fen: chess.fen(),
    turnColor: turnColor(chess),
    movable: { color: turnColor(chess), dests: legalDests(chess) },
    check: chess.inCheck(),
  });
}

function onMove(orig, dest) {
  const m = chess.move({ from: orig, to: dest, promotion: 'q' });
  if (!m) { syncBoard(); return; }
  syncBoard();
  $('fen').value = chess.fen();
  maybeAutoRun();
}

function populateEloDropdowns() {
  const elos = [1100,1200,1300,1400,1500,1600,1700,1800,1900,2000];
  for (const sel of [$('self-elo'), $('oppo-elo')]) {
    sel.innerHTML = '';
    for (const e of elos) {
      const opt = document.createElement('option');
      opt.value = e; opt.textContent = e;
      sel.appendChild(opt);
    }
    sel.value = 1500;
  }
}

function setStatus(status) {
  const el = $('status');
  el.textContent = status;
  el.className = 'pill ' + status;
  $('run').disabled = status !== 'ready';
}

function renderResult(res) {
  const wp = res.winProbWhite;
  $('eval-white').style.width = (wp * 100).toFixed(1) + '%';
  $('eval-text').textContent =
    `White win prob: ${(wp*100).toFixed(2)}% · WDL (STM): L ${(res.wdl.loss*100).toFixed(1)}%  D ${(res.wdl.draw*100).toFixed(1)}%  W ${(res.wdl.win*100).toFixed(1)}%`;

  const tbody = $('moves').querySelector('tbody');
  tbody.innerHTML = '';
  const entries = Object.entries(res.policy).slice(0, 15);
  const maxP = entries.length ? entries[0][1] : 1;
  for (const [uci, p] of entries) {
    const tr = document.createElement('tr');
    const barWidth = (p / maxP) * 120;
    tr.innerHTML = `<td>${uci}</td><td>${(p*100).toFixed(2)}%</td><td><span class="prob-bar" style="width:${barWidth}px"></span></td>`;
    tbody.appendChild(tr);
  }
  if (entries.length > 0) {
    const [uci] = entries[0];
    ground.setShapes([{ orig: uci.slice(0,2), dest: uci.slice(2,4), brush: 'green' }]);
  }
}

let inferenceBusy = false;
async function runInference() {
  if (!engine.ready || inferenceBusy) return;
  inferenceBusy = true;
  $('timing').textContent = 'running…';
  const t0 = performance.now();
  try {
    const res = await engine.infer(chess.fen(), +$('self-elo').value, +$('oppo-elo').value);
    const dt = performance.now() - t0;
    $('timing').textContent = `${dt.toFixed(1)} ms`;
    renderResult(res);
  } catch (err) {
    $('timing').textContent = 'error';
    $('eval-text').textContent = 'Inference error: ' + err.message;
  } finally {
    inferenceBusy = false;
  }
}

function maybeAutoRun() { if ($('auto-run').checked && engine.ready) runInference(); }

await loadVocab();
populateEloDropdowns();

ground = Chessground($('board'), {
  fen: chess.fen(),
  turnColor: turnColor(chess),
  movable: { free: false, color: turnColor(chess), dests: legalDests(chess), events: { after: onMove } },
  draggable: { showGhost: true },
  highlight: { lastMove: true, check: true },
  animation: { duration: 200 },
  drawable: { enabled: true, defaultSnapToValidMove: true },
});

const engine = new MaiaEngine();
engine.addEventListener('status', (e) => setStatus(e.detail));
engine.addEventListener('progress', (e) => { $('progress').value = e.detail; });
engine.addEventListener('error', (e) => { $('eval-text').textContent = 'Worker error: ' + e.detail; });

$('download').onclick = async () => {
  try { await engine.download(); await refreshStorageInfo(); maybeAutoRun(); }
  catch (err) { $('eval-text').textContent = 'Download failed: ' + err.message; }
};
$('clear-cache').onclick = async () => {
  await engine.clearCache();
  $('storage-info').textContent = 'Cache cleared. Reload page to re-init.';
};
$('run').onclick = runInference;
$('reset').onclick = () => { chess.reset(); syncBoard(); $('fen').value = chess.fen(); maybeAutoRun(); };
$('flip').onclick = () => ground.toggleOrientation();
$('undo').onclick = () => { chess.undo(); syncBoard(); $('fen').value = chess.fen(); maybeAutoRun(); };
$('set-fen').onclick = () => {
  const f = $('fen').value.trim();
  try { chess.load(f); syncBoard(); maybeAutoRun(); }
  catch (err) { $('eval-text').textContent = 'Invalid FEN: ' + err.message; }
};
$('fen').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('set-fen').click(); });
[ 'self-elo', 'oppo-elo' ].forEach(id => $(id).addEventListener('change', maybeAutoRun));

async function refreshStorageInfo() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) $('storage-info').textContent =
      `IndexedDB usage: ${(est.usage/1e6).toFixed(1)} MB of ${(est.quota/1e6).toFixed(0)} MB quota`;
  } catch {}
}
refreshStorageInfo();
