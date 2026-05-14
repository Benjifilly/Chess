// ===================================================================
// GAME HISTORY SYSTEM — save, fetch, display, replay, review.
// ===================================================================
//
// Extracted from script.js as part of the modularization effort.
// Depends on the following globals defined in script.js / engine:
//   - supabaseClient, game, myName, myColor, gameMode
//   - botDifficulty, botEloOverride, timeControl
//   - LOCAL_OPPONENT_LABEL
//   - openModal/closeModal, settingsDropdown
//   - getStockfishEval, evalResolve, _stockfishDefaultHandler
//
// Exposes (called from script.js and HTML onclick handlers):
//   - saveGameToHistory, getEloForDifficulty
//   - openGameHistory, switchHistoryTab, loadLastMatch
//   - openReplay, closeReviewScreen, replayGame
//
// LOADING ORDER: this file must be loaded AFTER script.js so the globals
// above are already declared.
// ===================================================================

let ghCurrentTab = 'solo';
let ghCache = { solo: null, duo: null };

// --- Save a finished game to Supabase ---
async function saveGameToHistory(result, reason) {
    if (!supabaseClient) {
        console.warn('saveGameToHistory: supabaseClient non disponible');
        return;
    }

    if (gameMode === 'puzzle') return;

    // For duo mode, only the WHITE player saves to avoid duplicate entries
    if (gameMode === 'duo' && myColor !== 'w') {
        console.log('saveGameToHistory: duo mode, not white player — skipping (white player saves)');
        return;
    }

    try {
        const pgn = game.pgn();
        const fen = game.fen();
        const moves = game.history();
        const opponentName = myName === 'Benji' ? 'Sanaa' : 'Benji';

        // Check if this game was already saved (prevent duplicates on page reload)
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: existing, error: checkError } = await supabaseClient
            .from('game_history')
            .select('id')
            .eq('pgn', pgn)
            .gte('played_at', twentyFourHoursAgo)
            .limit(1);

        if (checkError) {
            console.warn('saveGameToHistory: check error', checkError);
        } else if (existing && existing.length > 0) {
            console.log('saveGameToHistory: game already saved, skipping duplicate');
            return;
        }

        // Local pass-and-play: file under the "solo" tab so it shows
        // alongside bot games. Result is recorded from White's perspective.
        const isLocal = gameMode === 'local';
        const recordMode = isLocal ? 'solo' : gameMode;
        const recordOpponent = isLocal
            ? LOCAL_OPPONENT_LABEL
            : (gameMode === 'solo' ? `Bot (${botEloOverride || getEloForDifficulty(botDifficulty)})` : opponentName);
        const recordMyColor = isLocal ? 'w' : myColor;
        const recordBotElo = (gameMode === 'solo' && !isLocal)
            ? (botEloOverride || getEloForDifficulty(botDifficulty))
            : null;

        const record = {
            player: myName,
            opponent: recordOpponent,
            mode: recordMode,
            result: result,
            reason: reason || null,
            pgn: pgn,
            final_fen: fen,
            my_color: recordMyColor,
            move_count: moves.length,
            time_control: timeControl,
            bot_elo: recordBotElo,
            played_at: new Date().toISOString()
        };

        console.log('saveGameToHistory: inserting', record.mode, record.result, isLocal ? '(local)' : '');
        const { data, error } = await supabaseClient.from('game_history').insert(record).select();
        if (error) {
            console.error('saveGameToHistory Supabase error:', error);
        } else {
            console.log('saveGameToHistory: saved successfully, id:', data?.[0]?.id);
        }
        // Invalidate cache for the tab the record went into
        ghCache[recordMode] = null;
    } catch (e) {
        console.error('saveGameToHistory exception:', e);
    }
}

function getEloForDifficulty(diff) {
    const map = { 1: 400, 2: 600, 3: 800, 4: 1500, 5: 2500 };
    return map[diff] || 800;
}

// --- Open History Modal ---
function openGameHistory() {
    // Close dropdown if open
    if (typeof settingsDropdown !== 'undefined' && settingsDropdown) {
        settingsDropdown.classList.remove('active');
    }
    openModal('game-history-modal');
    loadHistoryTab(ghCurrentTab);
}

