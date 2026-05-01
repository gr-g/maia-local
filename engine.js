// Shared Maia engine module: preprocessing, postprocessing, MaiaEngine (worker wrapper).
// Imported by both app.js (play) and endgame_training.js (endgame training).

import { Chess } from 'https://esm.sh/chess.js@1.0.0-beta.8';

export const MODEL_URL = 'https://raw.githubusercontent.com/CSSLab/maia-platform-frontend/main/public/maia3/maia3_simplified.onnx';
export const MODEL_VERSION = 'maia3-rapid-simplified';

// ── Move vocab ───────────────────────────────────────────────────────────────
let MOVE_TO_IDX = null;
let IDX_TO_MOVE = null;
let _vocabPromise = null;

export function loadVocab() {
  if (_vocabPromise) return _vocabPromise;
  _vocabPromise = Promise.all([
    fetch('./data/all_moves_maia3.json').then(r => r.json()),
    fetch('./data/all_moves_maia3_reversed.json').then(r => r.json()),
  ]).then(([fwd, rev]) => { MOVE_TO_IDX = fwd; IDX_TO_MOVE = rev; });
  return _vocabPromise;
}

// ── FEN mirroring (for black-to-move canonicalization) ──────────────────────

function swapCase(c) {
  if (/[A-Z]/.test(c)) return c.toLowerCase();
  if (/[a-z]/.test(c)) return c.toUpperCase();
  return c;
}
const swapColorsInRank = r => [...r].map(swapCase).join('');
const mirrorSquare = sq => sq[0] + (9 - parseInt(sq[1])).toString();
export function mirrorMove(uci) {
  const isPromo = uci.length > 4;
  return mirrorSquare(uci.slice(0,2)) + mirrorSquare(uci.slice(2,4)) + (isPromo ? uci.slice(4) : '');
}
function swapCastlingRights(cr) {
  if (cr === '-') return '-';
  const set = new Set(cr);
  const swapped = new Set();
  if (set.has('K')) swapped.add('k');
  if (set.has('Q')) swapped.add('q');
  if (set.has('k')) swapped.add('K');
  if (set.has('q')) swapped.add('Q');
  let out = '';
  for (const c of ['K','Q','k','q']) if (swapped.has(c)) out += c;
  return out || '-';
}
export function mirrorFEN(fen) {
  const [pos, color, castle, ep, half, full] = fen.split(' ');
  const ranks = pos.split('/').slice().reverse().map(swapColorsInRank);
  return [ranks.join('/'), color === 'w' ? 'b' : 'w',
          swapCastlingRights(castle),
          ep !== '-' ? mirrorSquare(ep) : '-',
          half, full].join(' ');
}

// ── Board → tokens ───────────────────────────────────────────────────────────
const PIECES = ['P','N','B','R','Q','K','p','n','b','r','q','k'];
function boardToMaia3Tokens(fen) {
  const rows = fen.split(' ')[0].split('/');
  const t = new Float32Array(64 * 12);
  for (let rank = 0; rank < 8; rank++) {
    const row = 7 - rank;
    let file = 0;
    for (const ch of rows[rank]) {
      if (isNaN(parseInt(ch))) {
        const pi = PIECES.indexOf(ch);
        if (pi >= 0) t[(row * 8 + file) * 12 + pi] = 1;
        file++;
      } else file += parseInt(ch);
    }
  }
  return t;
}

export function preprocessMaia3(fen) {
  const blackToMove = fen.split(' ')[1] === 'b';
  const canonFen = blackToMove ? mirrorFEN(fen) : fen;
  const chess = new Chess(canonFen);
  const boardTokens = boardToMaia3Tokens(canonFen);
  const legalMoves = new Float32Array(4352);
  for (const m of chess.moves({ verbose: true })) {
    const key = m.from + m.to + (m.promotion || '');
    const idx = MOVE_TO_IDX[key];
    if (idx !== undefined) legalMoves[idx] = 1;
  }
  return { boardTokens, legalMoves, blackToMove };
}

// ── Postprocessing ──────────────────────────────────────────────────────────

function softmaxOverLegal(logits, legalMask) {
  const idxs = [];
  for (let i = 0; i < legalMask.length; i++) if (legalMask[i] > 0) idxs.push(i);
  const ll = idxs.map(i => logits[i]);
  const maxL = Math.max(...ll);
  const ex = ll.map(l => Math.exp(l - maxL));
  const s = ex.reduce((a,b) => a+b, 0);
  return { idxs, probs: ex.map(e => e/s) };
}

