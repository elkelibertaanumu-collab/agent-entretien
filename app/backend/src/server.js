import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import Stripe from "stripe";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import pg from "pg";

const app = express();

const port = Number(process.env.PORT || 8787);
const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const frontendPublicUrl = process.env.FRONTEND_PUBLIC_URL || "http://localhost:5173";
const backendPublicUrl = process.env.BACKEND_PUBLIC_URL || `http://localhost:${port}`;
const sttModel = process.env.STT_MODEL || "whisper-1";
const llmModel = process.env.LLM_MODEL || "gpt-4o-mini";
const interviewQuestionCount = Number(process.env.INTERVIEW_QUESTION_COUNT || 7);
const dataFile = process.env.DATA_FILE || "data/store.json";
const databaseUrl = process.env.DATABASE_URL || "";
const authRateLimitMax = Number(process.env.AUTH_RATE_LIMIT_MAX || 20);
const apiRateLimitMax = Number(process.env.API_RATE_LIMIT_MAX || 300);

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const stripePriceSession = process.env.STRIPE_PRICE_SESSION || "";
const stripePriceMonthly = process.env.STRIPE_PRICE_MONTHLY || "";
const paymentCurrency = (process.env.PAYMENT_CURRENCY || "xof").toLowerCase();

const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const upload = multer({ storage: multer.memoryStorage() });
const defaultFrontendOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174"
];
const frontendOrigins = Array.from(new Set([
  ...defaultFrontendOrigins,
  ...String(frontendOrigin)
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean)
]));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataFilePath = path.isAbsolute(dataFile) ? dataFile : path.resolve(__dirname, "..", dataFile);
const { Pool } = pg;
const dbPool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
    })
  : null;

function loadStateFromFile() {
  try {
    if (!fs.existsSync(dataFilePath)) return {};
    const content = fs.readFileSync(dataFilePath, "utf8");
    if (!content.trim()) return {};
    return JSON.parse(content);
  } catch (error) {
    console.error(`Persist load error: ${error.message}`);
    return {};
  }
}

