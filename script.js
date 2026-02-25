// Configuration Supabase
let supabaseClient = null;

// Configuration Jeu
const GAME_ID = CONFIG.GAME_ID; // ID unique pour la partie
const SALT = 'ChessDuo_Salt_2024!';
const PLAYER_HASHES = {
    '450b02e834204bad2503ee356eeb190e92ad1ada765e69e058e094fa39b45fe0': 'Benji',
    '97ad62dd650af6c9af2b30df0963a09f40782ff0a4ad8cc976e4ab519e3e1fd9': 'Sanaa'
};

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
let botThinking = false;
let botEngine = 'chess-api';

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
        // Ignore play errors (autoplay policies)
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

function checkLogin() {
    const savedName = localStorage.getItem('chess_user_name');
    if (savedName) {
        // On fait confiance au localStorage pour la persistance simple
        // (Pour une vraie sécu, il faudrait un token, mais ici on veut juste éviter de retaper le mdp)
        login(savedName);
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

    // Hash input with salt
    const encoder = new TextEncoder();
    const data = encoder.encode(code + SALT);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    if (PLAYER_HASHES[hashHex]) {
        const name = PLAYER_HASHES[hashHex];
        localStorage.setItem('chess_user_name', name); // Store name instead of code

        // Animation de succès
        const loginScreen = document.getElementById('login-screen');
        loginScreen.classList.add('login-success');
        // triggerConfetti(); // Removed as requested

        myName = name;
        myNameEl.textContent = myName;
        opponentNameEl.textContent = myName === 'Benji' ? 'Sanaa' : 'Benji';
        gameScreen.classList.remove('hidden');
        restoreSoloState();
        initGame();

        // Attendre la fin de l'animation pour cacher l'écran de login
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
    gameScreen.classList.remove('hidden');

    restoreSoloState();
    initGame();
}

function logout() {
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
    document.getElementById('history-modal').classList.remove('hidden');
}

function openNewGameModal() {
    closeModal('game-over-modal');
    newGameModal.classList.remove('hidden');
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

const ENGINE_DESCRIPTIONS = {
    'chess-api': 'Stockfish via chess-api.com (puissant)',
    'lichess': 'Analyse Lichess cloud (moyen)',
    'random-weighted': 'Coups aléatoires pondérés (facile)'
};

function selectEngine(engine) {
    botEngine = engine;
    document.querySelectorAll('.engine-btn').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.engine === engine);
    });
    document.getElementById('engine-desc').textContent = ENGINE_DESCRIPTIONS[engine] || '';
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
}

function updateOpponentName() {
    if (gameMode === 'solo') {
        opponentNameEl.textContent = 'Bot 🤖';
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
    botThinking = false;

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

    renderBoard();
    updateStatus();
    startTimer();
    updateModeBadge();
    updateOpponentName();

    if (gameMode === 'duo') {
        clearSoloState();
    }

    if (gameMode === 'duo' && supabaseClient) {
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
                    time_control: timeControl
                })
                .eq('id', GAME_ID);
        } catch (error) {
            console.error('Erreur Supabase:', error);
        }
    }

    if (gameMode === 'solo' && game.turn() !== myColor) {
        makeBotMove();
    }
}
// --- BOT AI ENGINE (STOCKFISH API) ---

async function getStockfishMove(fen, difficultyElo) {
    try {
        let fullFen = fen;
        const fenParts = fen.split(' ');
        if (fenParts.length < 6) {
            if (fenParts.length === 4) fullFen += " 0 1";
            else if (fenParts.length === 5) fullFen += " 1";
        }

        const response = await fetch('https://chess-api.com/v1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fen: fullFen,
                maxDepth: 12,
                elo: difficultyElo
            })
        });
        const data = await response.json();

        if (data && data.from && data.to) {
            return { from: data.from, to: data.to, promotion: data.promotion || undefined };
        }
        console.error("Chess-api didn't return a valid bestmove:", data);
    } catch (error) {
        console.error("Error fetching move from chess-api:", error);
    }

    const moves = game.moves({ verbose: true });
    if (moves.length > 0) {
        return moves[Math.floor(Math.random() * moves.length)];
    }
    return null;
}

