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

// Anti-spam for system notices (leave / etc.)
let lastSystemNoticeAt = 0;

// Track last game params for "Rejouer" (replay with same settings)
let lastGameParams = null;

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

// Drag Variables
let sourceSquare = null;

// Audio assets
const AUDIO_FILES = {
    move: 'sound/move-self.mp3',
    capture: 'sound/capture.mp3'
};
const SOUNDS = {};

function loadSounds() {
    try {
        Object.keys(AUDIO_FILES).forEach(key => {
            const audio = new Audio(AUDIO_FILES[key]);
            audio.preload = 'auto';
            // Try to load; browsers may block autoplay until user interaction
            audio.load();
            SOUNDS[key] = audio;
        });
    } catch (e) {
        console.warn('Erreur preload sons:', e);
    }
}

function playSound(name) {
    const a = SOUNDS[name];
    if (!a) return;
    try {
        // Restart sound
        a.currentTime = 0;
        const p = a.play();
        if (p && p.catch) p.catch(() => { });
    } catch (e) {
    }
}

// History Navigation
let viewIndex = null; // null = live, -1 = start, 0 = after 1st move...

function navigateHistory(direction) {
    const history = game.history();
    if (history.length === 0) return; // Pas d'historique disponible

    const maxIndex = history.length - 1;

    // Initialize viewIndex if null (Live)
    if (viewIndex === null) {
        if (direction === -1) {
            // Si on est en live, on veut voir le dernier coup joué (maxIndex)
            // SAUF si on veut annuler le dernier coup, alors on veut voir l'état AVANT le dernier coup.
            // "Undo" visuel = voir l'état précédent.
            // État actuel (Live) = Après move[maxIndex].
            // État précédent = Après move[maxIndex-1].
            viewIndex = maxIndex - 1;
        } else {
            return; // Already at end
        }
    } else {
        viewIndex += direction;
    }

    // Clamp
    if (viewIndex < -1) viewIndex = -1; // Start position

    // Check if back to live
    if (viewIndex >= maxIndex) {
        viewIndex = null; // Back to live
    }

    renderBoard();
    updateStatus();
    updateHistoryButtons();
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
        // Initialiser Chess.js
        game = new Chess();
        console.log('Chess.js initialisé:', game);

        // Initialiser Supabase
        if (window.supabase && window.supabase.createClient) {
            const { createClient } = window.supabase;
            supabaseClient = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
            console.log('Supabase initialisé');
        } else {
            console.warn('Supabase non disponible');
        }

        checkLogin();
        loadTheme();
        // Précharger les sons (si disponibles)
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
    const savedTheme = localStorage.getItem('chess_theme') || 'dark';
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
}

function logout() {
    if (confirm('Voulez-vous vraiment vous déconnecter ?')) {
        if (supabaseClient) {
            supabaseClient.auth.signOut();
        }
        localStorage.removeItem('chess_user_name');
        location.reload();
    }
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
    document.getElementById('history-modal').classList.remove('hidden');
}