function saveStateToFile(payload) {
  try {
    const dir = path.dirname(dataFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dataFilePath, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    console.error(`Persist save error: ${error.message}`);
  }
}

async function ensureStateTable() {
  if (!dbPool) return;
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id integer PRIMARY KEY,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function loadPersistedState() {
  if (!dbPool) return loadStateFromFile();
  try {
    await ensureStateTable();
    const result = await dbPool.query("SELECT data FROM app_state WHERE id = 1");
    if (!result.rows.length) return {};
    return result.rows[0].data || {};
  } catch (error) {
    console.error(`Persist load error (postgres): ${error.message}`);
    return loadStateFromFile();
  }
}

async function savePersistedState(payload) {
  if (!dbPool) {
    saveStateToFile(payload);
    return;
  }

  try {
    await ensureStateTable();
    await dbPool.query(
      `INSERT INTO app_state (id, data, updated_at)
       VALUES (1, $1::jsonb, now())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify(payload)]
    );
  } catch (error) {
    console.error(`Persist save error (postgres): ${error.message}`);
    saveStateToFile(payload);
  }
}

const persisted = await loadPersistedState();
const usersByEmail = new Map(Object.entries(persisted.usersByEmail || {}));
const authTokens = new Map();
const paymentStore = new Map(Object.entries(persisted.paymentStore || {}));
const sessionStore = new Map();
const userSessions = new Map(
  Object.entries(persisted.userSessions || {}).map(([userId, sessions]) => [
    userId,
    Array.isArray(sessions) ? sessions : []
  ])
);

let persistQueue = Promise.resolve();
function persistStore() {
  const payload = {
    usersByEmail: Object.fromEntries(usersByEmail),
    paymentStore: Object.fromEntries(paymentStore),
    userSessions: Object.fromEntries(userSessions)
  };
  persistQueue = persistQueue
    .then(() => savePersistedState(payload))
    .catch((error) => console.error(`Persist queue error: ${error.message}`));
}

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: apiRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives, reessaie plus tard." }
});

function nowIso() {
  return new Date().toISOString();
}

function parseBearerToken(req) {
  const value = String(req.headers.authorization || "");
  if (!value.startsWith("Bearer ")) return null;
  return value.slice(7).trim() || null;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHash] = String(stored || "").split(":");
  if (!salt || !expectedHash) return false;
  const actualHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actualHash, "hex"), Buffer.from(expectedHash, "hex"));
}

function requireAuth(req, res, next) {
  const token = parseBearerToken(req);
  if (!token || !authTokens.has(token)) {
    return res.status(401).json({ error: "Non authentifie" });
  }

  req.user = authTokens.get(token);
  return next();
}

const INTERVIEW_CATEGORIES = {
  general: "General",
  behavioral: "Behavioral",
  technical: "Technical",
  case_study: "Case Study",
  leadership: "Leadership",
  culture_fit: "Culture Fit"
};

function normalizeInterviewCategory(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "general";
  if (INTERVIEW_CATEGORIES[raw]) return raw;
  return "general";
}

function getQuestionCount(value) {
  const n = Number(value || interviewQuestionCount);
  if (Number.isNaN(n)) return interviewQuestionCount;
  return Math.max(5, Math.min(12, Math.round(n)));
}

function fallbackQuestionBank(targetRole, category, questionCount = interviewQuestionCount) {
  const base = {
    general: [
      `Qu'est-ce qui te motive vraiment pour un poste de ${targetRole} ?`,
      "Raconte un projet dont tu es fier et explique pourquoi.",
      "Si je parle a ton ancien manager, quel est le feedback le plus probable qu'il donnerait ?",
      "Decris une situation ou tu as du apprendre tres vite pour livrer un resultat.",
      "Quel est ton plus grand risque de progression cette annee, et comment tu comptes le traiter ?",
      "Donne un exemple concret ou tu as transforme un echec en apprentissage mesurable.",
      "Pourquoi devrions-nous te choisir toi plutot qu'un profil similaire ?"
    ],
    behavioral: [
      "Raconte une situation de conflit en equipe et comment tu as gere la tension.",
      "Parle d'une decision difficile que tu as du prendre avec peu d'informations.",
      "Decris un moment ou tu as recu un feedback difficile: qu'as-tu change ensuite ?",
      "Raconte une fois ou tu n'etais pas d'accord avec ton manager: que s'est-il passe ?",
      "Donne un exemple de priorisation sous forte pression avec deadlines courtes.",
      "Parle d'une erreur que tu as faite, son impact, et comment tu as corrige.",
      "Raconte une situation ou tu as influence quelqu'un sans autorite hierarchique."
    ],
    technical: [
      `Quelles competences techniques sont critiques pour ${targetRole} et lesquelles dois-tu encore renforcer ?`,
      "Choisis un probleme technique difficile que tu as resolu et detaille ton raisonnement.",
      "Comment garantis-tu la qualite de ton travail (tests, revues, monitoring) ?",
      "Explique une decision d'architecture que tu as prise et les compromis associes.",
      "Comment reagis-tu quand une solution ne scale pas en production ?",
      "Parle d'un bug complexe que tu as investigue de bout en bout.",
      "Quelles pratiques utilises-tu pour securiser ton code et reduire la dette technique ?"
    ],
    case_study: [
      "On perd 20% de conversion sur un parcours cle: quelle est ta strategie en 48h ?",
      "Tu dois livrer une fonctionnalite critique en deux semaines avec equipe reduite: que fais-tu ?",
      "Un client majeur se plaint d'une regression severe: quelle est ta reponse immediate ?",
      "Tu as budget limite et objectifs ambitieux: comment arbitres-tu ?",
      "Ton indicateur principal baisse depuis 3 mois: comment mènes-tu l'enquete ?",
      "Donne ton plan d'action si le scope explose en milieu de sprint.",
      "Comment presentes-tu un plan de redressement credible a la direction ?"
    ],
    leadership: [
      "Comment eleves-tu le niveau d'une equipe en difficulte sans demotiver ?",
      "Raconte un cas ou tu as du recadrer des attentes non realistes.",
      "Comment prends-tu des decisions quand les avis sont bloques ?",
      "Que fais-tu pour developper l'autonomie des profils juniors ?",
      "Decris une situation ou tu as gere une baisse de performance d'un collaborateur.",
      "Comment assures-tu une communication claire pendant une crise ?",
      "Quelle est ta philosophie pour aligner execution court terme et vision long terme ?"
    ],
    culture_fit: [
      "Dans quel type de culture d'entreprise performes-tu le mieux, et pourquoi ?",
      "Quelle valeur professionnelle n'est pas negociable pour toi ?",
      "Comment reagis-tu face a l'ambiguite et a l'absence de cadre strict ?",
      "Qu'attends-tu concretement de ton manager pour progresser vite ?",
      "Comment construis-tu des relations de confiance avec les equipes partenaires ?",
      "Qu'est-ce qui te ferait refuser une offre, meme bien payee ?",
      "Comment contribues-tu a une culture saine dans ton quotidien ?"
    ]
  };

  const selected = base[category] || base.general;
  return selected.slice(0, getQuestionCount(questionCount));
}

async function generateQuestionBankWithAI({ targetRole, category, questionCount }) {
  const categoryLabel = INTERVIEW_CATEGORIES[category] || INTERVIEW_CATEGORIES.general;
  const prompt = [
    { role: "system", content: "Tu es un recruteur senior. Reponds uniquement en JSON valide." },
    {
      role: "user",
      content: `Genere ${questionCount} questions d'entretien en francais pour le poste "${targetRole}", categorie "${categoryLabel}". Les questions doivent etre exigeantes, concretes, et faire reflechir. Retourne strictement: {"questions": string[]}`
    }
  ];

  const text = await runOpenAIChat(prompt);
  const parsed = parseJsonSafely(text || "");
  if (!parsed || !Array.isArray(parsed.questions)) return null;

  const cleaned = parsed.questions
    .map((q) => String(q || "").trim())
    .filter(Boolean)
    .slice(0, questionCount);

  if (cleaned.length < 3) return null;
  return cleaned;
}

async function buildQuestionBank({ targetRole, category, questionCount }) {
  const normalizedCategory = normalizeInterviewCategory(category);
  const normalizedCount = getQuestionCount(questionCount);

  if (process.env.OPENAI_API_KEY) {
    try {
      const aiQuestions = await generateQuestionBankWithAI({
        targetRole,
        category: normalizedCategory,
        questionCount: normalizedCount
      });
      if (aiQuestions?.length) return aiQuestions;
    } catch {
      // Fallback below.
    }
  }

  return fallbackQuestionBank(targetRole, normalizedCategory, normalizedCount);
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeScore(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return 5;
  return Math.max(0, Math.min(10, Math.round(n)));
}

function fallbackAnswerFeedback(answer) {
  const words = answer.trim().split(/\s+/).filter(Boolean).length;
  const clarity = sanitizeScore(words / 12 + 3);
  const confidence = sanitizeScore(words / 15 + 4);
  const content = sanitizeScore(words / 10 + 3);

  return {
    summary: "Reponse recue. Structure-la en 3 blocs: contexte, action, resultat.",
    strengths: ["Reponse claire dans l'ensemble"],
    improvements: ["Ajoute des chiffres et un exemple concret", "Conclure avec l'impact obtenu"],
    scores: { clarity, confidence, content }
  };
}

function fallbackFinalFeedback(answers = []) {
  const totalWords = answers.join(" ").trim().split(/\s+/).filter(Boolean).length;
  const clarity = sanitizeScore(totalWords / 25 + 3);
  const confidence = sanitizeScore((answers.length * 1.5) + 3);
  const content = sanitizeScore(totalWords / 20 + 3);
  return {
    summary: `Clarte ${clarity}/10, confiance ${confidence}/10, contenu ${content}/10. Continue a utiliser la methode STAR.`,
    actionPlan: [
      "Preparer 3 exemples concrets avant l'entretien",
      "Repondre en format STAR sur les questions comportementales",
      "Conclure chaque reponse avec un resultat mesure"
    ],
    scores: { clarity, confidence, content }
  };
}

async function runOpenAIChat(messages) {
  if (!process.env.OPENAI_API_KEY) return null;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: llmModel,
      temperature: 0.3,
      messages
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || "Erreur OpenAI chat completions");
  }

  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content || "";
}

async function generateAnswerFeedback({ question, answer, targetRole }) {
  const prompt = [
    { role: "system", content: "Tu es un coach d'entretien. Reponds uniquement en JSON valide." },
    {
      role: "user",
      content: `Analyse cette reponse pour un poste de ${targetRole}.\nQuestion: ${question}\nReponse: ${answer}\nRetourne strictement ce JSON: {"summary": string, "strengths": string[], "improvements": string[], "scores": {"clarity": number, "confidence": number, "content": number}}`
    }
  ];

  try {
    const text = await runOpenAIChat(prompt);
    if (!text) return fallbackAnswerFeedback(answer);
    const parsed = parseJsonSafely(text);
    if (!parsed) return fallbackAnswerFeedback(answer);

    return {
      summary: String(parsed.summary || "Feedback genere."),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 3).map(String) : [],
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements.slice(0, 3).map(String) : [],
      scores: {
        clarity: sanitizeScore(parsed?.scores?.clarity),
        confidence: sanitizeScore(parsed?.scores?.confidence),
        content: sanitizeScore(parsed?.scores?.content)
      }
    };
  } catch {
    return fallbackAnswerFeedback(answer);
  }
}

