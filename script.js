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
let lastMove = null; // { from: 'e2', to: 'e4' }
let boardFlipped = false;

let selectedColorChoice = null;
let selectedTimeChoice = 5; // Default 5 min
let whiteTimeRemaining = 0;
let blackTimeRemaining = 0;
let lastMoveTimestamp = 0;
let timerInterval = null;
let timeControl = 0; // 0 = infinite

// Drag and Drop Variables
let draggedPiece = null;
let sourceSquare = null;

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
        document.body.setAttribute('data-theme', 'custom');
        loadCustomColors();
    } else {
        document.body.setAttribute('data-theme', savedTheme);
    }
}

function setTheme(theme) {
    document.body.setAttribute('data-theme', theme);
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

        // Préparer le jeu en arrière-plan
        myName = name;
        myNameEl.textContent = myName;
        opponentNameEl.textContent = myName === 'Benji' ? 'Sanaa' : 'Benji';
        gameScreen.classList.remove('hidden'); // Afficher le jeu derrière
        initGame(); // Initialiser le jeu

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
    
    // Hide login, show game
    loginScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    
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
    // Reset time selection to default (5 min)
    selectTime(5);
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
    
    if (selectedColorChoice === 'black') {
        whitePlayerName = myName === 'Benji' ? 'Sanaa' : 'Benji';
    } else if (selectedColorChoice === 'random') {
        whitePlayerName = Math.random() < 0.5 ? 'Benji' : 'Sanaa';
    }
    
    game.reset();
    lastMove = null; // Clear last move highlight
    viewIndex = null; // Reset history view

    // Update local player color based on selection
    if (whitePlayerName === myName) {
        myColor = 'w';
    } else {
        myColor = 'b';
    }
    
    // Update board orientation
    boardFlipped = (myColor === 'b');
    
    // Initialize Time
    timeControl = selectedTimeChoice * 60 * 1000; // Convert to ms
    whiteTimeRemaining = timeControl;
    blackTimeRemaining = timeControl;
    lastMoveTimestamp = Date.now();

    // Render immediately (Optimistic UI)
    renderBoard();
    updateStatus();
    startTimer();
    
    if (supabaseClient) {
        try {
            await supabaseClient
                .from('chess_state')
                .update({ 
                    fen: game.fen(), 
                    last_move: '',
                    white_player: whitePlayerName,
                    pgn: '', // Reset PGN
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
}

// --- GAME LOGIC ---

async function initGame() {
    console.log('initGame appelé');

    // 1. Afficher le plateau TOUT DE SUITE (Optimistic UI)
    if (!game) game = new Chess();
    // Définir une couleur par défaut si pas encore définie
    if (!myColor) myColor = myName === 'Benji' ? 'w' : 'b';
    boardFlipped = (myColor === 'b');
    
    console.log('Affichage immédiat du plateau (avant synchro)...');
    renderBoard();
    updateStatus();
    
    let data = null;
    let error = null;
    
    // 2. Charger l'état réel depuis Supabase
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

    // Écouter les changements en temps réel
    setupRealtimeSubscription();
    setupChatSubscription(); // Add Chat Subscription
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

function updateGameState(data = {}) {
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
        renderBoard();
        updateStatus();
    }
    
    // Always restart timer on update to sync
    startTimer();
    // Else: Do nothing to avoid flickering (re-render) when Supabase confirms our own move
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
            squareDiv.classList.remove('selected', 'last-move', 'capture-hint');
            
            if (selectedSquare === squareName) {
                squareDiv.classList.add('selected');
            }

            const isMyTurn = activeGame.turn() === myColor;
            
            // Determine move to highlight
            let highlightMove = null;
            
            if (viewIndex === null) {
                // Live: Highlight last OPPONENT move
                const history = activeGame.history({ verbose: true });
                for (let i = history.length - 1; i >= 0; i--) {
                    if (history[i].color !== myColor) {
                        highlightMove = history[i];
                        break;
                    }
                }
            } else {
                // History: Highlight the move at viewIndex
                const history = game.history({ verbose: true });
                if (viewIndex >= 0 && history[viewIndex]) {
                    highlightMove = history[viewIndex];
                }
            }

            // Highlight last move
            if (highlightMove && (highlightMove.from === squareName || highlightMove.to === squareName)) {
                squareDiv.classList.add('last-move');
            }

            // 2. Piece
            const piece = activeGame.get(squareName);
            let pieceDiv = squareDiv.querySelector('.piece');

            if (piece) {
                const colorName = piece.color === 'w' ? 'white' : 'black';
                const typeName = getPieceName(piece.type);
                const bgImage = `url("pièces/set1/${colorName}-${typeName}.png")`;

                if (!pieceDiv) {
                    pieceDiv = document.createElement('div');
                    pieceDiv.className = 'piece';
                    squareDiv.appendChild(pieceDiv);
                }
                
                if (!pieceDiv.style.backgroundImage.includes(`${colorName}-${typeName}.png`)) {
                     pieceDiv.style.backgroundImage = bgImage;
                }

                // Drag Events - ONLY if Live
                if (viewIndex === null && piece.color === myColor) {
                    pieceDiv.draggable = true;
                    pieceDiv.ondragstart = (e) => handleDragStart(e, squareName);
                    pieceDiv.ondragend = handleDragEnd;
                    
                    // Touch Events for Mobile
                    pieceDiv.ontouchstart = (e) => handleTouchStart(e, squareName);
                    pieceDiv.ontouchmove = (e) => handleTouchMove(e);
                    pieceDiv.ontouchend = (e) => handleTouchEnd(e);

                    pieceDiv.style.cursor = 'pointer';
                } else {
                    pieceDiv.draggable = false;
                    pieceDiv.ondragstart = null;
                    pieceDiv.ondragend = null;
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

            // Show hints only if Live
            if (viewIndex === null && selectedSquare) {
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
    // Si ce n'est pas mon tour, je ne peux rien faire
    if (viewIndex !== null || game.turn() !== myColor) return;

    const piece = game.get(square);
    
    // Si je clique sur une de mes pièces, je la sélectionne
    if (piece && piece.color === myColor) {
        selectedSquare = square;
        highlightMoves(square); // Use lightweight highlight to avoid flickering
    } 
    // Si j'ai déjà sélectionné une pièce et que je clique ailleurs (géré par les hints onclick, mais au cas où)
    else if (selectedSquare) {
        // Tentative de move simple (clic case vide sans hint)
        makeMove(selectedSquare, square);
    }
}

// --- DRAG AND DROP HANDLERS ---

function handleDragStart(e, square) {
    if (viewIndex !== null || game.turn() !== myColor) {
        e.preventDefault();
        return;
    }
    
    draggedPiece = e.target;
    sourceSquare = square;
    selectedSquare = square; // Select the piece visually too
    
    // Allow move effect
    e.dataTransfer.effectAllowed = 'move';
    
    // Optional: Create a custom drag image or hide the original
    setTimeout(() => {
        if (e.target) e.target.style.opacity = '0';
    }, 0);
    
    highlightMoves(square); // Use lightweight highlight instead of full render
}

function handleDragEnd(e) {
    if (e.target) {
        e.target.style.opacity = '1';
    }
    draggedPiece = null;
    sourceSquare = null;
    
    // Clean up hints if no move was made
    // renderBoard(); // Removed to prevent flickering on tap
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

function handleDragOver(e) {
    e.preventDefault(); // Necessary to allow dropping
    e.dataTransfer.dropEffect = 'move';
}

function handleDrop(e, targetSquare) {
    e.preventDefault();
    if (sourceSquare && sourceSquare !== targetSquare) {
        makeMove(sourceSquare, targetSquare);
    }
}

// --- TOUCH SUPPORT (Mobile Drag & Drop) ---

let activeTouchPiece = null;

function handleTouchStart(e, square) {
    if (viewIndex !== null || game.turn() !== myColor) return;
    e.preventDefault(); // Prevent scroll
    
    const touch = e.touches[0];
    const target = e.target;
    
    activeTouchPiece = target;
    sourceSquare = square;
    selectedSquare = square;
    
    // Visual feedback
    highlightMoves(square);
    
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
    
    if (squareDiv && squareDiv.dataset.square) {
        const targetSquare = squareDiv.dataset.square;
        if (sourceSquare !== targetSquare) {
            makeMove(sourceSquare, targetSquare);
        }
    }
    
    sourceSquare = null;
}

async function makeMove(from, to) {
    const move = game.move({ from, to, promotion: 'q' }); // Promotion auto en Reine pour simplifier
    
    if (move) {
        selectedSquare = null;
        lastMove = { from, to }; // Update local last move immediately
        
        // Update Time Logic
        const now = Date.now();
        if (timeControl > 0) {
            const elapsed = now - lastMoveTimestamp;
            if (game.turn() === 'b') { // White just moved
                whiteTimeRemaining -= elapsed;
                if (whiteTimeRemaining < 0) whiteTimeRemaining = 0;
            } else { // Black just moved
                blackTimeRemaining -= elapsed;
                if (blackTimeRemaining < 0) blackTimeRemaining = 0;
            }
        }
        lastMoveTimestamp = now;

        renderBoard();
        updateStatus();
        startTimer(); // Restart timer for next player
        
        // Envoyer à Supabase
        if (supabaseClient) {
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
        status = `Au tour des ${moveColor}`;
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
                    kingSquare.classList.add('capture-hint'); // Reuse capture hint style for check
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

    var interval = setInterval(function() {
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
    
    // Initial counts (standard chess set)
    const initial = {
        w: { p: 8, n: 2, b: 2, r: 2, q: 1 },
        b: { p: 8, n: 2, b: 2, r: 2, q: 1 }
    };
    
    // Count current pieces
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
    
    // Calculate captured (Initial - Current)
    // We want to show:
    // Near Me: Pieces I captured (Opponent's pieces that are missing)
    // Near Opponent: Pieces They captured (My pieces that are missing)
    
    const opponentColor = myColor === 'w' ? 'b' : 'w';
    
    // Pieces I captured (Opponent color pieces missing)
    const capturedByMe = [];
    ['p', 'n', 'b', 'r', 'q'].forEach(type => {
        const count = initial[opponentColor][type] - current[opponentColor][type];
        for (let i = 0; i < count; i++) {
            capturedByMe.push({ type, color: opponentColor });
        }
    });
    
    // Pieces Opponent captured (My color pieces missing)
    const capturedByOpponent = [];
    ['p', 'n', 'b', 'r', 'q'].forEach(type => {
        const count = initial[myColor][type] - current[myColor][type];
        for (let i = 0; i < count; i++) {
            capturedByOpponent.push({ type, color: myColor });
        }
    });
    
    // Render
    const renderPieces = (container, pieces) => {
        if (!container) return;
        container.innerHTML = pieces.map((p, index) => {
            const colorName = p.color === 'w' ? 'white' : 'black';
            const typeName = getPieceName(p.type);
            
            // Check if previous piece was same type
            const isStacked = index > 0 && pieces[index - 1].type === p.type;
            const stackClass = isStacked ? 'stacked' : '';
            
            return `<div class="captured-piece ${stackClass}" style="background-image: url('pièces/set1/${colorName}-${typeName}.png')"></div>`;
        }).join('');
    };
    
    renderPieces(capturedMeEl, capturedByMe);
    renderPieces(capturedOpponentEl, capturedByOpponent);
}

// Boutons
document.getElementById('flip-btn').addEventListener('click', () => {
    boardFlipped = !boardFlipped;
    renderBoard();
});

document.getElementById('reset-btn').addEventListener('click', () => {
    openNewGameModal();
});

// Service Worker Registration (disabled on localhost/dev to avoid stale caches)
const isLocalhost = ['localhost', '127.0.0.1', ''].includes(window.location.hostname) || window.location.protocol === 'file:';
const shouldRegisterSW = 'serviceWorker' in navigator && window.location.protocol === 'https:' && !isLocalhost;

if (shouldRegisterSW) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => {
            console.error('Service Worker registration failed:', err);
        });
    });
} else {
    // Désinscrire tout SW existant en dev pour éviter les erreurs de fetch
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(registrations => {
            registrations.forEach(reg => reg.unregister());
        });
    }
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

    // Check for Emoji Reaction (Length <= 4 chars) - ONLY if live message
    if (!isHistory && msg.message && msg.message.trim().length <= 4) {
         showReaction(msg.sender, msg.message);
    }

    const div = document.createElement('div');
    div.className = `message ${isMe ? 'me' : 'opponent'}`;
    div.dataset.id = msg.id; // Store ID for deletion
    
    // Format time
    const date = new Date(msg.created_at);
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    div.innerHTML = `
        <div class="message-content">${escapeHtml(msg.message)}</div>
        <div class="message-time">${timeStr}</div>
    `;
    
    container.appendChild(div);
    scrollToBottom();
    
    // Show badge if chat is closed and message is not from me AND it's a new message
    const sidebar = document.getElementById('chat-sidebar');
    if (!isHistory && !sidebar.classList.contains('open') && !isMe) {
        document.getElementById('chat-badge').classList.remove('hidden');
    }
}

function showReaction(sender, emoji) {
    const isMe = sender === myName;
    const reactionEl = document.getElementById(isMe ? 'my-reaction' : 'opponent-reaction');
    
    if (reactionEl) {
        // Clear previous timeouts
        if (reactionEl.exitTimeout) clearTimeout(reactionEl.exitTimeout);
        if (reactionEl.clearTimeout) clearTimeout(reactionEl.clearTimeout);

        reactionEl.textContent = emoji;
        
        // Reset animation classes
        reactionEl.classList.remove('exiting');
        reactionEl.classList.remove('entering');
        
        // Trigger reflow
        void reactionEl.offsetWidth; 
        
        // Start entrance animation
        reactionEl.classList.add('entering');
        
        // Schedule exit animation (at 6.5s)
        reactionEl.exitTimeout = setTimeout(() => {
            reactionEl.classList.remove('entering');
            reactionEl.classList.add('exiting');
        }, 6500);

        // Clear text after exit animation (at 7s)
        reactionEl.clearTimeout = setTimeout(() => {
            reactionEl.textContent = '';
            reactionEl.classList.remove('exiting');
        }, 7000);
    }
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
    chatInputEl.addEventListener('input', function() {
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
    
    try {
        const { error } = await supabaseClient
            .from('chess_chat')
            .delete()
            .eq('game_id', GAME_ID);
            
        if (error) throw error;
        
        // Clear local UI immediately (backup in case realtime is slow)
        const container = document.getElementById('chat-messages');
        container.innerHTML = '<div class="chat-empty">Aucun message...</div>';
        
        closeModal('clear-chat-modal');
        
    } catch (error) {
        console.error('Erreur suppression chat:', error);
        alert('Erreur lors de la suppression des messages.');
    }
}