async function getLichessMove(fen) {
    try {
        let fullFen = fen;
        const fenParts = fen.split(' ');
        if (fenParts.length < 6) {
            if (fenParts.length === 4) fullFen += " 0 1";
            else if (fenParts.length === 5) fullFen += " 1";
        }

        const response = await fetch(`https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fullFen)}&multiPv=1`, {
            headers: { 'Accept': 'application/json' }
        });
        const data = await response.json();

        if (data && data.pvs && data.pvs.length > 0) {
            const bestLine = data.pvs[0].moves;
            if (bestLine) {
                const uciMove = bestLine.split(' ')[0];
                const from = uciMove.substring(0, 2);
                const to = uciMove.substring(2, 4);
                const promotion = uciMove.length > 4 ? uciMove[4] : undefined;
                return { from, to, promotion };
            }
        }
    } catch (error) {
        console.error("Error fetching move from Lichess:", error);
    }

    return getStockfishMove(fen, 800);
}

function getWeightedRandomMove() {
    const moves = game.moves({ verbose: true });
    if (moves.length === 0) return null;

    const weighted = moves.map(m => {
        let weight = 1;
        if (m.flags.includes('c') || m.flags.includes('e')) weight += 3;
        if (m.san.includes('+')) weight += 2;
        if (m.san.includes('#')) weight += 10;
        const tc = m.to.charCodeAt(0) - 97;
        const tr = parseInt(m.to[1]);
        const centerDist = Math.abs(tc - 3.5) + Math.abs(tr - 4.5);
        if (centerDist <= 2) weight += 1;
        return { move: m, weight };
    });

    const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
    let rand = Math.random() * totalWeight;
    for (const w of weighted) {
        rand -= w.weight;
        if (rand <= 0) return w.move;
    }
    return weighted[weighted.length - 1].move;
}