async function generateFinalFeedback({ targetRole, answers }) {
  const fallback = fallbackFinalFeedback(answers);
  if (!process.env.OPENAI_API_KEY) return fallback;

  const prompt = [
    { role: "system", content: "Tu es un coach d'entretien. Reponds uniquement en JSON valide." },
    {
      role: "user",
      content: `Poste: ${targetRole}\nReponses: ${JSON.stringify(answers)}\nRetourne strictement ce JSON: {"summary": string, "actionPlan": string[], "scores": {"clarity": number, "confidence": number, "content": number}}`
    }
  ];

  try {
    const text = await runOpenAIChat(prompt);
    const parsed = parseJsonSafely(text || "");
    if (!parsed) return fallback;
    return {
      summary: String(parsed.summary || fallback.summary),
      actionPlan: Array.isArray(parsed.actionPlan) ? parsed.actionPlan.slice(0, 5).map(String) : fallback.actionPlan,
      scores: {
        clarity: sanitizeScore(parsed?.scores?.clarity),
        confidence: sanitizeScore(parsed?.scores?.confidence),
        content: sanitizeScore(parsed?.scores?.content)
      }
    };
  } catch {
    return fallback;
  }
}

async function transcribeWithOpenAI(file) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY absent dans .env");
  }

  const formData = new FormData();
  const type = file.mimetype || "audio/webm";
  const blob = new Blob([file.buffer], { type });
  formData.append("file", blob, file.originalname || "audio.webm");
  formData.append("model", sttModel);
  formData.append("language", "fr");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: formData
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    const message = errorPayload?.error?.message || "Erreur STT OpenAI";
    throw new Error(message);
  }

  const payload = await response.json();
  return String(payload.text || "").trim();
}

