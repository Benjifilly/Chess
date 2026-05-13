# 💡 Suggestions d'amélioration
Voici ce que je vois comme axes intéressants (du plus impactful au plus polish) :

## 🎯 Fonctionnalité
- [x] Annuler / undo en mode local — un bouton "Reprendre" dans le footer permettrait de revenir 1 coup en arrière. Très demandé en pass-and-play quand un joueur clique vite. Trivial avec game.undo().
- [ ] Noms personnalisés en mode local — au lancement, deux champs Joueur 1 / Joueur 2. Sauvegardés dans localStorage, affichés en bas et dans l'historique au lieu de "Blancs/Noirs".
- [x] Time controls en mode local — actuellement temps illimité. Ajouter 3/5/10 min comme en Duo.
- [ ] Stats dashboard — un onglet dans l'historique avec winrate, taux de promotion, ELO moyen battu, longest streak. Tu as déjà toute la data dans game_history.
- [ ] Détection d'ouvertures — une lib comme chess-openings (~30KB JSON) qui matche les ECO codes (Sicilienne, Italienne, etc.) et affiche le nom de l'ouverture en haut pendant les 15 premiers coups.
- [x] Puzzle du jour — endpoint Lichess gratuit (https://lichess.org/api/puzzle/daily), affiché sur l'écran menu avec un bouton "Résoudre".
   - Implémenté : `js/puzzle.js` (fetch + cache `localStorage` jour, solve loop avec validation UCI, opponent reply scripté, shake sur erreur, badge "✓ Résolu", overlay de succès + lien Lichess). Bandeau dans le game-screen, badge mode `PUZZLE`. Mode puzzle propre : pas de timer, pas d'eval bar, pas de Stockfish, pas de save dans game_history. Carte cachée silencieusement si offline / API down.

## 🎨 UX / Polish
- [ ] Sons distincts pour la promotion et le mat — actuellement tu joues capture pour les deux. Un son court pour promotion + un son théâtral pour mat améliorerait beaucoup le feel.
- [ ] Coordinated capture animation — quand une pièce est prise, elle pourrait s'envoler vers la barre des pièces capturées au lieu de disparaître.
- [ ] Pre-move visual — quand l'autre joueur réfléchit en Duo, montrer le premove en pointillé translucide. Tu as déjà la queue, juste un render manquant.
- [x] Confetti calibré par résultat — checkmate brillant + abandon = pas de confetti + nul = ribbons grises.

## ⚡ Performance / qualité de code
- [x] Split du script.js de 6200 lignes — extraire chess-engine.js (stockfish + bot), duo-sync.js (Supabase), menu.js, game-history.js. Aucun bundler nécessaire, juste des script séparés.
   - Fait partiellement : `js/engine.js` (Stockfish + bot AI + eval bar, 337 lignes) et `js/game-history.js` (save + modal + replay + analyse, 1396 lignes). script.js passé de 6990 → 5295 lignes.
   - À FAIRE plus tard : extraire `duo-sync.js` (Supabase realtime + sync + chat + push) et `menu.js`. Plus délicat car le code est très entrelacé avec les vars globales.
- [x] Service Worker actif — actuellement il y a un sw.js mais script.js:3060-3066 désinscrit tout SW au chargement. Si tu veux du vrai PWA offline (avec ressources cachées), il faut le réactiver avec une stratégie cache-first sur le statique.
   - Implémenté : `sw.js` enregistré, network-first sur HTML, cache-first sur le statique + CDN fonts/libs, versionné `chessmate-v3`.
- [x] Lazy-load Stockfish WASM — lib/stockfish.wasm se charge même en mode Duo où il n'est jamais utilisé. Le charger uniquement quand le mode Solo est sélectionné économise ~1MB au démarrage.
   - Implémenté : `getStockfish()` / `getStockfishEval()` créent les Web Workers à la première utilisation. Mode Duo avec timer ne paie pas le coût (eval bar masquée).
- [ ] ~~Migration vers chess.js v1.x~~ — **SKIPPED**. La v1 ne publie plus de build UMD/IIFE, seulement CJS et ESM. Migrer nécessiterait soit un bundler, soit de convertir `script.js` en module ESM (ce qui casserait tous les `onclick="..."` inline dans `index.html`). Bénéfice cosmétique vs. risque non justifié sans tests. À reconsidérer si on introduit un bundler un jour.

## 📱 Mobile / iOS
- [ ] Haptic feedback — navigator.vibrate([10]) sur déplacement / capture / mat. Une vibration courte au tap rend le tout beaucoup plus tactile sur mobile.
- [ ] Pinch-to-zoom sur le plateau — désactivé actuellement par user-scalable=no, mais en mode review/analyse ce serait pratique pour les phases tactiques.

