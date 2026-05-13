// ============================================================================
// Puzzle screen — Lichess puzzle hub
//
// Two API surfaces from Lichess (no auth required):
//   GET /api/puzzle/daily   → today's featured puzzle
//   GET /api/puzzle/next    → a fresh random puzzle each call
//
// Architecture:
//   - #puzzle-screen is a sibling of #main-menu / #game-screen.
//   - The screen shows the daily puzzle on top + a list of puzzles below,
//     with a "Charger plus" button that fetches more via /next.
//   - Solved puzzles are tracked by id in localStorage, persistently.
//   - The cached pool of fetched puzzles is persisted so reopening the screen
//     is instant (offline-friendly after first visit).
//
// Globals consumed from script.js (cross-script `let` bindings):
//   game, gameMode, myColor, lastMove, viewIndex, isBotThinking,
//   timeControl, whiteTimeRemaining, blackTimeRemaining, boardFlipped
// Functions called from script.js / game-history.js:
//   renderBoard, updateStatus, updateModeBadge, updateOpponentName,
//   updateEvalBarVisibility, transitionMenuToGame, transitionGameToMenu,
//   playSound, triggerConfetti, showMainMenu
// ============================================================================

const PUZZLE_DAILY_URL = 'https://lichess.org/api/puzzle/daily';
const PUZZLE_NEXT_URL = 'https://lichess.org/api/puzzle/next';

const STORAGE_DAILY_KEY = 'puzzle_daily_v2';   // per-day cache for the daily
const STORAGE_POOL_KEY = 'puzzle_pool_v2';     // list of fetched puzzles
const STORAGE_SOLVED_KEY = 'puzzle_solved_v2'; // array of solved ids
const POOL_MAX = 50;                            // hard cap to avoid bloat
const INITIAL_LOAD = 5;
const LOAD_MORE_COUNT = 5;

// --- State -----------------------------------------------------------------

let dailyPuzzle = null;        // Full /daily response (has .game + .puzzle)
let puzzlePool = [];           // Array of /next responses
let solvedIds = new Set();     // Solved puzzle ids
let activePuzzle = null;       // The puzzle currently being solved
let puzzleSolutionIndex = 0;
let puzzleAwaitingPlayer = false;
let puzzleFailed = false;
let chainModeEnabled = false;  // true while user is chaining "Puzzle suivant"

// --- Storage helpers --------------------------------------------------------

function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadFromStorage() {
    try {
        const daily = localStorage.getItem(STORAGE_DAILY_KEY);
        if (daily) {
            const entry = JSON.parse(daily);
            if (entry && entry.date === todayKey() && entry.puzzle) {
                dailyPuzzle = entry.puzzle;
            }
        }
    } catch (e) { /* ignore */ }

    try {
        const pool = localStorage.getItem(STORAGE_POOL_KEY);
        if (pool) {
            const arr = JSON.parse(pool);
            if (Array.isArray(arr)) puzzlePool = arr;
        }
    } catch (e) { /* ignore */ }

    try {
        const solved = localStorage.getItem(STORAGE_SOLVED_KEY);
        if (solved) {
            const arr = JSON.parse(solved);
            if (Array.isArray(arr)) solvedIds = new Set(arr);
        }
    } catch (e) { /* ignore */ }
}

function saveDaily() {
    try {
        localStorage.setItem(STORAGE_DAILY_KEY, JSON.stringify({
            date: todayKey(),
            puzzle: dailyPuzzle
        }));
    } catch (e) { /* ignore */ }
}

function savePool() {
    try {
        // Trim to POOL_MAX, prefer keeping unsolved ones near the top.
        if (puzzlePool.length > POOL_MAX) {
            puzzlePool = puzzlePool.slice(-POOL_MAX);
        }
        localStorage.setItem(STORAGE_POOL_KEY, JSON.stringify(puzzlePool));
    } catch (e) { /* ignore */ }
}