function getUserSessionList(userId) {
  if (!userSessions.has(userId)) userSessions.set(userId, []);
  return userSessions.get(userId);
}

function computeProgress(sessions = []) {
  const completed = sessions.filter((s) => s.done && s.feedback?.scores);
  if (!completed.length) {
    return { totalSessions: sessions.length, completedSessions: 0, avgClarity: 0, avgConfidence: 0, avgContent: 0 };
  }

  const sums = completed.reduce(
    (acc, s) => {
      acc.clarity += Number(s.feedback.scores.clarity || 0);
      acc.confidence += Number(s.feedback.scores.confidence || 0);
      acc.content += Number(s.feedback.scores.content || 0);
      return acc;
    },
    { clarity: 0, confidence: 0, content: 0 }
  );

  return {
    totalSessions: sessions.length,
    completedSessions: completed.length,
    avgClarity: Number((sums.clarity / completed.length).toFixed(2)),
    avgConfidence: Number((sums.confidence / completed.length).toFixed(2)),
    avgContent: Number((sums.content / completed.length).toFixed(2))
  };
}

function generateCvText(payload = {}) {
  const fullName = String(payload.fullName || "Nom Prenom");
  const title = String(payload.title || "Titre professionnel");
  const summary = String(payload.summary || "Resume professionnel");
  const phone = String(payload.phone || "+000000000");
  const city = String(payload.city || "Ville");
  const email = String(payload.email || "email@example.com");
  const skills = Array.isArray(payload.skills) ? payload.skills : [];
  const experiences = Array.isArray(payload.experiences) ? payload.experiences : [];
  const education = Array.isArray(payload.education) ? payload.education : [];

  const lines = [];
  lines.push(`# ${fullName}`);
  lines.push(`${title}`);
  lines.push(`${city} | ${phone} | ${email}`);
  lines.push("");
  lines.push("## PROFIL");
  lines.push(summary);
  lines.push("");
  lines.push("## COMPETENCES");
  if (skills.length) skills.forEach((s) => lines.push(`- ${String(s)}`));
  else {
    lines.push("- Competence 1");
    lines.push("- Competence 2");
  }
  lines.push("");
  lines.push("## EXPERIENCES");
  if (experiences.length) {
    experiences.forEach((exp) => {
      lines.push(`### ${String(exp.role || "Poste")} - ${String(exp.company || "Entreprise")} (${String(exp.period || "Periode")})`);
      if (Array.isArray(exp.bullets) && exp.bullets.length) exp.bullets.forEach((b) => lines.push(`- ${String(b)}`));
      else lines.push("- Realisation principale");
      lines.push("");
    });
  } else {
    lines.push("### Poste - Entreprise (Periode)");
    lines.push("- Realisation principale");
    lines.push("");
  }
  lines.push("## FORMATION");
  if (education.length) education.forEach((ed) => lines.push(`- ${String(ed.degree || "Diplome")} - ${String(ed.school || "Ecole")} (${String(ed.year || "Annee")})`));
  else lines.push("- Diplome - Ecole (Annee)");

  return lines.join("\n");
}

