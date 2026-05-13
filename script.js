// Configuration Supabase
let supabaseClient = null;

// Configuration Jeu
const GAME_ID = CONFIG.GAME_ID; // ID unique pour la partie

let game = null;
let myColor = null; // 'w' or 'b'
let myName = null;
let selectedSquare = null;
let lastMove = null;
let boardFlipped = false;

let premoveQueue = [];

let selectedColorChoice = null;
let selectedTimeChoice = 5;
let whiteTimeRemaining = 0;
let blackTimeRemaining = 0;
let lastMoveTimestamp = 0;
let timerInterval = null;
let timeControl = 0;

let gameMode = 'duo';
let botDifficulty = 1;
let isBotThinking = false; // Mutex: true while a Stockfish search is in progress
let duoInitializing = false; // Flag to ignore stale Supabase states during new game init
let isPageLoadingComplete = false; // Flag to suppress modal display on page reload

// Local (Pass-and-Play) mode state.
// When gameMode === 'local', both players share the same screen.
// `localAutoRotate` controls whether the board flips automatically each turn.
let localAutoRotate = true;
let isPromotionPending = false; // Lock during promotion picker

// Undo/redo stack for local pass-and-play.
// Each entry: { move: <chess.js verbose move>, timeSnapshot: { white, black, last } }
let localRedoStack = [];

// Anti-spam for system notices (leave / etc.)
let lastSystemNoticeAt = 0;

// Track last game params for "Rejouer" (replay with same settings)
let lastGameParams = null;

// --- RELIABLE MOVE SYNC: retry queue for failed Supabase updates ---
let pendingMoveSync = null; // Stores the last move payload that failed to sync

/**
 * Push the current game state to Supabase with automatic retry.
 * If all retries fail, the payload is stored in `pendingMoveSync`
 * and will be flushed on the next visibilitychange or next successful move.
 * @param {Object} payload  - The fields to update in chess_state
 * @param {number} maxRetries - Number of retry attempts (default 3)
 */
async function syncMoveToSupabase(payload, maxRetries = 3) {
    if (!supabaseClient) return;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const { error } = await supabaseClient
                .from('chess_state')
                .update(payload)
                .eq('id', GAME_ID);

            if (!error) {
                // Success — clear any pending sync
                pendingMoveSync = null;
                return;
            }

            console.warn(`syncMoveToSupabase attempt ${attempt + 1} failed (API error):`, error.message);
        } catch (networkErr) {
            console.warn(`syncMoveToSupabase attempt ${attempt + 1} failed (network):`, networkErr);
        }

        // Exponential backoff: 300ms, 900ms, 2700ms
        if (attempt < maxRetries - 1) {
            await new Promise(r => setTimeout(r, 300 * Math.pow(3, attempt)));
        }
    }

    // All retries exhausted — store for later flush
    console.error('syncMoveToSupabase: all retries failed, queuing for later');
    pendingMoveSync = payload;
}

/**
 * Flush any pending move that failed to sync previously.
 * Called on visibilitychange and before every new move sync.
 */
async function flushPendingSync() {
    if (!pendingMoveSync || !supabaseClient) return;

    const payload = pendingMoveSync;
    pendingMoveSync = null; // Clear first to avoid infinite loops

    try {
        const { error } = await supabaseClient
            .from('chess_state')
            .update(payload)
            .eq('id', GAME_ID);

        if (error) {
            console.warn('flushPendingSync failed:', error.message);
            pendingMoveSync = payload; // Re-queue
        } else {
            console.log('flushPendingSync: pending move successfully synced');
        }
    } catch (e) {
        console.warn('flushPendingSync network error:', e);
        pendingMoveSync = payload; // Re-queue
    }
}

// Stockfish Web Worker (local engine)
const stockfish = new Worker('lib/stockfish.js');
let stockfishResolve = null; // Promise resolver for current move request
let stockfishReady = false; // true once Stockfish has sent 'uciok'

stockfish.onmessage = function (e) {
    const line = typeof e.data === 'string' ? e.data : '';
    if (!line) return;

    // --- Intelligent UCI message filtering ---
    // Only process game-relevant messages; silently ignore engine noise.
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
            // bestmove (none) — no legal move, resolve null
            stockfishResolve(null);
            stockfishResolve = null;
        }
        return;
    }

    // Synchronization tokens — used internally, no console output
    if (line === 'uciok' || line === 'readyok') {
        if (line === 'uciok') stockfishReady = true;
        return;
    }

    // Silently ignore all other UCI messages:
    // 'info ...', 'option ...', 'id ...', debug lines, etc.
};

// --- EVAL BAR ---
const stockfishEval = new Worker('lib/stockfish.js');
let evalResolve = null;
let evalReady = false;
let evalAbortController = null;
let lastEvalCp = 0;
let lastEvalMate = null;

stockfishEval.postMessage('uci');

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
// Keep a reference to the default handler so analysis functions can restore it
const _stockfishDefaultHandler = stockfishEval.onmessage;

function requestEval(fen) {
    return new Promise((resolve) => {
        if (evalResolve) {
            evalResolve({ cp: 0, mate: null });
            evalResolve = null;
            stockfishEval.postMessage('stop');
        }
        resolve._lastResult = null;
        evalResolve = resolve;
        stockfishEval.postMessage('position fen ' + fen);
        stockfishEval.postMessage('go depth 14');
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
    if (gameMode === 'duo' && timeControl > 0) {
        bar.style.display = 'none';
    } else {
        bar.style.display = '';
    }
}

// Drag Variables
let sourceSquare = null;

// Audio assets
const AUDIO_FILES = {
    move: 'sound/move-self.mp3',
    capture: 'sound/capture.mp3',
    gameOver: 'sound/faaah.mp3',
    check: 'sound/echec.mp3'
};
const SOUNDS = {};
let audioCtx = null;
let checkSoundSource = null;
let checkSoundGain = null;

async function loadSounds() {
    try {
        // Initialize AudioContext only once
        if (!audioCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            audioCtx = new AudioContext();
        }

        for (const key of Object.keys(AUDIO_FILES)) {
            const response = await fetch(AUDIO_FILES[key]);
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            SOUNDS[key] = audioBuffer;
        }
    } catch (e) {
        console.warn('Erreur preload sons (Web Audio API):', e);
    }
}

function playSound(name) {
    // If context isn't ready or suspended (browser policy), try to resume
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
    }

    const buffer = SOUNDS[name];
    if (!audioCtx || !buffer) return;

    try {
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.start(0);
    } catch (e) {
        console.warn('Erreur lecture son:', e);
    }
}

function startCheckSound() {
    if (!audioCtx || !SOUNDS.check) return;
    if (checkSoundSource) return; // already playing
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

    try {
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.15, audioCtx.currentTime + 0.5);
        gain.connect(audioCtx.destination);

        const source = audioCtx.createBufferSource();
        source.buffer = SOUNDS.check;
        source.loop = true;
        source.connect(gain);
        source.start(0);

        checkSoundSource = source;
        checkSoundGain = gain;
    } catch (e) {
        console.warn('Erreur check sound:', e);
    }
}

function stopCheckSound() {
    if (!checkSoundGain || !checkSoundSource) return;
    try {
        const now = audioCtx.currentTime;
        checkSoundGain.gain.cancelScheduledValues(now);
        checkSoundGain.gain.setValueAtTime(checkSoundGain.gain.value, now);
        checkSoundGain.gain.linearRampToValueAtTime(0, now + 0.4);
        const src = checkSoundSource;
        setTimeout(() => { try { src.stop(); } catch (e) {} }, 450);
    } catch (e) {}
    checkSoundSource = null;
    checkSoundGain = null;
}

// History Navigation
let viewIndex = null; // null = live, -1 = start, 0 = after 1st move...
let lastAnimatedSquare = null;
let snapDragOffset = null;

async function navigateHistory(direction) {
    const history = game.history({ verbose: true });
    if (history.length === 0) return; // Pas d'historique disponible

    const maxIndex = history.length - 1;
    let oldIndex = viewIndex === null ? maxIndex : viewIndex;
    let newIndex;

    // Initialize viewIndex if null (Live)
    if (viewIndex === null) {
        if (direction === -1) {
            newIndex = maxIndex - 1;
        } else {
            return; // Already at end
        }
    } else {
        newIndex = viewIndex + direction;
    }

    // Clamp
    if (newIndex < -1) newIndex = -1; // Start position
    if (newIndex >= maxIndex) newIndex = null; // Back to live

    // Determine the move that is happening or being undone
    let moveToAnimate = null;
    let isUndo = false;

    if (direction === -1 && oldIndex >= 0) {
        moveToAnimate = history[oldIndex];
        isUndo = true; // backward animation
    } else if (direction === 1 && newIndex !== null && newIndex >= 0) {
        moveToAnimate = history[newIndex];
    } else if (direction === 1 && newIndex === null && oldIndex === maxIndex - 1) {
        moveToAnimate = history[maxIndex];
    }

    if (moveToAnimate) {
        // Find square from which to animate based on direction
        const fromSquare = isUndo ? moveToAnimate.to : moveToAnimate.from;
        const toSquare = isUndo ? moveToAnimate.from : moveToAnimate.to;
        await animateMove(fromSquare, toSquare);
    }

    viewIndex = newIndex;

    renderBoard();
    updateStatus();
    updateHistoryButtons();

    // --- EVAL BAR ---
    const evalGame = viewIndex === null ? game : getHistoricalGame(viewIndex);
    if (evalGame) triggerEvalForPosition(evalGame.fen());
}

function getHistoricalGame(index) {
    const tempChess = new Chess();
    const history = game.history({ verbose: true });
    for (let i = 0; i <= index && i < history.length; i++) {
        tempChess.move(history[i].san);
    }
    return tempChess;
}

function updateHistoryButtons() {
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const history = game.history();

    if (viewIndex === null) {
        // Disable Prev if no history OR if history has only 1 move and we are at live (optional, but consistent)
        // Actually, if history has 1 move, we can go back to Start (-1). So enabled if length > 0.
        btnPrev.disabled = (history.length === 0);
        btnNext.disabled = true;

        // Visual fix: If history is empty, opacity is lower
        btnPrev.style.opacity = (history.length === 0) ? '0.3' : '1';
    } else {
        btnPrev.disabled = (viewIndex === -1);
        btnNext.disabled = false;

        btnPrev.style.opacity = (viewIndex === -1) ? '0.3' : '1';
    }
    btnNext.style.opacity = (btnNext.disabled) ? '0.3' : '1';
}

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const gameScreen = document.getElementById('game-screen');
const passwordInput = document.getElementById('password-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('game-status');
const myNameEl = document.getElementById('my-name');
const opponentNameEl = document.getElementById('opponent-name');
const myIndicator = document.getElementById('my-indicator');
const opponentIndicator = document.getElementById('opponent-indicator');
const myTimerEl = document.getElementById('my-timer');
const opponentTimerEl = document.getElementById('opponent-timer');
const newGameModal = document.getElementById('new-game-modal');
const settingsModal = document.getElementById('settings-modal');
const gameOverModal = document.getElementById('game-over-modal');
const gameOverTitle = document.getElementById('game-over-title');
const gameOverMessage = document.getElementById('game-over-message');
const startGameBtn = document.getElementById('start-game-btn');
const settingsDropdown = document.getElementById('settings-dropdown');

// --- INIT & LOGIN ---
// S'assurer que l'appli s'initialise même si DOMContentLoaded est déjà passé
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('DOM chargé (event)');
        initializeApp();
    });
} else {
    console.log('DOM déjà prêt');
    initializeApp();
}

function initializeApp() {
    try {
        game = new Chess();
        console.log('Chess.js initialisé:', game);

        if (window.supabase && window.supabase.createClient) {
            const { createClient } = window.supabase;
            supabaseClient = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
            console.log('Supabase initialisé');
        } else {
            console.warn('Supabase non disponible');
        }

        checkLogin().then(() => {
            const params = new URLSearchParams(window.location.search);
            if (params.get('from') === 'push') {
                console.log('Retour via notification push');
                // Nettoyer l'URL pour éviter un re-trigger au refresh
                const cleanUrl = window.location.pathname;
                window.history.replaceState({}, '', cleanUrl);
                if (myName) {
                    resumeGame('duo');
                }
            }
        });
        loadTheme();
        checkNotificationStatus();
        loadSounds();
    } catch (error) {
        console.error('Erreur initialisation:', error);
    }
}

async function checkLogin() {
    if (!supabaseClient) {
        // Offline complet
        const savedName = localStorage.getItem('chess_user_name');
        if (savedName) login(savedName);
        return;
    }

    const { data: { session } } = await supabaseClient.auth.getSession();

    if (session) {
        // Find which user it is based on email
        const email = session.user.email;
        const name = email === 'benji@chess.local' ? 'Benji' : 'Sanaa';
        localStorage.setItem('chess_user_name', name);
        login(name);
    } else {
        // Plus de session Supabase valide : on force la reconnexion
        // Le loginScreen est affiché par défaut au chargement.
        localStorage.removeItem('chess_user_name');
    }
}

function loadTheme() {
    let savedTheme = localStorage.getItem('chess_theme') || 'dark';
    
    // Migration de l'ancien thème 'light' vers 'noir'
    if (savedTheme === 'light') {
        savedTheme = 'noir';
        localStorage.setItem('chess_theme', 'noir');
    }

    if (savedTheme === 'custom') {
        document.documentElement.setAttribute('data-theme', 'custom');
        loadCustomColors();
    } else {
        document.documentElement.setAttribute('data-theme', savedTheme);
    }
    // Ensure meta theme-color matches current CSS variables on load
    updateThemeColor();
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('chess_theme', theme);

    // Clean up custom inline styles if not custom
    if (theme !== 'custom') {
        const root = document.documentElement;
        root.style.removeProperty('--bg-color');
        root.style.removeProperty('--card-bg');
        root.style.removeProperty('--board-light');
        root.style.removeProperty('--board-dark');
        root.style.removeProperty('--accent');
    } else {
        // Re-apply custom colors if switching back to custom
        loadCustomColors();
    }

    // Update theme-color meta tag for Safari
    updateThemeColor();

    // Hide custom builder if not custom
    const builder = document.getElementById('custom-theme-builder');
    if (theme !== 'custom') {
        builder.classList.remove('active');
        closeModal('settings-modal');
    }
}

function updateThemeColor() {
    const root = getComputedStyle(document.documentElement);
    const bgColor = root.getPropertyValue('--bg-color').trim();
    let metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (!metaThemeColor) {
        metaThemeColor = document.createElement('meta');
        metaThemeColor.name = 'theme-color';
        document.head.appendChild(metaThemeColor);
    }
    metaThemeColor.content = bgColor;
}

function toggleCustomTheme() {
    setTheme('custom');
    const builder = document.getElementById('custom-theme-builder');
    builder.classList.add('active');
    loadCustomColors(); // Load current values into inputs
}

function applyCustomTheme() {
    const bg = document.getElementById('custom-bg').value;
    const cardBg = document.getElementById('custom-card-bg').value;
    const boardLight = document.getElementById('custom-board-light').value;
    const boardDark = document.getElementById('custom-board-dark').value;
    const accent = document.getElementById('custom-accent').value;

    const root = document.documentElement;
    root.style.setProperty('--bg-color', bg);
    root.style.setProperty('--card-bg', cardBg);
    root.style.setProperty('--board-light', boardLight);
    root.style.setProperty('--board-dark', boardDark);
    root.style.setProperty('--accent', accent);

    // Update theme-color meta tag
    updateThemeColor();

    // Save to local storage
    const customColors = { bg, cardBg, boardLight, boardDark, accent };
    localStorage.setItem('chess_custom_colors', JSON.stringify(customColors));
}

function loadCustomColors() {
    const saved = localStorage.getItem('chess_custom_colors');
    if (saved) {
        const colors = JSON.parse(saved);
        const root = document.documentElement;

        // Set CSS variables
        root.style.setProperty('--bg-color', colors.bg);
        root.style.setProperty('--card-bg', colors.cardBg || '#3d3126'); // Fallback for old saves
        root.style.setProperty('--board-light', colors.boardLight);
        root.style.setProperty('--board-dark', colors.boardDark);
        root.style.setProperty('--accent', colors.accent);

        // Set input values
        if (document.getElementById('custom-bg')) {
            document.getElementById('custom-bg').value = colors.bg;
            document.getElementById('custom-card-bg').value = colors.cardBg || '#3d3126';
            document.getElementById('custom-board-light').value = colors.boardLight;
            document.getElementById('custom-board-dark').value = colors.boardDark;
            document.getElementById('custom-accent').value = colors.accent;
        }
    }
}

loginBtn.addEventListener('click', async () => {
    // Resume AudioContext on user gesture
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    const code = passwordInput.value.trim();
    if (!code) return;

    if (!supabaseClient) {
        loginError.textContent = "Erreur de connexion au serveur";
        return;
    }

    loginBtn.textContent = 'Connexion...';
    loginBtn.disabled = true;

    try {
        let name = null;

        // Try Benji
        let { data, error } = await supabaseClient.auth.signInWithPassword({
            email: 'benji@chess.local',
            password: code
        });

        if (!error && data.session) {
            name = 'Benji';
        } else {
            // Try Sanaa
            const res = await supabaseClient.auth.signInWithPassword({
                email: 'sanaa@chess.local',
                password: code
            });
            if (!res.error && res.data.session) {
                name = 'Sanaa';
            }
        }

        if (name) {
            localStorage.setItem('chess_user_name', name);

            // Animation de succès
            const loginScreen = document.getElementById('login-screen');
            loginScreen.classList.add('login-success');

            myName = name;
            myNameEl.textContent = myName;
            opponentNameEl.textContent = myName === 'Benji' ? 'Sanaa' : 'Benji';

            // Setup presence channel
            setupPresence();

            // Show main menu
            showMainMenu();

            setTimeout(() => {
                loginScreen.classList.add('hidden');
                loginScreen.classList.remove('login-success');
            }, 800);

        } else {
            loginError.textContent = "Code incorrect";
            passwordInput.value = '';

            // Shake animation
            const container = document.querySelector('.login-container');
            container.classList.remove('shake');
            void container.offsetWidth; // trigger reflow
            container.classList.add('shake');
        }
    } catch (err) {
        console.error("Login error", err);
        loginError.textContent = "Erreur inattendue";
    } finally {
        loginBtn.textContent = "C'est parti !";
        loginBtn.disabled = false;
    }
});

passwordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        loginBtn.click();
    }
});

function login(name) {
    myName = name;

    // Setup UI
    myNameEl.textContent = myName;
    opponentNameEl.textContent = myName === 'Benji' ? 'Sanaa' : 'Benji';

    loginScreen.classList.add('hidden');

    // Setup presence channel early so it works on the menu screen
    if (supabaseClient) {
        setupPresence();
        setupGlobalRealtime();
    }

    // Show main menu instead of game screen directly
    showMainMenu();
    
    // Synchroniser la souscription push si déjà accordée
    syncPushSubscription();
}

function logout() {
    openModal('logout-modal');
}

async function confirmLogout() {
    try {
        if (supabaseClient) {
            await supabaseClient.auth.signOut();
        }
    } catch (e) {
        console.error('Logout error:', e);
    }
    localStorage.removeItem('chess_user_name');
    location.reload();
}

// --- MODALS & SETTINGS ---

function toggleDropdown() {
    settingsDropdown.classList.toggle('active');
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.settings-btn') && !e.target.closest('.dropdown')) {
        settingsDropdown.classList.remove('active');
    }
});

function openSettings() {
    settingsDropdown.classList.remove('active');
    settingsModal.classList.remove('hidden');
}

function openHistoryModal() {
    settingsDropdown.classList.remove('active');
    openGameHistory();
}