async function makeBotMove() {
    if (gameMode !== 'solo' || game.turn() === myColor || game.game_over()) return;

    botThinking = true;
    updateStatus();

    const failsafe = setTimeout(() => {
        if (botThinking) {
            console.warn('Bot failsafe: forçage coup aléatoire après timeout');
            botThinking = false;
            const moves = game.moves({ verbose: true });
            if (moves.length > 0) {
                const m = moves[Math.floor(Math.random() * moves.length)];
                makeMove(m.from, m.to);
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

        let botMove = null;
        if (botEngine === 'random-weighted') {
            await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
            botMove = getWeightedRandomMove();
        } else if (botEngine === 'lichess') {
            botMove = await getLichessMove(game.fen());
        } else {
            botMove = await getStockfishMove(game.fen(), targetElo);
        }

        clearTimeout(failsafe);

        if (botMove && botThinking) {
            await makeMove(botMove.from, botMove.to, botMove.promotion);
        }
    } catch (e) {
        console.error('Erreur bot:', e);
        clearTimeout(failsafe);
    } finally {
        botThinking = false;
        updateStatus();
        saveSoloState();
    }
}

function switchToDuo() {
    settingsDropdown.classList.remove('active');
    gameMode = 'duo';
    botThinking = false;
    clearSoloState();
    updateModeBadge();
    updateOpponentName();
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

function setupRealtimeSubscription() {
    if (!supabaseClient) return;

    // Clean up existing channels first to be safe
    const channels = supabaseClient.getChannels();
    channels.forEach(channel => {
        if (channel.topic.includes('chess_state')) {
            console.log('Removing existing channel:', channel.topic);
            supabaseClient.removeChannel(channel);
        }
    });

    try {
        console.log('Setting up new realtime subscription...');
        supabaseClient
            .channel('chess_game_' + Date.now()) // Unique name to force fresh connection
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chess_state', filter: `id=eq.${GAME_ID}` }, payload => {
                console.log('Realtime update received:', payload);
                updateGameState(payload.new);
            })
            .subscribe((status) => {
                console.log('Subscription status:', status);
            });
    } catch (error) {
        console.error('Erreur canal temps réel:', error);
    }
}

let presenceChannel = null;

function setupPresence() {
    if (!supabaseClient || gameMode === 'solo') return;

    if (presenceChannel) {
        supabaseClient.removeChannel(presenceChannel);
    }

    presenceChannel = supabaseClient.channel('chess_presence', {
        config: { presence: { key: myName } }
    });

    presenceChannel
        .on('presence', { event: 'sync' }, () => {
            const state = presenceChannel.presenceState();
            updatePresenceUI(state);
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

async function updateGameState(data = {}) {
    const newFen = data.fen;
    const newPgn = data.pgn;
    const whitePlayer = data.white_player;
    const lastMoveStr = data.last_move; // "e2-e4"

    // Time Sync
    if (data.time_control !== undefined) timeControl = data.time_control;
    if (data.white_time !== undefined) whiteTimeRemaining = data.white_time;
    if (data.black_time !== undefined) blackTimeRemaining = data.black_time;
    if (data.last_move_ts !== undefined) lastMoveTimestamp = data.last_move_ts;

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

    if (!newFen && !newPgn) {
        game.reset();
        viewIndex = null;
        needsRender = true;
    } else {
        // Prefer PGN for history
        // Force load PGN if available to ensure history is populated
        if (newPgn && newPgn.trim() !== '') {
            const loaded = game.load_pgn(newPgn);
            if (loaded) {
                needsRender = true;
            } else {
                console.warn('PGN invalide, fallback FEN');
                if (newFen) game.load(newFen);
                needsRender = true;
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
    if (botThinking) return;

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
    if (botThinking) return;
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
    if (botThinking) return;
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

        pieceDiv.style.transition = 'transform 0.15s ease-out';
        pieceDiv.style.transform = `translate(${dx}px, ${dy}px)`;
        pieceDiv.style.zIndex = '10';

        pieceDiv.addEventListener('transitionend', function handler() {
            pieceDiv.removeEventListener('transitionend', handler);
            pieceDiv.style.transition = '';
            pieceDiv.style.transform = '';
            pieceDiv.style.zIndex = '';
            resolve();
        });

        setTimeout(resolve, 200);
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

        if (gameMode === 'solo' && game.turn() !== myColor && !game.game_over()) {
            saveSoloState();
            makeBotMove();
        } else if (gameMode === 'solo') {
            saveSoloState();
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
        if (gameMode === 'solo' && botThinking) {
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

function showGameOver(winner) {
    gameOverModal.classList.remove('hidden');
    if (winner === 'draw') {
        gameOverTitle.textContent = "Match Nul !";
        gameOverMessage.textContent = "On est trop connectés, impossible de se départager ! 🤝";
    } else {
        const iWon = (winner === 'Blancs' && myColor === 'w') || (winner === 'Noirs' && myColor === 'b');
        gameOverTitle.textContent = iWon ? "Victoire ! 🎉" : "Défaite...";

        const messages = iWon ? WIN_MESSAGES : LOSE_MESSAGES;
        const randomMsg = messages[Math.floor(Math.random() * messages.length)];

        gameOverMessage.textContent = randomMsg;

        if (iWon) {
            triggerConfetti();
            // Victory sound
            try { playSound('capture'); } catch (e) { }
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
        console.log('App is back in foreground, refreshing game state...');

        // 1. Re-fetch state from Supabase
        if (supabaseClient) {
            try {
                const response = await supabaseClient
                    .from('chess_state')
                    .select('*')
                    .eq('id', GAME_ID)
                    .single();

                if (response.data) {
                    console.log('State refreshed:', response.data);
                    updateGameState(response.data);
                }

                // 2. Force Reconnect Realtime
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
    const msgText = msg.message ? msg.message.trim() : '';
    const emojiOnly = isOnlyEmojis(msgText);

    if (!isHistory && emojiOnly) {
        showReaction(msg.sender, msgText);
    }

    const div = document.createElement('div');
    div.className = `message ${isMe ? 'me' : 'opponent'}${emojiOnly ? ' emoji-only' : ''}`;
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
    const diffX = endX - startX;
    const diffY = endY - touchStartY;

    // Check if horizontal swipe is dominant
    if (Math.abs(diffX) > Math.abs(diffY)) {
        // Threshold for swipe
        if (Math.abs(diffX) > 50) {
            const sidebar = document.getElementById('chat-sidebar');

            // Swipe Right (Left -> Right) -> Open Chat
            if (diffX > 0) {
                // Only if starting from the left edge (optional, but better UX to avoid accidental swipes)
                // But user asked "swipe right to open", so let's be generous.
                // Check if we are not dragging a piece (handled in touchmove)
                if (!activeTouchPiece && !sidebar.classList.contains('open')) {
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
        botEngine,
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
        botEngine = state.botEngine || 'chess-api';
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
            setTimeout(() => makeBotMove(), 500);
        }
    } catch (e) {
        console.error('Erreur restauration solo:', e);
        clearSoloState();
    }
}

function clearSoloState() {
    localStorage.removeItem('chess_solo_state');
}
