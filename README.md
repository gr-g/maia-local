# Maia Local

A minimal replication of the [Maia Chess](https://www.maiachess.com/) play-page architecture, running entirely in the browser.

Written with Claude and [Agent Zero](https://www.agent-zero.ai/), with the objective to experiment using the Maia human-like chess engine for various applications, such as training endgame positions against an opponent that plays realistic moves (and also plays non-deterministically, potentially taking different lines from the same position).

## Model source

On first use (click **Download model**) the page fetches:

```
https://raw.githubusercontent.com/CSSLab/maia-platform-frontend/main/public/maia3/maia3_simplified.onnx
```

(~44 MB, served with `Access-Control-Allow-Origin: *` from GitHub). The buffer is stored in IndexedDB under the `MaiaModels` database, so subsequent loads are instant and offline-capable.

To clear the cached weights, click **Clear cache**.

## Files

| Path | Description |
| --- | --- |
| `index.html` | Play page shell |
| `endgame_training.html` | Endgame trainer shell |
| `app.js`, `endgame_training.js` | UI controllers |
| `engine.js` | Shared MaiaEngine wrapper, preprocessing/postprocessing |
| `maia-worker.js` | Web Worker: ONNX session, IndexedDB cache, inference |
| `tablebase.js` | Lichess tablebase helpers (endgame trainer) |
| `vendor/chessground.*.css` | Vendored chessground CSS (pieces embedded as data URIs) |
| `styles.css` | Page layout |
| `ort/` | onnxruntime-web 1.23.0 WASM runtime (single unified `.wasm` + `.mjs`) |
| `data/all_moves_maia3*.json` | Move-index ↔ UCI vocabulary (4352 moves) |

## Run locally

```bash
cd maia-local
python3 -m http.server 8765
# then open http://localhost:8765/
```

On first load:
1. Click **Download model** (~44 MB from raw.githubusercontent.com, cached in IndexedDB)
2. Status pill turns **ready**
3. Make a move or set a FEN — if auto-run is checked, inference runs automatically

## Performance notes
The project uses [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) to enable Cross-Origin Isolation (COOP/COEP) via a client-side service worker. This allows `SharedArrayBuffer` support even on restricted hosts like GitHub Pages, enabling **multi-threaded WebAssembly** performance.

In practice, with SIMD and multi-threading enabled, a single forward pass of Maia 3 typically takes **~200–400 ms** on modern hardware.

## Architecture

```
┌──────────────┐       ┌─────────────────┐       ┌──────────────────┐
│  Main thread │       │  Web Worker     │       │  onnxruntime-web │
│              │       │                 │       │   (WASM SIMD)    │
│  chessground │──────▶│  maia-worker.js │──────▶│                  │
│  chess.js    │ move  │                 │ feeds │  maia3.onnx      │
│  preprocess  │ tokens│  IndexedDB      │       │  (from GitHub)   │
│  postprocess │◀──────│  cache          │◀──────│                  │
└──────────────┘ logits└─────────────────┘       └──────────────────┘
```

- **Preprocessing** (`engine.js`): mirror FEN if black-to-move, encode 64×12 one-hot board tokens, build 4352-long legal-moves mask.
- **Inference** (`maia-worker.js`): forward pass through Maia-3 → `logits_move[4352]`, `logits_value[3]` (L/D/W for side-to-move).
- **Postprocessing** (`engine.js`): softmax WDL for white-win probability, masked+softmax move logits, mirror UCIs back if black-to-move.
