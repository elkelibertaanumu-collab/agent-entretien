# App - MVP technique

Ce dossier contient le squelette de l'application:
- `frontend/` : PWA React
- `backend/` : API Node.js

## Demarrage rapide
1. Ouvrir un terminal dans `app/`
2. Installer les dependances:
   - `npm install`
   - `npm run install:all`
3. Creer le fichier `.env` a partir de `.env.example`
4. Lancer frontend + backend en parallele:
   - `npm run dev`

Frontend:
- URL: `http://localhost:5173`

Backend:
- URL: `http://localhost:8787`
- Health: `GET /health`

## Journal des etapes
### Etape 1-2 (termine)
- simulation entretien basique (questions/reponses)

### Etape 3 (termine)
- auth classique (username + email + mot de passe)
- paiement test (checkout + confirmation)
- progression utilisateur (sessions + moyennes)
- generateur de CV (formulaire -> CV texte)
- export PDF depuis le generateur CV

### Etape 4 (termine)
- transcription audio (STT) via OpenAI (`POST /stt`)
- feedback IA par reponse + feedback final (fallback local si cle API absente)

## Endpoints principaux
- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /payment/checkout`
- `POST /payment/confirm`
- `GET /payment/status/:paymentId`
- `POST /stt`
- `GET /interview/categories`
- `POST /session/start`
- `POST /session/answer`
- `GET /me/sessions`
- `GET /me/progress`
- `POST /cv/generate`

## Notes Auth
- Les comptes sont stockes en memoire (MVP local).
- Mot de passe minimum: 6 caracteres.

## Notes IA (STT + LLM)
- Ajouter `OPENAI_API_KEY` dans `.env` pour activer la transcription et le feedback IA.
- Modeles configurables:
  - `STT_MODEL` (defaut `whisper-1`)
  - `LLM_MODEL` (defaut `gpt-4o-mini`)
  - `INTERVIEW_QUESTION_COUNT` (defaut `7`, min `5`, max `12`)
- Les questions d'entretien sont generees par categorie:
  - `general`, `behavioral`, `technical`, `case_study`, `leadership`, `culture_fit`
- Si l'API OpenAI est indisponible, le backend bascule automatiquement sur une banque locale de questions exigeantes.

## Paiement reel (Stripe)
- En mode local sans cles Stripe, l'app reste en mode `test` (confirmation manuelle).
- Pour activer Stripe:
  - renseigner `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
  - renseigner `STRIPE_PRICE_SESSION` (prix one-shot 1500) et `STRIPE_PRICE_MONTHLY` (prix recurrent mensuel 5000)
  - configurer `FRONTEND_PUBLIC_URL` et `BACKEND_PUBLIC_URL`
  - exposer le webhook: `POST /webhooks/stripe`
- Le plan `session` utilise Stripe checkout `payment`.
- Le plan `monthly` utilise Stripe checkout `subscription`.

## Persistance (MVP robuste)
- Les donnees critiques sont maintenant persistees dans un fichier JSON local:
  - `usersByEmail`, `paymentStore`, `userSessions`
- Fichier configurable via `DATA_FILE` (defaut: `data/store.json`).
- Les tokens d'auth restent en memoire (deconnexion implicite apres restart backend).
- Pour la prod, tu peux activer PostgreSQL en definissant `DATABASE_URL`.
  - Si `DATABASE_URL` est defini: stockage dans `app_state` (jsonb) en Postgres.
  - Sinon: fallback automatique sur fichier JSON local.
  - `DATABASE_SSL=false` si ton provider n'exige pas SSL.

## Securite backend
- `helmet` active des en-tetes de securite HTTP.
- Rate limiting global API + rate limiting strict sur routes `/auth`.
- Limite de payload JSON backend: `1mb`.
