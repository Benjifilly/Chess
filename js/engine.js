// =================================================================
// CHESS ENGINE MODULE — Stockfish workers + bot AI + eval bar.
// =================================================================
//
// Extracted from script.js for clarity. Loaded BEFORE script.js so
// the lazy worker accessors are available when other code references
// them. Functions in this file rely on globals from script.js (game,
// myColor, gameMode, isBotThinking, etc.) — those are accessed at
// CALL TIME, never at parse time, so the loading order is fine.
//
// Public surface (functions called from script.js and game-history.js):
//   - getStockfish() / getStockfishEval()  : lazy worker accessors
//   - requestStockfishMove(fen, elo)       : bot move from a position
//   - makeBotMove()                        : full bot turn handler
//   - requestEval(fen)                     : eval bar (cp + mate)
//   - triggerEvalForPosition(fen, flipped) : eval + update bar
//   - updateEvalBar(...) / updateEvalBarVisibility()
//
// =================================================================

// =================================================================
// Stockfish Web Workers — LAZY
// Two workers (one for bot moves, one for eval bar) total ~2 MB of WASM
// when fully booted. We defer creation so Duo-only sessions never pay
// that cost. The first call to `getStockfish()` / `getStockfishEval()`
// triggers the actual Worker instantiation.
// =================================================================

let stockfish = null; // bot-move engine (lazy)
let stockfishResolve = null;
let stockfishReady = false;

function getStockfish() {
    if (stockfish) return stockfish;
    stockfish = new Worker('lib/stockfish.js');
    stockfish.onmessage = function (e) {
        const line = typeof e.data === 'string' ? e.data : '';
        if (!line) return;
        if (line.startsWith('bestmove')) {
            const uciMove = line.split(' ')[1];
            if (uciMove && uciMove !== '(none)' && stockfishResolve) {
                const from = uciMove.substring(0, 2);
                const to = uciMove.substring(2, 4);
                const promotion = uciMove.length > 4 ? uciMove[4] : undefined;
                console.log('Stockfish bestmove:', uciMove);
                stockfishResolve({ from, to, promotion });
                stockfishResolve = null;
            } else if (stockfishResolve) {
                stockfishResolve(null);
                stockfishResolve = null;
            }
            return;
        }
        if (line === 'uciok' || line === 'readyok') {
            if (line === 'uciok') stockfishReady = true;
            return;
        }
        // Silently ignore other UCI noise (info/option/id/etc.)
    };
    return stockfish;
}

// --- EVAL BAR ---
let stockfishEval = null;
let evalResolve = null;
let evalReady = false;
let evalAbortController = null;
let lastEvalCp = 0;
let lastEvalMate = null;
let _stockfishDefaultHandler = null;

function getStockfishEval() {
    if (stockfishEval) return stockfishEval;
    stockfishEval = new Worker('lib/stockfish.js');
    stockfishEval.onmessage = function (e) {
        const line = typeof e.data === 'string' ? e.data : '';
        if (!line) return;

        if (line === 'uciok') { evalReady = true; stockfishEval.postMessage('isready'); return; }
        if (line === 'readyok') return;

        if (line.startsWith('info') && line.includes('score')) {
            const cpMatch = line.match(/score cp (-?\d+)/);
            const mateMatch = line.match(/score mate (-?\d+)/);
            if (evalResolve) {
                if (mateMatch) evalResolve._lastResult = { cp: null, mate: parseInt(mateMatch[1]) };
                else if (cpMatch) evalResolve._lastResult = { cp: parseInt(cpMatch[1]), mate: null };
            }
            return;
        }

        if (line.startsWith('bestmove')) {
            if (evalResolve) {
                const result = evalResolve._lastResult || { cp: 0, mate: null };
                evalResolve(result);
                evalResolve = null;
            }
            return;
        }
    };
    // Save default handler so analysis routines can restore it after override
    _stockfishDefaultHandler = stockfishEval.onmessage;
    stockfishEval.postMessage('uci');
    return stockfishEval;
}