function switchHistoryTab(tab) {
    ghCurrentTab = tab;
    document.querySelectorAll('.gh-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    loadHistoryTab(tab);
}

async function loadHistoryTab(tab) {
    const container = document.getElementById('gh-games-container');
    container.innerHTML = '<div class="gh-loading">Chargement...</div>';

    // Use cache if available
    if (ghCache[tab]) {
        renderHistoryGames(ghCache[tab], tab);
        return;
    }

    if (!supabaseClient) {
        container.innerHTML = '<div class="gh-empty">Supabase non connecté</div>';
        return;
    }

    try {
        let query;
        if (tab === 'duo') {
            // Duo: query ALL duo games (single record per game, saved by white player)
            query = supabaseClient
                .from('game_history')
                .select('*')
                .eq('mode', 'duo')
                .order('played_at', { ascending: false })
                .limit(50);
        } else {
            // Solo: only this player's games
            query = supabaseClient
                .from('game_history')
                .select('*')
                .eq('player', myName)
                .eq('mode', 'solo')
                .order('played_at', { ascending: false })
                .limit(50);
        }

        const { data, error } = await query;
        if (error) throw error;

        ghCache[tab] = data || [];
        renderHistoryGames(ghCache[tab], tab);
    } catch (e) {
        console.warn('Erreur loadHistoryTab:', e);
        container.innerHTML = '<div class="gh-empty">Erreur de chargement</div>';
    }
}

function renderHistoryGames(games, tab) {
    const container = document.getElementById('gh-games-container');

    if (!games || games.length === 0) {
        container.innerHTML = `
            <div class="gh-empty">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 6v6l4 2"/>
                </svg>
                Aucune partie ${tab === 'solo' ? 'solo' : 'duo'} jouée
            </div>`;
        return;
    }

    container.innerHTML = '';

    games.forEach((g, index) => {
        const card = document.createElement('div');
        card.className = 'gh-game-card';
        card.onclick = () => openReplay(g);

        // Build mini board from final FEN
        const miniBoard = buildMiniBoard(g.final_fen);

        // For duo games: adapt result/opponent/color to the viewer's perspective
        const isFlipped = tab === 'duo' && g.player !== myName;
        let displayResult = g.result;
        if (isFlipped) {
            if (g.result === 'win') displayResult = 'loss';
            else if (g.result === 'loss') displayResult = 'win';
        }
        const isLocalGame = g.opponent === LOCAL_OPPONENT_LABEL;
        const displayOpponent = isFlipped ? g.player : g.opponent;
        const displayColor = isFlipped ? (g.my_color === 'w' ? 'b' : 'w') : g.my_color;

        // Result badge — for local games, frame it as "Blancs/Noirs win" rather
        // than "Victoire/Défaite", since there's no me/opponent in pass-and-play.
        let badgeClass, badgeText;
        if (isLocalGame) {
            badgeClass = displayResult === 'draw' ? 'draw' : 'win';
            if (displayResult === 'win')      badgeText = 'Blancs gagnent';
            else if (displayResult === 'loss') badgeText = 'Noirs gagnent';
            else                               badgeText = 'Nul';
        } else {
            badgeClass = displayResult === 'win' ? 'win' : displayResult === 'loss' ? 'loss' : 'draw';
            badgeText  = displayResult === 'win' ? 'Victoire' : displayResult === 'loss' ? 'Défaite' : 'Nul';
        }

        // Meta info
        const date = new Date(g.played_at);
        const dateStr = formatHistoryDate(date);
        const movesStr = `${Math.ceil(g.move_count / 2)} coups`;

        let reasonStr = '';
        if (g.reason === 'resign') reasonStr = ' (abandon)';
        else if (g.reason === 'timeout') reasonStr = ' (temps)';

        const movesLine = isLocalGame
            ? movesStr
            : `${movesStr} · ${displayColor === 'w' ? 'Blancs' : 'Noirs'}`;
        const metaLine = isLocalGame
            ? `${displayOpponent} · ${dateStr}`
            : `vs ${displayOpponent} · ${dateStr}`;
        card.innerHTML = `
            ${miniBoard}
            <div class="gh-game-info">
                <div class="gh-game-result">
                    <span class="gh-result-badge ${badgeClass}">${badgeText}${reasonStr}</span>
                </div>
                <div class="gh-game-meta">${metaLine}</div>
                <div class="gh-game-moves">${movesLine}</div>
            </div>
            <div class="gh-game-actions">
                <button class="gh-analyze-btn" data-game-index="${index}" title="Analyser la partie">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="20" x2="18" y2="10"></line>
                        <line x1="12" y1="20" x2="12" y2="4"></line>
                        <line x1="6" y1="20" x2="6" y2="14"></line>
                    </svg>
                </button>
                <div class="gh-game-arrow">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
                </div>
            </div>
        `;

        // --- GAME REVIEW --- Analyze button
        card.querySelector('.gh-analyze-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            openReplay(g, true);
        });

        container.appendChild(card);
    });
}

function buildMiniBoard(fen) {
    if (!fen) return '<div class="gh-mini-board"></div>';

    const rows = fen.split(' ')[0].split('/');
    let html = '<div class="gh-mini-board">';

    for (let r = 0; r < 8; r++) {
        let col = 0;
        for (const ch of rows[r]) {
            if (ch >= '1' && ch <= '8') {
                for (let i = 0; i < parseInt(ch); i++) {
                    const isLight = (r + col) % 2 === 0;
                    html += `<div class="gh-mini-sq ${isLight ? 'light' : 'dark'}"></div>`;
                    col++;
                }
            } else {
                const isLight = (r + col) % 2 === 0;
                const color = ch === ch.toUpperCase() ? 'white' : 'black';
                const pieceMap = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
                const pieceName = pieceMap[ch.toLowerCase()];
                html += `<div class="gh-mini-sq ${isLight ? 'light' : 'dark'}"><img src="pièces/default/${color}-${pieceName}.png" alt="${ch}"></div>`;
                col++;
            }
        }
    }

    html += '</div>';
    return html;
}