function openNewGameModal() {
    closeModal('game-over-modal');
    newGameModal.classList.remove('hidden');

    // Wire the modal sub-mode toggle the first time it's opened.
    const modalSubToggle = document.getElementById('modal-submode-toggle');
    if (modalSubToggle && !modalSubToggle.dataset.wired) {
        modalSubToggle.dataset.wired = '1';
        modalSubToggle.querySelectorAll('.menu-submode-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                setModalSubmode(btn.dataset.submode);
            });
        });
    }

    // Restore last-used settings from localStorage (or use defaults)
    const saved = localStorage.getItem('chess_new_game_settings');
    if (saved) {
        try {
            const s = JSON.parse(saved);
            // Map saved mode 'local' → display as 'solo' with the local sub-tab.
            const persistedSub = (s.mode === 'local') ? 'local' : 'bot';
            const baseMode = (s.mode === 'local') ? 'solo' : (s.mode || 'duo');
            selectMode(baseMode);
            setModalSubmode(persistedSub);
            if (typeof s.localAutoRotate === 'boolean') {
                const t = document.getElementById('modal-local-rotate-toggle');
                if (t) t.checked = s.localAutoRotate;
            }
            selectTime(typeof s.time === 'number' ? s.time : 5);
            if (s.color) {
                selectColor(s.color);
            } else {
                selectedColorChoice = null;
                startGameBtn.disabled = true;
                document.querySelectorAll('.color-option').forEach(el => el.classList.remove('selected'));
            }
            // Restore Elo / difficulty
            if (typeof s.botEloOverride === 'number') {
                botEloOverride = s.botEloOverride;
                document.getElementById('elo-input').value = s.botEloOverride;
            }
            if (typeof s.botDifficulty === 'number') {
                botDifficulty = s.botDifficulty;
            }
            // Update difficulty label
            const el = document.getElementById('difficulty-value');
            if (el) {
                const presetMatch = [400, 800, 1500, 2500].includes(botEloOverride);
                el.textContent = presetMatch ? DIFFICULTY_NAMES[Math.round(botDifficulty)] : (botEloOverride ? `Perso (${botEloOverride})` : DIFFICULTY_NAMES[Math.round(botDifficulty)]);
            }
            return;
        } catch (e) {
            // Ignore parse errors, fall through to defaults
        }
    }

    // Defaults (first launch or corrupted data)
    selectedColorChoice = null;
    startGameBtn.disabled = true;
    document.querySelectorAll('.color-option').forEach(el => el.classList.remove('selected'));
    selectTime(5);
    selectMode('duo');
}

// Sub-mode chosen inside the old "Nouvelle Partie" modal when SOLO is picked.
let modalSubmode = 'bot'; // 'bot' | 'local'

function selectMode(mode) {
    gameMode = mode;
    const toggle = document.getElementById('mode-toggle');
    const diffSection = document.getElementById('difficulty-section');
    const submodeSection = document.getElementById('modal-submode-section');
    if (mode === 'solo') {
        toggle.classList.add('solo-active');
        diffSection.classList.add('visible');
        if (submodeSection) submodeSection.style.display = '';
        // Re-apply current modal sub-mode so the panels are in sync.
        setModalSubmode(modalSubmode);
    } else {
        toggle.classList.remove('solo-active');
        diffSection.classList.remove('visible');
        if (submodeSection) submodeSection.style.display = 'none';
        // Force color/time back on (in case we came from a local sub-tab)
        revealColorAndTimeSections();
    }
}

function revealColorAndTimeSections() {
    const colorBlock = document.querySelector('#new-game-modal .color-choices');
    const colorLabel = colorBlock ? colorBlock.previousElementSibling : null;
    const timeBlock  = document.querySelector('#new-game-modal .time-choices');
    const timeLabel  = timeBlock ? timeBlock.previousElementSibling : null;
    [colorBlock, colorLabel, timeBlock, timeLabel].forEach(el => {
        if (el) el.style.display = '';
    });
}

function setModalSubmode(sub, skipPanelToggle) {
    if (sub !== 'bot' && sub !== 'local') return;
    modalSubmode = sub;

    const toggleEl  = document.getElementById('modal-submode-toggle');
    const localOpts = document.getElementById('modal-local-options');
    const diffSection = document.getElementById('difficulty-section');

    if (toggleEl) {
        toggleEl.dataset.active = sub;
        toggleEl.querySelectorAll('.menu-submode-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.submode === sub);
        });
    }
    if (localOpts) {
        localOpts.style.display = (sub === 'local') ? '' : 'none';
    }

    // In local sub-mode, hide color + difficulty (irrelevant). Keep TIME
    // visible so the user can still pick 3/5/10/∞ for pass-and-play.
    if (!skipPanelToggle && gameMode === 'solo') {
        const colorBlock = document.querySelector('#new-game-modal .color-choices');
        const colorLabel = colorBlock ? colorBlock.previousElementSibling : null;
        const hide = (sub === 'local');
        [colorBlock, colorLabel].forEach(el => {
            if (el) el.style.display = hide ? 'none' : '';
        });
        if (diffSection) {
            if (hide) {
                diffSection.style.display = 'none';
                diffSection.classList.remove('visible');
            } else {
                diffSection.style.display = '';
                diffSection.classList.add('visible');
            }
        }

        // The "Jouer" button is gated by color selection in bot mode — but
        // local mode needs no color, so enable it directly.
        const startBtn = document.getElementById('start-game-btn');
        if (startBtn && hide) startBtn.disabled = false;
    }
}



const DIFFICULTY_NAMES = ['', 'Débutant', 'Facile', 'Intermédiaire', 'Avancé', 'Expert'];

let botEloOverride = null;

function updateDifficultyLabel(val) {
    botDifficulty = parseFloat(val);
    botEloOverride = null;
    const rounded = Math.round(botDifficulty);
    const el = document.getElementById('difficulty-value');
    if (el) el.textContent = DIFFICULTY_NAMES[rounded];
}

function selectPreset(difficulty, elo) {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('selected'));
    event.currentTarget.classList.add('selected');
    document.getElementById('elo-input').value = elo;
    botDifficulty = difficulty;
    botEloOverride = elo;
    const el = document.getElementById('difficulty-value');
    if (el) el.textContent = DIFFICULTY_NAMES[Math.round(difficulty)];
}

function saveAdvancedDifficulty() {
    const elo = parseInt(document.getElementById('elo-input').value);
    if (!isNaN(elo) && elo >= 200 && elo <= 3000) {
        botEloOverride = elo;
        const el = document.getElementById('difficulty-value');
        const presetMatch = [400, 800, 1500, 2500].includes(elo);
        if (el) {
            el.textContent = presetMatch ? DIFFICULTY_NAMES[Math.round(botDifficulty)] : `Perso (${elo})`;
        }
    }
    closeModal('advanced-diff-modal');
}

function updateModeBadge() {
    const badge = document.getElementById('mode-badge');
    const switchDuoItem = document.getElementById('switch-duo-item');
    if (badge) {
        if (gameMode === 'solo') {
            badge.textContent = 'SOLO';
            badge.classList.add('solo');
            badge.classList.remove('local');
        } else if (gameMode === 'local') {
            badge.textContent = 'LOCAL';
            badge.classList.add('solo'); // reuse styling
            badge.classList.add('local');
        } else {
            badge.textContent = 'DUO';
            badge.classList.remove('solo');
            badge.classList.remove('local');
        }
    }
    if (switchDuoItem) {
        switchDuoItem.style.display = gameMode === 'solo' ? '' : 'none';
    }
    document.querySelectorAll('.duo-only-item').forEach(el => {
        el.style.display = gameMode === 'duo' ? '' : 'none';
    });
    // Show rotation toggle only in local mode
    document.querySelectorAll('.local-only-item').forEach(el => {
        el.style.display = gameMode === 'local' ? '' : 'none';
    });
    // Toggle a body-level class so CSS can declutter the header in local mode
    document.body.classList.toggle('mode-local', gameMode === 'local');
    document.body.classList.toggle('local-no-timer',
        gameMode === 'local' && (!timeControl || timeControl === 0));
    // Refresh undo/redo buttons (they're local-only)
    updateLocalUndoButtons();
}

function updateOpponentName() {
    if (gameMode === 'solo') {
        opponentNameEl.innerHTML = 'Bot <img src="images/benji_robot.png" style="width: 24px; vertical-align: middle; margin-left: 5px;">';
        if (myNameEl && myName) myNameEl.textContent = myName;
    } else if (gameMode === 'local') {
        // The bottom line shows who plays now. The top opponent block is
        // either fully hidden (no timer) or shows the inactive side's clock.
        const turnColor = game ? game.turn() : 'w';
        if (myNameEl) {
            myNameEl.textContent = turnColor === 'w' ? 'Tour des Blancs' : 'Tour des Noirs';
        }
        // Label the opposite side on the opponent block (read by CSS ::before).
        const opponentBlock = document.querySelector('#game-screen header .player-status.opponent');
        if (opponentBlock) {
            opponentBlock.dataset.sideLabel = turnColor === 'w' ? 'Noirs' : 'Blancs';
        }
    } else {
        opponentNameEl.textContent = myName === 'Benji' ? 'Sanaa' : 'Benji';
        if (myNameEl && myName) {
            myNameEl.textContent = myName;
        }
    }
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('hidden');
    }
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
}

async function sendSystemChatMessage(message) {
    if (!supabaseClient || !GAME_ID) return;
    const msg = (message || '').trim();
    if (!msg) return;
    try {
        // Avoid duplicate \"quitté la partie\" announcements for this game
        const { data } = await supabaseClient
            .from('chess_chat')
            .select('sender,message')
            .eq('game_id', GAME_ID)
            .order('created_at', { ascending: false })
            .limit(1);
        if (data && data.length > 0) {
            const last = data[0];
            if (last.sender === 'Système' && last.message.includes('a quitté la partie')) {
                return;
            }
        }

        await supabaseClient
            .from('chess_chat')
            .insert([{ game_id: GAME_ID, sender: 'Système', message: msg }]);
    } catch (e) {
        console.warn('Erreur message système chat:', e);
    }
}

// Close modal when clicking outside
window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal') && !e.target.classList.contains('hidden')) {
        closeModal(e.target.id);
    }
});

function selectTime(minutes) {
    selectedTimeChoice = minutes;
    document.querySelectorAll('.time-btn').forEach(btn => {
        btn.classList.remove('selected');
        if (btn.dataset.time == minutes) {
            btn.classList.add('selected');
        }
    });
}

function selectColor(color) {
    selectedColorChoice = color;
    startGameBtn.disabled = false;

    // UI Update
    document.querySelectorAll('.color-option').forEach(el => el.classList.remove('selected'));
    document.getElementById(`opt-${color}`).classList.add('selected');
}

async function confirmNewGame() {
    // Solo card with Local sub-mode: delegate to the dedicated pass-and-play
    // starter — color/difficulty don't apply, but we keep the time-control
    // chosen in the modal's standard time row.
    if (gameMode === 'solo' && modalSubmode === 'local') {
        const rotInput = document.getElementById('modal-local-rotate-toggle');
        const rotate = rotInput ? !!rotInput.checked : true;
        const timeMin = (typeof selectedTimeChoice === 'number') ? selectedTimeChoice : 0;
        closeModal('new-game-modal');
        startLocalGame(rotate, timeMin);
        return;
    }

    if (!selectedColorChoice) return;

    closeModal('new-game-modal');

    // Persist new game settings to localStorage for next time
    localStorage.setItem('chess_new_game_settings', JSON.stringify({
        mode: gameMode,
        color: selectedColorChoice,
        time: selectedTimeChoice,
        botDifficulty: botDifficulty,
        botEloOverride: botEloOverride
    }));

    // Save params for "Rejouer" (replay with same settings)
    lastGameParams = {
        mode: gameMode,
        color: selectedColorChoice,
        time: selectedTimeChoice,
        botDifficulty: botDifficulty,
        botEloOverride: botEloOverride
    };

    let whitePlayerName = myName;

    if (gameMode === 'solo') {
        if (selectedColorChoice === 'black') {
            whitePlayerName = 'Bot';
        } else if (selectedColorChoice === 'random') {
            whitePlayerName = Math.random() < 0.5 ? myName : 'Bot';
        }
    } else {
        if (selectedColorChoice === 'black') {
            whitePlayerName = myName === 'Benji' ? 'Sanaa' : 'Benji';
        } else if (selectedColorChoice === 'random') {
            whitePlayerName = Math.random() < 0.5 ? 'Benji' : 'Sanaa';
        }
    }

    game.reset();
    lastMove = null;
    viewIndex = null;
    isBotThinking = false;

    if (whitePlayerName === myName) {
        myColor = 'w';
    } else {
        myColor = 'b';
    }

    boardFlipped = (myColor === 'b');

    timeControl = selectedTimeChoice * 60 * 1000;
    whiteTimeRemaining = timeControl;
    blackTimeRemaining = timeControl;
    lastMoveTimestamp = Date.now();

    clearGameOverFlags();

    if (gameMode === 'duo') {
        clearSoloState();
        // Reset Supabase FIRST before rendering to avoid stale state triggers
        if (supabaseClient) {
            duoInitializing = true;
            try {
                await supabaseClient
                    .from('chess_state')
                    .update({
                        fen: game.fen(),
                        last_move: '',
                        white_player: whitePlayerName,
                        pgn: '',
                        white_time: whiteTimeRemaining,
                        black_time: blackTimeRemaining,
                        last_move_ts: lastMoveTimestamp,
                        time_control: timeControl,
                        status: null,
                        draw_offer: null,
                        draw_rejected: null,
                        resigned_by: null
                    })
                    .eq('id', GAME_ID);
            } catch (error) {
                console.error('Erreur Supabase:', error);
            }
            duoInitializing = false;
        }
    }

    renderBoard();
    updateStatus();
    startTimer();
    updateModeBadge();
    updateOpponentName();

    if (gameMode === 'solo' && game.turn() !== myColor) {
        makeBotMove();
    }
}
// --- BOT AI ENGINE (LOCAL STOCKFISH WEB WORKER) ---

/**
 * Send UCI commands to Stockfish and return a Promise that resolves with the best move.
 * Only one search can be active at a time (enforced by isBotThinking mutex in makeBotMove).
 */
function requestStockfishMove(fen, elo) {
    return new Promise((resolve, reject) => {
        // Safety: cancel any lingering previous request
        if (stockfishResolve) {
            stockfishResolve(null);
            stockfishResolve = null;
        }
        stockfishResolve = resolve;
        stockfish.postMessage('uci');
        stockfish.postMessage('setoption name UCI_LimitStrength value true');
        stockfish.postMessage('setoption name UCI_Elo value ' + elo);
        stockfish.postMessage('position fen ' + fen);
        stockfish.postMessage('go movetime 1000');
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
            stockfish.postMessage('stop');
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

function switchToDuo() {
    settingsDropdown.classList.remove('active');
    gameMode = 'duo';
    isBotThinking = false;
    clearSoloState();
    updateModeBadge();
    updateOpponentName();
    clearGameOverFlags();
    game.reset();
    lastMove = null;
    viewIndex = null;
    renderBoard();
    updateStatus();
    initGame();
}

// --- GAME LOGIC ---

async function initGame() {
    console.log('initGame appelé');

    if (!game) game = new Chess();
    if (!myColor) myColor = myName === 'Benji' ? 'w' : 'b';
    boardFlipped = (myColor === 'b');

    renderBoard();
    updateStatus();
    updateModeBadge();
    updateEvalBarVisibility();
    triggerEvalForPosition(game.fen());

    if (gameMode === 'solo') {
        console.log('Mode solo détecté, Supabase ignoré');
        return;
    }

    setupPresence();

    let data = null;
    let error = null;

    if (supabaseClient) {
        try {
            console.log('Tentative de connexion Supabase...');
            const response = await supabaseClient
                .from('chess_state')
                .select('*')
                .eq('id', GAME_ID)
                .single();
            data = response.data;
            error = response.error;
            console.log('Réponse Supabase reçue:', data);
        } catch (e) {
            console.error('Erreur Supabase:', e);
            error = e;
        }
    }

    if (data) {
        // Mark that we're doing initial page load to suppress modal
        isPageLoadingComplete = false;
        updateGameState(data);
        isPageLoadingComplete = true; // Mark page load complete after initial state update
    } else {
        console.warn("Aucune donnée trouvée ou erreur Supabase (utilisation du plateau local):", error);
        isPageLoadingComplete = true;
    }

    setupRealtimeSubscription();
    setupChatSubscription();
}

// --- GLOBAL REALTIME NOTIFICATIONS ---
let globalRealtimeChannel = null;

function setupGlobalRealtime() {
    if (!supabaseClient) return;

    // Prevent duplicate subscriptions
    if (globalRealtimeChannel) {
        supabaseClient.removeChannel(globalRealtimeChannel);
    }

    globalRealtimeChannel = supabaseClient.channel('global_notifications_' + Date.now())
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chess_state', filter: `id=eq.${GAME_ID}` }, payload => {
            const state = payload.new;

            // 1. Is it a new game being created right now?
            // A fresh game usually has no PGN and is initiated by the opponent
            const isNewGame = (!state.pgn || state.pgn.trim() === '') &&
                state.status !== 'deleted' &&
                state.status !== 'resigned' &&
                state.status !== 'draw';

            // 2. Show invite toast lorsqu'une nouvelle partie Duo est créée par l'autre
            // Que l'on soit sur le menu OU en mode solo
            const isOnMenu = mainMenuEl && !mainMenuEl.classList.contains('hidden');
            const isInSolo = !gameScreen.classList.contains('hidden') && gameMode === 'solo';

            // Vérifier si c'est nous qui avons créé la partie :
            // On compare le timestamp stocké localement avec celui de la DB.
            // (Le upsert utilise lastMoveTimestamp, donc les valeurs correspondent.)
            const weCreatedIt = (state.last_move_ts === lastMoveTimestamp);

            if (isNewGame && (isOnMenu || isInSolo) && !weCreatedIt) {
                showToastInvite();
            }

            // 3. Always refresh the active games list on the main menu dynamically
            if (!mainMenuEl.classList.contains('hidden')) {
                // Throttle slightly to ensure local storage sync finishes if they were looking at it
                setTimeout(checkSavedGames, 100);
            }

            // 4. If we are IN the game screen actively playing this duo game, update the board
            if (!gameScreen.classList.contains('hidden') && gameMode === 'duo') {
                updateGameState(state);
            }
        })
        .subscribe();
}

let toastTimeout = null;
function showToast({ title, message, showJoin = false } = {}) {
    const toast = document.getElementById('toast-container');
    const joinBtn = document.getElementById('toast-join-btn');
    const closeBtn = document.getElementById('toast-close-btn');
    const titleEl = document.getElementById('toast-title');
    const messageEl = document.getElementById('toast-message');

    if (!toast) return;

    if (titleEl && typeof title === 'string') titleEl.textContent = title;
    if (messageEl && typeof message === 'string') messageEl.textContent = message;

    if (joinBtn) {
        joinBtn.classList.toggle('hidden', !showJoin);
    }

    toast.classList.remove('hidden');

    // Setup button listeners
    if (joinBtn) {
        joinBtn.onclick = () => {
            toast.classList.add('hidden');
            if (toastTimeout) clearTimeout(toastTimeout);
            // Automatically close settings/other modals if open
            closeModal('settings-modal');
            closeModal('resume-duo-modal');

            // Use standard resume behavior to jump in
            resumeGame('duo');
        };
    }

    if (closeBtn) closeBtn.onclick = () => {
        toast.classList.add('hidden');
        if (toastTimeout) clearTimeout(toastTimeout);
    };

    // Auto-hide after 10 seconds
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.add('hidden');
    }, 10000);
}

/**
 * Show a simple toast for features not yet implemented
 */
function showFutureToast() {
    showToast({
        title: "Bientôt disponible",
        message: "Pas encore mon coeur :P",
        showJoin: false
    });
}

function showToastInvite() {
    const opponentName = myName === 'Benji' ? 'Sanaa' : 'Benji';
    showToast({
        title: 'Nouvelle Partie Duo !',
        message: `${opponentName} vient de créer une partie.`,
        showJoin: true
    });
}

function setupRealtimeSubscription() {
    // This function is now mostly obsolete because setupGlobalRealtime handles 'chess_state' 
    // globally directly from login, but we keep it empty or remove references to avoid double events.
    // Kept here for compatibility if called by initGame().
}

let presenceChannel = null;

function setupPresence() {
    if (!supabaseClient || !myName) return;

    // If already connected, don't recreate
    if (presenceChannel) {
        // Already set up — just re-track
        presenceChannel.track({ user: myName, online_at: new Date().toISOString() }).catch(() => { });
        return;
    }

    presenceChannel = supabaseClient.channel('chess_presence', {
        config: { presence: { key: myName } }
    });

    presenceChannel
        .on('presence', { event: 'sync' }, () => {
            const state = presenceChannel.presenceState();
            updatePresenceUI(state);
            updateMenuPresenceUI(state);
        })
        .subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                await presenceChannel.track({ user: myName, online_at: new Date().toISOString() });
            }
        });
}

