# Configuration Supabase pour Échecs

Pour que le jeu fonctionne, vous devez créer une table dans votre projet Supabase.

1. Allez dans votre tableau de bord Supabase.
2. Ouvrez l'éditeur **SQL Editor** (icône terminal sur la gauche).
3. Copiez et collez le code suivant, puis cliquez sur **Run**.

```sql
-- Création de la table pour stocker l'état du jeu
CREATE TABLE chess_state (
    id TEXT PRIMARY KEY,
    fen TEXT NOT NULL,
    last_move TEXT,
    white_player TEXT, -- Nouveau : stocke le nom du joueur qui a les blancs
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- Si la table existe déjà, exécutez juste cette ligne pour ajouter la colonne :
-- ALTER TABLE chess_state ADD COLUMN white_player TEXT;

-- Désactiver la sécurité RLS pour simplifier (ou configurer des policies si besoin)
ALTER TABLE chess_state ENABLE ROW LEVEL SECURITY;

-- Créer une policy pour permettre à tout le monde (avec la clé anon) de lire et écrire
-- ATTENTION : C'est pour un projet perso. Pour de la prod, il faudrait de l'auth.
CREATE POLICY "Public Access" ON chess_state
FOR ALL
USING (true)
WITH CHECK (true);

-- Insérer la ligne initiale pour la partie
INSERT INTO chess_state (id, fen) 
VALUES ('main_game', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
ON CONFLICT (id) DO NOTHING;
```

## Codes d'accès par défaut
Dans le fichier `script.js`, les codes sont :
- **Benji** (Blancs) : `BENJI1`
- **Sanaa** (Noirs) : `SANAA1`

Vous pouvez les changer directement dans le fichier `script.js` à la ligne 8.