function formatHistoryDate(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    const diffH = Math.floor(diffMs / 3600000);
    const diffD = Math.floor(diffMs / 86400000);

    if (diffMin < 2) return "À l'instant";
    if (diffMin < 60) return `Il y a ${diffMin}min`;
    if (diffH < 24) return `Il y a ${diffH}h`;
    if (diffD < 7) return `Il y a ${diffD}j`;

    return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

// --- Last Match Widget (on main menu) ---

async function loadLastMatch() {
    const section = document.getElementById('last-match-section');
    if (!section) return;

    if (!supabaseClient) {
        section.classList.add('hidden');
        return;
    }

    try {
        // Query 1: games I saved
        const { data: myGames } = await supabaseClient
            .from('game_history')
            .select('*')
            .eq('player', myName)
            .order('played_at', { ascending: false })
            .limit(1);

        // Query 2: duo games saved by opponent (where I'm the opponent)
        const { data: duoGames } = await supabaseClient
            .from('game_history')
            .select('*')
            .eq('mode', 'duo')
            .eq('opponent', myName)
            .order('played_at', { ascending: false })
            .limit(1);

        // Pick the most recent between both
        const allGames = [...(myGames || []), ...(duoGames || [])];
        if (allGames.length === 0) {
            section.classList.add('hidden');
            return;
        }
        allGames.sort((a, b) => new Date(b.played_at) - new Date(a.played_at));
        const g = allGames[0];

        // Determine if we need to flip perspective (duo game saved by opponent)
        const isFlipped = g.mode === 'duo' && g.player !== myName;

        const resultEl = document.getElementById('last-match-result');
        const dateEl = document.getElementById('last-match-date');
        const avatar1 = section.querySelector('.lm-avatar-1');
        const avatar2 = section.querySelector('.lm-avatar-2');

        // Set avatars based on who won / mode
        if (myName === 'Benji') {
            avatar1.src = 'images/benji.png';
            avatar2.src = g.mode === 'solo' ? 'images/benji_robot.png' : 'images/sanaa.jpg';
        } else {
            avatar1.src = 'images/sanaa.jpg';
            avatar2.src = g.mode === 'solo' ? 'images/benji_robot.png' : 'images/benji.png';
        }

        // Adapt result for viewer
        let displayResult = g.result;
        if (isFlipped) {
            if (g.result === 'win') displayResult = 'loss';
            else if (g.result === 'loss') displayResult = 'win';
        }
        const displayOpponent = isFlipped ? g.player : g.opponent;

        // Result text (compact)
        let resultText = '';
        if (displayResult === 'win') {
            resultText = `Win vs ${displayOpponent}`;
        } else if (displayResult === 'loss') {
            resultText = `Loss vs ${displayOpponent}`;
        } else {
            resultText = `Draw vs ${displayOpponent}`;
        }
        resultEl.textContent = resultText;

        // Date
        dateEl.textContent = formatHistoryDate(new Date(g.played_at));

        section.classList.remove('hidden');
        // Trigger entrance animation after a short delay
        section.classList.remove('visible');
        requestAnimationFrame(() => {
            setTimeout(() => section.classList.add('visible'), 50);
        });
    } catch (e) {
        console.warn('loadLastMatch error:', e);
        section.classList.add('hidden');
    }
}

// ===================================================================
// REPLAY SYSTEM
// ===================================================================

let replayGame_data = null;
let replayMoveIndex = -1; // -1 = initial position
let replayMoves = [];
let replayChess = null;
let replayAutoplayInterval = null;
let replayIsPlaying = false;

function openReplay(gameData, autoAnalyze = false) {
    replayGame_data = gameData;
    replayMoveIndex = -1;
    replayIsPlaying = false;
    clearInterval(replayAutoplayInterval);
    replayAutoplayInterval = null;
    replayClassifications = [];
    replayEvaluations = [];
    replayBestMoves = [];
    replayAnalysisDone = false;

    // Parse PGN
    replayChess = new Chess();
    if (gameData.pgn) {
        const tempChess = new Chess();
        tempChess.load_pgn(gameData.pgn);
        replayMoves = tempChess.history({ verbose: true });
    } else {
        replayMoves = [];
    }

    // Set title
    const resultText = gameData.result === 'win' ? 'Victoire' : gameData.result === 'loss' ? 'Défaite' : 'Nul';
    document.getElementById('gr-title-text').textContent = `${resultText} vs ${gameData.opponent}`;
    const date = new Date(gameData.played_at);
    document.getElementById('gr-subtitle').textContent = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

    // Setup controls
    document.getElementById('gr-btn-start').onclick = () => { replayGoTo(-1); };
    document.getElementById('gr-btn-prev').onclick = () => { replayGoTo(replayMoveIndex - 1, true); };
    document.getElementById('gr-btn-next').onclick = () => { replayGoTo(replayMoveIndex + 1, true); };
    document.getElementById('gr-btn-end').onclick = () => { replayGoTo(replayMoves.length - 1); };
    document.getElementById('gr-btn-play').onclick = toggleAutoplay;

    // Reset review UI
    document.getElementById('gr-acc-white').textContent = '\u2014';
    document.getElementById('gr-acc-black').textContent = '\u2014';
    document.getElementById('gr-move-list').innerHTML = '';
    const grEvalBar = document.getElementById('gr-eval-bar');
    if (grEvalBar) grEvalBar.style.setProperty('--eval-pct', '50%');
    clearEvalGraphCanvas();

    // Render initial
    replayChess.reset();
    renderReplayBoard();
    updateReplayCounter();
    updateReplayProgress();
    updatePlayButtonIcon();

    // Close the history modal so it doesn't stay open in the background
    closeModal('game-history-modal');

    // Show review screen
    document.getElementById('review-screen').classList.add('show');

    // Réinitialiser les onglets du panel sur "Coups" (mobile)
    const _rPanel = document.querySelector('.review-panel');
    if (_rPanel) {
        _rPanel.querySelectorAll('.gr-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === 'moves');
        });
        _rPanel.querySelectorAll('.gr-tab-content').forEach(c => {
            c.classList.toggle('gr-tab-hidden', c.dataset.tabContent !== 'moves');
        });
    }

    // --- GAME REVIEW --- Launch background analysis
    if (replayMoves.length > 0) {
        analyzeFullGame(replayMoves);
    }
}

function closeReviewScreen() {
    stopAutoplay();
    replayAnalysisCancelled = true;
    document.getElementById('review-screen').classList.remove('show');
}

// --- TAB TOGGLE (onglets mobile: Coups / Graphique) ---
(function () {
    document.addEventListener('click', (e) => {
        const tab = e.target.closest('.gr-tab');
        if (!tab) return;
        const panel = tab.closest('.review-panel');
        if (!panel) return;
        const target = tab.dataset.tab;
        panel.querySelectorAll('.gr-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === target);
        });
        panel.querySelectorAll('.gr-tab-content').forEach(c => {
            c.classList.toggle('gr-tab-hidden', c.dataset.tabContent !== target);
        });
        // Re-rendre le graphique quand son onglet est activé
        // (canvas avait width=0 quand il était caché)
        if (target === 'graph') {
            requestAnimationFrame(() => renderEvalGraph());
        }
    });
})();

// --- GRAPH TAP: toucher le graphique pour sauter à un coup ---
(function () {
    const canvas = document.getElementById('gr-eval-graph');
    if (!canvas) return;

    function handleGraphTap(clientX) {
        if (replayEvaluations.length < 2) return;
        const rect = canvas.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        // replayEvaluations a N+1 entrées ; position 0 = avant tout coup (index -1)
        const posIdx = Math.round(ratio * (replayEvaluations.length - 1));
        replayGoTo(posIdx - 1, false);
    }

    canvas.addEventListener('click', (e) => handleGraphTap(e.clientX));
    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        handleGraphTap(e.touches[0].clientX);
    }, { passive: false });
})();

