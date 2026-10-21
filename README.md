# Planning des représentants

Une petite page web où les représentants de l'association indiquent leurs créneaux de disponibilité, pour cette semaine ou la suivante, et consultent les disponibilités des autres.

- **Frontend :** des fichiers statiques hébergés sur GitHub Pages. Du HTML/CSS simple, plus [Alpine.js](https://alpinejs.dev) chargé depuis un CDN. Aucune étape de build.
- **Backend :** un Google Apps Script lié à un Google Sheet. Le Sheet sert de base de données.

```
index.html              toute la page (connexion, « Mes créneaux », « Disponibilités »)
js/app.js               toute la logique du frontend (un seul composant Alpine), API_URL en haut du fichier
css/style.css           les styles, pensés pour mobile. Les couleurs sont des variables dans :root
manifest.json, icons/   pour pouvoir « ajouter à l'écran d'accueil »
apps-script/Code.gs     le backend : à coller dans l'éditeur Apps Script du Sheet
apps-script/appsscript.json  réglages Apps Script (fuseau horaire, accès à l'application web)
```

## Fonctionnement

1. Un représentant se connecte avec son **email + code représentant**, tous deux listés dans l'onglet `Membres`. Ils sont mémorisés sur l'appareil (`localStorage`).
2. Il choisit une semaine et ajoute des créneaux (jour, début, fin). Chaque créneau est découpé en demi-heures : lundi 06:00–07:00 → `Mo:0600,Mo:0630`.
3. Envoyer le formulaire remplace sa réponse précédente pour cette semaine. Envoyer sans aucun créneau signifie « pas disponible ».
4. Jusqu'au **dimanche 21:00** (heure de Paris), les semaines ouvertes sont cette semaine et la suivante. Ensuite, la suivante et celle d'après.
5. Chaque dimanche vers 21:30, un déclencheur déplace les réponses de la semaine terminée de `Réponses` vers `Historique`, et y ajoute une ligne « sans réponse » pour chaque représentant de `Membres` qui n'a pas répondu.

### Onglets du Sheet

| Onglet | Colonnes | Qui le remplit |
|---|---|---|
| `Membres` | email, nom, code, derniers créneaux | Vous (sauf « derniers créneaux », mis à jour par le script) |
| `Réponses` | semaine, email, nom, envoyé le, statut, nb créneaux, puis une colonne par demi-heure (`Lun 06:00` … `Dim 20:30`) | Le script, à chaque envoi |
| `Historique` | mêmes colonnes que `Réponses`, ligne 2 = totaux | Le script, chaque dimanche |
| `Analyse` | grille jours × heures, réponses par semaine | Des formules (créées par `setup`) |
| `Erreurs` | date, action, erreur | Le script, en cas de problème |

- **Une ligne = la réponse d'un représentant pour une semaine.** Les 210 colonnes de demi-heures (7 jours × 30) contiennent `1` si le représentant est disponible, et restent vides sinon. Les cases à `1` sont colorées : chaque ligne se lit comme la semaine du représentant.
- `statut` vaut `disponible`, `indisponible` (a répondu sans créneau) ou `sans réponse` (ajouté par l'archivage du dimanche).
- `semaine` est toujours la date du lundi, en texte, par ex. `2026-10-26`.
- `nom` est recopié au moment de l'envoi : c'est ce que les autres représentants voient sur la page des disponibilités, et l'historique reste lisible même après le départ d'un représentant. Les emails ne sont jamais affichés dans l'app.

## Analyse des données

- **Créneaux les plus vides / les plus pleins :** l'onglet `Analyse` affiche une grille heures × jours avec le nombre moyen de représentants disponibles par semaine, coloré du rouge (vide) au vert (plein). Choisissez une semaine en `B1` pour n'afficher que celle-ci ; laissez `B1` vide pour la moyenne sur tout l'historique.
- **Qui a répondu chaque semaine :** à droite de la grille, le nombre de représentants disponibles / indisponibles / sans réponse par semaine. Pour les noms, filtrez `Historique` sur la colonne `semaine` (Données → Créer un filtre).
- **Totaux filtrés :** la ligne 2 de `Historique` additionne chaque demi-heure sur les lignes visibles. Filtrez par semaine, par représentant ou par statut, et les totaux suivent.

Les données de la semaine en cours sont dans `Réponses` ; elles n'apparaissent dans l'analyse qu'après l'archivage du dimanche.

## Mise en place (une seule fois)

Créez tout avec le **compte Google de l'association**, pas un compte personnel, pour que tout continue de fonctionner quand quelqu'un part.

1. Créez un Google Sheet, puis ouvrez **Extensions → Apps Script**.
2. Remplacez le contenu de `Code.gs` par [`apps-script/Code.gs`](apps-script/Code.gs).
   Dans les **Paramètres du projet**, réglez le fuseau horaire sur `Europe/Paris`.
3. Dans l'éditeur, sélectionnez la fonction `setup` et cliquez sur **Exécuter**. Acceptez les autorisations.
   Cela crée les onglets (dont `Analyse`) et installe le déclencheur du dimanche.
   Si un onglet contient déjà des données dans un ancien format, `setup` s'arrête avec un message : videz ou supprimez cet onglet, puis relancez.
4. Remplissez l'onglet `Membres` : une ligne par représentant avec `email` et `nom`, par ex. `Alice B.`.
   Lancez ensuite `generateCodes` pour attribuer un code à chaque représentant. Envoyez son code à chaque représentant.
5. **Déployer → Nouveau déploiement → Application web**
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde**

   Copiez l'URL de l'application web (`https://script.google.com/macros/s/…/exec`).
6. Collez cette URL dans `API_URL`, en haut de [`js/app.js`](js/app.js).
7. Poussez le dépôt sur GitHub, puis **Settings → Pages → Deploy from branch → main / root**.

## Administration courante

- **Ajouter un représentant :** ajoutez une ligne dans `Membres`, lancez `generateCodes`, et envoyez-lui son code.
- **Retirer un représentant :** supprimez sa ligne dans `Membres`. Son historique est conservé.
- **Réinitialiser un code :** videz la cellule et lancez `generateCodes`.
- **Un problème ?** Regardez l'onglet `Erreurs`, et **Exécutions** dans l'éditeur Apps Script.

## Modifier le code

**Frontend :** modifiez les fichiers et poussez. GitHub Pages se met à jour en moins d'une minute.
Pour tester en local, servez le dossier avec n'importe quel serveur statique, par exemple `python -m http.server`, puis ouvrez http://localhost:8000.
Ouvrir `index.html` directement depuis le disque ne fonctionne pas.

**Backend :** après avoir modifié `Code.gs` dans Apps Script :

- Pour **tester**, utilisez l'URL `/dev` (Déployer → Tester les déploiements). Elle exécute toujours le dernier code enregistré.
- Pour **publier**, utilisez **Déployer → Gérer les déploiements → ✏️ Modifier → Version : Nouvelle version → Déployer**.
  ⚠️ N'utilisez pas « Nouveau déploiement » : cela crée une nouvelle URL, et le site continuerait d'appeler l'ancienne.

Recopiez vos modifications dans `apps-script/Code.gs` pour que le dépôt reste la référence.
Ou utilisez [clasp](https://github.com/google/clasp) pour pousser depuis le dépôt.

**Modifications courantes**

- Horaires d'ouverture : `OPEN` / `CLOSE` dans `js/app.js` **et** dans `Code.gs`, puis relancez `setup`.
  ⚠️ Cela change les colonnes de demi-heures : l'historique existant ne sera plus aligné. Archivez-le à part (copie du Sheet) avant de changer les horaires.
- Heure de clôture : `allowedWeeks()` et le déclencheur dans `setup()`, dans `Code.gs` (relancez `setup` après modification).
- Textes : directement dans `index.html`. Messages d'erreur : `ERRORS` dans `js/app.js`.
- Couleurs : les variables en haut de `css/style.css`.
- Noms des onglets : ils sont écrits en toutes lettres dans `Code.gs`. Si vous renommez un onglet dans le Sheet, renommez-le aussi dans le code.

## Remarques

- Les requêtes sont volontairement envoyées en POST `text/plain`. Un `Content-Type` JSON déclencherait une requête CORS préalable (preflight), à laquelle Apps Script ne sait pas répondre.
- L'URL de l'API est visible par tous dans le code de la page. C'est normal : la protection, c'est le code représentant, vérifié côté serveur. Le Sheet lui-même reste privé : partagez-le uniquement avec les administrateurs.
- Les disponibilités sont mises en cache 5 minutes, et rafraîchies à chaque envoi. Un changement de nom dans `Membres` n'apparaît qu'au prochain envoi du représentant concerné.
- Le code représentant protège des personnes extérieures, mais ce n'est pas une sécurité forte. Ne stockez rien de sensible dans ce Sheet.