function getPlanConfig(plan) {
  if (plan === "monthly") {
    return {
      label: "Abonnement mensuel",
      amount: Number(process.env.PLAN_MONTHLY_AMOUNT || 5000),
      stripePriceId: stripePriceMonthly
    };
  }
  return {
    label: "Session unique",
    amount: Number(process.env.PLAN_SESSION_AMOUNT || 1500),
    stripePriceId: stripePriceSession
  };
}

function updatePaymentByStripeSessionId(stripeSessionId, status) {
  for (const [, payment] of paymentStore) {
    if (payment.stripeSessionId === stripeSessionId) {
      payment.status = status;
      if (status === "paid") payment.paidAt = nowIso();
      paymentStore.set(payment.paymentId, payment);
      persistStore();
      return payment;
    }
  }
  return null;
}

// Stripe webhook must receive raw body.
if (stripe && stripeWebhookSecret) {
  app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) return res.status(400).send("Missing stripe-signature");

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
    } catch (error) {
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const paymentId = session.metadata?.paymentId;
      if (paymentId && paymentStore.has(paymentId)) {
        const payment = paymentStore.get(paymentId);
        payment.status = "paid";
        payment.paidAt = nowIso();
        payment.stripeSessionId = session.id;
        paymentStore.set(paymentId, payment);
        persistStore();
      } else {
        updatePaymentByStripeSessionId(session.id, "paid");
      }
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      updatePaymentByStripeSessionId(session.id, "expired");
    }

    if (event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object;
      updatePaymentByStripeSessionId(session.id, "failed");
    }

    return res.json({ received: true });
  });
}

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const normalized = String(origin).trim().replace(/\/+$/, "");
    if (frontendOrigins.includes(normalized)) return callback(null, true);
    return callback(new Error(`Origin non autorisee: ${origin}`));
  }
}));
app.use(helmet());
app.use(apiLimiter);
app.use(express.json({ limit: "1mb" }));
app.use("/auth", authLimiter);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "agent-entretien-backend",
    paymentMode: stripe ? "stripe" : "test",
    webhookConfigured: Boolean(stripe && stripeWebhookSecret),
    date: nowIso()
  });
});

app.post("/stt", requireAuth, upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Fichier audio manquant" });
  }

  try {
    const text = await transcribeWithOpenAI(req.file);
    if (!text) {
      return res.status(422).json({ error: "Audio recu mais transcription vide" });
    }

    return res.json({ text, provider: "openai", model: sttModel });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Echec de transcription" });
  }
});