function requestEval(fen) {
    return new Promise((resolve) => {
        const engine = getStockfishEval();
        if (evalResolve) {
            evalResolve({ cp: 0, mate: null });
            evalResolve = null;
            engine.postMessage('stop');
        }
        resolve._lastResult = null;
        evalResolve = resolve;
        engine.postMessage('position fen ' + fen);
        engine.postMessage('go depth 14');
    });
}

function updateEvalBar(cp, mate, colorToMove, barEl, labelTopEl, labelBottomEl, flipped) {
    let pct, labelText;

    if (colorToMove === 'b' && cp !== null) cp = -cp;
    if (colorToMove === 'b' && mate !== null) mate = -mate;

    if (mate !== null) {
        labelText = 'M' + Math.abs(mate);
        pct = mate > 0 ? 5 : 95;
    } else {
        pct = 50 - (cp / 10);
        pct = Math.max(3, Math.min(97, pct));
        const evalVal = cp / 100;
        labelText = (evalVal > 0 ? '+' : '') + evalVal.toFixed(1);
    }

    if (flipped) pct = 100 - pct;

    barEl.style.setProperty('--eval-pct', pct + '%');

    if (labelTopEl) {
        if (pct > 50) {
            labelTopEl.textContent = mate !== null ? labelText : (flipped ? labelText : labelText);
            labelBottomEl.textContent = '';
        } else {
            labelBottomEl.textContent = mate !== null ? labelText : labelText;
            labelTopEl.textContent = '';
        }
    }
}

function triggerEvalForPosition(fen, flipped) {
    const bar = document.getElementById('eval-bar');
    if (!bar || bar.style.display === 'none') return;
    const colorToMove = fen.split(' ')[1] || 'w';
    requestEval(fen).then(result => {
        lastEvalCp = result.cp;
        lastEvalMate = result.mate;
        updateEvalBar(result.cp, result.mate, colorToMove,
            bar,
            document.getElementById('eval-label-top'),
            document.getElementById('eval-label-bottom'),
            flipped !== undefined ? flipped : boardFlipped
        );
    });
}

function updateEvalBarVisibility() {
    const bar = document.getElementById('eval-bar');
    if (!bar) return;
    if (gameMode === 'puzzle' || (gameMode === 'duo' && timeControl > 0)) {
        bar.style.display = 'none';
    } else {
        bar.style.display = '';
    }
}

// --- BOT AI ENGINE (LOCAL STOCKFISH WEB WORKER) ---

/**
 * Send UCI commands to Stockfish and return a Promise that resolves with the best move.
 * Only one search can be active at a time (enforced by isBotThinking mutex in makeBotMove).
 */
function requestStockfishMove(fen, elo) {
    return new Promise((resolve, reject) => {
        const engine = getStockfish();
        // Safety: cancel any lingering previous request
        if (stockfishResolve) {
            stockfishResolve(null);
            stockfishResolve = null;
        }
        stockfishResolve = resolve;
        engine.postMessage('uci');
        engine.postMessage('setoption name UCI_LimitStrength value true');
        engine.postMessage('setoption name UCI_Elo value ' + elo);
        engine.postMessage('position fen ' + fen);
        engine.postMessage('go movetime 1000');
    });
}

/**
 * Main bot turn handler.
 * Uses isBotThinking as a mutex to prevent concurrent Stockfish searches.
 * No artificial setTimeout delays — Stockfish responds asynchronously via the Worker.
 */
