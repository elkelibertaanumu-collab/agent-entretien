# App - MVP technique

Ce dossier contient l'application:
- `frontend/` : interface utilisateur multi-pages
- `backend/` : API Node.js (auth, sessions, paiement test, CV)

## Demarrage rapide
1. Ouvrir un terminal dans `app/`
2. Installer les dependances:
   - `npm install`
   - `npm run install:all`
3. Creer le fichier `.env` a partir de `.env.example`
4. Ajouter ta cle OpenAI dans `.env` (`OPENAI_API_KEY=...`) pour STT/LLM
5. (Optionnel) Configurer PostgreSQL via `DATABASE_URL`
6. Lancer:
   - `npm run dev`

Frontend:
- URL: `http://localhost:5173`
- Navigation pages: `#/signup`, `#/login`, `#/home`, `#/simulate`, `#/payment`, `#/progress`, `#/cv`

Backend:
- URL: `http://localhost:8787`
- Health: `GET /health`

## Journal d'avancement
### Frontend (fait)
- redesign inspire de references (style portail + cards + footer)
- navigation en pages separees (signup/login/home/modules)
- flux utilisateur corrige: inscription -> accueil -> modules
- pages modules: simulation, abonnement, progression, generateur CV + export PDF

### Backend (fait)
- sessions entretien + feedback + historique + progression
- STT OpenAI (`/stt`) + feedback LLM (si `OPENAI_API_KEY` configuree)
- auth OTP dev separee:
  - inscription: `/auth/signup/request-code`, `/auth/signup/verify-code`
  - connexion: `/auth/login/request-code`, `/auth/login/verify-code`
- routes compatibles anciennes API: `/auth/request-code`, `/auth/verify-code`
- paiement test + statut
- generation de CV

## Routes principales
- POST `/auth/signup/request-code`
- POST `/auth/signup/verify-code`
- POST `/auth/login/request-code`
- POST `/auth/login/verify-code`
- GET `/auth/me`
- POST `/session/start`
- POST `/session/answer`
- GET `/me/sessions`
- GET `/me/progress`
- POST `/stt`
- POST `/payment/checkout`
- POST `/payment/confirm`
- GET `/payment/status/:paymentId`
- POST `/cv/generate`

## Ce qu'il reste pour production
- brancher OTP reel (email/SMS) au lieu du `devCode`
- brancher paiement reel (Stripe/PayDunya/Flutterwave + webhook)
- proteger l'API (rate limit, validation stricte, logs, monitoring)
- persistance robuste des comptes/auth (pas en memoire)
- tests e2e + deploiement (domain, SSL, sauvegardes)
## OTP email reel (SMTP)
Configurer dans .env:
- SMTP_HOST
- SMTP_PORT
- SMTP_SECURE
- SMTP_USER
- SMTP_PASS
- MAIL_FROM

Comportement:
- si SMTP configure: OTP envoye par email
- sinon: fallback mode dev (devCode)

## Paiement Stripe reel
Configurer dans .env:
- FRONTEND_PUBLIC_URL
- STRIPE_SECRET_KEY
- (optionnel) STRIPE_PRICE_SESSION / STRIPE_PRICE_MONTHLY
- PAYMENT_CURRENCY, PLAN_SESSION_AMOUNT, PLAN_MONTHLY_AMOUNT

Flux:
1. /payment/checkout retourne checkoutUrl`r
2. frontend redirige vers Stripe Checkout
3. retour app puis Verifier statut via /payment/status/:paymentId`r

## Correction connexion OTP (fait)
- separation inscription / connexion
- comptes relies au store DB (plus fiable que map en memoire seule)
- test e2e valide: signup puis login OK

## Depannage NetworkError (frontend -> backend)
- Cause courante: CORS quand Vite change de port (5173 -> 5174...)
- Correction appliquee: backend autorise localhost/127.0.0.1 sur n'importe quel port en dev
- Verifier que backend tourne sur http://localhost:8787`r