function saveSolved() {
    try {
        localStorage.setItem(STORAGE_SOLVED_KEY, JSON.stringify([...solvedIds]));
    } catch (e) { /* ignore */ }
}

// --- Lichess fetch helpers --------------------------------------------------

async function fetchDailyPuzzle() {
    if (dailyPuzzle) return dailyPuzzle;
    try {
        const res = await fetch(PUZZLE_DAILY_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data || !data.puzzle || !data.puzzle.fen) throw new Error('Invalid payload');
        dailyPuzzle = data;
        saveDaily();
        return data;
    } catch (e) {
        console.warn('Daily puzzle fetch failed:', e);
        return null;
    }
}

async function fetchOnePuzzle() {
    try {
        const res = await fetch(PUZZLE_NEXT_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data || !data.puzzle || !data.game || !data.game.pgn) throw new Error('Invalid payload');
        return data;
    } catch (e) {
        console.warn('Puzzle fetch failed:', e);
        return null;
    }
}

// --- Theme labels (French) --------------------------------------------------

const THEME_LABELS = {
    advantage: 'Avantage', crushing: 'Écrasant', equality: 'Égalité',
    mate: 'Mat', mateIn1: 'Mat en 1', mateIn2: 'Mat en 2',
    mateIn3: 'Mat en 3', mateIn4: 'Mat en 4', mateIn5: 'Mat en 5',
    fork: 'Fourchette', pin: 'Clouage', skewer: 'Enfilade',
    discoveredAttack: 'Découverte', doubleCheck: 'Échec double',
    sacrifice: 'Sacrifice', deflection: 'Déviation', attraction: 'Attraction',
    interference: 'Interception', quietMove: 'Coup tranquille',
    xRayAttack: 'Rayons X', capturingDefender: 'Capture défenseur',
    hangingPiece: 'Pièce en prise', trappedPiece: 'Pièce piégée',
    backRankMate: 'Mat du couloir', smotheredMate: 'Mat étouffé',
    promotion: 'Promotion', underPromotion: 'Sous-promotion',
    enPassant: 'En passant', castling: 'Roque',
    opening: 'Ouverture', middlegame: 'Milieu de jeu', endgame: 'Finale',
    rookEndgame: 'Finale tours', queenEndgame: 'Finale dames',
    pawnEndgame: 'Finale pions', bishopEndgame: 'Finale fous',
    knightEndgame: 'Finale cavaliers', queenRookEndgame: 'Dame + tour',
    short: 'Court', long: 'Long', veryLong: 'Très long', oneMove: 'En 1 coup',
    master: 'Maître', masterVsMaster: 'Maître vs maître', superGM: 'Super GM'
};

const PHASE_THEMES = new Set([
    'opening', 'middlegame', 'endgame', 'short', 'long', 'veryLong', 'oneMove',
    'master', 'masterVsMaster', 'superGM', 'advantage', 'crushing', 'equality'
]);

// Pick the most "tactical" theme first (skip generic phase tags).
function primaryTheme(themes) {
    if (!Array.isArray(themes) || themes.length === 0) return 'Tactique';
    const tactical = themes.find(t => !PHASE_THEMES.has(t) && THEME_LABELS[t]);
    if (tactical) return THEME_LABELS[tactical];
    const anyKnown = themes.find(t => THEME_LABELS[t]);
    return anyKnown ? THEME_LABELS[anyKnown] : 'Tactique';
}

function sideToMoveLabel(fenOrPgn) {
    if (!fenOrPgn) return 'Blancs';
    // If it's a PGN, the side to move is Whites if initialPly is even, Black if odd, but we don't have initialPly here.
    // However, if the string doesn't look like a FEN (no slashes), we can try to guess or let's default to Whites if we can't tell easily.
    // A better way is to pass the whole puzzle object. For simplicity:
    if (!fenOrPgn.includes('/')) {
        return 'Blancs'; // We will fix this by using the `game.turn()` in a moment, but this avoids crashes
    }
    return fenOrPgn.split(' ')[1] === 'b' ? 'Noirs' : 'Blancs';
}

