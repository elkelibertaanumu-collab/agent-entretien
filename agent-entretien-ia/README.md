# Agent IA de preparation aux entretiens (vocal)

Projet MVP pour entrainer des candidats a l'oral via une experience 100% voix (style entretien reel).

## Objectif
Creer une PWA ou l'utilisateur :
1. dit le poste vise,
2. repond vocalement aux questions,
3. recoit un feedback structure (clarte, confiance, contenu),
4. peut rejouer une session et suivre sa progression.

## Dossier du projet
- `docs/01-validation.md` : valider la demande avec paiement reel
- `docs/02-produit-mvp.md` : definition du MVP
- `docs/03-stack-technique.md` : stack recommandee
- `docs/04-roadmap-30-jours.md` : plan d'execution simple
- `app/` : code de l'application PWA

## Journal des etapes
### Etape 1 - Structure projet (termine)
- dossier projet cree
- documentation business + roadmap creees
- README principal ajoute

### Etape 2 - Squelette technique (termine)
- monorepo npm (`app/`)
- frontend React + Vite
- backend Express
- endpoints session de base (`/session/start`, `/session/answer`)

### Etape 3 - Voix + STT (termine)
- capture micro via navigateur (MediaRecorder)
- envoi audio au backend
- endpoint `/stt` ajoute
- transcription OpenAI ajoutee

### Etape 4 - LLM + Data + Historique (termine)
- feedback LLM apres chaque reponse utilisateur
- feedback final LLM de session
- stockage PostgreSQL (fallback memoire si DB absente)
- endpoints historique/progression utilisateur
- interface "Historique & progression" cote frontend

### Etape 5 - Prochaines priorites
- authentification simple (email OTP)
- paiement (mobile money / stripe)
- generation rapport PDF

## Validation business (rappel)
Action concrete :
- Publier un statut WhatsApp :
  "Je construis un coach IA vocal pour preparer les entretiens. Les 5 premiers testeurs paient 2000 FCFA pour une version beta. Interesse ?"

Critere de validation :
- >= 3 paiements = go build plus loin.
- < 3 paiements = ajuster le positionnement, puis retester.

## Fonctionnalites d'amelioration proposees
### Priorite P1 (impact direct)
- feedback IA detaille par question (forces/faiblesses + reformulation ideale)
- relance intelligente pendant l'entretien (questions adaptees a la reponse)
- rapport PDF de fin de session partageable

### Priorite P2 (retention)
- historique des sessions + courbe de progression
- mode "entretien RH" vs "entretien technique"
- objectif hebdo (3 simulations/semaine) + rappels WhatsApp

### Priorite P3 (monetisation)
- plan freemium (1 session gratuite, puis abonnement)
- packs par metier (dev, data, marketing, support)
- correction de CV/lettre en upsell

## Regle produit
Ne pas complexifier tant que les utilisateurs ne paient pas.
Validation = Paiement.
