# App - MVP technique

Ce dossier contient le squelette de l'application:
- `frontend/` : PWA React (UI vocale)
- `backend/` : API Node.js (sessions + logique agent)

## Demarrage rapide
1. Ouvrir un terminal dans `app/`
2. Installer les dependances:
   - `npm install`
   - `npm run install:all`
3. Creer le fichier `.env` a partir de `.env.example`
4. Ajouter ta cle API OpenAI dans `.env` (`OPENAI_API_KEY=...`)
5. (Optionnel) Configurer PostgreSQL via `DATABASE_URL`
6. Lancer frontend + backend en parallele:
   - `npm run dev`

Frontend:
- URL: `http://localhost:5173`

Backend:
- URL: `http://localhost:8787`
- Health: `GET /health`
- STT: `POST /stt` (audio `multipart/form-data`, champ `audio`)
- Sessions user: `GET /users/:userId/sessions`
- Progress user: `GET /users/:userId/progress`

## Journal d'avancement
### Fait
- simulation d'entretien (questions/reponses)
- capture micro navigateur
- transcription audio via backend + OpenAI
- feedback LLM apres chaque reponse
- feedback final LLM
- persistance PostgreSQL (avec fallback memoire)
- page historique + progression connectee API

### Prochaine iteration
- authentification (email OTP)
- page de paiement
- export PDF du rapport final