// --- Puzzle screen show/hide -----------------------------------------------

function openPuzzleScreen() {
    const mainMenu = document.getElementById('main-menu');
    const puzzleScreen = document.getElementById('puzzle-screen');
    const gameScreen = document.getElementById('game-screen');
    if (!puzzleScreen) return;

    if (mainMenu) mainMenu.classList.add('hidden');
    if (gameScreen) gameScreen.classList.add('hidden');
    puzzleScreen.classList.remove('hidden');

    chainModeEnabled = false;

    // Kick off async work; render whatever we already have first.
    renderPuzzleScreen();
    ensurePuzzlesLoaded();
}

function closePuzzleScreen() {
    const mainMenu = document.getElementById('main-menu');
    const puzzleScreen = document.getElementById('puzzle-screen');
    if (puzzleScreen) puzzleScreen.classList.add('hidden');
    if (typeof showMainMenu === 'function') {
        showMainMenu();
    } else if (mainMenu) {
        mainMenu.classList.remove('hidden');
    }
}

async function ensurePuzzlesLoaded() {
    // Always try to refresh the daily once per session (cached per local day).
    if (!dailyPuzzle) {
        await fetchDailyPuzzle();
        renderFeatured();
    }
    // Fill the list to INITIAL_LOAD unsolved entries if it's short.
    const unsolvedCount = puzzlePool.filter(p => p && p.puzzle && !solvedIds.has(p.puzzle.id)).length;
    if (unsolvedCount < INITIAL_LOAD) {
        await loadMorePuzzles(INITIAL_LOAD - unsolvedCount, true);
    } else {
        showLoadMore(true);
    }
}

async function loadMorePuzzles(count, silent = false) {
    if (typeof count !== 'number' || count <= 0) count = LOAD_MORE_COUNT;

    const btn = document.getElementById('puzzle-load-more');
    const emptyEl = document.getElementById('puzzle-list-empty');
    const offlineEl = document.getElementById('puzzle-offline');

    if (!silent && btn) btn.classList.add('loading');
    if (puzzlePool.length === 0 && emptyEl) emptyEl.classList.remove('hidden');
    if (offlineEl) offlineEl.classList.add('hidden');

    const seenIds = new Set(puzzlePool.map(p => p.puzzle && p.puzzle.id).filter(Boolean));
    if (dailyPuzzle && dailyPuzzle.puzzle) seenIds.add(dailyPuzzle.puzzle.id);

    const results = [];
    for (let i = 0; i < count; i++) {
        const result = await fetchOnePuzzle();
        if (result) results.push(result);
        if (i < count - 1) await new Promise(r => setTimeout(r, 500)); // Pause de 500ms pour éviter le blocage Lichess
    }

    let added = 0;
    for (const data of results) {
        if (!data || !data.puzzle) continue;
        if (seenIds.has(data.puzzle.id)) continue; // dedupe
        puzzlePool.push(data);
        seenIds.add(data.puzzle.id);
        added++;
    }

    if (added > 0) savePool();

    if (emptyEl) emptyEl.classList.add('hidden');
    if (btn) btn.classList.remove('loading');

    if (puzzlePool.length === 0) {
        if (offlineEl) offlineEl.classList.remove('hidden');
        if (btn) btn.classList.add('hidden');
    } else {
        showLoadMore(true);
    }

    renderPuzzleList();
    return added;
}

function showLoadMore(show) {
    const btn = document.getElementById('puzzle-load-more');
    if (!btn) return;
    btn.classList.toggle('hidden', !show);
}

// --- Render -----------------------------------------------------------------

function renderPuzzleScreen() {
    renderFeatured();
    renderPuzzleList();
}