// Keyboard & swipe navigation for review screen
(function () {
    // Keyboard
    document.addEventListener('keydown', (e) => {
        const rs = document.getElementById('review-screen');
        if (!rs || !rs.classList.contains('show')) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            replayGoTo(replayMoveIndex + 1, true);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            replayGoTo(replayMoveIndex - 1, true);
        } else if (e.key === 'Home') {
            e.preventDefault();
            replayGoTo(-1);
        } else if (e.key === 'End') {
            e.preventDefault();
            replayGoTo(replayMoves.length - 1);
        } else if (e.key === 'Escape') {
            closeReviewScreen();
        }
    });

    // Touch swipe
    let _swipeTouchX = null;
    document.addEventListener('touchstart', (e) => {
        const rs = document.getElementById('review-screen');
        if (!rs || !rs.classList.contains('show')) return;
        // Only swipe if touching the board area
        if (e.target.closest('.review-board-col')) {
            _swipeTouchX = e.touches[0].clientX;
        }
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
        if (_swipeTouchX === null) return;
        const diff = e.changedTouches[0].clientX - _swipeTouchX;
        _swipeTouchX = null;
        if (Math.abs(diff) < 40) return;
        if (diff < 0) {
            replayGoTo(replayMoveIndex + 1, true); // swipe left = next
        } else {
            replayGoTo(replayMoveIndex - 1, true); // swipe right = prev
        }
    }, { passive: true });
})();

function replayGoTo(index, animate = false) {
    if (index < -1) index = -1;
    if (index >= replayMoves.length) index = replayMoves.length - 1;

    if (index >= replayMoves.length - 1) {
        stopAutoplay();
    }

    const prevIndex = replayMoveIndex;
    const isSingleStep = (animate || replayIsPlaying) && Math.abs(index - prevIndex) === 1;

    replayChess.reset();
    for (let i = 0; i <= index; i++) {
        replayChess.move(replayMoves[i].san);
    }
    replayMoveIndex = index;

    if (isSingleStep && index > prevIndex) {
        animateReplayMove(replayMoves[index], false);
    } else if (isSingleStep && index < prevIndex) {
        animateReplayMove(replayMoves[prevIndex], true);
    } else {
        renderReplayBoard();
    }
    updateReplayCounter();
    updateReplayProgress();

    // --- GAME REVIEW --- Eval bar in replay
    const flipped = replayGame_data && replayGame_data.my_color === 'b';
    const fen = replayChess.fen();
    const colorToMove = fen.split(' ')[1] || 'w';
    const grEvalBar = document.getElementById('gr-eval-bar');
    if (grEvalBar) {
        requestEval(fen).then(result => {
            updateEvalBar(result.cp, result.mate, colorToMove,
                grEvalBar,
                grEvalBar.querySelector('.gr-eval-label-top'),
                grEvalBar.querySelector('.gr-eval-label-bottom'),
                flipped
            );
        });
    }

    // --- GAME REVIEW --- Highlight active move in list
    highlightActiveMoveInList(index);

    // --- GAME REVIEW --- Update move info bar
    updateMoveInfo(index);

    // --- GAME REVIEW --- Update eval graph cursor
    updateEvalGraphCursor(index);
}

function animateReplayMove(move, isReverse) {
    const board = document.getElementById('gr-board');
    const flipped = replayGame_data.my_color === 'b';
    const boardRect = board.getBoundingClientRect();
    const sqSize = boardRect.width / 8;

    function squareToGrid(sq) {
        const file = sq.charCodeAt(0) - 97;
        const rank = 8 - parseInt(sq[1]);
        const col = flipped ? (7 - file) : file;
        const row = flipped ? (7 - rank) : rank;
        return { row, col };
    }

    const fromGrid = squareToGrid(isReverse ? move.to : move.from);
    const toGrid = squareToGrid(isReverse ? move.from : move.to);
    const fromIdx = fromGrid.row * 8 + fromGrid.col;
    const toIdx = toGrid.row * 8 + toGrid.col;

    // First render the DESTINATION state (current board after move)
    renderReplayBoard(true); // silent = skip highlight anim

    // Now find the piece that just arrived at destination and move it back, then animate forward
    const destSq = board.children[toIdx];
    const pieceImg = destSq ? destSq.querySelector('img') : null;

    if (!pieceImg) {
        // Fallback: just render normally
        renderReplayBoard();
        return;
    }

    // Calculate pixel delta (from source to dest)
    const dx = (fromGrid.col - toGrid.col) * sqSize;
    const dy = (fromGrid.row - toGrid.row) * sqSize;

    // Place piece at origin position instantly
    pieceImg.style.transition = 'none';
    pieceImg.style.transform = `translate(${dx}px, ${dy}px)`;
    pieceImg.classList.add('gr-piece-moving');

    // Handle captured piece (show it briefly then fade)
    if (!isReverse && move.captured) {
        const capturedSq = board.children[toIdx];
        // We need to show the captured piece fading out
        // The captured piece was at the destination before the move
        // Create a temporary captured piece overlay
        const captColor = move.color === 'w' ? 'black' : 'white';
        const pieceMap = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
        let capturedPieceName = pieceMap[move.captured];
        if (capturedPieceName) {
            const captImg = document.createElement('img');
            captImg.src = `pièces/default/${captColor}-${capturedPieceName}.png`;
            captImg.style.width = '82%';
            captImg.style.height = '82%';
            captImg.style.objectFit = 'contain';
            captImg.style.position = 'absolute';
            captImg.style.zIndex = '0';
            captImg.classList.add('gr-piece-captured');
            capturedSq.appendChild(captImg);
            setTimeout(() => captImg.remove(), 200);
        }
    }

    // Handle castling rook animation
    if (move.flags && (move.flags.includes('k') || move.flags.includes('q'))) {
        let rookFrom, rookTo;
        const rank = move.color === 'w' ? '1' : '8';
        if (move.flags.includes('k')) {
            rookFrom = isReverse ? 'f' + rank : 'h' + rank;
            rookTo = isReverse ? 'h' + rank : 'f' + rank;
        } else {
            rookFrom = isReverse ? 'd' + rank : 'a' + rank;
            rookTo = isReverse ? 'a' + rank : 'd' + rank;
        }
        const rookFromGrid = squareToGrid(rookFrom);
        const rookToGrid = squareToGrid(rookTo);
        const rookDestIdx = rookToGrid.row * 8 + rookToGrid.col;
        const rookDestSq = board.children[rookDestIdx];
        const rookImg = rookDestSq ? rookDestSq.querySelector('img') : null;
        if (rookImg) {
            const rookDx = (rookFromGrid.col - rookToGrid.col) * sqSize;
            const rookDy = (rookFromGrid.row - rookToGrid.row) * sqSize;
            rookImg.style.transition = 'none';
            rookImg.style.transform = `translate(${rookDx}px, ${rookDy}px)`;
            rookImg.classList.add('gr-piece-moving');
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    rookImg.style.transition = 'transform 0.22s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
                    rookImg.style.transform = 'translate(0, 0)';
                });
            });
        }
    }

    // Trigger the animation to destination
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            pieceImg.style.transition = 'transform 0.22s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
            pieceImg.style.transform = 'translate(0, 0)';
        });
    });

    // Clean up after animation
    setTimeout(() => {
        pieceImg.classList.remove('gr-piece-moving');
        pieceImg.style.transition = '';
        pieceImg.style.transform = '';
    }, 250);
}