async function makeBotMove() {
    // Guard: only proceed if it's solo mode, bot's turn, game not over, and no search in progress
    if (gameMode !== 'solo' || game.turn() === myColor || game.game_over()) return;
    if (isBotThinking) return; // Mutex: prevent concurrent searches

    isBotThinking = true;
    updateStatus();

    // Snapshot the turn color before the async search to detect stale results
    const expectedTurn = game.turn();

    const failsafe = setTimeout(() => {
        if (isBotThinking) {
            console.warn('Bot failsafe: forçage coup aléatoire après timeout');
            // Cancel the pending Stockfish request
            stockfishResolve = null;
            if (stockfish) stockfish.postMessage('stop');
            isBotThinking = false;
            // Only play if it's still the bot's turn
            if (game.turn() === expectedTurn && !game.game_over()) {
                const moves = game.moves({ verbose: true });
                if (moves.length > 0) {
                    const m = moves[Math.floor(Math.random() * moves.length)];
                    makeMove(m.from, m.to);
                }
            }
            updateStatus();
            saveSoloState();
        }
    }, 10000);

    try {
        let targetElo = botEloOverride;
        if (targetElo === null) {
            if (botDifficulty <= 2) {
                targetElo = Math.round(100 + (botDifficulty - 1) * 300);
            } else if (botDifficulty <= 3) {
                targetElo = Math.round(400 + (botDifficulty - 2) * 400);
            } else if (botDifficulty <= 4) {
                targetElo = Math.round(800 + (botDifficulty - 3) * 700);
            } else {
                targetElo = Math.round(1500 + (botDifficulty - 4) * 1500);
            }
        }

        let moveApplied = false;

        // Custom "bad AI" logic for extreme beginners (Elo < 1320)
        // Since Stockfish's minimum is 1320, we forcibly mix in greedy depth-1 mistakes.
        if (targetElo < 1320) {
            // Error rate: e.g. 400 Elo = ~60% chance of making a beginner mistake, 1000 Elo = ~20% chance
            const errorRate = Math.max(0, Math.min(0.8, (1320 - targetElo) / 1500));

            if (Math.random() < errorRate) {
                // Play a sensible blunder: 1-ply search (greedy but blind to opponent responses)
                const moves = game.moves({ verbose: true });
                if (moves.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 500));

                    const sensibleMove = getSensibleBeginnerMove(game, moves);
                    if (isBotThinking && game.turn() === expectedTurn && !game.game_over()) {
                        await makeMove(sensibleMove.from, sensibleMove.to, sensibleMove.promotion);
                        moveApplied = true;
                        clearTimeout(failsafe);
                    }
                }
            }
        }

        if (!moveApplied) {
            // Clamp Elo to Stockfish's supported UCI_Elo range (1320-3190)
            const sfElo = Math.max(1320, Math.min(3190, targetElo));

            const botMove = await requestStockfishMove(game.fen(), sfElo);
            clearTimeout(failsafe);

            // Validate: only apply the move if it's still the bot's turn (guards against tab-switch race)
            if (botMove && isBotThinking && game.turn() === expectedTurn && !game.game_over()) {
                await makeMove(botMove.from, botMove.to, botMove.promotion);
            }
        }
    } catch (e) {
        console.error('Erreur bot:', e);
        clearTimeout(failsafe);
    } finally {
        isBotThinking = false;
        updateStatus();
        saveSoloState();
        // Exécuter un premove en attente après le coup du bot
        if (game.turn() === myColor && !game.game_over()) {
            await tryExecutePremove();
        }
    }
}

// Fonction pour simuler un joueur humain débutant: 
// Voit les prises immédiates (profondeur 1) et les mats, mais est aveugle aux conséquences
function getSensibleBeginnerMove(activeGame, moves) {
    const pieceValues = { p: 10, n: 30, b: 30, r: 50, q: 90, k: 900 };
    const myTurn = activeGame.turn();

    const evaluateBoard = (board) => {
        let score = 0;
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const piece = board[r][c];
                if (piece && piece.color === myTurn) score += pieceValues[piece.type];
                else if (piece) score -= pieceValues[piece.type];
            }
        }
        return score;
    };

    let scoredMoves = [];
    for (const m of moves) {
        activeGame.move(m);
        // Ajout d'un peu d'aléatoire pour varier et ne pas toujours prendre la première pièce venue
        let score = evaluateBoard(activeGame.board()) + (Math.random() * 5);
        if (activeGame.in_checkmate()) score += 10000;

        scoredMoves.push({ move: m, score: score });
        activeGame.undo();
    }

    // Trie du meilleur coup immédiat au pire
    scoredMoves.sort((a, b) => b.score - a.score);

    // Prend un des coups parmi le Top 3 (simule l'hésitation ou un visionnement partiel)
    const poolSize = Math.min(3, scoredMoves.length);
    return scoredMoves[Math.floor(Math.random() * poolSize)].move;
}