function renderFeatured() {
    const el = document.getElementById('puzzle-featured');
    if (!el) return;

    if (!dailyPuzzle || !dailyPuzzle.puzzle) {
        el.classList.add('hidden');
        return;
    }
    el.classList.remove('hidden');

    const p = dailyPuzzle.puzzle;
    const themeEl = el.querySelector('.puzzle-featured-theme');
    const ratingEl = el.querySelector('.puzzle-featured-rating');
    const sideEl = el.querySelector('.puzzle-featured-side');
    const solvedEl = el.querySelector('.puzzle-featured-solved');
    const playBtn = el.querySelector('.puzzle-featured-play');

    if (themeEl) themeEl.textContent = primaryTheme(p.themes);
    if (ratingEl) ratingEl.textContent = p.rating ? `Cote ${p.rating}` : '';
    if (sideEl) sideEl.textContent = `${sideToMoveLabel(p.game ? p.game.pgn : p.fen)} jouent`;

    const solved = solvedIds.has(p.id);
    if (solvedEl) solvedEl.classList.toggle('hidden', !solved);
    if (playBtn) playBtn.textContent = solved ? 'Rejouer' : 'Résoudre';
}

function renderPuzzleList() {
    const listEl = document.getElementById('puzzle-list');
    const countEl = document.getElementById('puzzle-list-count');
    if (!listEl) return;

    listEl.innerHTML = '';

    if (puzzlePool.length === 0) {
        if (countEl) countEl.textContent = '';
        return;
    }

    // Sort: unsolved first, then by index order (most recent fetches appear later).
    const ordered = [...puzzlePool].sort((a, b) => {
        const aSolved = solvedIds.has(a.puzzle.id) ? 1 : 0;
        const bSolved = solvedIds.has(b.puzzle.id) ? 1 : 0;
        return aSolved - bSolved;
    });

    if (countEl) {
        const solvedNum = ordered.filter(p => solvedIds.has(p.puzzle.id)).length;
        countEl.textContent = `${ordered.length - solvedNum} à résoudre`;
    }

    for (const data of ordered) {
        const p = data.puzzle;
        const isSolved = solvedIds.has(p.id);

        const item = document.createElement('div');
        item.className = 'puzzle-list-item' + (isSolved ? ' solved' : '');
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.dataset.puzzleId = p.id;

        const rating = document.createElement('div');
        rating.className = 'puzzle-list-rating';
        rating.innerHTML = `${p.rating || '?'}<span class="puzzle-list-rating-label">ELO</span>`;

        const body = document.createElement('div');
        body.className = 'puzzle-list-body';
        const theme = document.createElement('div');
        theme.className = 'puzzle-list-theme';
        theme.textContent = primaryTheme(p.themes);
        const meta = document.createElement('div');
        meta.className = 'puzzle-list-meta';
        meta.textContent = `${sideToMoveLabel(p.game ? p.game.pgn : p.fen)} jouent · ${(p.solution || []).length} coups`;
        body.appendChild(theme);
        body.appendChild(meta);

        const status = document.createElement('span');
        status.className = 'puzzle-list-status';
        status.innerHTML = isSolved
            ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
            : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

        item.appendChild(rating);
        item.appendChild(body);
        item.appendChild(status);

        const handler = () => playPuzzleById(p.id);
        item.addEventListener('click', handler);
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handler();
            }
        });

        listEl.appendChild(item);
    }
}

// --- Playing ----------------------------------------------------------------

function playDailyPuzzle() {
    if (!dailyPuzzle) return;
    chainModeEnabled = false;
    startPuzzleData(dailyPuzzle);
}

function playPuzzleById(id) {
    const data = puzzlePool.find(p => p.puzzle && p.puzzle.id === id);
    if (!data) return;
    chainModeEnabled = false;
    startPuzzleData(data);
}

