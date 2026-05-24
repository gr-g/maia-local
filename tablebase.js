// Thin wrapper around Lichess tablebase endpoint.
// Docs: https://lichess.org/api#tag/tablebase
// Covers up to 7 pieces.  CORS is enabled.

const BASE = 'https://tablebase.lichess.org/standard';

// Category conventions we use:
//   win / cursed-win / maybe-win / syzygy-win → winning for side-to-move (we ignore the 50-move rule)
//   draw → draw
//   loss / blessed-loss / maybe-loss / syzygy-loss → losing for side-to-move
//   unknown → unknown

const WIN_CATEGORIES  = new Set(['win', 'cursed-win', 'maybe-win', 'syzygy-win']);
const DRAW_CATEGORIES = new Set(['draw']);
const LOSS_CATEGORIES = new Set(['loss', 'blessed-loss', 'maybe-loss', 'syzygy-loss']);

/**
 * Query the tablebase for a FEN.
 * Returns the raw JSON, or null if the position is not in coverage, or throws on network error.
 */
export async function queryTablebase(fen, { signal, retries = 1 } = {}) {
  const url = `${BASE}?fen=${encodeURIComponent(fen)}`;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;
    }
  }
  throw lastErr || new Error('Tablebase request failed');
}

/**
 * Given a tablebase response, return:
 *   { bestMoves: [uci,...], summary: 'winning'|'drawing'|'losing'|null, allMoves: [...] }
 *
 * `summary` is from the perspective of the side currently to move.
 * The moves in `bestMoves` achieve that best category (from STM's POV), derived from
 * `moves[].category` which is reported from the POV of the responder (next STM).
 *
 * Opponent-POV "best" mapping:
 *   - opponent winning moves = moves whose resulting-position category ∈ LOSS_CATEGORIES (responder loses)
 *   - opponent drawing moves = moves whose category ∈ DRAW_CATEGORIES
 *   - else any move (opponent is losing anyway)
 */
export function classifyMoves(tb) {
  if (!tb || !Array.isArray(tb.moves)) return { bestMoves: [], summary: null, allMoves: [] };
  const winMoves  = tb.moves.filter(m => LOSS_CATEGORIES.has(m.category)); // opp wins → user-after loses
  const drawMoves = tb.moves.filter(m => DRAW_CATEGORIES.has(m.category));
  const losMoves  = tb.moves.filter(m => WIN_CATEGORIES.has(m.category));
  let bestMoves, summary;
  if (winMoves.length)       { bestMoves = winMoves;  summary = 'winning'; }
  else if (drawMoves.length) { bestMoves = drawMoves; summary = 'drawing'; }
  else                       { bestMoves = tb.moves;  summary = losMoves.length ? 'losing' : null; }
  return {
    bestMoves: bestMoves.map(m => ({ uci: m.uci, dtz: (m.zeroing ? 0 : m.dtz), dtm: m.dtm })),
    summary,
    allMoves: tb.moves,
  };
}

/**
 * Normalized root category from a response, mapped to 'win' | 'draw' | 'loss' | 'unknown'.
 * This is from the STM's POV.
 */
export function rootOutcome(tb) {
  if (!tb || !tb.category) return 'unknown';
  if (WIN_CATEGORIES.has(tb.category))  return 'win';
  if (DRAW_CATEGORIES.has(tb.category)) return 'draw';
  if (LOSS_CATEGORIES.has(tb.category)) return 'loss';
  return 'unknown';
}