function processOutputs(logitsMove, logitsValue, legalMask, blackToMove) {
  const [L,D,W] = logitsValue;
  const maxV = Math.max(L,D,W);
  const eL = Math.exp(L-maxV), eD = Math.exp(D-maxV), eW = Math.exp(W-maxV);
  const sumV = eL + eD + eW;
  let whiteWinProb = (eW + 0.5 * eD) / sumV;
  if (blackToMove) whiteWinProb = 1 - whiteWinProb;
  whiteWinProb = Math.round(whiteWinProb * 10000) / 10000;

  const { idxs, probs } = softmaxOverLegal(logitsMove, legalMask);
  const dict = {};
  for (let i = 0; i < idxs.length; i++) {
    let uci = IDX_TO_MOVE[String(idxs[i])];
    if (blackToMove) uci = mirrorMove(uci);
    dict[uci] = probs[i];
  }
  const sorted = Object.fromEntries(Object.entries(dict).sort((a,b) => b[1]-a[1]));
  return { policy: sorted, winProbWhite: whiteWinProb, wdl: { loss: eL/sumV, draw: eD/sumV, win: eW/sumV } };
}

// ── MaiaEngine (worker wrapper) ──────────────────────────────────────────────

export class MaiaEngine extends EventTarget {
  constructor() {
    super();
    this.worker = new Worker('./maia-worker.js');
    this.ready = false;
    this._nextId = 0;
    this._pending = new Map();
    this._download = null;
    this.worker.onmessage = (e) => {
      const m = e.data;
      switch (m.type) {
        case 'status':
          this.dispatchEvent(new CustomEvent('status', { detail: m.status }));
          if (m.status === 'ready') {
            this.ready = true;
            this._download?.resolve();
            this._download = null;
          }
          break;
        case 'progress':
          this.dispatchEvent(new CustomEvent('progress', { detail: m.progress }));
          break;
        case 'error':
          if (m.id !== undefined) {
            const p = this._pending.get(m.id);
            if (p) { p.reject(new Error(m.message)); this._pending.delete(m.id); }
          } else {
            this._download?.reject(new Error(m.message));
            this._download = null;
            this.dispatchEvent(new CustomEvent('error', { detail: m.message }));
          }
          break;
        case 'inference-result': {
          const p = this._pending.get(m.id);
          if (p) {
            p.resolve({
              logitsMove: new Float32Array(m.logitsMove),
              logitsValue: new Float32Array(m.logitsValue),
            });
            this._pending.delete(m.id);
          }
          break;
        }
      }
    };
    this.worker.postMessage({ type: 'init', modelUrl: MODEL_URL, modelVersion: MODEL_VERSION });
  }

  download() {
    if (this._download) return this._download.promise;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this._download = { resolve, reject, promise };
    this.worker.postMessage({ type: 'download' });
    return promise;
  }

  async infer(fen, eloSelf, eloOppo) {
    if (!this.ready) throw new Error('Model not ready');
    const { boardTokens, legalMoves, blackToMove } = preprocessMaia3(fen);
    const id = this._nextId++;
    const promise = new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
    const tokenBuf = boardTokens.buffer;
    const selfBuf = new Float32Array([eloSelf]).buffer;
    const oppoBuf = new Float32Array([eloOppo]).buffer;
    this.worker.postMessage(
      { type: 'inference', id, tokens: tokenBuf, eloSelfs: selfBuf, eloOppos: oppoBuf, batchSize: 1 },
      [tokenBuf, selfBuf, oppoBuf],
    );
    const { logitsMove, logitsValue } = await promise;
    return processOutputs(logitsMove, logitsValue, legalMoves, blackToMove);
  }

  async clearCache() {
    await new Promise((res, rej) => {
      const req = indexedDB.deleteDatabase('MaiaModels');
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
      req.onblocked = () => res();
    });
  }
}

// ── Utility: sample from policy ──────────────────────────────────────────────

/** Sample a UCI move from a {move: prob} dict. Optionally restrict to a subset of UCIs. */
export function samplePolicy(policy, subset = null) {
  let entries = Object.entries(policy);
  if (subset) {
    const allow = new Set(subset);
    entries = entries.filter(([m]) => allow.has(m));
    if (entries.length === 0) return null;
  }
  const sum = entries.reduce((a, [,p]) => a + p, 0);
  if (sum === 0) return entries[Math.floor(Math.random() * entries.length)][0];
  let r = Math.random() * sum;
  for (const [m, p] of entries) {
    r -= p;
    if (r <= 0) return m;
  }
  return entries[entries.length - 1][0];
}

/** Return a renormalized subset-policy dict. */
export function restrictPolicy(policy, subset) {
  const allow = new Set(subset);
  const ent = Object.entries(policy).filter(([m]) => allow.has(m));
  const sum = ent.reduce((a, [,p]) => a + p, 0);
  if (sum === 0) {
    // All excluded or zero probabilities: fallback to uniform over subset
    const u = 1 / (subset.length || 1);
    return Object.fromEntries(subset.map(m => [m, u]));
  }
  return Object.fromEntries(ent.map(([m,p]) => [m, p/sum]));
}