app.post("/auth/register", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (username.length < 2) return res.status(400).json({ error: "Username invalide" });
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Email invalide" });
  if (password.length < 6) return res.status(400).json({ error: "Mot de passe trop court (min 6)" });
  if (usersByEmail.has(email)) return res.status(409).json({ error: "Compte deja existant" });

  usersByEmail.set(email, {
    userId: email,
    username,
    email,
    passwordHash: hashPassword(password),
    createdAt: nowIso()
  });
  persistStore();

  const token = crypto.randomUUID();
  const user = { userId: email, username, email };
  authTokens.set(token, user);

  return res.status(201).json({ token, user });
});

app.post("/auth/login", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

  const account = usersByEmail.get(email);
  if (!account || !verifyPassword(password, account.passwordHash)) {
    return res.status(401).json({ error: "Identifiants invalides" });
  }

  const token = crypto.randomUUID();
  const user = { userId: account.userId, username: account.username, email: account.email };
  authTokens.set(token, user);

  return res.json({ token, user });
});

app.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post("/payment/checkout", requireAuth, async (req, res) => {
  const plan = String(req.body?.plan || "session");
  const config = getPlanConfig(plan);

  const paymentId = crypto.randomUUID();
  const payment = {
    paymentId,
    userId: req.user.userId,
    email: req.user.email,
    plan,
    amount: config.amount,
    currency: paymentCurrency.toUpperCase(),
    status: "pending",
    provider: stripe ? "stripe" : "test",
    createdAt: nowIso(),
    paidAt: null,
    stripeSessionId: null
  };

  paymentStore.set(paymentId, payment);
  persistStore();

  if (!stripe) {
    return res.status(201).json({ ...payment, message: "Stripe non configure: mode test" });
  }

  try {
    const isMonthly = plan === "monthly";
    const lineItem = config.stripePriceId
      ? { price: config.stripePriceId, quantity: 1 }
      : {
          price_data: {
            currency: paymentCurrency,
            product_data: {
              name: `Coach Entretien IA - ${config.label}`,
              description: "Preparation entretien vocal avec feedback IA"
            },
            unit_amount: Math.round(config.amount),
            ...(isMonthly ? { recurring: { interval: "month" } } : {})
          },
          quantity: 1
        };

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: isMonthly ? "subscription" : "payment",
      customer_email: req.user.email,
      line_items: [lineItem],
      success_url: `${frontendPublicUrl}?payment=success&paymentId=${paymentId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendPublicUrl}?payment=cancel&paymentId=${paymentId}`,
      metadata: {
        paymentId,
        userId: req.user.userId,
        plan
      }
    });

    payment.stripeSessionId = checkoutSession.id;
    paymentStore.set(paymentId, payment);
    persistStore();

    return res.status(201).json({
      paymentId,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      provider: payment.provider,
      checkoutUrl: checkoutSession.url
    });
  } catch (error) {
    payment.status = "failed";
    paymentStore.set(paymentId, payment);
    persistStore();
    return res.status(500).json({ error: `Stripe checkout error: ${error.message}` });
  }
});

app.post("/payment/confirm", requireAuth, (req, res) => {
  const paymentId = String(req.body?.paymentId || "").trim();
  if (!paymentStore.has(paymentId)) return res.status(404).json({ error: "Paiement introuvable" });

  const payment = paymentStore.get(paymentId);
  if (payment.userId !== req.user.userId) return res.status(403).json({ error: "Paiement non autorise" });

  // Fallback test-only confirmation.
  if (payment.provider !== "stripe") {
    payment.status = "paid";
    payment.paidAt = nowIso();
    paymentStore.set(paymentId, payment);
    persistStore();
  }

  return res.json({ ok: true, payment });
});

app.get("/payment/status/:paymentId", requireAuth, async (req, res) => {
  const paymentId = String(req.params.paymentId || "").trim();
  if (!paymentStore.has(paymentId)) return res.status(404).json({ error: "Paiement introuvable" });

  const payment = paymentStore.get(paymentId);
  if (payment.userId !== req.user.userId) return res.status(403).json({ error: "Paiement non autorise" });

  if (stripe && payment.stripeSessionId && payment.status === "pending") {
    try {
      const stripeSession = await stripe.checkout.sessions.retrieve(payment.stripeSessionId);
      if (stripeSession.payment_status === "paid") {
        payment.status = "paid";
        payment.paidAt = payment.paidAt || nowIso();
        paymentStore.set(paymentId, payment);
        persistStore();
      }
      if (stripeSession.status === "expired") {
        payment.status = "expired";
        paymentStore.set(paymentId, payment);
        persistStore();
      }
    } catch {
      // Keep last known status.
    }
  }

  return res.json({ payment });
});