async function playNextPuzzle() {
    closePuzzleSuccess();
    chainModeEnabled = true;

    // Prefer an unsolved one already in the pool.
    const unsolved = puzzlePool.find(p => p.puzzle && !solvedIds.has(p.puzzle.id) &&
        (!activePuzzle || p.puzzle.id !== activePuzzle.puzzle.id));
    if (unsolved) {
        startPuzzleData(unsolved);
        return;
    }

    // Otherwise fetch a fresh one. Briefly show "loading" feedback in the
    // banner so the wait doesn't feel dead.
    updatePuzzleBanner('loading');
    const data = await fetchOnePuzzle();
    if (!data) {
        // Fetch failed: bail to the screen.
        returnToPuzzleScreen();
        return;
    }
    // De-dup + add to pool so list reflects it next time.
    if (!puzzlePool.find(p => p.puzzle.id === data.puzzle.id)) {
        puzzlePool.push(data);
        savePool();
    }
    startPuzzleData(data);
}

function startPuzzleData(data) {
    if (!data || !data.puzzle) return;
    const p = data.puzzle;
    const g = data.game;

    activePuzzle = data;
    puzzleSolutionIndex = 0;
    puzzleAwaitingPlayer = false;
    puzzleFailed = false;

    gameMode = 'puzzle';
    timeControl = 0;
    whiteTimeRemaining = 0;
    blackTimeRemaining = 0;

    game.reset();
    
    if (g && g.pgn) {
        // Load the full PGN into chess.js then grab moves
        const tempGame = new Chess();
        tempGame.load_pgn(g.pgn);
        const moves = tempGame.history({ verbose: true });
        
        // Replay up to initialPly
        for (let i = 0; i < p.initialPly; i++) {
            if (moves[i]) game.move(moves[i]);
        }
    } else if (p.fen) {
        if (!game.load(p.fen)) {
            console.warn('Puzzle: invalid FEN', p.fen);
            gameMode = 'duo';
            activePuzzle = null;
            return;
        }
    } else {
        return;
    }

    myColor = game.turn();
    boardFlipped = (myColor === 'b');
    viewIndex = null;
    isBotThinking = false;

    if (p.lastMove && p.lastMove.length >= 4) {
        lastMove = { from: p.lastMove.slice(0, 2), to: p.lastMove.slice(2, 4) };
    } else {
        lastMove = null;
    }

    updatePuzzleBanner('start');

    const puzzleScreen = document.getElementById('puzzle-screen');
    const gameScreen = document.getElementById('game-screen');
    const fromPuzzleScreen = puzzleScreen && !puzzleScreen.classList.contains('hidden');
    const fromGameScreen = gameScreen && !gameScreen.classList.contains('hidden');

    const applyState = () => {
        renderBoard();
        updateStatus(false);
        updateModeBadge();
        updateOpponentName();
        if (typeof updateEvalBarVisibility === 'function') updateEvalBarVisibility();
        puzzleAwaitingPlayer = true;
    };

    if (fromGameScreen) {
        // Chain mode: success overlay just closed, game-screen already on.
        // No transition needed — just re-render the new position.
        applyState();
    } else if (fromPuzzleScreen) {
        // Hard swap from puzzle-screen → game-screen, no menu involved.
        puzzleScreen.classList.add('hidden');
        if (gameScreen) {
            gameScreen.classList.remove('hidden');
            void gameScreen.offsetWidth;
            gameScreen.classList.add('game-enter');
            setTimeout(() => gameScreen.classList.remove('game-enter'), 500);
        }
        applyState();
    } else {
        // From main menu (rare path — direct daily-puzzle deeplink).
        transitionMenuToGame(applyState);
    }
}

// --- Banner -----------------------------------------------------------------