function renderReplayBoard(silent) {
    const board = document.getElementById('gr-board');
    const flipped = replayGame_data.my_color === 'b';
    let html = '';

    // Determine current move info
    const currentMove = (replayMoveIndex >= 0 && replayMoveIndex < replayMoves.length)
        ? replayMoves[replayMoveIndex] : null;
    const currentCls = currentMove && replayClassifications[replayMoveIndex]
        ? replayClassifications[replayMoveIndex] : null;
    const bestMove = currentMove && replayBestMoves[replayMoveIndex]
        ? replayBestMoves[replayMoveIndex] : null;
    const showBestMove = bestMove && currentCls && currentCls !== 'best' && currentCls !== 'brilliant';

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const row = flipped ? (7 - r) : r;
            const col = flipped ? (7 - c) : c;
            const file = String.fromCharCode(97 + col);
            const rank = 8 - row;
            const squareName = file + rank;
            const isLight = (row + col) % 2 === 0;

            let squareExtraClasses = '';
            let overlayHtml = '';

            if (currentMove) {
                const config = currentCls ? CLASSIFICATION_CONFIG[currentCls] : null;
                if (squareName === currentMove.to) {
                    squareExtraClasses = currentCls ? `highlight-${currentCls}` : 'highlight';
                    if (config) {
                        overlayHtml += `<div class="gr-class-icon" style="background:${config.color}">${config.icon}</div>`;
                    }
                } else if (squareName === currentMove.from) {
                    squareExtraClasses = currentCls ? `highlight-from-${currentCls}` : 'highlight-from';
                }
            }

            const piece = replayChess.get(squareName);
            let pieceHtml = '';
            if (piece) {
                const color = piece.color === 'w' ? 'white' : 'black';
                const pieceMap = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
                pieceHtml = `<img src="pièces/default/${color}-${pieceMap[piece.type]}.png" alt="${piece.type}">`;
            }

            html += `<div class="gr-sq ${isLight ? 'light' : 'dark'}${squareExtraClasses ? ' ' + squareExtraClasses : ''}">${overlayHtml}${pieceHtml}</div>`;
        }
    }

    board.innerHTML = html;

    // Draw SVG arrow for best move
    drawBestMoveArrow(board, bestMove, showBestMove, flipped);
}

function drawBestMoveArrow(board, bestMove, show, flipped) {
    // Remove previous arrow
    const prev = board.querySelector('.gr-best-arrow-svg');
    if (prev) prev.remove();
    if (!show || !bestMove) return;

    function squareToColRow(sq) {
        const file = sq.charCodeAt(0) - 97; // 0–7
        const rank = parseInt(sq[1]) - 1;    // 0–7
        const col = flipped ? (7 - file) : file;
        const row = flipped ? rank : (7 - rank);
        return { col, row };
    }

    const from = squareToColRow(bestMove.from);
    const to   = squareToColRow(bestMove.to);

    // Center coords in percent of board (each square = 12.5%)
    const sq = 12.5;
    const x1 = from.col * sq + sq / 2;
    const y1 = from.row * sq + sq / 2;
    const x2 = to.col * sq + sq / 2;
    const y2 = to.row * sq + sq / 2;

    // Shorten line to avoid covering the arrowhead anchor square center
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = dx / len, ny = dy / len;
    const shrink = 3.5;
    const ax2 = x2 - nx * shrink;
    const ay2 = y2 - ny * shrink;

    const markerId = 'gr-arrow-' + Math.random().toString(36).slice(2, 8);
    const arrowColor = 'rgba(90,190,255,0.90)';

    const arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowSvg.setAttribute('viewBox', '0 0 100 100');
    arrowSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    arrowSvg.classList.add('gr-best-arrow-svg');

    arrowSvg.innerHTML = `
        <defs>
            <marker id="${markerId}" markerWidth="4.5" markerHeight="4.5" refX="2.5" refY="2.25" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L4.5,2.25 L0,4.5 Z" fill="${arrowColor}"/>
            </marker>
        </defs>
        <line x1="${x1}" y1="${y1}" x2="${ax2}" y2="${ay2}"
              stroke="${arrowColor}" stroke-width="2.2"
              stroke-linecap="round"
              marker-end="url(#${markerId})"/>
    `;

    board.appendChild(arrowSvg);
}

function updateReplayProgress() {
    const bar = document.getElementById('gr-progress-bar');
    if (!bar) return;
    const total = replayMoves.length;
    const pct = total > 0 ? ((replayMoveIndex + 1) / total) * 100 : 0;
    bar.style.width = pct + '%';
}

function updateReplayCounter() {
    const counter = document.getElementById('gr-move-counter');
    const current = replayMoveIndex + 1;
    const total = replayMoves.length;
    counter.textContent = `${current} / ${total}`;
}

function toggleAutoplay() {
    if (replayIsPlaying) {
        stopAutoplay();
    } else {
        startAutoplay();
    }
}

