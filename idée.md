# 💡 Suggestions d'amélioration
Voici ce que je vois comme axes intéressants (du plus impactful au plus polish) :

## 🎯 Fonctionnalité
- [ ] Annuler / undo en mode local — un bouton "Reprendre" dans le footer permettrait de revenir 1 coup en arrière. Très demandé en pass-and-play quand un joueur clique vite. Trivial avec game.undo().
- [ ] Noms personnalisés en mode local — au lancement, deux champs Joueur 1 / Joueur 2. Sauvegardés dans localStorage, affichés en bas et dans l'historique au lieu de "Blancs/Noirs".
- [ ] Time controls en mode local — actuellement temps illimité. Ajouter 3/5/10 min comme en Duo.
- [ ] Stats dashboard — un onglet dans l'historique avec winrate, taux de promotion, ELO moyen battu, longest streak. Tu as déjà toute la data dans game_history.
- [ ] Détection d'ouvertures — une lib comme chess-openings (~30KB JSON) qui matche les ECO codes (Sicilienne, Italienne, etc.) et affiche le nom de l'ouverture en haut pendant les 15 premiers coups.
- [ ] Puzzle du jour — endpoint Lichess gratuit (https://lichess.org/api/puzzle/daily), affiché sur l'écran menu avec un bouton "Résoudre".

## 🎨 UX / Polish
- [ ] Sons distincts pour la promotion et le mat — actuellement tu joues capture pour les deux. Un son court pour promotion + un son théâtral pour mat améliorerait beaucoup le feel.
- [ ] Coordinated capture animation — quand une pièce est prise, elle pourrait s'envoler vers la barre des pièces capturées au lieu de disparaître.
- [ ] Pre-move visual — quand l'autre joueur réfléchit en Duo, montrer le premove en pointillé translucide. Tu as déjà la queue, juste un render manquant.
- [ ] Confetti calibré par résultat — checkmate brillant + abandon = pas de confetti + nul = ribbons grises.

## ⚡ Performance / qualité de code
- [ ] Split du script.js de 6200 lignes — extraire chess-engine.js (stockfish + bot), duo-sync.js (Supabase), menu.js, game-history.js. Aucun bundler nécessaire, juste des script séparés.
- [ ] Service Worker actif — actuellement il y a un sw.js mais script.js:3060-3066 désinscrit tout SW au chargement. Si tu veux du vrai PWA offline (avec ressources cachées), il faut le réactiver avec une stratégie cache-first sur le statique.
- [ ] Lazy-load Stockfish WASM — lib/stockfish.wasm se charge même en mode Duo où il n'est jamais utilisé. Le charger uniquement quand le mode Solo est sélectionné économise ~1MB au démarrage.
- [ ] Migration vers chess.js v1.x — tu es sur 0.10.3, la v1 a une API plus propre, le support des PGN avec annotations ({ comment }), et est plus rapide.

## 📱 Mobile / iOS
- [ ] Haptic feedback — navigator.vibrate([10]) sur déplacement / capture / mat. Une vibration courte au tap rend le tout beaucoup plus tactile sur mobile.
- [ ] Pinch-to-zoom sur le plateau — désactivé actuellement par user-scalable=no, mais en mode review/analyse ce serait pratique pour les phases tactiques.