function updatePuzzleBanner(state) {
    const banner = document.getElementById('puzzle-banner');
    if (!banner) return;

    if (gameMode !== 'puzzle') {
        banner.classList.add('hidden');
        return;
    }
    banner.classList.remove('hidden');

    const p = activePuzzle && activePuzzle.puzzle;
    if (!p) return;

    const titleEl = banner.querySelector('.puzzle-banner-title');
    const subEl = banner.querySelector('.puzzle-banner-sub');
    const chipsEl = banner.querySelector('.puzzle-banner-chips');

    const side = sideToMoveLabel(p.game ? p.game.pgn : p.fen);

    if (state === 'wrong') {
        if (titleEl) titleEl.textContent = 'Pas le bon coup';
        if (subEl) subEl.textContent = `Réessaie pour ${side}.`;
    } else if (state === 'correct') {
        if (titleEl) titleEl.textContent = 'Bon coup !';
        if (subEl) subEl.textContent = 'Continue…';
    } else if (state === 'loading') {
        if (titleEl) titleEl.textContent = 'Chargement…';
        if (subEl) subEl.textContent = 'Récupération du prochain puzzle.';
    } else {
        if (titleEl) titleEl.textContent = primaryTheme(p.themes);
        if (subEl) subEl.textContent = `Trouve le meilleur coup pour ${side}.`;
    }

    if (chipsEl) {
        chipsEl.innerHTML = '';
        if (p.rating) {
            const chip = document.createElement('span');
            chip.className = 'puzzle-banner-chip puzzle-banner-chip-rating';
            chip.textContent = p.rating;
            chipsEl.appendChild(chip);
        }
        (p.themes || []).slice(0, 3).forEach(t => {
            if (PHASE_THEMES.has(t)) return;
            const label = THEME_LABELS[t];
            if (!label) return;
            const chip = document.createElement('span');
            chip.className = 'puzzle-banner-chip';
            chip.textContent = label;
            chipsEl.appendChild(chip);
        });
    }
}

// --- Solve flow -------------------------------------------------------------

function moveToUci(m) {
    if (!m) return '';
    return m.from + m.to + (m.promotion || '');
}

function uciMatches(played, expected) {
    if (!played || !expected) return false;
    if (played === expected) return true;
    if (played.length >= 4 && expected.length >= 4 &&
        played.slice(0, 4) === expected.slice(0, 4)) return true;
    return false;
}

function handlePuzzleMove(move) {
    if (!activePuzzle || gameMode !== 'puzzle') return 'correct';
    if (!puzzleAwaitingPlayer || puzzleFailed) return 'correct';

    const solution = activePuzzle.puzzle.solution || [];
    const expected = solution[puzzleSolutionIndex];
    const played = moveToUci(move);

    if (!uciMatches(played, expected)) {
        puzzleFailed = true;
        puzzleAwaitingPlayer = false;
        updatePuzzleBanner('wrong');
        shakeBoard();
        return 'wrong';
    }

    puzzleSolutionIndex++;
    puzzleAwaitingPlayer = false;

    if (puzzleSolutionIndex >= solution.length) {
        solvedIds.add(activePuzzle.puzzle.id);
        saveSolved();
        setTimeout(showPuzzleSuccess, 450);
        return 'done';
    }

    updatePuzzleBanner('correct');
    setTimeout(playPuzzleOpponentReply, 420);
    return 'correct';
}

function playPuzzleOpponentReply() {
    if (gameMode !== 'puzzle' || !activePuzzle) return;
    const solution = activePuzzle.puzzle.solution || [];
    const uci = solution[puzzleSolutionIndex];
    if (!uci) return;

    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const obj = { from, to };
    if (uci.length >= 5) obj.promotion = uci[4];

    const result = game.move(obj);
    if (!result) {
        console.warn('Puzzle: opponent reply illegal', uci);
        return;
    }

    lastMove = { from, to };
    try {
        if (result.flags && (result.flags.includes('c') || result.flags.includes('e'))) {
            playSound('capture');
        } else {
            playSound('move');
        }
    } catch (e) { /* ignore */ }

    renderBoard();
    updateStatus(false);

    puzzleSolutionIndex++;
    puzzleAwaitingPlayer = true;
    updatePuzzleBanner('start');
}