function updatePresenceUI(state) {
    const opponentName = myName === 'Benji' ? 'Sanaa' : 'Benji';
    const isOnline = !!state[opponentName] && state[opponentName].length > 0;

    const chatDot = document.getElementById('chat-online-dot');
    const dropdownDot = document.querySelector('#presence-status .online-dot');
    const presenceText = document.getElementById('presence-text');

    if (chatDot) {
        chatDot.style.display = isOnline ? 'inline-block' : 'none';
        chatDot.classList.toggle('offline', !isOnline);
    }

    if (dropdownDot) {
        dropdownDot.classList.toggle('offline', !isOnline);
    }

    if (presenceText) {
        presenceText.textContent = isOnline ? `${opponentName} en ligne` : `${opponentName} hors ligne`;
    }
}

function updateMenuPresenceUI(state) {
    if (!myName) return;
    const opponentName = myName === 'Benji' ? 'Sanaa' : 'Benji';
    const isOnline = !!state[opponentName] && state[opponentName].length > 0;

    const dot = document.getElementById('menu-duo-presence-dot');
    const text = document.getElementById('menu-duo-presence-text');

    if (dot) {
        dot.classList.toggle('offline', !isOnline);
        dot.classList.toggle('online', isOnline);
    }
    if (text) {
        text.textContent = isOnline
            ? `${opponentName} en ligne`
            : `${opponentName} hors ligne`;
    }
}

async function updateGameState(data = {}) {
    // Skip stale updates while a new duo game is being initialized
    if (duoInitializing) {
        console.log('Ignoring Supabase update during duo initialization');
        return;
    }

    const newFen = data.fen;
    const newPgn = data.pgn;
    const whitePlayer = data.white_player;
    const lastMoveStr = data.last_move; // "e2-e4"

    // Clear victory modal anti-spam flag if a new game is detected
    if (!newFen && !newPgn) {
        clearGameOverFlags();
        sessionStorage.removeItem('duoDeletedHandled');
    } else if (newFen && newFen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq')) {
        if (!newPgn || newPgn.trim() === '') {
            clearGameOverFlags();
            sessionStorage.removeItem('duoDeletedHandled');
        }
    }

    // Time Sync
    if (data.time_control !== undefined) timeControl = data.time_control;
    if (data.white_time !== undefined) whiteTimeRemaining = data.white_time;
    if (data.black_time !== undefined) blackTimeRemaining = data.black_time;
    if (data.last_move_ts !== undefined) lastMoveTimestamp = data.last_move_ts;

    // Reject Draw logic
    if (data.draw_rejected && data.draw_rejected !== myName) {
        // The opponent rejected my draw offer
        statusEl.textContent = 'Proposition de nul refusée !';
        // Clear it from our local UI so it doesn't stay forever, and reset the DB field
        if (supabaseClient && data.draw_offer === myName) {
            try {
                // Remove the reject flag so it only triggers once
                await supabaseClient.from('chess_state').update({ draw_rejected: null, draw_offer: null }).eq('id', GAME_ID);
            } catch (e) { }
        }
    }

    // Draw offer
    if (data.draw_offer && data.draw_offer !== myName && !data.draw_rejected) {
        const opponentName = myName === 'Benji' ? 'Sanaa' : 'Benji';
        const offerMsgEl = document.getElementById('draw-offer-message');
        if (offerMsgEl) offerMsgEl.textContent = `${opponentName} propose un match nul. Accepter ?`;
        document.getElementById('draw-offer-modal').classList.remove('hidden');
    } else {
        document.getElementById('draw-offer-modal').classList.add('hidden');
    }

    // 'deleted' status — game was removed
    if (data.status === 'deleted') {
        // If someone is still on the duo game screen, bring them back to menu + notify
        const alreadyHandled = sessionStorage.getItem('duoDeletedHandled') === 'true';
        if (!alreadyHandled && gameMode === 'duo' && !gameScreen.classList.contains('hidden')) {
            sessionStorage.setItem('duoDeletedHandled', 'true');
            // Close modals that could be open
            closeModal('settings-modal');
            closeModal('resume-duo-modal');
            closeModal('draw-offer-modal');
            closeModal('resign-modal');
            // Return to menu without sending the "left game" system notice
            returnToMenu({ suppressLeaveNotice: true });
            showToast({
                title: 'Partie supprimée',
                message: 'Cette partie a été supprimée.',
                showJoin: false
            });
        }
        return;
    }

    // Resign and Draw status
    if (data.status === 'resigned' && data.resigned_by) {
        // If someone resigned, figure out who won
        // If resigned_by is whitePlayer, black wins, etc.
        const isWhiteWhoResigned = (data.resigned_by === data.white_player);
        const winner = isWhiteWhoResigned ? 'Noirs' : 'Blancs';
        showGameOver(winner, { reason: 'resign', resignedBy: data.resigned_by });
        return;
    }
    if (data.status === 'draw') {
        showGameOver('draw');
        return;
    }

    // Update Last Move
    if (lastMoveStr) {
        const [from, to] = lastMoveStr.split('-');
        lastMove = { from, to };
    } else {
        lastMove = null;
    }

    // Déterminer ma couleur
    if (whitePlayer) {
        if (myName === whitePlayer) {
            myColor = 'w';
        } else {
            myColor = 'b';
        }
    } else {
        // Fallback si pas défini (ancienne version)
        myColor = myName === 'Benji' ? 'w' : 'b';
    }

    // Auto flip board
    const oldFlipped = boardFlipped;
    boardFlipped = (myColor === 'b');

    let needsRender = false;

    // Capture game-over state BEFORE loading new state
    // so we can distinguish "game was already over" from "game just ended"
    const wasAlreadyGameOver = game.game_over();

    // Seulement mettre à jour si on a vraiment recu un nouvel etat
    if (data.fen !== undefined || data.pgn !== undefined) {
        if (!newFen && !newPgn) {
            // Nouvelle partie ou reset complet
            game.reset();
            viewIndex = null;
            needsRender = true;
        } else {
            // Prefer PGN for history
            if (newPgn && newPgn.trim() !== '') {
                // On charge le PGN uniquement si on a une version différente de la nôtre
                if (game.pgn() !== newPgn) {
                    const loaded = game.load_pgn(newPgn);
                    if (loaded) {
                        needsRender = true;
                    } else {
                        console.warn('PGN invalide, fallback FEN');
                        if (newFen && newFen !== game.fen()) {
                            try {
                                game.load(newFen);
                                needsRender = true;
                            } catch (e) { console.error(e); }
                        }
                    }
                }
            } else if (newFen && newFen !== game.fen()) {
                // Fallback to FEN
                try {
                    game.load(newFen);
                    needsRender = true;
                } catch (err) {
                    console.error('FEN invalide reçue, reset local:', err);
                    game.reset();
                    needsRender = true;
                }
            }
        }
    }

    if (!needsRender && oldFlipped !== boardFlipped) {
        needsRender = true;
    }

    if (!needsRender && boardEl.innerHTML.trim() === '') {
        needsRender = true;
    }

    if (needsRender) {
        if (lastMove && lastMoveStr) {
            await animateMove(lastMove.from, lastMove.to);
        }
        renderBoard();
        
        // Only suppress modal if the game was already over BEFORE we loaded the new state
        // OR if we're in the middle of page loading (suppress modal on reload)
        // If the game just ended (new move caused checkmate), wasAlreadyGameOver is false → show modal
        const shouldShowModal = (wasAlreadyGameOver || !isPageLoadingComplete) ? false : true;
        updateStatus(shouldShowModal);

        if (game.turn() === myColor) {
            await tryExecutePremove();
        }
    }

    startTimer();
}

// Helper to reconstruct game state for history navigation
// (Chess.js 0.10.3 doesn't provide FEN in history objects, so we replay moves)
function getHistoricalGame(index) {
    if (index === null) return game;

    const history = game.history(); // Get SAN moves
    const tempGame = new Chess();

    // Apply moves up to index
    for (let i = 0; i <= index; i++) {
        tempGame.move(history[i]);
    }
    return tempGame;
}