function openNewGameModal() {
    closeModal('game-over-modal');
    newGameModal.classList.remove('hidden');

    // Restore last-used settings from localStorage (or use defaults)
    const saved = localStorage.getItem('chess_new_game_settings');
    if (saved) {
        try {
            const s = JSON.parse(saved);
            selectMode(s.mode || 'duo');
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

function selectMode(mode) {
    gameMode = mode;
    const toggle = document.getElementById('mode-toggle');
    const diffSection = document.getElementById('difficulty-section');
    if (mode === 'solo') {
        toggle.classList.add('solo-active');
        diffSection.classList.add('visible');
    } else {
        toggle.classList.remove('solo-active');
        diffSection.classList.remove('visible');
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
        } else {
            badge.textContent = 'DUO';
            badge.classList.remove('solo');
        }
    }
    if (switchDuoItem) {
        switchDuoItem.style.display = gameMode === 'solo' ? '' : 'none';
    }
    document.querySelectorAll('.duo-only-item').forEach(el => {
        el.style.display = gameMode === 'duo' ? '' : 'none';
    });
}

function updateOpponentName() {
    if (gameMode === 'solo') {
        opponentNameEl.innerHTML = 'Bot <img src="images/benji_robot.png" style="width: 24px; vertical-align: middle; margin-left: 5px;">';
    } else {
        opponentNameEl.textContent = myName === 'Benji' ? 'Sanaa' : 'Benji';
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

    sessionStorage.removeItem('gameOverShown');

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
    sessionStorage.removeItem('gameOverShown');
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
    updateModeBadge(); // Ensure dropdown items visibility is correct on first load

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
        updateGameState(data);
    } else {
        console.warn("Aucune donnée trouvée ou erreur Supabase (utilisation du plateau local):", error);
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

            // 2. Show invite toast lorsque l'on est sur le menu et qu'une nouvelle partie Duo est créée par l'autre
            const isOnMenu = mainMenuEl && !mainMenuEl.classList.contains('hidden');

            // Pour savoir si c'est nous qui avons créé la partie, on compare le timestamp
            // d'initialisation (state.last_move_ts) avec notre propre lastMoveTimestamp global.
            const weCreatedIt = (state.last_move_ts === lastMoveTimestamp);

            if (isNewGame && isOnMenu && !weCreatedIt) {
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

    // Play sound if available for notification
    playSound('move');

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
        sessionStorage.removeItem('gameOverShown');
        sessionStorage.removeItem('duoDeletedHandled');
    } else if (newFen && newFen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq')) {
        if (!newPgn || newPgn.trim() === '') {
            sessionStorage.removeItem('gameOverShown');
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
        updateStatus();

        if (game.turn() === myColor) {
            tryExecutePremove();
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
            let pieceDiv = squareDiv.querySelector('.piece');

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
                const bgImage = `url("pièces/set1/${colorName}-${typeName}.png")`;

                if (!pieceDiv) {
                    pieceDiv = document.createElement('div');
                    pieceDiv.className = 'piece';
                    squareDiv.appendChild(pieceDiv);
                }

                if (!pieceDiv.style.backgroundImage.includes(`${colorName}-${typeName}.png`)) {
                    pieceDiv.style.backgroundImage = bgImage;
                }

                pieceDiv.style.opacity = isPremoveGhost ? '0.5' : '1';

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
            } else {
                if (pieceDiv) pieceDiv.remove();
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
}

function getPieceName(type) {
    const names = { p: 'pawn', r: 'rook', n: 'knight', b: 'bishop', q: 'queen', k: 'king' };
    return names[type];
}

function onSquareClick(square) {
    if (viewIndex !== null) return;
    if (isBotThinking) return;
    if (sessionStorage.getItem('gameOverShown') === 'true') return;

    if (game.turn() !== myColor) {
        if (gameMode === 'solo') return;
        handlePremoveClick(square);
        return;
    }

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

function tryExecutePremove() {
    if (premoveQueue.length === 0) return;
    if (game.turn() !== myColor) return;

    const pm = premoveQueue.shift();
    const legalMoves = game.moves({ square: pm.from, verbose: true });
    const isLegal = legalMoves.some(m => m.to === pm.to);

    if (isLegal) {
        makeMove(pm.from, pm.to);
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
    if (isBotThinking) return;
    if (sessionStorage.getItem('gameOverShown') === 'true') return;
    e.preventDefault();

    const piece = getPredictedPieceAt(square);
    if (!piece || piece.color !== myColor) return;

    const isPremove = game.turn() !== myColor;
    if (isPremove && gameMode === 'solo') return;

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
                makeMove(sourceSquare, targetSquare);
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
    if (isBotThinking) return;
    if (sessionStorage.getItem('gameOverShown') === 'true') return;
    e.preventDefault();

    const piece = getPredictedPieceAt(square);
    if (!piece || piece.color !== myColor) return;

    const isPremove = game.turn() !== myColor;
    if (isPremove && gameMode === 'solo') return;
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
                makeMove(sourceSquare, targetSquare);
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
        const fromDiv = document.querySelector(`.square[data-square="${from}"]`);
        const toDiv = document.querySelector(`.square[data-square="${to}"]`);
        if (!fromDiv || !toDiv) { resolve(); return; }

        const pieceDiv = fromDiv.querySelector('.piece');
        if (!pieceDiv) { resolve(); return; }

        const fromRect = fromDiv.getBoundingClientRect();
        const toRect = toDiv.getBoundingClientRect();
        const dx = toRect.left - fromRect.left;
        const dy = toRect.top - fromRect.top;

        pieceDiv.style.transition = 'transform 0.4s ease-out';
        pieceDiv.style.transform = `translate(${dx}px, ${dy}px)`;
        pieceDiv.style.zIndex = '10';

        pieceDiv.addEventListener('transitionend', function handler() {
            pieceDiv.removeEventListener('transitionend', handler);
            pieceDiv.style.transition = '';
            pieceDiv.style.transform = '';
            pieceDiv.style.zIndex = '';
            resolve();
        });

        setTimeout(resolve, 450);
    });
}

async function makeMove(from, to) {
    const move = game.move({ from, to, promotion: 'q' }); // Promotion auto en Reine pour simplifier

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

        await animateMove(from, to);
        renderBoard();
        updateStatus();
        startTimer();

        if (gameMode === 'duo' && supabaseClient) {
            try {
                await supabaseClient
                    .from('chess_state')
                    .update({
                        fen: game.fen(),
                        last_move: `${from}-${to}`,
                        pgn: game.pgn(),
                        white_time: whiteTimeRemaining,
                        black_time: blackTimeRemaining,
                        last_move_ts: lastMoveTimestamp
                    })
                    .eq('id', GAME_ID);
            } catch (error) {
                console.error('Erreur mise à jour coup:', error);
            }
        }

        // Save game state after every move (both modes)
        saveGameState();

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
            showGameOver('Noirs'); // White ran out of time
        } else if (currentBlack <= 0) {
            currentBlack = 0;
            clearInterval(timerInterval);
            showGameOver('Blancs'); // Black ran out of time
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

function updateStatus() {
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
        if (viewIndex === null) showGameOver(winner);
    } else if (activeGame.in_draw() || activeGame.in_stalemate() || activeGame.in_threefold_repetition() || activeGame.insufficient_material()) {
        status = 'Match nul !';
        if (viewIndex === null) showGameOver('draw');
    } else {
        if (gameMode === 'solo' && isBotThinking) {
            status = 'Bot réfléchit...';
        } else {
            status = `Au tour des ${moveColor}`;
        }
        if (activeGame.in_check()) {
            status += ' (Échec !)';
            highlightKingInCheck(activeGame);
        } else {
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

function showGameOver(winner, context = {}) {
    if (sessionStorage.getItem('gameOverShown') === 'true') return;
    sessionStorage.setItem('gameOverShown', 'true');

    clearPremove();

    // Clear the saved game since the game is over
    clearGameSave(gameMode);

    gameOverModal.classList.remove('hidden');
    if (winner === 'draw') {
        gameOverTitle.textContent = "Match Nul !";
        gameOverMessage.textContent = "On est trop connectés, impossible de se départager ! 🤝";
    } else {
        const iWon = (winner === 'Blancs' && myColor === 'w') || (winner === 'Noirs' && myColor === 'b');
        const opponentName = myName === 'Benji' ? 'Sanaa' : 'Benji';

        if (context && context.reason === 'resign') {
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
            triggerConfetti();
            // Victory sound
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
    sessionStorage.removeItem('gameOverShown');

    if (!lastGameParams) {
        // Fallback: return to menu if no params saved
        returnToMenu();
        return;
    }

    const params = lastGameParams;

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

function triggerConfetti() {
    var duration = 3 * 1000;
    var animationEnd = Date.now() + duration;
    var defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 300 };

    function randomInRange(min, max) {
        return Math.random() * (max - min) + min;
    }

    var interval = setInterval(function () {
        var timeLeft = animationEnd - Date.now();

        if (timeLeft <= 0) {
            return clearInterval(interval);
        }

        var particleCount = 50 * (timeLeft / duration);
        // since particles fall down, start a bit higher than random
        confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } }));
        confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } }));
    }, 250);
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
            return `<div class="captured-piece ${stackClass}" style="background-image: url('pièces/set1/${colorName}-${typeName}.png')"></div>`;
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
});

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
        console.log('App is back in foreground');

        // --- Solo mode: preserve local state, skip Supabase sync ---
        if (gameMode === 'solo') {
            // Re-render board and timers to reflect any elapsed time
            renderBoard();
            updateStatus();
            startTimer();
            // If it's the bot's turn and no search is in progress, resume
            if (game.turn() !== myColor && !game.game_over() && !isBotThinking) {
                makeBotMove();
            }
            return;
        }

        // --- Duo mode: re-fetch state from Supabase ---
        if (supabaseClient) {
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
    const emojiOnly = isOnlyEmojis(msgText);

    if (!isHistory && emojiOnly && !isSystem) {
        showReaction(msg.sender, msgText);
    }

    const div = document.createElement('div');
    if (isSystem) {
        div.className = 'message system';
    } else {
        div.className = `message ${isMe ? 'me' : 'opponent'}${emojiOnly ? ' emoji-only' : ''}`;
    }
    div.dataset.id = msg.id;

    const date = new Date(msg.created_at);
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    div.innerHTML = `
        <div class="message-content">${escapeHtml(msg.message)}</div>
        <div class="message-time">${timeStr}</div>
    `;

    container.appendChild(div);
    scrollToBottom();

    const sidebar = document.getElementById('chat-sidebar');
    if (!isHistory && !sidebar.classList.contains('open') && !isMe) {
        document.getElementById('chat-badge').classList.remove('hidden');
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
    menuDomReady = true;
}

// Menu state
let menuSoloElo = 400;
let menuSoloDiff = 1;
let menuSoloColor = null;
let menuDuoColor = null;
let menuDuoTime = 5; // Default 5 minutes for duo

// --- Show / Hide Main Menu ---

function showMainMenu() {
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

    // Show menu
    mainMenuEl.classList.remove('hidden');
}

function restoreMenuSettings() {
    const saved = localStorage.getItem('chess_new_game_settings');
    if (!saved) return;
    try {
        const s = JSON.parse(saved);
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
            sessionStorage.removeItem('gameOverShown');
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
    sessionStorage.removeItem('gameOverShown');

    myColor = (whitePlayerName === myName) ? 'w' : 'b';
    boardFlipped = (myColor === 'b');

    timeControl = selectedTimeChoice * 60 * 1000;
    whiteTimeRemaining = timeControl;
    blackTimeRemaining = timeControl;
    lastMoveTimestamp = Date.now();

    clearSoloState();

    // Reset Supabase FIRST to avoid stale state triggers
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
        timestamp: new Date().toISOString()
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
    const turnColor = save.turn === 'w' ? 'Blancs' : 'Noirs';
    const turnDotClass = save.turn === 'w' ? 'white' : 'black';
    const eloText = isSolo && save.botEloOverride ? save.botEloOverride + ' ELO' : '';

    // Format time control (only for duo — solo always uses infinite time)
    let timeText = '';
    if (!isSolo && save.timeControl !== undefined && save.timeControl !== null) {
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
                <span class="mode-tag ${isSolo ? 'solo' : 'duo'}">${isSolo ? 'SOLO' : 'DUO'}</span>
                ${eloText ? `<span class="elo-tag">${eloText}</span>` : ''}
                ${timeText ? `<span class="time-tag">${timeText}</span>` : ''}
            </div>
            <div class="saved-game-turn">
                <span class="turn-dot ${turnDotClass}"></span>
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
        sessionStorage.removeItem('gameOverShown');

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
        botEloOverride: botEloOverride
    };

    game.reset();
    if (save.pgn && save.pgn.trim()) {
        game.load_pgn(save.pgn);
    } else if (save.fen) {
        game.load(save.fen);
    }

    boardFlipped = (myColor === 'b');
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
    sessionStorage.removeItem('gameOverShown');

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
