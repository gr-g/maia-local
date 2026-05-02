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
  { key: 'r', w: '♖', b: '♜', label: 'Rook'   },
  { key: 'b', w: '♗', b: '♝', label: 'Bishop' },
  { key: 'n', w: '♘', b: '♞', label: 'Knight' },
];

export function askPromotion(boardEl, destSquare, color, orientation) {
  // Clean any stale overlay first (shouldn't normally exist).
  document.querySelectorAll('.promotion-overlay').forEach(e => e.remove());

  // Use the boardEl itself if it is already the chessground container, 
  // otherwise search for cg-wrap or cg-container.
  // Ensure we are inside the absolute coordinate system of the board squares
  // Find the closest relative container that defines the 8x8 grid
  // Find a suitable relative parent for the absolute overlay
  const boardWrap = boardEl.querySelector('.cg-wrap, cg-container') || boardEl;
  if (getComputedStyle(boardWrap).position === 'static') {
    boardWrap.style.position = 'relative';
  }

  // Rendered grid position (row, col) 0..7 from top-left of the rendered board.
  const fileIdx = destSquare.charCodeAt(0) - 'a'.charCodeAt(0); // 0..7
  const rankIdx = parseInt(destSquare[1], 10) - 1;              // 0..7
  
  // Visual row and col (0-7) considering orientation
  const isWhite = orientation === 'white';
  const renderRow = (orientation === 'black') ? rankIdx : 7 - rankIdx;
  const renderCol = (orientation === 'black') ? 7 - fileIdx : fileIdx;

  // Stack direction: from the promotion square edge inward.
  // If we are at the top (row 0), we extend down. If at the bottom (row 7), we extend up.
  const isAtTop = renderRow === 0;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'promotion-overlay';
    // Ensure overlay covers the target perfectly
    Object.assign(overlay.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '100'
    });
    overlay.dataset.debug = JSON.stringify({ destSquare, color, orientation, renderRow, renderCol, isAtTop });

    const backdrop = document.createElement('div');
    backdrop.className = 'promotion-backdrop';

    const stack = document.createElement('div');
    stack.className = 'promotion-stack';

    Object.assign(stack.style, {
      position: 'absolute',
      display: 'flex',
      flexDirection: isAtTop ? 'column' : 'column-reverse',
      left: `${renderCol * 12.5}%`,
      width: '12.5%',
      height: '50%',
      top: isAtTop ? '0' : 'auto',
      bottom: isAtTop ? 'auto' : '0'
    });

    const cells = PIECES.map((p, i) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'promotion-cell';
      Object.assign(cell.style, {
        position: 'relative',
        width: '100%',
        flex: '1',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 'min(32px, 4vw)',
        padding: '0'
      });
      cell.dataset.piece = p.key;
      cell.setAttribute('aria-label', `Promote to ${p.label}`);
      cell.textContent = color === 'w' ? p.w : p.b;
      // Order: if at bottom, we want Queen (index 0) at the top of the stack
      // if at top, we want Queen (index 0) at the bottom? No, usually 
      // pieces should extend from the promotion square into the board.
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
    boardWrap.appendChild(overlay);

    // Focus first cell for keyboard accessibility.
    cells[0].focus();

    function finish(piece) {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(piece);
    }
  });
}