function startAutoplay() {
    if (replayMoveIndex >= replayMoves.length - 1) {
        // Reset to start if at end
        replayGoTo(-1);
    }
    replayIsPlaying = true;
    updatePlayButtonIcon();
    replayAutoplayInterval = setInterval(() => {
        if (replayMoveIndex >= replayMoves.length - 1) {
            stopAutoplay();
            return;
        }
        replayGoTo(replayMoveIndex + 1, true);
    }, 900);
}

function stopAutoplay() {
    replayIsPlaying = false;
    clearInterval(replayAutoplayInterval);
    replayAutoplayInterval = null;
    updatePlayButtonIcon();
}

function updatePlayButtonIcon() {
    const btn = document.getElementById('gr-btn-play');
    const icon = document.getElementById('gr-play-icon');
    if (replayIsPlaying) {
        btn.classList.add('playing');
        icon.innerHTML = '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';
    } else {
        btn.classList.remove('playing');
        icon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
    }
}

// ===================================================================
// GAME REVIEW SYSTEM — Classification, Accuracy, Eval Graph
// ===================================================================

// --- GAME REVIEW ---
let replayClassifications = [];
let replayEvaluations = [];
let replayBestMoves = []; // best engine move per position
let replayAnalysisDone = false;
let replayAnalysisCancelled = false;

const _ICON_THUMB = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:12px;height:12px;display:block"><path d="M2 20h2c.55 0 1-.45 1-1v-9c0-.55-.45-1-1-1H2v11zm19.83-7.12c.11-.25.17-.52.17-.8V11c0-1.1-.9-2-2-2h-5.5l.92-4.65c.05-.22.02-.46-.08-.66-.23-.45-.52-.86-.88-1.22L14 2 7.59 8.41C7.21 8.79 7 9.3 7 9.83V19c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3-7.11z"/></svg>`;

const CLASSIFICATION_CONFIG = {
    brilliant:  { label: 'Brillant',    icon: '!!',         color: '#1bada6' },
    best:       { label: 'Meilleur',    icon: '★',          color: '#6eaedb' },
    excellent:  { label: 'Excellent',   icon: '!',          color: '#96bc4b' },
    good:       { label: 'Bien',        icon: _ICON_THUMB,  color: '#96bc4b' },
    inaccuracy: { label: 'Imprécision', icon: '?!',         color: '#f0c040' },
    mistake:    { label: 'Erreur',      icon: '?',          color: '#e58c28' },
    blunder:    { label: 'Gaffe',       icon: '??',         color: '#ca3431' }
};

// ─── UN SEUL APPEL MOTEUR PAR POSITION ─────────────────────────────────────
// MultiPV 2 : retourne les 2 meilleurs coups + scores depuis le côté à jouer
// Résultat : { bestMove, secondMove, cp, cp2, mate }
function requestAnalysisPosition(fen) {
    return new Promise((resolve) => {
        const engine = getStockfishEval();
        // Couper toute recherche précédente
        if (evalResolve) {
            evalResolve({ cp: 0, mate: null });
            evalResolve = null;
            engine.postMessage('stop');
        }

        const pvData = {}; // { 1: {cp, mate, move}, 2: {cp, mate, move} }

        engine.onmessage = function (e) {
            const line = typeof e.data === 'string' ? e.data : '';
            if (!line) return;

            if (line.startsWith('info') && line.includes(' pv ') && line.includes('score')) {
                const pvIdx = parseInt((line.match(/ multipv (\d+)/) || [, '1'])[1]);
                if (!pvData[pvIdx]) pvData[pvIdx] = { cp: 0, mate: null, move: null };
                const cpM = line.match(/score cp (-?\d+)/);
                const matM = line.match(/score mate (-?\d+)/);
                const pvM  = line.match(/ pv ([a-h][1-8][a-h][1-8][a-z]?)/);
                if (cpM)  { pvData[pvIdx].cp = parseInt(cpM[1]); pvData[pvIdx].mate = null; }
                if (matM) { pvData[pvIdx].mate = parseInt(matM[1]);
                            pvData[pvIdx].cp = pvData[pvIdx].mate > 0 ? 9999 : -9999; }
                if (pvM)  { pvData[pvIdx].move = pvM[1]; }
            }

            if (line.startsWith('bestmove')) {
                engine.onmessage = _stockfishDefaultHandler;
                const p1 = pvData[1] || { cp: 0, mate: null, move: null };
                const p2 = pvData[2] || null;
                resolve({
                    bestMove:   p1.move,
                    secondMove: p2 ? p2.move : null,
                    cp:         p1.cp,
                    cp2:        p2 ? p2.cp : null,
                    mate:       p1.mate
                });
            }
        };

        engine.postMessage('setoption name MultiPV value 2');
        engine.postMessage('setoption name Hash value 64');
        engine.postMessage('position fen ' + fen);
        engine.postMessage('go depth 20 movetime 200');
    });
}

