// Pawn promotion overlay.
//
// Shows a vertical stack of 4 piece choices (Queen, Knight, Rook, Bishop)
// aligned with the destination file of a promoting pawn. The stack extends
// from the promotion square into the board. Clicking the backdrop or pressing
// Esc cancels.
//
// Usage:
//   const promo = await askPromotion(boardEl, 'e8', 'w', 'white');
//   if (!promo) { /* user cancelled — revert visual move */ }
//
// The caller is responsible for freezing board input while the overlay is
// up, and for reverting the visual move on cancel (syncBoard in our case).

const PIECES = [
  { key: 'q', w: '♕', b: '♛', label: 'Queen'  },
  { key: 'n', w: '♘', b: '♞', label: 'Knight' },
  { key: 'r', w: '♖', b: '♜', label: 'Rook'   },
  { key: 'b', w: '♗', b: '♝', label: 'Bishop' },
];

export function askPromotion(boardEl, destSquare, color, orientation) {
  // Clean any stale overlay first (shouldn't normally exist).
  const existing = boardEl.querySelector('.promotion-overlay');
  if (existing) existing.remove();

  // Rendered grid position (row, col) 0..7 from top-left of the rendered board.
  const fileIdx = destSquare.charCodeAt(0) - 'a'.charCodeAt(0); // 0..7
  const rankIdx = parseInt(destSquare[1], 10) - 1;              // 0..7
  const renderRow = orientation === 'white' ? 7 - rankIdx : rankIdx;
  const renderCol = orientation === 'white' ? fileIdx     : 7 - fileIdx;

  // Stack direction: from the promotion square edge inward.
  // renderRow is always 0 (top edge) or 7 (bottom edge) for promotions.
  const goingDown = renderRow === 0;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'promotion-overlay';

    const backdrop = document.createElement('div');
    backdrop.className = 'promotion-backdrop';

    const stack = document.createElement('div');
    stack.className = 'promotion-stack';
    // Position: 12.5% per square (100%/8). Column is fixed by dest file.
    stack.style.left = `${renderCol * 12.5}%`;
    stack.style.width = `12.5%`;
    if (goingDown) {
      stack.style.top = `0`;
    } else {
      stack.style.bottom = `0`;
    }
    // Height covers 4 squares.
    stack.style.height = `50%`;

    const cells = PIECES.map((p, i) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'promotion-cell';
      cell.dataset.piece = p.key;
      cell.setAttribute('aria-label', `Promote to ${p.label}`);
      cell.textContent = color === 'w' ? p.w : p.b;
      // Stack order matches PIECES order, extending away from edge.
      if (goingDown) {
        cell.style.top = `${i * 25}%`;
      } else {
        cell.style.bottom = `${i * 25}%`;
      }
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        finish(p.key);
      });
      return cell;
    });

    backdrop.addEventListener('click', () => finish(null));
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    };
    window.addEventListener('keydown', onKey);

    overlay.appendChild(backdrop);
    for (const cell of cells) stack.appendChild(cell);
    overlay.appendChild(stack);
    boardEl.appendChild(overlay);

    // Focus first cell for keyboard accessibility.
    cells[0].focus();

    function finish(piece) {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(piece);
    }
  });
}
