// Configuration Supabase
let supabaseClient = null;

// Configuration Jeu
const GAME_ID = CONFIG.GAME_ID; // ID unique pour la partie
const PLAYERS = {
    'BENJI1': 'Benji',
    'SANAA1': 'Sanaa'
};

let game = null;
let myColor = null; // 'w' or 'b'
let myName = null;
let selectedSquare = null;
let boardFlipped = false;

let selectedColorChoice = null;

// Drag and Drop Variables
let draggedPiece = null;
let sourceSquare = null;

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
const newGameModal = document.getElementById('new-game-modal');
const settingsModal = document.getElementById('settings-modal');
const gameOverModal = document.getElementById('game-over-modal');
const gameOverTitle = document.getElementById('game-over-title');
const gameOverMessage = document.getElementById('game-over-message');
const startGameBtn = document.getElementById('start-game-btn');
const settingsDropdown = document.getElementById('settings-dropdown');

// --- INIT & LOGIN ---
// Attendre que tout soit chargé
window.addEventListener('DOMContentLoaded', () => {
    console.log('DOM chargé');
    initializeApp();
});

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
    const savedCode = localStorage.getItem('chess_user_code');
    if (savedCode && PLAYERS[savedCode]) {
        login(savedCode);
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
    
    // Hide custom builder if not custom
    const builder = document.getElementById('custom-theme-builder');
    if (theme !== 'custom') {
        builder.classList.remove('active');
        closeModal('settings-modal');
    }
}

function toggleCustomTheme() {
    setTheme('custom');
    const builder = document.getElementById('custom-theme-builder');
    builder.classList.add('active');
    loadCustomColors(); // Load current values into inputs
}

function applyCustomTheme() {
    const bg = document.getElementById('custom-bg').value;
    const boardLight = document.getElementById('custom-board-light').value;
    const boardDark = document.getElementById('custom-board-dark').value;
    const accent = document.getElementById('custom-accent').value;

    const root = document.documentElement;
    root.style.setProperty('--bg-color', bg);
    root.style.setProperty('--board-light', boardLight);
    root.style.setProperty('--board-dark', boardDark);
    root.style.setProperty('--accent', accent);
    
    // Save to local storage
    const customColors = { bg, boardLight, boardDark, accent };
    localStorage.setItem('chess_custom_colors', JSON.stringify(customColors));
}

function loadCustomColors() {
    const saved = localStorage.getItem('chess_custom_colors');
    if (saved) {
        const colors = JSON.parse(saved);
        const root = document.documentElement;
        
        // Set CSS variables
        root.style.setProperty('--bg-color', colors.bg);
        root.style.setProperty('--board-light', colors.boardLight);
        root.style.setProperty('--board-dark', colors.boardDark);
        root.style.setProperty('--accent', colors.accent);
        
        // Set input values
        if (document.getElementById('custom-bg')) {
            document.getElementById('custom-bg').value = colors.bg;
            document.getElementById('custom-board-light').value = colors.boardLight;
            document.getElementById('custom-board-dark').value = colors.boardDark;
            document.getElementById('custom-accent').value = colors.accent;
        }
    }
}

loginBtn.addEventListener('click', () => {
    const code = passwordInput.value.trim();
    if (PLAYERS[code]) {
        localStorage.setItem('chess_user_code', code);
        login(code);
    } else {
        loginError.textContent = "Code incorrect";
    }
});

function login(code) {
    myName = PLAYERS[code];
    
    // Setup UI
    myNameEl.textContent = myName;
    opponentNameEl.textContent = myName === 'Benji' ? 'Sanaa' : 'Benji';
    
    // Hide login, show game
    loginScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
    
    initGame();
}