async function analyzeFullGame(moves) {
    replayAnalysisCancelled = false;
    const loader    = document.getElementById('gr-analysis-loader');
    const loaderTxt = loader ? loader.querySelector('span') : null;
    if (loader) loader.classList.remove('hidden');

    replayClassifications = new Array(moves.length).fill(null);
    replayEvaluations     = new Array(moves.length + 1).fill(0);
    replayBestMoves       = new Array(moves.length).fill(null);

    const clamp = v => Math.max(-2000, Math.min(2000, v));

    // ── Construire tous les FENs en une passe ────────────────────────────────
    const chess = new Chess();
    const fens  = [chess.fen()]; // fens[i] = position avant le coup i, fens[N] = position finale
    for (let i = 0; i < moves.length; i++) {
        chess.move(moves[i].san);
        fens.push(chess.fen());
    }

    // ── Analyser chaque position (N+1 appels au lieu de 2N) ──────────────────
    // fens[i] est évalué → résultat utilisé comme "avant" pour le coup i
    //                     ET comme "après" pour le coup i-1
    const results = new Array(fens.length).fill(null);

    for (let i = 0; i < fens.length; i++) {
        if (replayAnalysisCancelled) break;

        if (loaderTxt) loaderTxt.textContent =
            `Analyse en cours… ${Math.round(i / fens.length * 100)}%`;

        results[i] = await requestAnalysisPosition(fens[i]);
        if (replayAnalysisCancelled) break;

        // ── Dès qu'on a results[i], on peut classer le coup i-1 ──────────────
        if (i > 0) {
            const mi   = i - 1; // index du coup à classer
            const fen0 = fens[mi];

            // Côté qui joue le coup mi (extrait du FEN)
            const colorBefore = fens[mi].split(' ')[1]; // 'w' ou 'b'

            const resBefore = results[i - 1]; // analyse avant le coup
            const resAfter  = results[i];     // analyse après le coup

            // Score du meilleur coup depuis le point de vue du joueur (avant)
            const bestCpFromMover = clamp(
                resBefore.mate !== null
                    ? (resBefore.mate > 0 ? 9999 : -9999)
                    : resBefore.cp
            );

            // Score après le coup : côté adverse à jouer → on négative pour revenir
            const afterCpOpponentRaw = resAfter.mate !== null
                ? (resAfter.mate > 0 ? 9999 : -9999)
                : resAfter.cp;
            const afterCpOpponent   = clamp(afterCpOpponentRaw);
            const actualFromMoverPov = -afterCpOpponent;

            const diff = bestCpFromMover - actualFromMoverPov;

            // Coup joué vs meilleur / 2e meilleur moteur
            const actualUCI   = moves[mi].from + moves[mi].to + (moves[mi].promotion || '');
            const isTopMove   = resBefore.bestMove   && actualUCI === resBefore.bestMove;
            const isSecondMove= resBefore.secondMove && actualUCI === resBefore.secondMove;

            // ── Stocker le meilleur coup pour affichage ───────────────────────
            if (resBefore.bestMove) {
                const tmp = new Chess(fen0);
                const bm  = tmp.move({
                    from: resBefore.bestMove.slice(0, 2),
                    to:   resBefore.bestMove.slice(2, 4),
                    promotion: resBefore.bestMove[4] || 'q'
                });
                replayBestMoves[mi] = {
                    uci:  resBefore.bestMove,
                    san:  bm ? bm.san : resBefore.bestMove,
                    from: resBefore.bestMove.slice(0, 2),
                    to:   resBefore.bestMove.slice(2, 4)
                };
            }

            // ── Classification ────────────────────────────────────────────────
            // Scaling contextuel : en position déjà décidée (±400cp+), les petites
            // erreurs de cp ont moins d'importance → on assouplit les seuils.
            // scale va de 1.0 (position équilibrée) jusqu'à 2.5 (victoire/défaite nette).
            const posBalance = Math.abs(bestCpFromMover);
            const scale = Math.min(2.5, 1 + Math.max(0, posBalance - 400) / 500);

            let cls;
            if      (isTopMove)                                cls = 'best';      // exact top moteur
            else if (isSecondMove || diff <= 8  * scale)      cls = 'excellent';
            else if (diff <= 35  * scale)                     cls = 'good';
            else if (diff <= 90  * scale)                     cls = 'inaccuracy';
            else if (diff <= 220 * scale)                     cls = 'mistake';
            else                                              cls = 'blunder';

            // Brillant : amélioration significative sur le choix moteur
            if (!isTopMove && !isSecondMove && diff < -60 && posBalance <= 400)
                cls = 'brilliant';

            replayClassifications[mi] = cls;

            // ── Graphe (perspective blanche absolue) ──────────────────────────
            // replayEvaluations[i] = eval à la position i, côté blanc
            // results[i].cp est du côté de l'adversaire (après le coup)
            replayEvaluations[i] = colorBefore === 'w' ? -afterCpOpponent : afterCpOpponent;
            if (mi === 0) {
                // Position initiale
                replayEvaluations[0] = colorBefore === 'w' ? bestCpFromMover : -bestCpFromMover;
            }

            // ── Mise à jour UI progressive tous les 6 coups ───────────────────
            if (mi % 6 === 5 || mi === moves.length - 1) {
                renderMoveList();
                renderEvalGraph();
            }
        }
    }

    // Position finale (pas de coup associé, juste le graphe)
    if (!replayAnalysisCancelled && results[moves.length]) {
        const lastColor = fens[moves.length].split(' ')[1];
        const lastCp = clamp(
            results[moves.length].mate !== null
                ? (results[moves.length].mate > 0 ? 9999 : -9999)
                : results[moves.length].cp
        );
        replayEvaluations[moves.length] = lastColor === 'w' ? lastCp : -lastCp;
    }

    // Réinitialiser MultiPV à 1 pour ne pas perturber l'eval normale
    if (stockfishEval) stockfishEval.postMessage('setoption name MultiPV value 1');

    if (!replayAnalysisCancelled) {
        replayAnalysisDone = true;
        renderMoveList();
        renderEvalGraph();
        calculateAndDisplayAccuracy();
        renderReplayBoard();
        updateMoveInfo(replayMoveIndex);
    }

    if (loader) loader.classList.add('hidden');
}

function renderMoveList() {
    const list = document.getElementById('gr-move-list');
    if (!list) return;
    let html = '';

    const buildMoveHtml = (i) => {
        const cls = replayClassifications[i];
        const best = replayBestMoves[i];
        const isActive = replayMoveIndex === i;
        const showBest = cls && cls !== 'best' && cls !== 'brilliant' && best;
        const cfgCls = cls ? CLASSIFICATION_CONFIG[cls] : null;

        const badge = cfgCls
            ? `<span class="gr-ml-badge" style="background:${cfgCls.color}" title="${cfgCls.label}">${cfgCls.icon}</span>`
            : '';
        const bestHint = showBest
            ? `<span class="gr-ml-best-hint" title="Meilleur coup">${best.san}</span>`
            : '';

        return `<div class="gr-ml-move${isActive ? ' active' : ''}" data-move-idx="${i}">
            <span class="gr-ml-san">${replayMoves[i].san}</span>${badge}${bestHint}
        </div>`;
    };

    for (let i = 0; i < replayMoves.length; i += 2) {
        const moveNum = Math.floor(i / 2) + 1;
        const blackHtml = (i + 1 < replayMoves.length) ? buildMoveHtml(i + 1) : '<div class="gr-ml-move gr-ml-empty"></div>';
        html += `<div class="gr-ml-row">
            <span class="gr-ml-number">${moveNum}.</span>
            ${buildMoveHtml(i)}
            ${blackHtml}
        </div>`;
    }

    list.innerHTML = html;

    list.querySelectorAll('.gr-ml-move').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.moveIdx);
            replayGoTo(idx);
        });
    });

    highlightActiveMoveInList(replayMoveIndex);
}