app.post("/cv/generate", requireAuth, (req, res) => {
  const cvText = generateCvText({ ...req.body, email: req.user.email });
  return res.json({ cvText });
});

app.get("/interview/categories", requireAuth, (_req, res) => {
  return res.json({
    categories: Object.entries(INTERVIEW_CATEGORIES).map(([value, label]) => ({ value, label }))
  });
});

app.post("/session/start", requireAuth, async (req, res) => {
  const targetRole = String(req.body?.targetRole || "Poste non precise").trim();
  const category = normalizeInterviewCategory(req.body?.category);
  const questionCount = getQuestionCount(req.body?.questionCount);
  const questionBank = await buildQuestionBank({ targetRole, category, questionCount });
  const sessionId = crypto.randomUUID();

  const session = {
    sessionId,
    userId: req.user.userId,
    email: req.user.email,
    targetRole,
    category,
    questionBank,
    answers: [],
    index: 0,
    done: false,
    feedback: null,
    startedAt: nowIso(),
    endedAt: null
  };

  sessionStore.set(sessionId, session);
  getUserSessionList(req.user.userId).push(session);
  persistStore();

  return res.status(201).json({
    sessionId,
    targetRole,
    category,
    currentQuestion: questionBank[0],
    questionIndex: 0,
    totalQuestions: questionBank.length,
    done: false
  });
});

app.post("/session/answer", requireAuth, async (req, res) => {
  const sessionId = String(req.body?.sessionId || "");
  const answer = String(req.body?.answer || "").trim();

  if (!sessionStore.has(sessionId)) return res.status(404).json({ error: "Session introuvable" });
  if (!answer) return res.status(400).json({ error: "Reponse vide" });

  const session = sessionStore.get(sessionId);
  if (session.userId !== req.user.userId) return res.status(403).json({ error: "Session non autorisee" });
  const questionIndex = session.index;
  const question = session.questionBank[questionIndex];
  const answerFeedback = await generateAnswerFeedback({ question, answer, targetRole: session.targetRole });

  session.answers.push(answer);
  session.index += 1;
  persistStore();

  const hasNext = session.index < session.questionBank.length;
  if (hasNext) {
    return res.json({
      sessionId,
      answerFeedback,
      nextQuestion: session.questionBank[session.index],
      questionIndex: session.index,
      totalQuestions: session.questionBank.length,
      done: false
    });
  }

  session.done = true;
  session.feedback = await generateFinalFeedback({ targetRole: session.targetRole, answers: session.answers });
  session.endedAt = nowIso();
  persistStore();

  return res.json({
    sessionId,
    done: true,
    answerFeedback,
    feedback: session.feedback,
    questionIndex: session.index,
    totalQuestions: session.questionBank.length
  });
});

app.get("/me/sessions", requireAuth, (req, res) => {
  const sessions = [...getUserSessionList(req.user.userId)]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map((s) => ({
      sessionId: s.sessionId,
      targetRole: s.targetRole,
      category: s.category || "general",
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      answerCount: s.answers.length,
      done: s.done,
      feedback: s.feedback
    }));

  return res.json({ sessions });
});

app.get("/me/progress", requireAuth, (req, res) => {
  return res.json({ progress: computeProgress(getUserSessionList(req.user.userId)) });
});

app.use((error, _req, res, _next) => {
  if (String(error?.message || "").startsWith("Origin non autorisee")) {
    return res.status(403).json({ error: "Origin non autorisee" });
  }
  console.error(error);
  return res.status(500).json({ error: "Erreur serveur" });
});

app.listen(port, () => {
  console.log(`Backend running on ${backendPublicUrl}`);
  console.log(`Payment mode: ${stripe ? "stripe" : "test"}`);
  console.log(`Storage mode: ${dbPool ? "postgres" : "file"}`);
  if (stripe) {
    console.log(`Stripe webhook route: ${backendPublicUrl}/webhooks/stripe`);
  }
});