function logout() {
    localStorage.removeItem('chess_user_code');
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

function openNewGameModal() {
    closeModal('game-over-modal');
    newGameModal.classList.remove('hidden');
    selectedColorChoice = null;
    startGameBtn.disabled = true;
    document.querySelectorAll('.color-option').forEach(el => el.classList.remove('selected'));
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
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
    
    if (supabaseClient) {
        try {
            await supabaseClient
                .from('chess_state')
                .update({ 
                    fen: game.fen(), 
                    last_move: '',
                    white_player: whitePlayerName
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
    
    let data = null;
    let error = null;
    
    // Charger l'état actuel depuis Supabase
    if (supabaseClient) {
        try {
            const response = await supabaseClient
                .from('chess_state')
                .select('*')
                .eq('id', GAME_ID)
                .single();
            data = response.data;
            error = response.error;
        } catch (e) {
            console.error('Erreur Supabase:', e);
            error = e;
        }
    }

    if (data) {
        updateGameState(data);
    } else {
        console.warn("Aucune donnée trouvée ou erreur Supabase:", error);
        // Initialisation par défaut si pas de données
        if (!myColor) myColor = myName === 'Benji' ? 'w' : 'b';
        boardFlipped = (myColor === 'b');
        renderBoard();
        updateStatus();
    }

    // Écouter les changements en temps réel
    if (supabaseClient) {
        try {
            supabaseClient
                .channel('chess_game')
                .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chess_state', filter: `id=eq.${GAME_ID}` }, payload => {
                    updateGameState(payload.new);
                })
                .subscribe();
        } catch (error) {
            console.error('Erreur canal temps réel:', error);
        }
    }
}

function updateGameState(data) {
    const newFen = data.fen;
    const whitePlayer = data.white_player;

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

    if (newFen !== game.fen()) {
        game.load(newFen);
        renderBoard();
        updateStatus();
    } else if (oldFlipped !== boardFlipped) {
        renderBoard();
        updateStatus();
    } else if (boardEl.innerHTML.trim() === '') {
        renderBoard();
        updateStatus();
    }
    // Else: Do nothing to avoid flickering (re-render) when Supabase confirms our own move
}

function renderBoard() {
    boardEl.innerHTML = '';
    const squares = game.board(); // 8x8 array
    
    // Gestion de l'orientation (Blanc en bas ou Noir en bas)
    let rows = [0, 1, 2, 3, 4, 5, 6, 7];
    let cols = [0, 1, 2, 3, 4, 5, 6, 7];
    
    if (boardFlipped) {
        rows.reverse();
        cols.reverse();
    }

    // Création de la grille
    for (let r of rows) { // 0 to 7 (8 to 1 in chess notation logic, but array index 0 is rank 8)
        for (let c of cols) {
            const squareIndex = (r * 8) + c;
            const squareName = String.fromCharCode(97 + c) + (8 - r);
            
            const squareDiv = document.createElement('div');
            squareDiv.className = `square ${(r + c) % 2 === 0 ? 'light' : 'dark'}`;
            squareDiv.dataset.square = squareName;
            
            // Highlight selected
            if (selectedSquare === squareName) {
                squareDiv.classList.add('selected');
            }

            // Highlight last move (optionnel, à faire plus tard)

            const piece = game.get(squareName);
            if (piece) {
                const pieceImg = document.createElement('div');
                pieceImg.className = 'piece';
                const colorName = piece.color === 'w' ? 'white' : 'black';
                const typeName = getPieceName(piece.type);
                pieceImg.style.backgroundImage = `url('pièces/set1/${colorName}-${typeName}.png')`;
                
                // Drag and Drop Logic
                if (piece.color === myColor) {
                    pieceImg.draggable = true;
                    pieceImg.addEventListener('dragstart', (e) => handleDragStart(e, squareName));
                    pieceImg.addEventListener('dragend', handleDragEnd);
                }
                
                squareDiv.appendChild(pieceImg);
            }

            // Drop Zone Logic
            squareDiv.addEventListener('dragover', handleDragOver);
            squareDiv.addEventListener('drop', (e) => handleDrop(e, squareName));

            // Ajout des hints pour les coups possibles
            if (selectedSquare) {
                const moves = game.moves({ square: selectedSquare, verbose: true });
                const isMove = moves.find(m => m.to === squareName);
                if (isMove) {
                    const hint = document.createElement('div');
                    
                    // Check if it's a capture
                    if (isMove.flags.includes('c') || isMove.flags.includes('e')) {
                        squareDiv.classList.add('capture-hint');
                    } else {
                        hint.className = 'hint';
                        squareDiv.appendChild(hint);
                    }
                    
                    squareDiv.onclick = () => makeMove(selectedSquare, squareName);
                }
            }

            // Click handler pour sélectionner
            if (!squareDiv.onclick) {
                squareDiv.onclick = () => onSquareClick(squareName);
            }

            boardEl.appendChild(squareDiv);
        }
    }
}

function getPieceName(type) {
    const names = { p: 'pawn', r: 'rook', n: 'knight', b: 'bishop', q: 'queen', k: 'king' };
    return names[type];
}

function onSquareClick(square) {
    // Si ce n'est pas mon tour, je ne peux rien faire
    if (game.turn() !== myColor) return;

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
    if (game.turn() !== myColor) {
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

async function makeMove(from, to) {
    const move = game.move({ from, to, promotion: 'q' }); // Promotion auto en Reine pour simplifier
    
    if (move) {
        selectedSquare = null;
        renderBoard();
        updateStatus();
        
        // Envoyer à Supabase
        if (supabaseClient) {
            try {
                await supabaseClient
                    .from('chess_state')
                    .update({ fen: game.fen(), last_move: `${from}-${to}` })
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

function updateStatus() {
    let status = '';
    let moveColor = game.turn() === 'w' ? 'Blancs' : 'Noirs';

    // Check for game over conditions
    if (game.in_checkmate()) {
        const winner = game.turn() === 'w' ? 'Noirs' : 'Blancs';
        status = `Échec et mat ! ${winner} gagnent.`;
        showGameOver(winner);
    } else if (game.in_draw() || game.in_stalemate() || game.in_threefold_repetition() || game.insufficient_material()) {
        status = 'Match nul !';
        showGameOver('draw');
    } else {
        status = `Au tour des ${moveColor}`;
        if (game.in_check()) {
            status += ' (Échec !)';
            highlightKingInCheck();
        } else {
            // Remove check highlight if not in check
            const kingSquare = document.querySelector('.square.capture-hint');
            // Only remove if it's a king (check logic) not a capture hint
            // Actually, renderBoard clears everything, so we are good.
            // But if we just updated status without renderBoard (rare), we might need to clear.
            // renderBoard is called before updateStatus in all cases.
        }
    }
    
    statusEl.textContent = status;

    // Update indicators
    if (game.turn() === myColor) {
        myIndicator.classList.add('active');
        opponentIndicator.classList.remove('active');
    } else {
        myIndicator.classList.remove('active');
        opponentIndicator.classList.add('active');
    }
}

function highlightKingInCheck() {
    const kingColor = game.turn();
    const board = game.board();
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

function showGameOver(winner) {
    gameOverModal.classList.remove('hidden');
    if (winner === 'draw') {
        gameOverTitle.textContent = "Match Nul !";
        gameOverMessage.textContent = "Personne n'a gagné cette fois.";
    } else {
        const iWon = (winner === 'Blancs' && myColor === 'w') || (winner === 'Noirs' && myColor === 'b');
        gameOverTitle.textContent = iWon ? "Victoire ! 🎉" : "Défaite...";
        gameOverMessage.textContent = iWon ? "Bien joué, tu as gagné !" : "L'adversaire a été meilleur.";
        
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

// Boutons
document.getElementById('flip-btn').addEventListener('click', () => {
    boardFlipped = !boardFlipped;
    renderBoard();
});

document.getElementById('reset-btn').addEventListener('click', () => {
    openNewGameModal();
});

// Service Worker Registration
if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js');
}