function highlightActiveMoveInList(index) {
    const list = document.getElementById('gr-move-list');
    if (!list) return;
    list.querySelectorAll('.gr-ml-move').forEach(el => {
        const idx = parseInt(el.dataset.moveIdx);
        el.classList.toggle('active', idx === index);
    });

    // Auto-scroll
    const active = list.querySelector('.gr-ml-move.active');
    if (active) {
        active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function updateMoveInfo(index) {
    const infoEl = document.getElementById('gr-move-info');
    const iconEl = document.getElementById('gr-info-icon');
    const labelEl = document.getElementById('gr-info-label');
    const bestWrap = document.getElementById('gr-info-best');
    const bestSanEl = document.getElementById('gr-info-best-san');
    if (!infoEl) return;

    if (index < 0 || index >= replayMoves.length || !replayClassifications[index]) {
        infoEl.classList.add('hidden');
        return;
    }

    const cls = replayClassifications[index];
    const config = CLASSIFICATION_CONFIG[cls];
    const best = replayBestMoves[index];

    infoEl.classList.remove('hidden');
    iconEl.innerHTML = config.icon;
    iconEl.style.color = config.color;
    labelEl.textContent = config.label;
    infoEl.style.setProperty('--info-color', config.color);

    if (best && cls !== 'best' && cls !== 'brilliant' && bestSanEl) {
        bestWrap.classList.remove('hidden');
        bestSanEl.textContent = best.san;
    } else if (bestWrap) {
        bestWrap.classList.add('hidden');
    }
}

function renderEvalGraph() {
    const canvas = document.getElementById('gr-eval-graph');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    const isMobile = window.innerWidth <= 768;
    const graphH = isMobile ? 130 : 48;
    canvas.width = rect.width * (window.devicePixelRatio || 1);
    canvas.height = graphH * (window.devicePixelRatio || 1);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = graphH + 'px';
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

    const w = rect.width;
    const h = graphH;
    const total = replayEvaluations.length;
    if (total < 2) return;

    // Background gradient
    const gradTop = ctx.createLinearGradient(0, 0, 0, h);
    gradTop.addColorStop(0, 'rgba(30,30,30,0.6)');
    gradTop.addColorStop(0.5, 'rgba(50,50,50,0.3)');
    gradTop.addColorStop(1, 'rgba(240,240,240,0.6)');
    ctx.fillStyle = gradTop;
    ctx.fillRect(0, 0, w, h);

    // Reference line at y=50%
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Eval curve
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;

    for (let i = 0; i < total; i++) {
        const x = (i / (total - 1)) * w;
        let cp = replayEvaluations[i];
        cp = Math.max(-1000, Math.min(1000, cp));
        const y = h / 2 - (cp / 1000) * (h / 2 - 4);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill area
    ctx.lineTo((total - 1) / (total - 1) * w, h / 2);
    ctx.lineTo(0, h / 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(136,176,75,0.15)';
    ctx.fill();

    // Cursor for current move
    updateEvalGraphCursor(replayMoveIndex);
}

function updateEvalGraphCursor(index) {
    const canvas = document.getElementById('gr-eval-graph');
    if (!canvas || replayEvaluations.length < 2) return;

    renderEvalGraphBase();

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const total = replayEvaluations.length;
    const cursorIdx = index + 1;
    if (cursorIdx < 0 || cursorIdx >= total) return;

    const x = (cursorIdx / (total - 1)) * w;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = 'var(--accent)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.restore();
}

function renderEvalGraphBase() {
    const canvas = document.getElementById('gr-eval-graph');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const total = replayEvaluations.length;
    if (total < 2) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    const gradTop = ctx.createLinearGradient(0, 0, 0, h);
    gradTop.addColorStop(0, 'rgba(30,30,30,0.6)');
    gradTop.addColorStop(0.5, 'rgba(50,50,50,0.3)');
    gradTop.addColorStop(1, 'rgba(240,240,240,0.6)');
    ctx.fillStyle = gradTop;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;

    for (let i = 0; i < total; i++) {
        const x = (i / (total - 1)) * w;
        let cp = replayEvaluations[i];
        cp = Math.max(-1000, Math.min(1000, cp));
        const y = h / 2 - (cp / 1000) * (h / 2 - 4);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const lastX = w;
    ctx.lineTo(lastX, h / 2);
    ctx.lineTo(0, h / 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(136,176,75,0.15)';
    ctx.fill();
    ctx.restore();
}

function clearEvalGraphCanvas() {
    const canvas = document.getElementById('gr-eval-graph');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function calculateAndDisplayAccuracy() {
    if (replayClassifications.length === 0) return;

    const scoreMap = {
        brilliant: 100, best: 100, excellent: 95,
        good: 80, inaccuracy: 50, mistake: 20, blunder: 0
    };

    let whiteScores = [], blackScores = [];
    for (let i = 0; i < replayClassifications.length; i++) {
        const cls = replayClassifications[i];
        if (!cls) continue;
        const score = scoreMap[cls] || 50;
        if (i % 2 === 0) whiteScores.push(score);
        else blackScores.push(score);
    }

    const avg = arr => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const whiteAcc = avg(whiteScores);
    const blackAcc = avg(blackScores);

    const wEl = document.getElementById('gr-acc-white');
    const bEl = document.getElementById('gr-acc-black');
    if (wEl) wEl.textContent = whiteAcc + '%';
    if (bEl) bEl.textContent = blackAcc + '%';
}