function renderBoard() {
    // Determine which game state to render
    const activeGame = getHistoricalGame(viewIndex);

    const squares = activeGame.board(); // 8x8 array

    // Check if we need a full rebuild
    const isRebuild = boardEl.children.length !== 64 || (boardEl.dataset.flipped !== String(boardFlipped));

    if (isRebuild) {
        boardEl.innerHTML = '';
        boardEl.dataset.flipped = String(boardFlipped);
    }

    // Gestion de l'orientation (Blanc en bas ou Noir en bas)
    let rows = [0, 1, 2, 3, 4, 5, 6, 7];
    let cols = [0, 1, 2, 3, 4, 5, 6, 7];

    if (boardFlipped) {
        rows.reverse();
        cols.reverse();
    }

    // Création ou Mise à jour de la grille
    for (let r of rows) {
        for (let c of cols) {
            const squareIndex = (r * 8) + c;
            const squareName = String.fromCharCode(97 + c) + (8 - r);

            let squareDiv;

            if (isRebuild) {
                squareDiv = document.createElement('div');
                squareDiv.className = `square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
                squareDiv.dataset.square = squareName;

                // Coordonnées (Static)
                if (c === cols[0]) {
                    const rankNum = 8 - r;
                    const rankSpan = document.createElement('span');
                    rankSpan.className = 'coord coord-rank';
                    rankSpan.innerText = rankNum;
                    squareDiv.appendChild(rankSpan);
                }

                if (r === rows[rows.length - 1]) {
                    const fileName = String.fromCharCode(97 + c);
                    const fileSpan = document.createElement('span');
                    fileSpan.className = 'coord coord-file';
                    fileSpan.innerText = fileName;
                    squareDiv.appendChild(fileSpan);
                }

                boardEl.appendChild(squareDiv);
            } else {
                squareDiv = boardEl.querySelector(`[data-square="${squareName}"]`);
            }

            // --- Dynamic Updates ---

            // 1. Classes
            squareDiv.classList.remove('selected', 'last-move', 'capture-hint', 'in-check');

            if (selectedSquare === squareName) {
                squareDiv.classList.add('selected');
            }

            const isMyTurn = activeGame.turn() === myColor;

            let highlightMove = null;

            if (viewIndex === null) {
                const history = activeGame.history({ verbose: true });
                if (history.length > 0) {
                    highlightMove = history[history.length - 1];
                }
            } else {
                const history = game.history({ verbose: true });
                if (viewIndex >= 0 && history[viewIndex]) {
                    highlightMove = history[viewIndex];
                }
            }

            if (highlightMove && (highlightMove.from === squareName || highlightMove.to === squareName)) {
                squareDiv.classList.add('last-move');
            }

            squareDiv.classList.remove('premove');
            if (viewIndex === null && premoveQueue.length > 0) {
                for (const pm of premoveQueue) {
                    if (squareName === pm.from || squareName === pm.to) {
                        squareDiv.classList.add('premove');
                        break;
                    }
                }
            }

            // 2. Piece
            const piece = activeGame.get(squareName);
            let pieceDiv = squareDiv.querySelector('.piece:not(.piece-dying)');

            let displayPiece = piece;
            let isPremoveGhost = false;
            if (viewIndex === null && premoveQueue.length > 0) {
                const overlay = getPremoveOverlay();
                if (overlay.removed.has(squareName) && !overlay.placed.has(squareName)) {
                    displayPiece = null;
                } else if (overlay.placed.has(squareName)) {
                    displayPiece = overlay.placed.get(squareName);
                    isPremoveGhost = true;
                }
            }

            if (displayPiece) {
                const colorName = displayPiece.color === 'w' ? 'white' : 'black';
                const typeName = getPieceName(displayPiece.type);
                const bgImage = `url("pièces/default/${colorName}-${typeName}.png")`;

                if (!pieceDiv) {
                    pieceDiv = document.createElement('div');
                    pieceDiv.className = 'piece';
                    squareDiv.appendChild(pieceDiv);
                }

                if (!pieceDiv.style.backgroundImage.includes(`${colorName}-${typeName}.png`)) {
                    pieceDiv.style.backgroundImage = bgImage;
                }

                pieceDiv.style.opacity = isPremoveGhost ? '0.5' : '1';

                if (snapDragOffset && snapDragOffset.square === squareName) {
                    pieceDiv.style.transition = 'none';
                    pieceDiv.style.transform = `translate(${snapDragOffset.dx}px, ${snapDragOffset.dy}px)`;
                    const sd = snapDragOffset;
                    snapDragOffset = null;

                    // Force layout recalc to ensure the initial transform is applied without transition
                    void pieceDiv.offsetHeight;

                    requestAnimationFrame(() => {
                        pieceDiv.style.transition = 'transform 0.15s cubic-bezier(0.2, 0.8, 0.2, 1)';
                        pieceDiv.style.transform = 'translate(0px, 0px)';

                        // Cleanup transition string after animation completes
                        pieceDiv.addEventListener('transitionend', function handler() {
                            pieceDiv.removeEventListener('transitionend', handler);
                            pieceDiv.style.transition = '';
                            pieceDiv.style.transform = '';
                        }, { once: true });
                    });
                } else {
                    pieceDiv.style.transform = '';
                }

                if (viewIndex === null && displayPiece.color === myColor) {
                    pieceDiv.draggable = false;
                    pieceDiv.ondragstart = (e) => e.preventDefault();
                    pieceDiv.onmousedown = (e) => handlePointerDown(e, squareName);
                    pieceDiv.ontouchstart = (e) => handleTouchStart(e, squareName);
                    pieceDiv.ontouchmove = (e) => handleTouchMove(e);
                    pieceDiv.ontouchend = (e) => handleTouchEnd(e);
                    pieceDiv.style.cursor = 'grab';
                } else {
                    pieceDiv.draggable = false;
                    pieceDiv.ondragstart = null;
                    pieceDiv.onmousedown = null;
                    pieceDiv.style.cursor = 'default';
                }
            } else if (pieceDiv) {
                pieceDiv.remove();
            }

            // 3. Drop Zone Events (Static-ish)
            if (isRebuild) {
                squareDiv.addEventListener('dragover', handleDragOver);
                squareDiv.addEventListener('drop', (e) => handleDrop(e, squareName));
            }

            // 4. Hints & Click Handlers
            squareDiv.onclick = () => onSquareClick(squareName);

            const existingHint = squareDiv.querySelector('.hint');
            if (existingHint) existingHint.remove();

            if (viewIndex === null && selectedSquare) {
                const isMyTurnNow = activeGame.turn() === myColor;
                if (isMyTurnNow) {
                    const moves = activeGame.moves({ square: selectedSquare, verbose: true });
                    const isMove = moves.find(m => m.to === squareName);
                    if (isMove) {
                        if (isMove.flags.includes('c') || isMove.flags.includes('e')) {
                            squareDiv.classList.add('capture-hint');
                        } else {
                            const hint = document.createElement('div');
                            hint.className = 'hint';
                            squareDiv.appendChild(hint);
                        }
                        squareDiv.onclick = () => makeMove(selectedSquare, squareName);
                    }
                } else {
                    const srcPiece = getPredictedPieceAt(selectedSquare);
                    if (srcPiece && srcPiece.color === myColor && squareName !== selectedSquare && isPseudoLegalPremove(selectedSquare, squareName, srcPiece)) {
                        const targetPiece = getPredictedPieceAt(squareName);
                        const showCapture = isPremoveCapture(selectedSquare, squareName, srcPiece, targetPiece);
                        if (showCapture) {
                            squareDiv.classList.add('capture-hint');
                        } else {
                            const hint = document.createElement('div');
                            hint.className = 'hint';
                            squareDiv.appendChild(hint);
                        }
                    }
                }
            }
        }
    }

    // Re-apply check highlight if king is in check
    if (activeGame.in_check()) {
        highlightKingInCheck(activeGame);
    }

    updateHistoryButtons();
    lastAnimatedSquare = null;
}

function getPieceName(type) {
    const names = { p: 'pawn', r: 'rook', n: 'knight', b: 'bishop', q: 'queen', k: 'king' };
    return names[type];
}

function onSquareClick(square) {
    if (viewIndex !== null) return;
    if (sessionStorage.getItem('gameOverShown') === 'true') return;

    // Allow premoves even when bot is thinking
    if (game.turn() !== myColor) {
        handlePremoveClick(square);
        return;
    }

    // Only block direct moves while bot is thinking (for solo mode)
    if (isBotThinking) return;

    const piece = game.get(square);

    if (piece && piece.color === myColor) {
        selectedSquare = square;
        highlightMoves(square);
    } else if (selectedSquare) {
        makeMove(selectedSquare, square);
    }
}

function handlePremoveClick(square) {
    const predicted = getPredictedPieceAt(square);

    if (predicted && predicted.color === myColor) {
        selectedSquare = square;
        highlightPremoveMoves(square);
        return;
    }

    if (selectedSquare) {
        const srcPiece = getPredictedPieceAt(selectedSquare);
        if (srcPiece && isPseudoLegalPremove(selectedSquare, square, srcPiece)) {
            premoveQueue.push({ from: selectedSquare, to: square, piece: srcPiece });
            selectedSquare = null;
            renderBoard();
        } else {
            selectedSquare = null;
            renderBoard();
        }
        return;
    }

    clearPremove();
}

function getPremoveOverlay() {
    const removed = new Set();
    const placed = new Map();

    for (const pm of premoveQueue) {
        let piece = placed.has(pm.from) ? placed.get(pm.from) : game.get(pm.from);
        if (!piece) continue;
        if (placed.has(pm.from)) placed.delete(pm.from); else removed.add(pm.from);
        placed.set(pm.to, piece);
    }

    return { removed, placed };
}

function getPredictedPieceAt(square) {
    if (premoveQueue.length === 0) return game.get(square);
    const overlay = getPremoveOverlay();
    if (overlay.placed.has(square)) return overlay.placed.get(square);
    if (overlay.removed.has(square)) return null;
    return game.get(square);
}

function isPseudoLegalPremove(from, to, piece) {
    if (!piece) piece = getPredictedPieceAt(from);
    if (!piece || piece.color !== myColor) return false;
    if (from === to) return false;

    const fc = from.charCodeAt(0) - 97;
    const fr = parseInt(from[1]);
    const tc = to.charCodeAt(0) - 97;
    const tr = parseInt(to[1]);
    const dc = Math.abs(tc - fc);
    const dr = Math.abs(tr - fr);

    switch (piece.type) {
        case 'p': {
            const dir = piece.color === 'w' ? 1 : -1;
            const startRank = piece.color === 'w' ? 2 : 7;
            if (dc === 0 && (tr - fr) === dir) return true;
            if (dc === 0 && fr === startRank && (tr - fr) === 2 * dir) return true;
            if (dc === 1 && (tr - fr) === dir) return true;
            return false;
        }
        case 'n': return (dc === 1 && dr === 2) || (dc === 2 && dr === 1);
        case 'b': return dc === dr;
        case 'r': return dc === 0 || dr === 0;
        case 'q': return dc === dr || dc === 0 || dr === 0;
        case 'k': return dc <= 1 && dr <= 1 || (dr === 0 && dc === 2);
        default: return false;
    }
}

function isPremoveCapture(from, to, piece, targetPiece) {
    if (!targetPiece || targetPiece.color === myColor) return false;
    if (piece.type === 'p') {
        const fc = from.charCodeAt(0) - 97;
        const tc = to.charCodeAt(0) - 97;
        return Math.abs(tc - fc) === 1;
    }
    return true;
}

function clearPremove() {
    premoveQueue = [];
    selectedSquare = null;
    renderBoard();
}

async function tryExecutePremove() {
    if (premoveQueue.length === 0) return;
    if (game.turn() !== myColor) return;

    const pm = premoveQueue.shift();
    const legalMoves = game.moves({ square: pm.from, verbose: true });
    const isLegal = legalMoves.some(m => m.to === pm.to);

    if (isLegal) {
        await makeMove(pm.from, pm.to);
    } else {
        premoveQueue = [];
        renderBoard();
    }
}

// --- POINTER DRAG SYSTEM ---

let pointerDragPiece = null;
let pointerDragClone = null;

function handlePointerDown(e, square) {
    if (viewIndex !== null || e.button !== 0) return;
    if (sessionStorage.getItem('gameOverShown') === 'true') return;
    e.preventDefault();

    const piece = getPredictedPieceAt(square);
    if (!piece || piece.color !== myColor) return;

    const isPremove = game.turn() !== myColor;

    // Only block drag if bot is thinking AND it's not a premove
    if (isBotThinking && !isPremove) return;

    pointerDragPiece = e.target;
    sourceSquare = square;

    if (isPremove) highlightPremoveMoves(square);
    else highlightMoves(square);

    const rect = pointerDragPiece.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);

    pointerDragClone = pointerDragPiece.cloneNode(true);
    pointerDragClone.style.position = 'fixed';
    pointerDragClone.style.width = size * 1.15 + 'px';
    pointerDragClone.style.height = size * 1.15 + 'px';
    pointerDragClone.style.zIndex = '1000';
    pointerDragClone.style.pointerEvents = 'none';
    pointerDragClone.style.transition = 'none';
    pointerDragClone.style.filter = 'drop-shadow(0 4px 8px rgba(0,0,0,0.4))';
    document.body.appendChild(pointerDragClone);

    movePointerClone(e.clientX, e.clientY, size * 1.15);
    pointerDragPiece.style.opacity = '0';

    document.addEventListener('mousemove', onPointerDragMove);
    document.addEventListener('mouseup', onPointerDragUp);
}

function movePointerClone(x, y, size) {
    if (!pointerDragClone) return;
    const half = (size || parseFloat(pointerDragClone.style.width)) / 2;
    pointerDragClone.style.left = (x - half) + 'px';
    pointerDragClone.style.top = (y - half) + 'px';
}

function onPointerDragMove(e) {
    if (!pointerDragClone) return;
    movePointerClone(e.clientX, e.clientY);
}

function onPointerDragUp(e) {
    document.removeEventListener('mousemove', onPointerDragMove);
    document.removeEventListener('mouseup', onPointerDragUp);

    if (pointerDragClone) {
        pointerDragClone.remove();
        pointerDragClone = null;
    }
    if (pointerDragPiece) {
        pointerDragPiece.style.opacity = '1';
        pointerDragPiece = null;
    }

    const targetEl = document.elementFromPoint(e.clientX, e.clientY);
    const squareDiv = targetEl ? targetEl.closest('.square') : null;

    if (squareDiv && squareDiv.dataset.square && sourceSquare) {
        const targetSquare = squareDiv.dataset.square;
        if (sourceSquare !== targetSquare) {
            if (game.turn() !== myColor) {
                const srcPiece = getPredictedPieceAt(sourceSquare);
                if (srcPiece && isPseudoLegalPremove(sourceSquare, targetSquare, srcPiece)) {
                    premoveQueue.push({ from: sourceSquare, to: targetSquare, piece: srcPiece });
                    renderBoard();
                }
            } else {
                makeMove(sourceSquare, targetSquare, e);
            }
        } else {
            selectedSquare = sourceSquare;
            if (game.turn() === myColor) highlightMoves(sourceSquare);
            else handlePremoveClick(sourceSquare);
        }
    }

    sourceSquare = null;
}

function highlightMoves(square) {
    // Clear existing hints first (visually)
    document.querySelectorAll('.square').forEach(sq => {
        sq.classList.remove('selected', 'capture-hint');
        const hint = sq.querySelector('.hint');
        if (hint) hint.remove();
    });

    // Highlight selected
    const selectedDiv = document.querySelector(`.square[data-square="${square}"]`);
    if (selectedDiv) selectedDiv.classList.add('selected');

    // Highlight moves
    const moves = game.moves({ square: square, verbose: true });
    moves.forEach(move => {
        const targetDiv = document.querySelector(`.square[data-square="${move.to}"]`);
        if (targetDiv) {
            if (move.flags.includes('c') || move.flags.includes('e')) {
                targetDiv.classList.add('capture-hint');
            } else {
                const hint = document.createElement('div');
                hint.className = 'hint';
                targetDiv.appendChild(hint);
            }
        }
    });

    // Re-apply check highlight if king is in check
    if (game.in_check()) {
        highlightKingInCheck();
    }
}

function highlightPremoveMoves(square) {
    document.querySelectorAll('.square').forEach(sq => {
        sq.classList.remove('selected', 'capture-hint');
        const hint = sq.querySelector('.hint');
        if (hint) hint.remove();
    });

    const selectedDiv = document.querySelector(`.square[data-square="${square}"]`);
    if (selectedDiv) selectedDiv.classList.add('selected');

    const piece = getPredictedPieceAt(square);
    if (!piece || piece.color !== myColor) return;

    const files = 'abcdefgh';
    for (let f = 0; f < 8; f++) {
        for (let r = 1; r <= 8; r++) {
            const target = files[f] + r;
            if (target === square) continue;
            if (isPseudoLegalPremove(square, target, piece)) {
                const targetDiv = document.querySelector(`.square[data-square="${target}"]`);
                if (targetDiv) {
                    const targetPiece = getPredictedPieceAt(target);
                    const showCapture = isPremoveCapture(square, target, piece, targetPiece);
                    if (showCapture) {
                        targetDiv.classList.add('capture-hint');
                    } else {
                        const hint = document.createElement('div');
                        hint.className = 'hint';
                        targetDiv.appendChild(hint);
                    }
                }
            }
        }
    }
}

function handleDragOver(e) {
    e.preventDefault();
}

function handleDrop(e, targetSquare) {
    e.preventDefault();
}

// --- TOUCH SUPPORT (Mobile Drag & Drop) ---

let activeTouchPiece = null;

function handleTouchStart(e, square) {
    if (viewIndex !== null) return;
    if (sessionStorage.getItem('gameOverShown') === 'true') return;
    e.preventDefault();
    e.stopPropagation();

    const piece = getPredictedPieceAt(square);
    if (!piece || piece.color !== myColor) return;

    const isPremove = game.turn() !== myColor;

    // Only block touch if bot is thinking AND it's not a premove
    if (isBotThinking && !isPremove) return;

    sourceSquare = square;

    const touch = e.touches[0];
    const target = e.target;

    activeTouchPiece = target;

    // Visual feedback
    if (isPremove) highlightPremoveMoves(square);
    else highlightMoves(square);

    // Prepare for moving
    const rect = target.getBoundingClientRect();
    activeTouchPiece.style.width = rect.width + 'px';
    activeTouchPiece.style.height = rect.height + 'px';
    activeTouchPiece.style.position = 'fixed';
    activeTouchPiece.style.zIndex = '1000';
    // activeTouchPiece.style.pointerEvents = 'none'; // Removed to ensure events keep firing

    // Center piece on finger
    moveTouchPiece(touch.clientX, touch.clientY);
}

function handleTouchMove(e) {
    if (!activeTouchPiece) return;
    e.preventDefault();
    e.stopPropagation();
    const touch = e.touches[0];
    moveTouchPiece(touch.clientX, touch.clientY);
}

function moveTouchPiece(x, y) {
    if (activeTouchPiece) {
        activeTouchPiece.style.left = (x - parseFloat(activeTouchPiece.style.width) / 2) + 'px';
        activeTouchPiece.style.top = (y - parseFloat(activeTouchPiece.style.height) / 2) + 'px';
    }
}

function handleTouchEnd(e) {
    if (!activeTouchPiece) return;
    e.preventDefault();
    e.stopPropagation();

    const touch = e.changedTouches[0];

    // Hide to see what's under
    activeTouchPiece.style.display = 'none';
    const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
    activeTouchPiece.style.display = 'block';

    // Reset styles
    activeTouchPiece.style.position = '';
    activeTouchPiece.style.left = '';
    activeTouchPiece.style.top = '';
    activeTouchPiece.style.zIndex = '';
    activeTouchPiece.style.width = '90%';
    activeTouchPiece.style.height = '90%';
    activeTouchPiece.style.pointerEvents = '';

    activeTouchPiece = null;

    // Find square
    const squareDiv = targetEl ? targetEl.closest('.square') : null;

    if (squareDiv && squareDiv.dataset.square && sourceSquare) {
        const targetSquare = squareDiv.dataset.square;
        if (sourceSquare !== targetSquare) {
            if (game.turn() !== myColor) {
                const srcPiece = getPredictedPieceAt(sourceSquare);
                if (srcPiece && isPseudoLegalPremove(sourceSquare, targetSquare, srcPiece)) {
                    premoveQueue.push({ from: sourceSquare, to: targetSquare, piece: srcPiece });
                    renderBoard();
                }
            } else {
                const touch = e.changedTouches[0];
                makeMove(sourceSquare, targetSquare, touch);
            }
        } else {
            selectedSquare = sourceSquare;
            if (game.turn() === myColor) highlightMoves(sourceSquare);
            else handlePremoveClick(sourceSquare);
        }
    }

    sourceSquare = null;
}

function animateMove(from, to) {
    return new Promise(resolve => {
        // Clean up any leftover dying pieces first
        document.querySelectorAll('.piece-dying').forEach(el => el.remove());

        const fromDiv = document.querySelector(`.square[data-square="${from}"]`);
        const toDiv = document.querySelector(`.square[data-square="${to}"]`);
        if (!fromDiv || !toDiv) { resolve(); return; }

        const pieceDiv = fromDiv.querySelector('.piece');
        if (!pieceDiv) { resolve(); return; }

        // Reset any inline transform before measuring
        pieceDiv.style.transition = 'none';
        pieceDiv.style.transform = 'none';
        void pieceDiv.offsetHeight;

        // Use SQUARE positions (not piece) to avoid interference from active/scale states
        const fromRect = fromDiv.getBoundingClientRect();
        const toRect = toDiv.getBoundingClientRect();
        const dx = toRect.left - fromRect.left;
        const dy = toRect.top - fromRect.top;

        // Remove captured piece immediately
        const capturedPiece = toDiv.querySelector('.piece');
        if (capturedPiece && capturedPiece !== pieceDiv) {
            capturedPiece.remove();
        }

        // Animate
        pieceDiv.style.zIndex = '10';
        pieceDiv.style.transform = `translate(0px, 0px)`;
        void pieceDiv.offsetHeight;
        pieceDiv.style.transition = 'transform 0.18s ease-out';
        pieceDiv.style.transform = `translate(${dx}px, ${dy}px)`;

        let resolved = false;
        const finishAnimation = () => {
            if (resolved) return;
            resolved = true;
            pieceDiv.style.transition = '';
            pieceDiv.style.transform = '';
            pieceDiv.style.zIndex = '';
            lastAnimatedSquare = to;
            resolve();
        };

        pieceDiv.addEventListener('transitionend', finishAnimation, { once: true });
        setTimeout(finishAnimation, 250);
    });
}

// ---------- Pawn promotion ----------

function isPromotionMove(from, to, currentGame = game) {
    const piece = currentGame.get(from);
    if (!piece || piece.type !== 'p') return false;
    const toRank = to[1];
    return (piece.color === 'w' && toRank === '8') ||
           (piece.color === 'b' && toRank === '1');
}

/**
 * Show a contextual popover above (or below) the destination square
 * and let the user pick Q/R/B/N. Resolves with the piece letter, or
 * null if the user cancels.
 */
function showPromotionPicker(toSquare, color) {
    return new Promise((resolve) => {
        // Clean any previous instance
        document.querySelectorAll('.promo-overlay, .promo-popover').forEach(el => el.remove());

        const overlay = document.createElement('div');
        overlay.className = 'promo-overlay';

        const popover = document.createElement('div');
        popover.className = 'promo-popover';

        const colorName = color === 'w' ? 'white' : 'black';
        const pieces = ['q', 'r', 'b', 'n'];
        const pieceNames = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };

        // Position relative to the destination square.
        const toDiv = document.querySelector(`.square[data-square="${toSquare}"]`);
        if (!toDiv) { resolve(null); return; }
        const rect = toDiv.getBoundingClientRect();
        const boardEl = document.getElementById('board');
        const boardRect = boardEl.getBoundingClientRect();
        const sqSize = rect.width;

        // Stack 4 pieces. If the destination is in the top half of the board,
        // stack downward (into the board) so it doesn't escape the screen.
        // Otherwise stack upward.
        const stackDown = (rect.top - boardRect.top) < (boardRect.height / 2);
        const pieceOrder = stackDown ? pieces : pieces.slice().reverse();

        pieceOrder.forEach(p => {
            const btn = document.createElement('button');
            btn.className = 'promo-piece';
            btn.type = 'button';
            btn.dataset.piece = p;
            btn.setAttribute('aria-label', pieceNames[p]);
            const img = document.createElement('img');
            img.src = `pièces/default/${colorName}-${pieceNames[p]}.png`;
            img.alt = pieceNames[p];
            img.draggable = false;
            btn.appendChild(img);
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                cleanup();
                resolve(p);
            });
            popover.appendChild(btn);
        });

        const cancel = document.createElement('button');
        cancel.className = 'promo-cancel';
        cancel.type = 'button';
        cancel.textContent = '×';
        cancel.setAttribute('aria-label', 'Annuler');
        cancel.addEventListener('click', (e) => {
            e.stopPropagation();
            cleanup();
            resolve(null);
        });
        popover.appendChild(cancel);

        // Position: width matches one square; pieces stack 4 high + cancel row.
        popover.style.width = sqSize + 'px';
        // Horizontally clamp so the popover stays on screen.
        let leftPx = rect.left;
        const maxLeft = window.innerWidth - sqSize - 4;
        if (leftPx < 4) leftPx = 4;
        if (leftPx > maxLeft) leftPx = maxLeft;
        popover.style.left = leftPx + 'px';

        const popoverHeight = sqSize * 4 + 28; // 4 pieces + cancel row
        if (stackDown) {
            popover.style.top = rect.top + 'px';
            popover.classList.add('stack-down');
        } else {
            popover.style.top = (rect.bottom - popoverHeight) + 'px';
            popover.classList.add('stack-up');
        }

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                cleanup();
                resolve(null);
            }
        });

        function cleanup() {
            overlay.remove();
            popover.remove();
            document.removeEventListener('keydown', onEsc);
        }
        function onEsc(e) {
            if (e.key === 'Escape') {
                cleanup();
                resolve(null);
            }
        }
        document.addEventListener('keydown', onEsc);

        document.body.appendChild(overlay);
        document.body.appendChild(popover);
    });
}

async function makeMove(from, to, dragEvent = null) {
    // Pawn promotion: ask the player which piece to promote to.
    let promotionPiece = 'q';
    if (isPromotionMove(from, to)) {
        const pawnColor = game.get(from).color;
        isPromotionPending = true;
        try {
            const choice = await showPromotionPicker(to, pawnColor);
            if (!choice) {
                // User cancelled — reset selection and re-render.
                selectedSquare = null;
                renderBoard();
                return;
            }
            promotionPiece = choice;
        } finally {
            isPromotionPending = false;
        }
    }

    const move = game.move({ from, to, promotion: promotionPiece });

    if (move) {
        // Play move or capture sound
        try {
            if (move.flags && (move.flags.includes('c') || move.flags.includes('e'))) {
                playSound('capture');
            } else {
                playSound('move');
            }
        } catch (e) {
            // ignore
        }
        selectedSquare = null;
        lastMove = { from, to };

        const now = Date.now();
        if (timeControl > 0) {
            const elapsed = now - lastMoveTimestamp;
            if (game.turn() === 'b') {
                whiteTimeRemaining -= elapsed;
                if (whiteTimeRemaining < 0) whiteTimeRemaining = 0;
            } else {
                blackTimeRemaining -= elapsed;
                if (blackTimeRemaining < 0) blackTimeRemaining = 0;
            }
        }
        lastMoveTimestamp = now;

        if (!dragEvent) {
            await animateMove(from, to);
        } else {
            // Remove captured piece immediately on drag drop
            document.querySelectorAll('.piece-dying').forEach(el => el.remove());
            const toDiv = document.querySelector(`.square[data-square="${to}"]`);
            if (toDiv) {
                const capturedPiece = toDiv.querySelector('.piece');
                if (capturedPiece && move.captured) {
                    capturedPiece.remove();
                }
            }
            lastAnimatedSquare = to;
            const toDivSnap = document.querySelector(`.square[data-square="${to}"]`);
            if (toDivSnap) {
                const rect = toDivSnap.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                let dropX = dragEvent.clientX;
                let dropY = dragEvent.clientY;
                if (dragEvent.changedTouches && dragEvent.changedTouches.length > 0) {
                    dropX = dragEvent.changedTouches[0].clientX;
                    dropY = dragEvent.changedTouches[0].clientY;
                }
                snapDragOffset = { dx: dropX - centerX, dy: dropY - centerY, square: to };
            }
        }

        // Pass-and-play: the next turn belongs to the other side.
        // Re-target `myColor` and flip the board if rotation is enabled.
        if (gameMode === 'local') {
            myColor = game.turn();
            updateOpponentName();
            if (localAutoRotate) {
                boardFlipped = (myColor === 'b');
            }
            // A fresh move invalidates the redo stack.
            clearLocalRedoStack();
            updateLocalUndoButtons();
        }

        renderBoard();
        updateStatus();
        startTimer();

        if (gameMode === 'duo' && supabaseClient) {
            // Flush any previously failed sync first
            await flushPendingSync();

            // Send this move with automatic retry
            await syncMoveToSupabase({
                fen: game.fen(),
                last_move: `${from}-${to}`,
                pgn: game.pgn(),
                white_time: whiteTimeRemaining,
                black_time: blackTimeRemaining,
                last_move_ts: lastMoveTimestamp
            });
        }

        // Save game state after every move (both modes)
        saveGameState();

        // --- EVAL BAR ---
        triggerEvalForPosition(game.fen());

        if (gameMode === 'solo' && game.turn() !== myColor && !game.game_over()) {
            makeBotMove();
        }
    } else {
        selectedSquare = null;
        // renderBoard(); // Optimized to avoid flickering
        document.querySelectorAll('.square').forEach(sq => {
            sq.classList.remove('selected', 'capture-hint');
            const hint = sq.querySelector('.hint');
            if (hint) hint.remove();
        });
    }
}

function startTimer() {
    if (timerInterval) clearInterval(timerInterval);

    // If game over or infinite time, stop
    if (game.game_over() || timeControl === 0) {
        updateTimerDisplay();
        return;
    }

    timerInterval = setInterval(() => {
        const now = Date.now();
        const elapsed = now - lastMoveTimestamp;

        // Calculate current remaining time for active player
        // Note: The stored time is the time remaining at the START of the turn
        // So we subtract elapsed from that.

        let currentWhite = whiteTimeRemaining;
        let currentBlack = blackTimeRemaining;

        if (game.turn() === 'w') {
            currentWhite -= elapsed;
        } else {
            currentBlack -= elapsed;
        }

        // Check for flag fall
        if (currentWhite <= 0) {
            currentWhite = 0;
            clearInterval(timerInterval);
            showGameOver('Noirs', { reason: 'timeout' }); // White ran out of time
        } else if (currentBlack <= 0) {
            currentBlack = 0;
            clearInterval(timerInterval);
            showGameOver('Blancs', { reason: 'timeout' }); // Black ran out of time
        }

        updateTimerDisplay(currentWhite, currentBlack);
    }, 100);

    // Initial update
    updateTimerDisplay();
}

function updateTimerDisplay(currentWhite = null, currentBlack = null) {
    // If not provided (e.g. initial call), use stored values
    // But for active player, we want the calculated value from setInterval

    let wTime = currentWhite !== null ? currentWhite : whiteTimeRemaining;
    let bTime = currentBlack !== null ? currentBlack : blackTimeRemaining;

    // If infinite
    if (timeControl === 0) {
        myTimerEl.style.display = 'none';
        opponentTimerEl.style.display = 'none';
        return;
    } else {
        myTimerEl.style.display = 'block';
        opponentTimerEl.style.display = 'block';
    }

    const formatTime = (ms) => {
        if (ms < 0) ms = 0;
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    const myTime = myColor === 'w' ? wTime : bTime;
    const oppTime = myColor === 'w' ? bTime : wTime;

    myTimerEl.innerText = formatTime(myTime);
    opponentTimerEl.innerText = formatTime(oppTime);

    // Low time warning (< 30s) AND > 0
    if (myTime < 30000 && myTime > 0) myTimerEl.classList.add('low-time');
    else myTimerEl.classList.remove('low-time');

    if (oppTime < 30000 && oppTime > 0) opponentTimerEl.classList.add('low-time');
    else opponentTimerEl.classList.remove('low-time');
}

function updateStatus(showGameOverModal = true) {
    const activeGame = getHistoricalGame(viewIndex);

    let status = '';
    let moveColor = activeGame.turn() === 'w' ? 'Blancs' : 'Noirs';

    // Update History UI
    updateHistoryUI();

    // Update Captured Pieces
    updateCapturedPieces(activeGame);

    // Check for game over conditions
    if (activeGame.in_checkmate()) {
        const winner = activeGame.turn() === 'w' ? 'Noirs' : 'Blancs';
        status = `Échec et mat ! ${winner} gagnent.`;
        stopCheckSound();
        if (viewIndex === null && showGameOverModal) showGameOver(winner);
    } else if (activeGame.in_draw() || activeGame.in_stalemate() || activeGame.in_threefold_repetition() || activeGame.insufficient_material()) {
        status = 'Match nul !';
        stopCheckSound();
        if (viewIndex === null && showGameOverModal) showGameOver('draw');
    } else {
        if (gameMode === 'solo' && isBotThinking) {
            status = 'Bot réfléchit...';
        } else {
            status = `Au tour des ${moveColor}`;
        }
        if (activeGame.in_check()) {
            status += ' (Échec !)';
            highlightKingInCheck(activeGame);
            if (viewIndex === null) startCheckSound();
        } else {
            stopCheckSound();
            // Remove check highlight if not in check
            // renderBoard handles this
        }
    }

    if (viewIndex !== null) {
        const total = game.history().length;
        const current = viewIndex + 1;
        status = `Historique (${current}/${total})`;
        if (viewIndex === -1) status = `Historique (Début)`;
    }

    statusEl.textContent = status;

    // Update indicators
    if (activeGame.turn() === myColor) {
        myIndicator.classList.add('active');
        opponentIndicator.classList.remove('active');
    } else {
        myIndicator.classList.remove('active');
        opponentIndicator.classList.add('active');
    }
}

function highlightKingInCheck(activeGame = game) {
    const kingColor = activeGame.turn();
    const board = activeGame.board();
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const piece = board[r][c];
            if (piece && piece.type === 'k' && piece.color === kingColor) {
                const squareName = String.fromCharCode(97 + c) + (8 - r);
                const kingSquare = document.querySelector(`[data-square="${squareName}"]`);
                if (kingSquare) {
                    kingSquare.classList.add('in-check');
                }
            }
        }
    }
}

const WIN_MESSAGES = [
    "Bravo mon cœur ! Tu es trop forte ! 😺",
    "Victoire éclatante ! Je suis fier de toi ! 😸",
    "Tu as gagné ! Yayyyyy 😽",
    "Championne du monde (de mon cœur) ! 😻",
    "Échec et mat ! Tu es brillante ! :)",
    "Wouah ! Quelle intelligence ! ;)"
];

const LOSE_MESSAGES = [
    "Oh non... Mais tu restes la meilleure ! 😿",
    "Pas grave, on refait une partie ? :(",
    "Tu m'as laissé gagner, avoue ! 😼",
    "L'important c'est de participer (et de m'aimer) ! 😽",
    "Belle partie quand même ! Câlin de réconfort ? :)",
    "Mince alors... Bisous pour soigner ça ? 😿"
];

/**
 * Clear all game over flags from storage when starting a new game.
 * Removes both legacy sessionStorage flag and all localStorage gameOver_* keys.
 */
function clearGameOverFlags() {
    // Remove legacy sessionStorage flag
    sessionStorage.removeItem('gameOverShown');
    
    // Remove all gameOver_* keys from localStorage
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('gameOver_')) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));
}

function showGameOver(winner, context = {}) {
    // Prevent showing game over multiple times for the same game (even across page reloads)
    const currentPgn = game.pgn();
    const gameOverKey = `gameOver_${gameMode}_${currentPgn}`;
    if (localStorage.getItem(gameOverKey) === 'true') return;
    localStorage.setItem(gameOverKey, 'true');

    clearPremove();

    // Play game over sound
    try { playSound('gameOver'); } catch (e) { }

    // Save to game history before clearing.
    // In local mode `myColor` flips every turn, so we record the result
    // from White's perspective and always save with my_color = 'w'.
    let result = 'draw';
    if (winner !== 'draw') {
        if (gameMode === 'local') {
            result = winner === 'Blancs' ? 'win' : 'loss';
        } else {
            const iWon = (winner === 'Blancs' && myColor === 'w') ||
                         (winner === 'Noirs'  && myColor === 'b');
            result = iWon ? 'win' : 'loss';
        }
    }
    saveGameToHistory(result, context.reason || null);

    // Clear the saved game since the game is over
    clearGameSave(gameMode);

    gameOverModal.classList.remove('hidden');
    // Pick the confetti style that matches the outcome.
    const reason = context && context.reason;
    let confettiKind = 'checkmate';
    if (winner === 'draw')         confettiKind = 'draw';
    else if (reason === 'resign')  confettiKind = 'resign';
    else if (reason === 'timeout') confettiKind = 'timeout';

    if (winner === 'draw') {
        gameOverTitle.textContent = "Match Nul !";
        gameOverMessage.textContent = gameMode === 'local'
            ? "Partie nulle. Bien joué à vous deux !"
            : "On est trop connectés, impossible de se départager ! 🤝";
        triggerConfetti(confettiKind);
    } else if (gameMode === 'local') {
        // Pass-and-play: announce the winning side, no "me/opponent" perspective.
        gameOverTitle.textContent = `Les ${winner} gagnent ! 🎉`;
        gameOverMessage.textContent = reason === 'resign'
            ? `${winner === 'Blancs' ? 'Les Noirs' : 'Les Blancs'} ont abandonné.`
            : reason === 'timeout'
                ? `${winner === 'Blancs' ? 'Les Noirs' : 'Les Blancs'} ont manqué de temps.`
                : 'Échec et mat. GG !';
        triggerConfetti(confettiKind);
    } else {
        const iWon = (winner === 'Blancs' && myColor === 'w') || (winner === 'Noirs' && myColor === 'b');
        const opponentName = myName === 'Benji' ? 'Sanaa' : 'Benji';

        if (reason === 'resign') {
            gameOverTitle.textContent = iWon ? 'Victoire par démission' : 'Défaite par démission';
            if (iWon) {
                gameOverMessage.textContent = `${opponentName} a abandonné la partie.`;
            } else {
                gameOverMessage.textContent = `Tu as abandonné la partie.`;
            }
        } else {
            gameOverTitle.textContent = iWon ? "Victoire ! 🎉" : "Défaite...";

            const messages = iWon ? WIN_MESSAGES : LOSE_MESSAGES;
            const randomMsg = messages[Math.floor(Math.random() * messages.length)];

            gameOverMessage.textContent = randomMsg;
        }

        if (iWon) {
            // Resign / timeout aren't celebratory wins — no confetti there.
            triggerConfetti(confettiKind);
            try { playSound('capture'); } catch (e) { }
        }
    }
}

/**
 * Replay the last game with the same parameters (mode, color, time, bot settings).
 * Called from the "Rejouer" button in the game-over modal.
 */
async function replayGame() {
    closeModal('game-over-modal');
    clearGameOverFlags();

    if (!lastGameParams) {
        // Fallback: return to menu if no params saved
        returnToMenu();
        return;
    }

    const params = lastGameParams;

    if (params.mode === 'local') {
        // Pass-and-play replay (same time + rotation settings)
        gameMode = 'local';
        localAutoRotate = !!params.localAutoRotate;

        game.reset();
        lastMove = null;
        viewIndex = null;
        isBotThinking = false;
        myColor = 'w';
        boardFlipped = false;

        const replayMinutes = typeof params.time === 'number' ? params.time : 0;
        timeControl = replayMinutes * 60 * 1000;
        whiteTimeRemaining = timeControl;
        blackTimeRemaining = timeControl;
        lastMoveTimestamp = Date.now();

        const rotateInput = document.getElementById('rotate-toggle-input');
        if (rotateInput) rotateInput.checked = localAutoRotate;

        clearLocalRedoStack();
        renderBoard();
        updateStatus();
        startTimer();
        updateModeBadge();
        updateOpponentName();
        return;
    }

    if (params.mode === 'solo') {
        // Solo replay
        gameMode = 'solo';
        botDifficulty = params.botDifficulty || 1;
        botEloOverride = params.botEloOverride || null;

        let whitePlayerName = myName;
        if (params.color === 'black') {
            whitePlayerName = 'Bot';
        } else if (params.color === 'random') {
            whitePlayerName = Math.random() < 0.5 ? myName : 'Bot';
        }

        game.reset();
        lastMove = null;
        viewIndex = null;
        isBotThinking = false;

        myColor = (whitePlayerName === myName) ? 'w' : 'b';
        boardFlipped = (myColor === 'b');

        timeControl = (params.time || 0) * 60 * 1000;
        whiteTimeRemaining = timeControl;
        blackTimeRemaining = timeControl;
        lastMoveTimestamp = Date.now();

        renderBoard();
        updateStatus();
        startTimer();
        updateModeBadge();
        updateOpponentName();

        if (game.turn() !== myColor) {
            makeBotMove();
        }
    } else {
        // Duo replay — reset Supabase and start fresh
        gameMode = 'duo';

        let whitePlayerName = myName;
        if (params.color === 'black') {
            whitePlayerName = myName === 'Benji' ? 'Sanaa' : 'Benji';
        } else if (params.color === 'random') {
            whitePlayerName = Math.random() < 0.5 ? 'Benji' : 'Sanaa';
        }

        game.reset();
        lastMove = null;
        viewIndex = null;
        isBotThinking = false;

        myColor = (whitePlayerName === myName) ? 'w' : 'b';
        boardFlipped = (myColor === 'b');

        timeControl = (params.time || 5) * 60 * 1000;
        whiteTimeRemaining = timeControl;
        blackTimeRemaining = timeControl;
        lastMoveTimestamp = Date.now();

        // Reset Supabase first
        if (supabaseClient) {
            duoInitializing = true;
            try {
                await supabaseClient
                    .from('chess_state')
                    .update({
                        fen: game.fen(),
                        last_move: '',
                        white_player: whitePlayerName,
                        pgn: '',
                        white_time: whiteTimeRemaining,
                        black_time: blackTimeRemaining,
                        last_move_ts: lastMoveTimestamp,
                        time_control: timeControl,
                        status: null,
                        draw_offer: null,
                        draw_rejected: null,
                        resigned_by: null
                    })
                    .eq('id', GAME_ID);
            } catch (error) {
                console.error('Erreur Supabase reset:', error);
            }
            duoInitializing = false;
        }

        renderBoard();
        updateStatus();
        startTimer();
        updateModeBadge();
        updateOpponentName();

        // Re-init Supabase subscriptions
        if (supabaseClient) {
            setupRealtimeSubscription();
            setupChatSubscription();
            setupPresence();
        }
    }
}

/**
 * Trigger a confetti burst tuned to the game outcome.
 *
 * Variants:
 *   - 'checkmate' : double burst + golden cannons (default if no kind passed)
 *   - 'draw'      : gentle silver ribbons drifting down
 *   - 'resign'    : nothing (defeat by giving up — no celebration)
 *   - 'timeout'   : same as resign
 *   - 'win'       : alias of checkmate (kept for older call sites)
 */
function triggerConfetti(kind) {
    if (typeof confetti !== 'function') return;
    if (kind === 'resign' || kind === 'timeout') return; // no party for forfeits

    if (kind === 'draw') {
        // Slow silver/grey ribbons — visually says "it's a tie".
        const colors = ['#c0c5cc', '#9aa0a6', '#dfe1e5', '#e8eaed'];
        confetti({
            particleCount: 60,
            spread: 100,
            startVelocity: 22,
            ticks: 220,
            gravity: 0.55,
            decay: 0.92,
            scalar: 0.9,
            shapes: ['circle'],
            colors,
            origin: { x: 0.5, y: 0.3 },
            zIndex: 9999
        });
        setTimeout(() => confetti({
            particleCount: 30,
            spread: 70,
            startVelocity: 18,
            ticks: 180,
            gravity: 0.5,
            colors,
            origin: { x: 0.5, y: 0.4 },
            zIndex: 9999
        }), 350);
        return;
    }

    // Default / 'checkmate' / 'win' — theatrical celebration.
    const goldPalette = ['#ffd700', '#ffea70', '#ffae00', '#ffffff', '#fff7c2'];
    const accentPalette = [
        getComputedStyle(document.documentElement)
            .getPropertyValue('--accent').trim() || '#88B04B',
        '#ffd700', '#ffffff'
    ];

    // Initial big burst from both sides
    confetti({
        particleCount: 90,
        angle: 60,
        spread: 65,
        startVelocity: 55,
        origin: { x: 0, y: 0.7 },
        colors: goldPalette,
        zIndex: 9999,
        scalar: 1.1
    });
    confetti({
        particleCount: 90,
        angle: 120,
        spread: 65,
        startVelocity: 55,
        origin: { x: 1, y: 0.7 },
        colors: goldPalette,
        zIndex: 9999,
        scalar: 1.1
    });

    // Sustained streamers across the top for ~3s
    const duration = 3000;
    const end = Date.now() + duration;
    const interval = setInterval(() => {
        const left = end - Date.now();
        if (left <= 0) return clearInterval(interval);
        const particleCount = 28 * (left / duration);
        confetti({
            particleCount,
            spread: 360,
            startVelocity: 28,
            ticks: 70,
            origin: { x: 0.1 + Math.random() * 0.2, y: Math.random() - 0.2 },
            colors: accentPalette,
            zIndex: 9999
        });
        confetti({
            particleCount,
            spread: 360,
            startVelocity: 28,
            ticks: 70,
            origin: { x: 0.7 + Math.random() * 0.2, y: Math.random() - 0.2 },
            colors: accentPalette,
            zIndex: 9999
        });
    }, 220);
}

async function proposeDraw() {
    settingsDropdown.classList.remove('active');
    // Solo mode: offer draw is not applicable (playing vs bot)
    if (gameMode === 'solo') {
        alert('Impossible de proposer un nul contre le bot. Vous pouvez abandonner si vous le souhaitez.');
        return;
    }
    if (gameMode !== 'duo' || !GAME_ID) return;
    if (supabaseClient) {
        try {
            await supabaseClient.from('chess_state').update({ draw_offer: myName }).eq('id', GAME_ID);
        } catch (e) {
            console.error('Erreur proposition nul:', e);
        }
    }
    statusEl.textContent = 'Proposition de nul envoyée...';
    const item = document.getElementById('draw-offer-item');
    if (item) {
        item.style.pointerEvents = 'none';
        item.style.opacity = '0.4';
        setTimeout(() => { item.style.pointerEvents = ''; item.style.opacity = ''; }, 10000);
    }
}

async function acceptDraw() {
    closeModal('draw-offer-modal');
    if (!GAME_ID) return;
    if (supabaseClient) {
        try {
            await supabaseClient.from('chess_state').update({ draw_offer: null, status: 'draw' }).eq('id', GAME_ID);
        } catch (e) {
            console.error('Erreur accept nul:', e);
        }
    }
    showGameOver('draw');
}

async function declineDraw() {
    closeModal('draw-offer-modal');
    if (!GAME_ID) return;
    if (supabaseClient) {
        try {
            await supabaseClient.from('chess_state').update({ draw_offer: null, draw_rejected: myName }).eq('id', GAME_ID);
        } catch (e) {
            console.error('Erreur refus nul:', e);
        }
    }
    statusEl.textContent = 'Proposition de nul refusée.';
}

function openResignModal() {
    settingsDropdown.classList.remove('active');
    document.getElementById('resign-modal').classList.remove('hidden');
}

async function confirmResign() {
    closeModal('resign-modal');
    // In solo mode, just show game over locally
    if (gameMode === 'solo') {
        const winner = myColor === 'w' ? 'Noirs' : 'Blancs';
        game.reset({ layout: ' unicode' });
        showGameOver(winner, { reason: 'resign', resignedBy: myName });
        clearSoloState();
        return;
    }
    // Duo mode: update Supabase. The real winner will be calculated by the other player based on `resigned_by`
    if (gameMode !== 'duo' || !GAME_ID) return;

    // Determine winner immediately for local UI, though updateGameState will also handle it
    const winner = myColor === 'w' ? 'Noirs' : 'Blancs';

    if (supabaseClient) {
        try {
            await supabaseClient.from('chess_state').update({ status: 'resigned', resigned_by: myName }).eq('id', GAME_ID);
        } catch (e) {
            console.error('Erreur abandon:', e);
        }
    }
    showGameOver(winner, { reason: 'resign', resignedBy: myName });
}

function updateHistoryUI() {
    const history = game.history();
    const desktopContainer = document.getElementById('desktop-history');
    const historyList = document.getElementById('history-list');

    // Generate HTML
    let html = '';
    for (let i = 0; i < history.length; i += 2) {
        const moveNumber = Math.floor(i / 2) + 1;
        const whiteMove = history[i];
        const blackMove = history[i + 1] || '';

        html += `<div class="history-move"><span>${moveNumber}.</span> ${whiteMove} ${blackMove}</div>`;
    }

    if (desktopContainer) {
        desktopContainer.innerHTML = html;
        desktopContainer.scrollTop = desktopContainer.scrollHeight;
    }
    if (historyList) {
        historyList.innerHTML = html;
        historyList.scrollTop = historyList.scrollHeight;
    }
}

function updateCapturedPieces(activeGame = game) {
    const board = activeGame.board();
    const capturedMeEl = document.getElementById('captured-me');
    const capturedOpponentEl = document.getElementById('captured-opponent');

    const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };

    const initial = {
        w: { p: 8, n: 2, b: 2, r: 2, q: 1 },
        b: { p: 8, n: 2, b: 2, r: 2, q: 1 }
    };

    const current = {
        w: { p: 0, n: 0, b: 0, r: 0, q: 0 },
        b: { p: 0, n: 0, b: 0, r: 0, q: 0 }
    };

    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const piece = board[r][c];
            if (piece && piece.type !== 'k') {
                current[piece.color][piece.type]++;
            }
        }
    }

    const opponentColor = myColor === 'w' ? 'b' : 'w';

    const capturedByMe = [];
    let myScore = 0;
    ['p', 'n', 'b', 'r', 'q'].forEach(type => {
        const count = initial[opponentColor][type] - current[opponentColor][type];
        for (let i = 0; i < count; i++) {
            capturedByMe.push({ type, color: opponentColor });
        }
        myScore += count * PIECE_VALUES[type];
    });

    const capturedByOpponent = [];
    let oppScore = 0;
    ['p', 'n', 'b', 'r', 'q'].forEach(type => {
        const count = initial[myColor][type] - current[myColor][type];
        for (let i = 0; i < count; i++) {
            capturedByOpponent.push({ type, color: myColor });
        }
        oppScore += count * PIECE_VALUES[type];
    });

    const diff = myScore - oppScore;

    const renderPieces = (container, pieces, advantage) => {
        if (!container) return;
        let html = pieces.map((p, index) => {
            const colorName = p.color === 'w' ? 'white' : 'black';
            const typeName = getPieceName(p.type);
            const isStacked = index > 0 && pieces[index - 1].type === p.type;
            const stackClass = isStacked ? 'stacked' : '';
            return `<div class="captured-piece ${stackClass}" style="background-image: url('pièces/default/${colorName}-${typeName}.png')"></div>`;
        }).join('');

        if (advantage > 0) {
            html += `<span class="material-score">+${advantage}</span>`;
        }
        container.innerHTML = html;
    };

    renderPieces(capturedMeEl, capturedByMe, diff > 0 ? diff : 0);
    renderPieces(capturedOpponentEl, capturedByOpponent, diff < 0 ? -diff : 0);
}

// Boutons
document.getElementById('flip-btn').addEventListener('click', () => {
    boardFlipped = !boardFlipped;
    renderBoard();
    // --- EVAL BAR ---
    triggerEvalForPosition(game.fen());
});

// In-game rotation toggle (kebab menu, local mode only).
// Disabling mid-game snaps the board back to the default (white at bottom).
(function wireRotateToggle() {
    const rotateInput = document.getElementById('rotate-toggle-input');
    if (!rotateInput) return;
    rotateInput.addEventListener('change', () => {
        localAutoRotate = !!rotateInput.checked;
        if (gameMode !== 'local') return;
        if (localAutoRotate) {
            boardFlipped = (game.turn() === 'b');
        } else {
            // Reset to default orientation (white at bottom) immediately.
            boardFlipped = false;
        }
        renderBoard();
    });
})();

// ---------- Local pass-and-play: undo / redo ----------

function updateLocalUndoButtons() {
    const undoBtns = [
        document.getElementById('btn-undo'),
        document.getElementById('btn-undo-top')
    ].filter(Boolean);
    const redoBtns = [
        document.getElementById('btn-redo'),
        document.getElementById('btn-redo-top')
    ].filter(Boolean);
    const moves = game.history();
    const canUndo = !(moves.length === 0 || gameMode !== 'local');
    const canRedo = !(localRedoStack.length === 0 || gameMode !== 'local');
    undoBtns.forEach(b => { b.disabled = !canUndo; });
    redoBtns.forEach(b => { b.disabled = !canRedo; });
}

function clearLocalRedoStack() {
    localRedoStack = [];
    updateLocalUndoButtons();
}

function performLocalUndo() {
    if (gameMode !== 'local') return;
    if (viewIndex !== null) return; // refuse while browsing history
    const undone = game.undo();
    if (!undone) return;
    // Push to redo stack with the SAN so we can replay exactly the same coup
    localRedoStack.push(undone);

    // Rebuild client-side state.
    selectedSquare = null;
    lastMove = null;
    const history = game.history({ verbose: true });
    if (history.length > 0) {
        const last = history[history.length - 1];
        lastMove = { from: last.from, to: last.to };
    }
    myColor = game.turn();
    if (localAutoRotate) boardFlipped = (myColor === 'b');
    lastMoveTimestamp = Date.now();

    renderBoard();
    updateStatus();
    updateOpponentName();
    triggerEvalForPosition(game.fen());
    saveGameState();
    updateLocalUndoButtons();
    try { playSound('move'); } catch (e) {}
}

function performLocalRedo() {
    if (gameMode !== 'local') return;
    if (viewIndex !== null) return;
    if (localRedoStack.length === 0) return;
    const m = localRedoStack.pop();
    const applied = game.move({
        from: m.from,
        to: m.to,
        promotion: m.promotion || undefined
    });
    if (!applied) {
        updateLocalUndoButtons();
        return;
    }
    selectedSquare = null;
    lastMove = { from: applied.from, to: applied.to };
    myColor = game.turn();
    if (localAutoRotate) boardFlipped = (myColor === 'b');
    lastMoveTimestamp = Date.now();

    renderBoard();
    updateStatus();
    updateOpponentName();
    triggerEvalForPosition(game.fen());
    saveGameState();
    updateLocalUndoButtons();
    try {
        if (applied.captured) playSound('capture');
        else playSound('move');
    } catch (e) {}
}

(function wireUndoRedo() {
    ['btn-undo', 'btn-undo-top'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', (e) => { e.stopPropagation(); performLocalUndo(); });
    });
    ['btn-redo', 'btn-redo-top'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', (e) => { e.stopPropagation(); performLocalRedo(); });
    });
})();

document.getElementById('reset-btn').addEventListener('click', () => {
    openNewGameModal();
});

// Service Worker Management
// Désinscription forcée du Service Worker pour éviter le cache agressif
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(registrations => {
        for (let registration of registrations) {
            registration.unregister();
            console.log('Service Worker désinscrit');
        }
    });
}

// Gestion de la visibilité (PWA/Mobile) pour rafraîchir l'état au retour
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
        console.log('App is back in foreground (mode=' + gameMode + ')');

        // --- Solo mode: preserve local state, skip Supabase sync ---
        if (gameMode === 'solo') {
            // Re-render board and timers to reflect any elapsed time
            renderBoard();
            updateStatus(false); // Don't re-show game over modal on return
            startTimer();
            // If it's the bot's turn and no search is in progress, resume
            if (game.turn() !== myColor && !game.game_over() && !isBotThinking) {
                makeBotMove();
            }
            return;
        }

        // --- Local pass-and-play: preserve local state, never touch Supabase ---
        // (Without this, the Duo branch below would refetch a stale Duo state
        //  and overwrite the local game — making it look like "the bot" took over.)
        if (gameMode === 'local') {
            renderBoard();
            updateStatus(false);
            startTimer();
            return;
        }

        // --- Duo mode: re-fetch state from Supabase ---
        if (supabaseClient) {
            // Flush any move that failed to sync while the app was backgrounded
            await flushPendingSync();

            try {
                const response = await supabaseClient
                    .from('chess_state')
                    .select('*')
                    .eq('id', GAME_ID)
                    .single();

                if (response.data) {
                    console.log('Duo state refreshed:', response.data);
                    updateGameState(response.data);
                }

                // Force Reconnect Realtime
                console.log('Forcing realtime reconnection...');
                setupRealtimeSubscription();

            } catch (e) {
                console.error('Error refreshing game state:', e);
            }
        }
    }
});

// History Buttons
document.getElementById('btn-prev').addEventListener('click', () => navigateHistory(-1));
document.getElementById('btn-next').addEventListener('click', () => navigateHistory(1));

// --- CHAT SYSTEM ---

function toggleChat() {
    const sidebar = document.getElementById('chat-sidebar');
    sidebar.classList.toggle('open');

    // Clear badge when opening
    if (sidebar.classList.contains('open')) {
        document.getElementById('chat-badge').classList.add('hidden');
        scrollToBottom();
    }
}

async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();

    if (!message || !supabaseClient) return;

    input.value = ''; // Clear input immediately

    // Hide button immediately
    const btn = document.getElementById('chat-send-btn');
    if (btn) btn.classList.remove('visible');

    try {
        await supabaseClient
            .from('chess_chat')
            .insert([
                {
                    game_id: GAME_ID,
                    sender: myName,
                    message: message
                }
            ]);
    } catch (error) {
        console.error('Erreur envoi message:', error);
    }
}

// --- Chat Image Handling ---

function handleChatImage(input) {
    const file = input.files[0];
    if (!file) return;

    // Reset input so user can pick same file again
    input.value = '';

    // Max 2MB raw check
    if (file.size > 5 * 1024 * 1024) {
        alert('Image trop lourde (max 5 Mo)');
        return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
            // Compress: max 600px, JPEG quality 0.5
            const maxDim = 600;
            let w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
                if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
                else { w = Math.round(w * maxDim / h); h = maxDim; }
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
            sendChatImage(dataUrl);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

async function sendChatImage(dataUrl) {
    if (!supabaseClient) return;

    try {
        await supabaseClient
            .from('chess_chat')
            .insert([
                {
                    game_id: GAME_ID,
                    sender: myName,
                    message: '[IMG]' + dataUrl
                }
            ]);
    } catch (error) {
        console.error('Erreur envoi image:', error);
    }
}

// Allow Enter key to send
document.getElementById('chat-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
});

function setupChatSubscription() {
    if (!supabaseClient) return;

    // Load existing messages
    loadChatHistory();

    // Subscribe to new messages and deletions
    supabaseClient
        .channel('chess_chat_room')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chess_chat', filter: `game_id=eq.${GAME_ID}` }, payload => {
            displayMessage(payload.new, false);
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chess_chat', filter: `game_id=eq.${GAME_ID}` }, payload => {
            const msgId = payload.old.id;
            const el = document.querySelector(`.message[data-id="${msgId}"]`);
            if (el) el.remove();

            const container = document.getElementById('chat-messages');
            if (container.children.length === 0) {
                container.innerHTML = '<div class="chat-empty">Aucun message...</div>';
            }
        })
        .subscribe();
}

async function loadChatHistory() {
    try {
        const { data, error } = await supabaseClient
            .from('chess_chat')
            .select('*')
            .eq('game_id', GAME_ID)
            .order('created_at', { ascending: true });

        if (data) {
            const container = document.getElementById('chat-messages');
            container.innerHTML = ''; // Clear empty state
            data.forEach(msg => displayMessage(msg, true));
        }
    } catch (e) {
        console.error('Erreur chargement chat:', e);
    }
}

function displayMessage(msg, isHistory = false) {
    const container = document.getElementById('chat-messages');
    const emptyState = container.querySelector('.chat-empty');
    if (emptyState) emptyState.remove();

    const isMe = msg.sender === myName;
    const isSystem = msg.sender === 'Système';
    const msgText = msg.message ? msg.message.trim() : '';
    const isImage = msgText.startsWith('[IMG]');
    const emojiOnly = !isImage && isOnlyEmojis(msgText);

    if (!isHistory && emojiOnly && !isSystem) {
        showReaction(msg.sender, msgText);
    }

    const div = document.createElement('div');
    if (isSystem) {
        div.className = 'message system';
    } else {
        let cls = `message ${isMe ? 'me' : 'opponent'}`;
        if (emojiOnly) cls += ' emoji-only';
        if (isImage) cls += ' has-image';
        div.className = cls;
    }
    div.dataset.id = msg.id;

    const date = new Date(msg.created_at);
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (isImage) {
        const imgSrc = msgText.substring(5); // Remove '[IMG]' prefix
        div.innerHTML = `
            <div class="message-content"><img src="${imgSrc}" class="chat-image-msg" alt="Image" onclick="openChatImageFullscreen(this)" loading="lazy"></div>
            <div class="message-time">${timeStr}</div>
        `;
    } else {
        div.innerHTML = `
            <div class="message-content">${escapeHtml(msg.message)}</div>
            <div class="message-time">${timeStr}</div>
        `;
    }

    container.appendChild(div);
    scrollToBottom();

    const sidebar = document.getElementById('chat-sidebar');
    if (!isHistory && !sidebar.classList.contains('open') && !isMe) {
        document.getElementById('chat-badge').classList.remove('hidden');
    }

    // Vibrate on incoming message (mobile haptic feedback)
    if (!isHistory && !isMe && !isSystem) {
        try {
            if (navigator.vibrate) {
                navigator.vibrate(50); // Android
            } else if (audioCtx) {
                // iOS fallback: tiny silent impulse that sometimes triggers a subtle taptic
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                gain.gain.value = 0.001; // nearly silent
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start();
                osc.stop(audioCtx.currentTime + 0.01);
            }
        } catch (e) { /* ignore */ }
    }
}

const EMOJI_GRAPHEME_TEST = /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|[\u{1F1E0}-\u{1F1FF}]{2}|\u200D|\uFE0F|[\u{E0020}-\u{E007F}]|\u{E0001}|[\u{1F3FB}-\u{1F3FF}]|[\u{FE00}-\u{FE0F}]|\u20E3|[\u{E0061}-\u{E007A}]|[\u{1FA00}-\u{1FAFF}]|[\u{1F900}-\u{1F9FF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{2600}-\u{27BF}]|[\u{2300}-\u{23FF}]|[\u{2B50}]|[\u{200D}]|[\u{1F400}-\u{1F4FF}]|[\u{1F300}-\u{1F3FF}]|[\u{1F000}-\u{1F0FF}]|[\u{1FA70}-\u{1FAFF}]|[\u{2702}-\u{27B0}]|[\u{FE00}-\u{FEFF}]|[\u{1F170}-\u{1F251}])+$/u;

function isOnlyEmojis(str) {
    if (!str || str.length === 0) return false;
    const cleaned = str.replace(/\s/g, '');
    if (cleaned.length === 0 || cleaned.length > 60) return false;

    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
        const graphemes = [...seg.segment(cleaned)].map(s => s.segment);
        if (graphemes.length === 0 || graphemes.length > 8) return false;
        return graphemes.every(g => /^\p{Emoji_Presentation}/u.test(g) || /^\p{Emoji}\uFE0F/u.test(g) || EMOJI_GRAPHEME_TEST.test(g));
    }

    return EMOJI_GRAPHEME_TEST.test(cleaned);
}

function extractEmojis(str) {
    const cleaned = str.replace(/\s/g, '');
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
        return [...seg.segment(cleaned)]
            .map(s => s.segment)
            .filter(s => /^\p{Emoji_Presentation}/u.test(s) || /^\p{Emoji}\uFE0F/u.test(s) || EMOJI_GRAPHEME_TEST.test(s));
    }
    return [...cleaned];
}

function showReaction(sender, emojiStr) {
    const isMe = sender === myName;
    const reactionEl = document.getElementById(isMe ? 'my-reaction' : 'opponent-reaction');
    if (!reactionEl) return;

    if (reactionEl._exitTimer) clearTimeout(reactionEl._exitTimer);
    if (reactionEl._clearTimer) clearTimeout(reactionEl._clearTimer);
    if (reactionEl._rafId) cancelAnimationFrame(reactionEl._rafId);

    const emojis = extractEmojis(emojiStr);
    const toShow = emojis.slice(0, 8);

    reactionEl.classList.remove('exiting', 'entering');
    reactionEl.innerHTML = '';

    toShow.forEach(e => {
        const span = document.createElement('span');
        span.textContent = e;
        span.className = 'reaction-single';
        reactionEl.appendChild(span);
    });

    reactionEl._rafId = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            reactionEl.classList.add('entering');
        });
    });

    reactionEl._exitTimer = setTimeout(() => {
        reactionEl.classList.add('exiting');

        reactionEl._clearTimer = setTimeout(() => {
            reactionEl.innerHTML = '';
            reactionEl.classList.remove('exiting', 'entering');
        }, 500);
    }, 5000);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function openChatImageFullscreen(imgEl) {
    const overlay = document.createElement('div');
    overlay.className = 'chat-img-overlay';
    overlay.innerHTML = `<img src="${imgEl.src}" alt="Image">`;
    overlay.addEventListener('click', () => {
        overlay.classList.add('closing');
        setTimeout(() => overlay.remove(), 250);
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('active'));
}

function scrollToBottom() {
    const container = document.getElementById('chat-messages');
    container.scrollTop = container.scrollHeight;
}

// --- SWIPE GESTURES FOR CHAT ---

let touchStartX = 0;
let touchStartY = 0;

document.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
}, { passive: false });

document.addEventListener('touchend', (e) => {
    const touchEndX = e.changedTouches[0].screenX;
    const touchEndY = e.changedTouches[0].screenY;

    handleSwipe(touchStartX, touchStartY, touchEndX, touchEndY);
}, { passive: false });

function handleSwipe(startX, startY, endX, endY) {
    // Ne pas permettre le swipe dans le menu principal
    if (!gameScreen || gameScreen.classList.contains('hidden')) return;

    // Ne pas gérer le swipe si on est en train de déplacer une pièce (tactile ou souris)
    if (activeTouchPiece || pointerDragPiece) return;

    const diffX = endX - startX;
    const diffY = endY - touchStartY;

    // Check if horizontal swipe is dominant
    if (Math.abs(diffX) > Math.abs(diffY)) {
        // Threshold for swipe
        if (Math.abs(diffX) > 50) {
            const sidebar = document.getElementById('chat-sidebar');

            // Swipe Right (Left -> Right) -> Open Chat
            if (diffX > 0) {
                if (!sidebar.classList.contains('open')) {
                    toggleChat();
                }
            }
            // Swipe Left (Right -> Left) -> Close Chat
            else if (diffX < 0) {
                if (sidebar.classList.contains('open')) {
                    toggleChat();
                }
            }
        }
    }
}

// Chat Input Monitor for Button Visibility
const chatInputEl = document.getElementById('chat-input');
if (chatInputEl) {
    chatInputEl.addEventListener('input', function () {
        const btn = document.getElementById('chat-send-btn');
        if (btn) {
            if (this.value.trim().length > 0) {
                btn.classList.add('visible');
            } else {
                btn.classList.remove('visible');
            }
        }
    });
}

// Close chat when clicking outside
document.addEventListener('click', (e) => {
    const sidebar = document.getElementById('chat-sidebar');
    // Check if chat is open
    if (sidebar.classList.contains('open')) {
        // Check if click is outside sidebar AND not on a toggle button AND not inside a modal
        if (!sidebar.contains(e.target) &&
            !e.target.closest('[onclick="toggleChat()"]') &&
            !e.target.closest('.modal')) {
            toggleChat();
        }
    }
});

function openClearChatModal() {
    openModal('clear-chat-modal');
}

async function confirmClearChat() {
    if (!supabaseClient) return;

    const confirmBtn = document.querySelector('#clear-chat-modal .modal-actions button:first-child');
    const originalText = confirmBtn.innerText;
    confirmBtn.innerText = "Patientez...";
    confirmBtn.disabled = true;

    try {
        // Note: Pour que cela fonctionne, la politique RLS (Row Level Security) de Supabase
        // doit autoriser le DELETE pour le rôle 'anon' ou 'public' sur la table 'chess_chat'.
        const { error, count } = await supabaseClient
            .from('chess_chat')
            .delete({ count: 'exact' })
            .eq('game_id', GAME_ID);

        if (error) throw error;

        console.log(`Chat effacé : ${count} messages supprimés.`);

        // Clear local UI immediately
        const container = document.getElementById('chat-messages');
        container.innerHTML = '<div class="chat-empty">Aucun message...</div>';

        closeModal('clear-chat-modal');

    } catch (error) {
        console.error('Erreur suppression chat:', error);
        alert('Erreur lors de la suppression : Vérifiez les permissions (RLS) sur Supabase.');
    } finally {
        confirmBtn.innerText = originalText;
        confirmBtn.disabled = false;
    }
}

// --- SOLO STATE PERSISTENCE ---

function saveSoloState() {
    if (gameMode !== 'solo') return;
    const state = {
        fen: game.fen(),
        pgn: game.pgn(),
        myColor,
        botDifficulty,
        botEloOverride,
        whiteTimeRemaining,
        blackTimeRemaining,
        timeControl,
        lastMoveTimestamp,
        gameMode: 'solo'
    };
    localStorage.setItem('chess_solo_state', JSON.stringify(state));
}

function restoreSoloState() {
    const saved = localStorage.getItem('chess_solo_state');
    if (!saved) return;

    try {
        const state = JSON.parse(saved);
        if (state.gameMode !== 'solo') return;

        gameMode = 'solo';
        myColor = state.myColor;
        botDifficulty = state.botDifficulty || 3;
        botEloOverride = state.botEloOverride || null;
        timeControl = state.timeControl || 0;
        whiteTimeRemaining = state.whiteTimeRemaining || 0;
        blackTimeRemaining = state.blackTimeRemaining || 0;
        lastMoveTimestamp = state.lastMoveTimestamp || Date.now();

        game.reset();
        if (state.pgn && state.pgn.trim()) {
            game.load_pgn(state.pgn);
        } else if (state.fen) {
            game.load(state.fen);
        }

        boardFlipped = (myColor === 'b');
        updateModeBadge();
        updateOpponentName();
        renderBoard();
        updateStatus();
        startTimer();

        if (game.turn() !== myColor && !game.game_over()) {
            makeBotMove();
        }
    } catch (e) {
        console.error('Erreur restauration solo:', e);
        clearSoloState();
    }
}

function clearSoloState() {
    localStorage.removeItem('chess_solo_state');
}

// ================================================================
// MAIN MENU SYSTEM
// ================================================================

// Menu DOM elements (lazily initialized to avoid TDZ issues)
let mainMenuEl, soloCard, duoCard, soloSettings, duoSettings;
let menuEloSlider, menuEloDisplay, soloLaunchBtn, duoLaunchBtn;
let menuLocalLaunchBtn, menuLocalRotateToggle, menuSubmodeToggle;
let menuDomReady = false;

function ensureMenuDom() {
    if (menuDomReady) return;
    mainMenuEl = document.getElementById('main-menu');
    soloCard = document.getElementById('menu-solo-card');
    duoCard = document.getElementById('menu-duo-card');
    soloSettings = document.getElementById('menu-solo-settings');
    duoSettings = document.getElementById('menu-duo-settings');
    menuEloSlider = document.getElementById('menu-elo-slider');
    menuEloDisplay = document.getElementById('menu-elo-display');
    soloLaunchBtn = document.getElementById('menu-solo-launch');
    duoLaunchBtn = document.getElementById('menu-duo-launch');
    menuLocalLaunchBtn = document.getElementById('menu-local-launch');
    menuLocalRotateToggle = document.getElementById('menu-local-rotate-toggle');
    menuSubmodeToggle = document.getElementById('menu-submode-toggle');
    menuDomReady = true;
}

// Menu state
let menuSoloElo = 400;
let menuSoloDiff = 1;
let menuSoloColor = null;
let menuDuoColor = null;
let menuDuoTime = 5; // Default 5 minutes for duo
let menuSubmode = 'bot'; // 'bot' | 'local' — sub-mode of the Solo card
let menuLocalRotate = true; // Pass-and-play rotation default
let menuLocalTime = 0;      // Pass-and-play time per player in minutes (0 = infinite)

// --- Show / Hide Main Menu ---

function showMainMenu() {
    stopCheckSound();
    ensureMenuDom();
    setupMenuListeners();

    // Ensure game screen is hidden
    gameScreen.classList.add('hidden');
    gameScreen.classList.remove('game-enter', 'game-exit');

    // Reset menu card states
    soloCard.classList.remove('expanded');
    duoCard.classList.remove('expanded');
    menuSoloColor = null;
    menuDuoColor = null;
    menuDuoTime = 5;

    // Reset color button selections
    document.querySelectorAll('#menu-solo-settings .menu-color-btn').forEach(b => b.classList.remove('selected'));
    document.querySelectorAll('#menu-duo-settings .menu-color-btn').forEach(b => b.classList.remove('selected'));
    // Reset time button selections (default to 5 min)
    document.querySelectorAll('#menu-duo-settings .menu-time-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.time === '5');
    });
    soloLaunchBtn.disabled = true;
    duoLaunchBtn.disabled = true;

    // Restore last-used settings
    restoreMenuSettings();

    // Check for saved games
    checkSavedGames();

    // Load last match widget
    loadLastMatch();

    // Show menu
    mainMenuEl.classList.remove('hidden');

    // Check notification status to show/hide the top-left bell
    checkNotificationStatus();
}

function restoreMenuSettings() {
    const saved = localStorage.getItem('chess_new_game_settings');
    if (!saved) return;
    try {
        const s = JSON.parse(saved);

        // Restore Solo sub-mode (bot vs local)
        if (s.mode === 'local') {
            setMenuSubmode('local');
        } else {
            setMenuSubmode('bot');
        }
        if (typeof s.localAutoRotate === 'boolean') {
            menuLocalRotate = s.localAutoRotate;
            if (menuLocalRotateToggle) menuLocalRotateToggle.checked = s.localAutoRotate;
        }
        // Restore time choice for the local pass-and-play sub-panel
        if (s.mode === 'local' && typeof s.time === 'number') {
            menuLocalTime = s.time;
            document.querySelectorAll('#menu-local-time-select .menu-time-btn').forEach(btn => {
                btn.classList.toggle('selected', parseInt(btn.dataset.time) === menuLocalTime);
            });
        }

        // Restore Solo Elo
        if (typeof s.botEloOverride === 'number') {
            menuSoloElo = s.botEloOverride;
            menuSoloDiff = s.botDifficulty || 1;
            menuEloSlider.value = menuSoloElo;
            menuEloDisplay.textContent = menuSoloElo + ' ELO';
            document.querySelectorAll('.menu-elo-btn').forEach(btn => {
                btn.classList.toggle('selected', parseInt(btn.dataset.elo) === menuSoloElo);
            });
        }

        // Restore Duo Time
        if (typeof s.time === 'number') {
            menuDuoTime = s.time;
            document.querySelectorAll('.menu-time-btn').forEach(btn => {
                btn.classList.toggle('selected', parseInt(btn.dataset.time) === menuDuoTime);
            });
        }

        // Restore Duo Color
        if (typeof s.color === 'string') {
            menuDuoColor = s.color;
            document.querySelectorAll('.menu-color-btn').forEach(btn => {
                btn.classList.toggle('selected', btn.dataset.color === menuDuoColor);
            });
            const duoLaunchBtn = document.getElementById('menu-duo-launch');
            if (duoLaunchBtn) duoLaunchBtn.disabled = false;
        }

        // Restore Solo Color (if any was saved in the object, currently solo uses another flow but let's check)
        const activeSoloColorBtn = document.querySelector('#menu-solo-settings .menu-color-btn.selected');
        if (activeSoloColorBtn) {
            menuSoloColor = activeSoloColorBtn.dataset.color;
            const soloLaunchBtn = document.getElementById('menu-solo-launch');
            if (soloLaunchBtn) soloLaunchBtn.disabled = false;
        }

    } catch (e) { /* ignore */ }
}

// --- Card Expand/Collapse ---

function toggleCardExpand(card, otherCard) {
    const isExpanding = !card.classList.contains('expanded');

    // Collapse the other card
    otherCard.classList.remove('expanded');

    if (isExpanding) {
        card.classList.add('expanded');
    } else {
        card.classList.remove('expanded');
    }

    // Fade last-match section when any card is expanded
    updateLastMatchVisibility();
}

function updateLastMatchVisibility() {
    const section = document.getElementById('last-match-section');
    if (!section || section.classList.contains('hidden')) return;
    const anyExpanded = (soloCard && soloCard.classList.contains('expanded')) ||
                        (duoCard && duoCard.classList.contains('expanded'));
    if (anyExpanded) {
        section.classList.add('fade-out');
    } else {
        section.classList.remove('fade-out');
    }
}

// --- Setup Menu Event Listeners (called once DOM is ready) ---
let menuListenersAttached = false;

function setupMenuListeners() {
    if (menuListenersAttached) return;
    ensureMenuDom();
    if (!soloCard || !duoCard) return; // DOM not ready yet
    menuListenersAttached = true;

    // Solo card click
    soloCard.addEventListener('click', (e) => {
        if (soloCard.classList.contains('expanded') && e.target.closest('.menu-card-settings')) return;
        if (soloCard.classList.contains('expanded') && !e.target.closest('.menu-card-front')) return;
        toggleCardExpand(soloCard, duoCard);
    });

    // Duo card click
    duoCard.addEventListener('click', (e) => {
        if (duoCard.classList.contains('expanded') && e.target.closest('.menu-card-settings')) return;
        if (duoCard.classList.contains('expanded') && !e.target.closest('.menu-card-front')) return;
        toggleCardExpand(duoCard, soloCard);
    });

    // Elo Preset Buttons
    document.querySelectorAll('.menu-elo-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const elo = parseInt(btn.dataset.elo);
            const diff = parseInt(btn.dataset.diff);
            menuSoloElo = elo;
            menuSoloDiff = diff;
            menuEloSlider.value = elo;
            menuEloDisplay.textContent = elo + ' ELO';
            document.querySelectorAll('.menu-elo-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
    });

    // Elo Slider
    menuEloSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        const val = parseInt(menuEloSlider.value);
        menuSoloElo = val;
        menuEloDisplay.textContent = val + ' ELO';

        let matchedPreset = false;
        document.querySelectorAll('.menu-elo-btn').forEach(btn => {
            const isMatch = parseInt(btn.dataset.elo) === val;
            btn.classList.toggle('selected', isMatch);
            if (isMatch) {
                menuSoloDiff = parseInt(btn.dataset.diff);
                matchedPreset = true;
            }
        });
        if (!matchedPreset) {
            if (val <= 400) menuSoloDiff = 1;
            else if (val <= 800) menuSoloDiff = 3;
            else if (val <= 1500) menuSoloDiff = 4;
            else menuSoloDiff = 5;
        }
    });

    // Color Selection (Solo)
    document.querySelectorAll('#menu-solo-settings .menu-color-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menuSoloColor = btn.dataset.color;
            document.querySelectorAll('#menu-solo-settings .menu-color-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            soloLaunchBtn.disabled = false;
        });
    });

    // Color Selection (Duo)
    document.querySelectorAll('#menu-duo-settings .menu-color-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menuDuoColor = btn.dataset.color;
            document.querySelectorAll('#menu-duo-settings .menu-color-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            duoLaunchBtn.disabled = false;
        });
    });

    // Time Selection (Duo)
    document.querySelectorAll('#menu-duo-settings .menu-time-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menuDuoTime = parseInt(btn.dataset.time);
            document.querySelectorAll('#menu-duo-settings .menu-time-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
    });

    // Sub-mode toggle (Bot / Local) inside the Solo card
    if (menuSubmodeToggle) {
        menuSubmodeToggle.querySelectorAll('.menu-submode-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                setMenuSubmode(btn.dataset.submode);
            });
        });
    }

    // Local rotation toggle in the menu
    if (menuLocalRotateToggle) {
        menuLocalRotateToggle.addEventListener('change', (e) => {
            menuLocalRotate = !!menuLocalRotateToggle.checked;
        });
    }

    // Local time-control buttons
    document.querySelectorAll('#menu-local-time-select .menu-time-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menuLocalTime = parseInt(btn.dataset.time);
            document.querySelectorAll('#menu-local-time-select .menu-time-btn')
                .forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
    });

    // Launch Local Multiplayer (Pass-and-Play)
    if (menuLocalLaunchBtn) {
        menuLocalLaunchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            startLocalGame();
        });
    }

    // Launch Solo Game
    soloLaunchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!menuSoloColor) return;

        gameMode = 'solo';
        botEloOverride = menuSoloElo;
        botDifficulty = menuSoloDiff;
        selectedColorChoice = menuSoloColor;
        selectedTimeChoice = 0;

        // Save params for replay
        lastGameParams = {
            mode: 'solo',
            color: menuSoloColor,
            time: 0,
            botDifficulty: menuSoloDiff,
            botEloOverride: menuSoloElo
        };

        localStorage.setItem('chess_new_game_settings', JSON.stringify({
            mode: 'solo',
            color: menuSoloColor,
            time: 0,
            botDifficulty: menuSoloDiff,
            botEloOverride: menuSoloElo
        }));

        let whitePlayerName = myName;
        if (menuSoloColor === 'black') {
            whitePlayerName = 'Bot';
        } else if (menuSoloColor === 'random') {
            whitePlayerName = Math.random() < 0.5 ? myName : 'Bot';
        }

        game.reset();
        lastMove = null;
        viewIndex = null;
        isBotThinking = false;

        myColor = (whitePlayerName === myName) ? 'w' : 'b';
        boardFlipped = (myColor === 'b');

        timeControl = 0;
        whiteTimeRemaining = 0;
        blackTimeRemaining = 0;
        lastMoveTimestamp = Date.now();

        transitionMenuToGame(() => {
            renderBoard();
            updateStatus();
            startTimer();
            updateModeBadge();
            updateOpponentName();
            clearGameOverFlags();
            saveGameState();

            if (game.turn() !== myColor) {
                makeBotMove();
            }
        });
    });

    // Launch Duo Game — check Supabase for existing game instead of localStorage
    duoLaunchBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!menuDuoColor) return;

        // Check Supabase for an active duo game
        if (supabaseClient) {
            try {
                const { data } = await supabaseClient
                    .from('chess_state')
                    .select('fen, pgn, status, time_control, white_time, black_time, last_move_ts')
                    .eq('id', GAME_ID)
                    .single();

                if (data && data.pgn && data.pgn.trim() !== '' &&
                    data.status !== 'deleted' && data.status !== 'resigned' && data.status !== 'draw') {

                    let isGameOver = false;
                    let currentTurn = 'w';
                    try {
                        const tempGame = new Chess();
                        tempGame.load_pgn(data.pgn);
                        currentTurn = tempGame.turn();
                        if (tempGame.game_over()) isGameOver = true;
                    } catch (e) { /* ignore */ }

                    if (data.time_control && data.time_control > 0) {
                        let wTime = data.white_time !== undefined && data.white_time !== null ? data.white_time : data.time_control;
                        let bTime = data.black_time !== undefined && data.black_time !== null ? data.black_time : data.time_control;

                        if (data.last_move_ts) {
                            const elapsed = Date.now() - data.last_move_ts;
                            if (currentTurn === 'w') {
                                wTime -= elapsed;
                            } else {
                                bTime -= elapsed;
                            }
                        }

                        if (wTime <= 0 || bTime <= 0) {
                            isGameOver = true;
                        }
                    }

                    if (!isGameOver) {
                        // There's an active, non-finished game on Supabase
                        document.getElementById('resume-duo-modal').classList.remove('hidden');
                        return;
                    }
                }
            } catch (e) {
                // No existing game or error — proceed to new game
            }
        }

        startNewDuoGame();
    });
}

// --- Local Pass-and-Play sub-mode ---

function setMenuSubmode(mode) {
    if (mode !== 'bot' && mode !== 'local') return;
    menuSubmode = mode;
    if (!menuSubmodeToggle) return;

    menuSubmodeToggle.dataset.active = mode;
    menuSubmodeToggle.querySelectorAll('.menu-submode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.submode === mode);
    });
    const botPanel = document.getElementById('menu-submode-bot');
    const localPanel = document.getElementById('menu-submode-local');
    if (botPanel)   botPanel.classList.toggle('hidden', mode !== 'bot');
    if (localPanel) localPanel.classList.toggle('hidden', mode !== 'local');
}

function startLocalGame(rotateOverride, timeOverride) {
    gameMode = 'local';
    if (typeof rotateOverride === 'boolean') {
        localAutoRotate = rotateOverride;
    } else {
        localAutoRotate = !!(menuLocalRotateToggle && menuLocalRotateToggle.checked);
    }

    // Resolve time per player (in minutes). 0 = infinite.
    let timeMinutes;
    if (typeof timeOverride === 'number') {
        timeMinutes = timeOverride;
    } else {
        timeMinutes = menuLocalTime;
    }

    selectedColorChoice = 'white';
    selectedTimeChoice = timeMinutes;

    lastGameParams = {
        mode: 'local',
        color: 'white',
        time: timeMinutes,
        localAutoRotate: localAutoRotate
    };

    localStorage.setItem('chess_new_game_settings', JSON.stringify({
        mode: 'local',
        color: 'white',
        time: timeMinutes,
        localAutoRotate: localAutoRotate
    }));

    game.reset();
    lastMove = null;
    viewIndex = null;
    isBotThinking = false;
    clearGameOverFlags();

    // White starts at the bottom. myColor tracks "who plays next" so
    // the existing turn-gating in onSquareClick allows whoever is to move.
    myColor = 'w';
    boardFlipped = false;

    timeControl = timeMinutes * 60 * 1000;
    whiteTimeRemaining = timeControl;
    blackTimeRemaining = timeControl;
    lastMoveTimestamp = Date.now();

    // Sync the kebab rotate toggle with the current state.
    const rotateInput = document.getElementById('rotate-toggle-input');
    if (rotateInput) rotateInput.checked = localAutoRotate;

    transitionMenuToGame(() => {
        renderBoard();
        updateStatus();
        startTimer();
        updateModeBadge();
        updateOpponentName();
        saveGameState();
        clearLocalRedoStack();
    });
}

function confirmNewDuoGame() {
    closeModal('resume-duo-modal');
    startNewDuoGame();
}

function resumeExistingDuoGame() {
    closeModal('resume-duo-modal');
    // Using existing resumeGame functionality
    resumeGame('duo');
}

async function startNewDuoGame() {

    gameMode = 'duo';
    selectedColorChoice = menuDuoColor;
    selectedTimeChoice = menuDuoTime;

    // Save params for replay
    lastGameParams = {
        mode: 'duo',
        color: menuDuoColor,
        time: menuDuoTime
    };

    localStorage.setItem('chess_new_game_settings', JSON.stringify({
        mode: 'duo',
        color: menuDuoColor,
        time: menuDuoTime,
        botDifficulty: botDifficulty,
        botEloOverride: botEloOverride
    }));

    let whitePlayerName = myName;
    if (menuDuoColor === 'black') {
        whitePlayerName = myName === 'Benji' ? 'Sanaa' : 'Benji';
    } else if (menuDuoColor === 'random') {
        whitePlayerName = Math.random() < 0.5 ? 'Benji' : 'Sanaa';
    }

    game.reset();
    lastMove = null;
    viewIndex = null;
    isBotThinking = false;
    clearGameOverFlags();

    myColor = (whitePlayerName === myName) ? 'w' : 'b';
    boardFlipped = (myColor === 'b');

    timeControl = selectedTimeChoice * 60 * 1000;
    whiteTimeRemaining = timeControl;
    blackTimeRemaining = timeControl;
    lastMoveTimestamp = Date.now();

    clearSoloState();

    // Reset Supabase FIRST to avoid stale state triggers
    if (supabaseClient) {
        try {
            const opponentName = myName === 'Benji' ? 'Sanaa' : 'Benji';
            
            await supabaseClient
                .from('chess_state')
                .upsert({
                    id: GAME_ID,
                    fen: game.fen(),
                    pgn: game.pgn(),
                    white_player: whitePlayerName,
                    white_time: timeControl,
                    black_time: timeControl,
                    time_control: timeControl,
                    last_move_ts: lastMoveTimestamp,
                    status: 'active',
                    draw_offer: null,
                    resigned_by: null,
                    draw_rejected: null
                });

            // Trigger Push Notification to opponent
            notifyOpponentOfNewGame(opponentName);
            
        } catch (e) {
            console.error('Erreur Supabase startNewDuoGame:', e);
        }
    }
    duoInitializing = false;

    transitionMenuToGame(() => {
        renderBoard();
        updateStatus();
        startTimer();
        updateModeBadge();
        updateOpponentName();

        if (supabaseClient) {
            initGame();
        }
    });
}

// --- Transition: Menu → Game ---
function transitionMenuToGame(callback) {
    if (callback) callback();

    mainMenuEl.classList.add('menu-exit');

    setTimeout(() => {
        mainMenuEl.classList.add('hidden');
        mainMenuEl.classList.remove('menu-exit');

        gameScreen.classList.remove('hidden');

        // Force reflow and exact sizing before animation to prevent distorted grid
        void gameScreen.offsetWidth;

        gameScreen.classList.add('game-enter');

        setTimeout(() => {
            gameScreen.classList.remove('game-enter');
        }, 500);
    }, 400);
}

// --- Transition: Game → Menu ---
function transitionGameToMenu() {
    gameScreen.classList.add('game-exit');

    setTimeout(() => {
        gameScreen.classList.add('hidden');
        gameScreen.classList.remove('game-exit');

        // Stop timers
        if (timerInterval) clearInterval(timerInterval);

        showMainMenu();
        mainMenuEl.classList.add('menu-enter');

        setTimeout(() => {
            mainMenuEl.classList.remove('menu-enter');
        }, 500);
    }, 400);
}

// --- Return to Menu (from game screen) ---
function returnToMenu(options = {}) {
    // Save current game state before leaving
    saveGameState();
    clearPremove();

    // Close any open dropdowns/modals
    settingsDropdown.classList.remove('active');

    // Drop the local-mode body class so the menu header isn't affected
    document.body.classList.remove('mode-local');

    // Duo illimité: avertir si quelqu'un quitte la partie
    if (!options.suppressLeaveNotice &&
        gameMode === 'duo' &&
        timeControl === 0 &&
        !game.game_over() &&
        supabaseClient) {
        const now = Date.now();
        if (now - lastSystemNoticeAt > 20000) {
            lastSystemNoticeAt = now;
            // Fire-and-forget
            sendSystemChatMessage(`${myName} a quitté la partie.`);
        }
    }

    transitionGameToMenu();
}

// --- Unified Game Save System ---

function saveGameState() {
    // Don't save if game is over
    if (game.game_over()) return;
    // Duo state lives on Supabase only — never write to localStorage
    if (gameMode === 'duo') return;

    const saves = getSavedGames();
    const history = game.history();

    const state = {
        fen: game.fen(),
        pgn: game.pgn(),
        gameMode: gameMode,
        myColor: myColor,
        botDifficulty: botDifficulty,
        botEloOverride: botEloOverride,
        whiteTimeRemaining: whiteTimeRemaining,
        blackTimeRemaining: blackTimeRemaining,
        timeControl: timeControl,
        lastMoveTimestamp: lastMoveTimestamp,
        moveCount: history.length,
        turn: game.turn(),
        timestamp: new Date().toISOString(),
        // Pass-and-play preference
        localAutoRotate: gameMode === 'local' ? localAutoRotate : undefined
    };

    saves[gameMode] = state;
    localStorage.setItem('chess_game_saves', JSON.stringify(saves));

    // Also keep backward-compatible solo state
    if (gameMode === 'solo') {
        saveSoloState();
    }
}

function getSavedGames() {
    try {
        const raw = localStorage.getItem('chess_game_saves');
        const saves = raw ? JSON.parse(raw) : {};
        // Remove any stale duo saves from localStorage (duo is Supabase-only now)
        if (saves.duo) {
            delete saves.duo;
            localStorage.setItem('chess_game_saves', JSON.stringify(saves));
        }
        return saves;
    } catch (e) {
        return {};
    }
}

function clearGameSave(mode) {
    if (mode === 'duo') {
        // Duo cleanup is handled via Supabase only (deleteDuoGameFromSupabase)
        return;
    }
    const saves = getSavedGames();
    delete saves[mode];
    localStorage.setItem('chess_game_saves', JSON.stringify(saves));

    if (mode === 'solo') {
        clearSoloState();
    }
}

// --- Saved Games Detection & Rendering ---

async function checkSavedGames() {
    const saves = getSavedGames(); // Only has solo saves now
    const section = document.getElementById('saved-games-section');
    const list = document.getElementById('saved-games-list');

    // Also check for legacy solo state
    migrateLegacySoloSave(saves);

    // Check Supabase for active duo game
    if (supabaseClient) {
        try {
            const { data } = await supabaseClient
                .from('chess_state')
                .select('*')
                .eq('id', GAME_ID)
                .single();

            if (data && data.fen && data.status !== 'deleted' && data.status !== 'resigned' && data.status !== 'draw') {
                let moveCount = 0;
                let isGameOver = false;
                let currentTurn = 'w';
                if (data.pgn && data.pgn.trim() !== '') {
                    try {
                        const tempGame = new Chess();
                        tempGame.load_pgn(data.pgn);
                        moveCount = tempGame.history().length;
                        currentTurn = tempGame.turn();
                        if (tempGame.game_over()) isGameOver = true;
                    } catch (e) { /* ignore */ }
                }

                if (data.time_control && data.time_control > 0) {
                    let wTime = data.white_time !== undefined && data.white_time !== null ? data.white_time : data.time_control;
                    let bTime = data.black_time !== undefined && data.black_time !== null ? data.black_time : data.time_control;

                    if (data.last_move_ts && moveCount > 0) {
                        const elapsed = Date.now() - data.last_move_ts;
                        if (currentTurn === 'w') {
                            wTime -= elapsed;
                        } else {
                            bTime -= elapsed;
                        }
                    }

                    if (wTime <= 0 || bTime <= 0) {
                        isGameOver = true;
                    }
                }

                // If game is over, we shouldn't show it in "saved games" as an active game.
                if (!isGameOver && (moveCount > 0 || (data.status !== 'deleted' && data.status !== 'resigned' && data.status !== 'draw'))) {
                    const tempGame2 = new Chess();
                    if (data.pgn && data.pgn.trim() !== '') {
                        tempGame2.load_pgn(data.pgn);
                    }
                    saves.duo = {
                        gameMode: 'duo',
                        moveCount: moveCount,
                        turn: tempGame2.turn(),
                        timeControl: data.time_control || 0,
                        timestamp: data.updated_at || new Date().toISOString(),
                        fromSupabase: true
                    };
                }
            }
        } catch (e) {
            console.warn('Could not check Supabase for duo game:', e);
        }
    }

    const keys = Object.keys(saves);
    if (keys.length === 0) {
        section.classList.add('hidden');
        return;
    }

    // Filter out saves with no moves (fresh games), EXCEPT for duo games which we want to show immediately
    const validSaves = keys.filter(k => saves[k] && (saves[k].moveCount > 0 || k === 'duo'));
    if (validSaves.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    list.innerHTML = '';

    validSaves.forEach((key, index) => {
        const save = saves[key];
        const card = createSavedGameCard(key, save, index);
        list.appendChild(card);
    });

    // Setup toggle chevron (only once)
    const toggle = document.getElementById('saved-games-toggle');
    const chevron = document.getElementById('saved-games-chevron');
    if (toggle && !toggle._toggleBound) {
        toggle._toggleBound = true;
        toggle.addEventListener('click', () => {
            const isCollapsed = list.classList.contains('collapsed');
            if (isCollapsed) {
                list.classList.remove('collapsed');
            } else {
                list.classList.add('collapsed');
            }
            if (chevron) {
                chevron.classList.toggle('collapsed', !isCollapsed);
            }
        });
    }
}

function migrateLegacySoloSave(saves) {
    // If there's an old-format solo save but no new-format one, migrate it
    if (!saves.solo) {
        const legacy = localStorage.getItem('chess_solo_state');
        if (legacy) {
            try {
                const old = JSON.parse(legacy);
                if (old.fen && old.gameMode === 'solo') {
                    // Count moves from PGN
                    let moveCount = 0;
                    if (old.pgn) {
                        const tempGame = new Chess();
                        tempGame.load_pgn(old.pgn);
                        moveCount = tempGame.history().length;
                    }

                    saves.solo = {
                        fen: old.fen,
                        pgn: old.pgn || '',
                        gameMode: 'solo',
                        myColor: old.myColor,
                        botDifficulty: old.botDifficulty || 3,
                        botEloOverride: old.botEloOverride || null,
                        whiteTimeRemaining: old.whiteTimeRemaining || 0,
                        blackTimeRemaining: old.blackTimeRemaining || 0,
                        timeControl: old.timeControl || 0,
                        lastMoveTimestamp: old.lastMoveTimestamp || Date.now(),
                        moveCount: moveCount,
                        turn: old.fen ? old.fen.split(' ')[1] : 'w',
                        timestamp: new Date().toISOString()
                    };
                    localStorage.setItem('chess_game_saves', JSON.stringify(saves));
                }
            } catch (e) { /* ignore */ }
        }
    }
}

// Pending delete state (for confirmation modal)
let pendingDeleteKey = null;
let pendingDeleteCard = null;

function createSavedGameCard(key, save, index) {
    const card = document.createElement('div');
    card.className = 'saved-game-card';
    card.style.animationDelay = (index * 0.08) + 's';

    const isSolo = save.gameMode === 'solo';
    const isLocal = save.gameMode === 'local';
    const isDuo = save.gameMode === 'duo';
    const turnColor = save.turn === 'w' ? 'Blancs' : 'Noirs';
    const turnDotClass = save.turn === 'w' ? 'white' : 'black';
    const eloText = isSolo && save.botEloOverride ? save.botEloOverride + ' ELO' : '';
    const modeLabel = isSolo ? 'SOLO' : isLocal ? 'LOCAL' : 'DUO';
    const modeClass = isSolo ? 'solo' : isLocal ? 'local' : 'duo';

    // Format time control (only for duo — solo/local use infinite time)
    let timeText = '';
    if (isDuo && save.timeControl !== undefined && save.timeControl !== null) {
        const minutes = save.timeControl / 60000;
        timeText = minutes > 0 ? `${minutes} min` : '∞';
    }

    // Format date/time
    let dateText = '';
    if (save.timestamp) {
        try {
            const d = new Date(save.timestamp);
            const day = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
            const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            dateText = `${day} – ${time}`;
        } catch (e) { /* ignore */ }
    }

    card.innerHTML = `
        <div class="saved-game-info">
            <div class="saved-game-mode">
                <span class="mode-tag ${modeClass}">${modeLabel}</span>
                ${eloText ? `<span class="elo-tag">${eloText}</span>` : ''}
                ${timeText ? `<span class="time-tag">${timeText}</span>` : ''}
            </div>
            <div class="saved-game-turn">
                Tour des ${turnColor}
            </div>
            <div class="saved-game-moves">${save.moveCount} coup${save.moveCount > 1 ? 's' : ''} joué${save.moveCount > 1 ? 's' : ''}</div>
            ${dateText ? `<div class="saved-game-date">${dateText}</div>` : ''}
        </div>
        <div class="saved-game-actions">
            <button class="resume-btn" title="Reprendre">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                <span class="resume-text">Reprendre</span>
            </button>
            <button class="delete-save-btn" title="Supprimer">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                </svg>
            </button>
        </div>
    `;

    // Resume button
    card.querySelector('.resume-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        resumeGame(key);
    });

    // Delete button — show confirmation modal
    card.querySelector('.delete-save-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        pendingDeleteKey = key;
        pendingDeleteCard = card;
        openModal('delete-save-modal');
    });

    return card;
}

function confirmDeleteSave() {
    if (!pendingDeleteKey) return;
    const key = pendingDeleteKey;
    const card = pendingDeleteCard;
    pendingDeleteKey = null;
    pendingDeleteCard = null;

    closeModal('delete-save-modal');

    // Handle Supabase cleanup for duo games
    if (key === 'duo' && supabaseClient) {
        deleteDuoGameFromSupabase();
    }

    // Remove from localStorage
    clearGameSave(key);

    // Animate card removal
    if (card) {
        card.classList.add('deleting-save');
        card.addEventListener('animationend', () => {
            card.remove();
            const list = document.getElementById('saved-games-list');
            if (list && list.children.length === 0) {
                document.getElementById('saved-games-section').classList.add('hidden');
            }
        });
    }
}

async function deleteDuoGameFromSupabase() {
    if (!supabaseClient || !GAME_ID) return;
    try {
        // Reset the game state in Supabase so both players see a clean slate
        await supabaseClient
            .from('chess_state')
            .update({
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                last_move: '',
                pgn: '',
                white_time: null,
                black_time: null,
                last_move_ts: null,
                status: 'deleted',
                draw_offer: null,
                draw_rejected: null,
                resigned_by: null
            })
            .eq('id', GAME_ID);
        console.log('Duo game deleted from Supabase');
    } catch (e) {
        console.error('Erreur suppression Supabase:', e);
    }
}

function deleteSave(key) {
    clearGameSave(key);
}

// --- Resume a Saved Game ---

function resumeGame(key) {
    if (key === 'duo') {
        // Duo state lives on Supabase — just transition and let initGame() fetch it
        gameMode = 'duo';
        isBotThinking = false;
        lastMove = null;
        viewIndex = null;
        clearGameOverFlags();

        // Save params for replay
        lastGameParams = { mode: 'duo', color: 'white', time: 5 };

        if (supabaseClient) {
            initGame(); // Fetches full state from Supabase
        }
        updateModeBadge();
        updateOpponentName();

        transitionMenuToGame(() => { });
        return;
    }

    const saves = getSavedGames();
    const save = saves[key];
    if (!save) return;

    // Restore game state
    gameMode = save.gameMode;
    myColor = save.myColor;
    botDifficulty = save.botDifficulty || 3;
    botEloOverride = save.botEloOverride || null;
    timeControl = save.timeControl || 0;
    whiteTimeRemaining = save.whiteTimeRemaining || 0;
    blackTimeRemaining = save.blackTimeRemaining || 0;
    lastMoveTimestamp = save.lastMoveTimestamp || Date.now();

    // Save params for replay
    lastGameParams = {
        mode: gameMode,
        color: myColor === 'w' ? 'white' : 'black',
        time: timeControl > 0 ? timeControl / 60000 : 0,
        botDifficulty: botDifficulty,
        botEloOverride: botEloOverride,
        localAutoRotate: save.localAutoRotate
    };

    game.reset();
    if (save.pgn && save.pgn.trim()) {
        game.load_pgn(save.pgn);
    } else if (save.fen) {
        game.load(save.fen);
    }

    // Local pass-and-play: myColor tracks the side to move, and rotation
    // follows the saved preference.
    if (gameMode === 'local') {
        localAutoRotate = save.localAutoRotate !== undefined ? !!save.localAutoRotate : true;
        myColor = game.turn();
        boardFlipped = localAutoRotate && (myColor === 'b');
        const rotateInput = document.getElementById('rotate-toggle-input');
        if (rotateInput) rotateInput.checked = localAutoRotate;
        // Resuming starts with an empty redo stack.
        clearLocalRedoStack();
    } else {
        boardFlipped = (myColor === 'b');
    }
    lastMove = null;
    viewIndex = null;
    isBotThinking = false;

    // Reconstruct lastMove from history
    const history = game.history({ verbose: true });
    if (history.length > 0) {
        const last = history[history.length - 1];
        lastMove = { from: last.from, to: last.to };
    }

    // Pre-render state before animating the screen transition
    renderBoard();
    updateStatus();
    updateModeBadge();
    updateOpponentName();
    startTimer();
    clearGameOverFlags();

    // Transition to game
    transitionMenuToGame(() => {
        // If solo and bot's turn, trigger bot move
        if (gameMode === 'solo' && game.turn() !== myColor && !game.game_over()) {
            makeBotMove();
        }
    });
}

// --- Parallax Effect for Desktop Background (smooth lerp) ---
(function () {
    let targetX = 0, targetY = 0;
    let currentX = 0, currentY = 0;
    let rafId = null;

    document.addEventListener('mousemove', (e) => {
        if (window.innerWidth <= 768) return;
        targetX = (e.clientX / window.innerWidth - 0.5) * -24;
        targetY = (e.clientY / window.innerHeight - 0.5) * -24;
        if (!rafId) rafId = requestAnimationFrame(lerpParallax);
    });

    function lerpParallax() {
        const mainMenu = document.getElementById('main-menu');
        if (!mainMenu || mainMenu.classList.contains('hidden')) {
            rafId = null;
            return;
        }
        const bg = document.querySelector('.menu-bg');
        if (!bg) { rafId = null; return; }

        // Smooth interpolation (lerp factor 0.08 = very smooth)
        currentX += (targetX - currentX) * 0.08;
        currentY += (targetY - currentY) * 0.08;

        bg.style.setProperty('--px', `${currentX}px`);
        bg.style.setProperty('--py', `${currentY}px`);

        // Keep animating until close enough
        if (Math.abs(targetX - currentX) > 0.05 || Math.abs(targetY - currentY) > 0.05) {
            rafId = requestAnimationFrame(lerpParallax);
        } else {
            rafId = null;
        }
    }
})();

// ==========================================
// PUSH NOTIFICATIONS (PWA iOS / Android)
// ==========================================

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// 1. Enregistrement du Service Worker
if ('serviceWorker' in navigator && 'PushManager' in window) {
    navigator.serviceWorker.register('sw.js')
        .then(reg => {
            console.log('Service Worker enregistré:', reg);
            checkNotificationStatus();
        })
        .catch(err => console.error('Erreur Service Worker:', err));
}

// Réception des messages du Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'PUSH_RECEIVED') {
      console.log('[App] Push reçu en foreground, notification OS supprimée');
      // App ouverte = pas de notification OS, rien à faire
    }
    if (event.data && event.data.type === 'NOTIFICATION_CLICK') {
      console.log('[App] Clic sur notification push, redirection vers la partie');
      if (myName) {
        resumeGame('duo');
      }
    }
  });
}

async function checkNotificationStatus() {
    const btn = document.getElementById('top-left-push-btn');
    if (!btn) return;

    // Masquer par défaut, on n'affiche que si nécessaire
    btn.classList.add('hidden');

    // Masquer si on est en jeu
    const currentGameScreen = gameScreen || document.getElementById('game-screen');
    if (currentGameScreen && !currentGameScreen.classList.contains('hidden')) {
        return;
    }

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        return;
    }

    // Si les notifications sont accordées, vérifier la souscription
    if (Notification.permission === 'granted') {
        try {
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.getSubscription();
            if (subscription) {
                // Tout est bon, bouton reste masqué
                return;
            }
            // Pas de souscription malgré permission : tenter de re-souscrire silencieusement
            if (CONFIG.VAPID_PUBLIC_KEY) {
                const applicationServerKey = urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY);
                const newSub = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: applicationServerKey
                });
                if (newSub) {
                    localStorage.setItem('push_subscription', JSON.stringify(newSub));
                    // Sync avec Supabase
                    if (supabaseClient) {
                        const { data: userData } = await supabaseClient.auth.getUser();
                        if (userData?.user) {
                            await supabaseClient.from('profiles').upsert({
                                id: userData.user.id,
                                username: myName,
                                push_subscription: JSON.stringify(newSub)
                            }, { onConflict: 'id' });
                        }
                    }
                    return; // Souscription restaurée, bouton reste masqué
                }
            }
        } catch (e) {
            console.warn('Erreur check/restore subscription:', e);
        }
    }

    if (Notification.permission === 'denied') {
        return; // L'utilisateur a bloqué, on ne peut rien faire
    }

    // Permission 'default' : afficher le bouton sur le menu principal
    const currentMenu = mainMenuEl || document.getElementById('main-menu');
    if (currentMenu && !currentMenu.classList.contains('hidden')) {
        btn.classList.remove('hidden');
    }
}

// 2. Demande de permission et souscription
async function requestNotificationPermission() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        alert("Les notifications Push ne sont pas supportées sur ce navigateur.");
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            alert('Vous avez refusé les notifications.');
            return;
        }

        const registration = await navigator.serviceWorker.ready;
        
        // Obtenir ou créer la souscription
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            if (!CONFIG.VAPID_PUBLIC_KEY) {
                alert("Erreur: La clé VAPID publique n'est pas renseignée dans config.js");
                return;
            }
            
            const applicationServerKey = urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY);
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            });
        }
        
        console.log('Push Subscription obtenue:', JSON.stringify(subscription));
        localStorage.setItem('push_subscription', JSON.stringify(subscription));
        
        // 3. Sauvegarder dans Supabase pour ce joueur
        const { data: userData } = await supabaseClient.auth.getUser();
        if (userData?.user) {
            const { error } = await supabaseClient
                .from('profiles')
                .upsert({ 
                    id: userData.user.id, 
                    username: myName, // Utilise myName ('Benji' ou 'Sanaa')
                    push_subscription: JSON.stringify(subscription) 
                }, { onConflict: 'id' });
                
            if (error) {
                console.warn('Impossible de sauvegarder la souscription dans Supabase:', error);
            }
        }
        
        // 4. Mettre à jour l'UI du bouton
        const btn = document.getElementById('push-notif-btn');
        if (btn) {
            btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg> Notifications activées`;
            btn.style.background = '#4caf50';
            btn.style.color = 'white';
            btn.style.borderColor = '#4caf50';
            btn.disabled = true;
        }

        // Masquer aussi le bouton en haut à gauche
        const topBtn = document.getElementById('top-left-push-btn');
        if (topBtn) topBtn.classList.add('hidden');
        
        showToast({ title: 'Notifications activées', message: "Vous recevrez une alerte lors d'une invitation Duo.", showJoin: false });
        
    } catch (e) {
        console.error('Erreur inscription push:', e);
        showToast({ title: 'Erreur', message: "Impossible d'activer les notifications. Vérifiez les permissions de votre navigateur.", showJoin: false });
    }
}

// 3. Envoyer une notification Push via Supabase Edge Function
async function notifyOpponentOfNewGame(opponentName) {
    if (!supabaseClient) return;
    
    try {
        // Récupérer la souscription de l'adversaire dans la table 'profiles'
        const { data, error } = await supabaseClient
            .from('profiles')
            .select('push_subscription')
            .eq('username', opponentName)
            .single();
            
        if (error || !data || !data.push_subscription) {
            console.warn(`Pas de souscription push trouvée pour ${opponentName}`);
            return;
        }
        
        const subscription = JSON.parse(data.push_subscription);
        
        // Appeler la Edge Function
        const { data: funcData, error: funcError } = await supabaseClient.functions.invoke('send_push', {
            body: {
                subscription: subscription,
                title: 'Nouvelle partie',
                message: `${myName} vous invite à jouer`,
                url: window.location.href
            },
            headers: {
                // On envoie la clé anon comme token d'autorisation
                'Authorization': `Bearer ${CONFIG.SUPABASE_KEY}`,
                'apikey': CONFIG.SUPABASE_KEY
            }
        });
        
        if (funcError) throw funcError;
        console.log('Notification Push envoyée avec succès:', funcData);
        
    } catch (e) {
        console.error('Erreur lors de l’envoi du Push:', e);
    }
}

async function syncPushSubscription() {
    if (!supabaseClient || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission !== 'granted') return;

    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        
        if (subscription) {
            const { data: userData } = await supabaseClient.auth.getUser();
            if (userData?.user) {
                await supabaseClient
                    .from('profiles')
                    .upsert({ 
                        id: userData.user.id, 
                        username: myName,
                        push_subscription: JSON.stringify(subscription) 
                    }, { onConflict: 'id' });
                console.log('Push subscription synchronisée avec Supabase');
            }
        }
    } catch (e) {
        console.warn('Erreur syncPushSubscription:', e);
    }
}

// ===================================================================
// GAME HISTORY SYSTEM — save, fetch, display, replay
// ===================================================================

let ghCurrentTab = 'solo';
let ghCache = { solo: null, duo: null };

// --- Save a finished game to Supabase ---
async function saveGameToHistory(result, reason) {
    if (!supabaseClient) {
        console.warn('saveGameToHistory: supabaseClient non disponible');
        return;
    }

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
            ? 'Multijoueur local'
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
        const isLocalGame = g.opponent === 'Multijoueur local';
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
        // Couper toute recherche précédente
        if (evalResolve) {
            evalResolve({ cp: 0, mate: null });
            evalResolve = null;
            stockfishEval.postMessage('stop');
        }

        const pvData = {}; // { 1: {cp, mate, move}, 2: {cp, mate, move} }

        stockfishEval.onmessage = function (e) {
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
                stockfishEval.onmessage = _stockfishDefaultHandler;
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

        stockfishEval.postMessage('setoption name MultiPV value 2');
        stockfishEval.postMessage('setoption name Hash value 64');
        stockfishEval.postMessage('position fen ' + fen);
        stockfishEval.postMessage('go depth 20 movetime 200');
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
    stockfishEval.postMessage('setoption name MultiPV value 1');

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