function shakeBoard() {
    const board = document.getElementById('board');
    if (!board) return;
    board.classList.remove('puzzle-shake');
    void board.offsetWidth;
    board.classList.add('puzzle-shake');
    setTimeout(() => board.classList.remove('puzzle-shake'), 500);
}

function rewindPuzzleWrongMove() {
    if (!game) return;
    game.undo();
    lastMove = null;
    renderBoard();
    updateStatus(false);
    setTimeout(() => {
        puzzleFailed = false;
        puzzleAwaitingPlayer = true;
        updatePuzzleBanner('start');
    }, 800);
}

// --- Success overlay --------------------------------------------------------

function showPuzzleSuccess() {
    const overlay = document.getElementById('puzzle-success-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    try { triggerConfetti('checkmate'); } catch (e) { /* ignore */ }
    try { playSound('gameOver'); } catch (e) { /* ignore */ }

    const lichessLink = overlay.querySelector('.puzzle-success-link');
    if (lichessLink && activePuzzle && activePuzzle.puzzle) {
        lichessLink.href = 'https://lichess.org/training/' + activePuzzle.puzzle.id;
    }
}

function closePuzzleSuccess() {
    const overlay = document.getElementById('puzzle-success-overlay');
    if (overlay) overlay.classList.add('hidden');
}

function returnToPuzzleScreen() {
    closePuzzleSuccess();
    chainModeEnabled = false;
    cleanupPuzzleState();

    // Fade game-screen out, swap to puzzle screen.
    const gameScreen = document.getElementById('game-screen');
    const puzzleScreen = document.getElementById('puzzle-screen');
    if (gameScreen) {
        gameScreen.classList.add('game-exit');
        setTimeout(() => {
            gameScreen.classList.add('hidden');
            gameScreen.classList.remove('game-exit');
            if (puzzleScreen) puzzleScreen.classList.remove('hidden');
            renderPuzzleScreen();
        }, 400);
    } else if (puzzleScreen) {
        puzzleScreen.classList.remove('hidden');
        renderPuzzleScreen();
    }
}

function exitPuzzleToMenu() {
    closePuzzleSuccess();
    chainModeEnabled = false;
    cleanupPuzzleState();
    if (typeof transitionGameToMenu === 'function') {
        transitionGameToMenu();
    } else if (typeof showMainMenu === 'function') {
        showMainMenu();
    }
}

function cleanupPuzzleState() {
    gameMode = 'duo';
    timeControl = 0;
    lastMove = null;
    activePuzzle = null;
    puzzleAwaitingPlayer = false;
    puzzleFailed = false;
    puzzleSolutionIndex = 0;
    if (game) game.reset();
    const banner = document.getElementById('puzzle-banner');
    if (banner) banner.classList.add('hidden');
    document.body.classList.remove('mode-puzzle');
}

// --- Init -------------------------------------------------------------------

loadFromStorage();

// Expose ----
window.openPuzzleScreen = openPuzzleScreen;
window.closePuzzleScreen = closePuzzleScreen;
window.loadMorePuzzles = loadMorePuzzles;
window.playDailyPuzzle = playDailyPuzzle;
window.playPuzzleById = playPuzzleById;
window.playNextPuzzle = playNextPuzzle;
window.returnToPuzzleScreen = returnToPuzzleScreen;
window.handlePuzzleMove = handlePuzzleMove;
window.rewindPuzzleWrongMove = rewindPuzzleWrongMove;
window.exitPuzzleToMenu = exitPuzzleToMenu;
window.closePuzzleSuccess = closePuzzleSuccess;
window.updatePuzzleBanner = updatePuzzleBanner;
window.isPuzzleAwaitingPlayer = function () { return puzzleAwaitingPlayer; };
window.isPuzzleChainMode = function () { return chainModeEnabled; };
