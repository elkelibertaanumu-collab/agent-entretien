import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import multer from "multer";
import nodemailer from "nodemailer";
import Stripe from "stripe";
import { getStore, getStorageMode } from "./db.js";

const app = express();
const port = Number(process.env.PORT || 8787);
const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const allowVercelAppOrigins = String(process.env.ALLOW_VERCEL_APP_ORIGINS || "false") === "true";
const sttModel = process.env.STT_MODEL || "whisper-1";
const llmModel = process.env.LLM_MODEL || "gpt-4o-mini";
const otpTtlMinutes = Number(process.env.AUTH_CODE_TTL_MINUTES || 10);
const smtpHost = process.env.SMTP_HOST || "";
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecure = String(process.env.SMTP_SECURE || "false") === "true";
const smtpUser = process.env.SMTP_USER || "";
const smtpPass = process.env.SMTP_PASS || "";
const mailFrom = process.env.MAIL_FROM || smtpUser || "noreply@prepcoach.local";
const frontendPublicUrl = process.env.FRONTEND_PUBLIC_URL || "http://localhost:5173";
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripePriceSession = process.env.STRIPE_PRICE_SESSION || "";
const stripePriceMonthly = process.env.STRIPE_PRICE_MONTHLY || "";
const paymentCurrency = (process.env.PAYMENT_CURRENCY || "xof").toLowerCase();
const planSessionAmount = Number(process.env.PLAN_SESSION_AMOUNT || 2000);
const planMonthlyAmount = Number(process.env.PLAN_MONTHLY_AMOUNT || 5000);

const configuredOrigins = frontendOrigin
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedDevOrigin(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

function isAllowedVercelOrigin(origin) {
  return /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);
}

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (configuredOrigins.includes(origin)) return callback(null, true);
    if (isAllowedDevOrigin(origin)) return callback(null, true);
    if (allowVercelAppOrigins && isAllowedVercelOrigin(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  }
}));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });
const sessionStore = new Map();
const db = getStore();
const authCodes = new Map();
const authTokens = new Map();
const paymentStore = new Map();
const isSmtpConfigured = Boolean(smtpHost && smtpUser && smtpPass);
const mailer = isSmtpConfigured
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: { user: smtpUser, pass: smtpPass }
    })
  : null;
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function nowIso() {
  return new Date().toISOString();
}

function parseBearerToken(req) {
  const value = String(req.headers.authorization || "");
  if (!value.startsWith("Bearer ")) return null;
  return value.slice(7).trim() || null;
}

function getUserFromToken(req) {
  const token = parseBearerToken(req);
  if (!token) return null;
  return authTokens.get(token) || null;
}

function requireAuth(req, res, next) {
  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ error: "Non authentifie" });
  req.user = user;
  return next();
}

function setOtp(email, purpose) {
  const code = generateOtp();
  authCodes.set(email, {
    code,
    purpose,
    expiresAt: Date.now() + otpTtlMinutes * 60 * 1000
  });
  return code;
}

async function sendOtpEmail({ email, code, purpose }) {
  if (!mailer) return false;
  const actionLabel = purpose === "signup" ? "inscription" : "connexion";
  await mailer.sendMail({
    from: mailFrom,
    to: email,
    subject: `Code OTP ${actionLabel} - PrepCoach IA`,
    text: `Ton code OTP est ${code}. Il expire dans ${otpTtlMinutes} minutes.`,
    html: `<p>Ton code OTP est <strong>${code}</strong>.</p><p>Il expire dans ${otpTtlMinutes} minutes.</p>`
  });
  return true;
}

function validateOtp(email, code, purpose) {
  const stored = authCodes.get(email);
  if (!stored) return { ok: false, status: 404, error: "Aucun code pour cet email" };
  if (Date.now() > stored.expiresAt) return { ok: false, status: 410, error: "Code expire" };
  if (stored.purpose !== purpose) return { ok: false, status: 400, error: "Code non valide pour cette action" };
  if (stored.code !== code) return { ok: false, status: 401, error: "Code incorrect" };
  authCodes.delete(email);
  return { ok: true };
}

function buildQuestionBank(targetRole) {
  return [
    `Peux-tu te presenter pour un poste de ${targetRole} ?`,
    `Pourquoi veux-tu ce poste de ${targetRole} ?`,
    "Raconte une situation difficile et comment tu l'as geree.",
    "Quel est ton plus grand point fort professionnel ?",
    "Pourquoi devrions-nous te recruter ?"
  ];
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
  lines.push(title);
  lines.push(`${city} | ${phone} | ${email}`);
  lines.push("");
  lines.push("## PROFIL");
  lines.push(summary);
  lines.push("");
  lines.push("## COMPETENCES");
  if (skills.length) skills.forEach((skill) => lines.push(`- ${String(skill)}`));
  else lines.push("- Competence 1", "- Competence 2");
  lines.push("");
  lines.push("## EXPERIENCES");
  if (experiences.length) {
    experiences.forEach((exp) => {
      lines.push(`### ${String(exp.role || "Poste")} - ${String(exp.company || "Entreprise")} (${String(exp.period || "Periode")})`);
      if (Array.isArray(exp.bullets) && exp.bullets.length) {
        exp.bullets.forEach((bullet) => lines.push(`- ${String(bullet)}`));
      } else {
        lines.push("- Realisation principale");
      }
      lines.push("");
    });
  } else {
    lines.push("### Poste - Entreprise (Periode)");
    lines.push("- Realisation principale");
    lines.push("");
  }
  lines.push("## FORMATION");
  if (education.length) {
    education.forEach((ed) => lines.push(`- ${String(ed.degree || "Diplome")} - ${String(ed.school || "Ecole")} (${String(ed.year || "Annee")})`));
  } else {
    lines.push("- Diplome - Ecole (Annee)");
  }

  return lines.join("\n");
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
    {
      role: "system",
      content: "Tu es un coach d'entretien. Reponds uniquement en JSON valide."
    },
    {
      role: "user",
      content: `Analyse cette reponse pour un poste de ${targetRole}.\nQuestion: ${question}\nReponse: ${answer}\nRetourne strictement ce JSON: {\"summary\": string, \"strengths\": string[], \"improvements\": string[], \"scores\": {\"clarity\": number, \"confidence\": number, \"content\": number}}`
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
  const fallback = fallbackFinalFeedback(answers.map((item) => item.answer));
  if (!process.env.OPENAI_API_KEY) return fallback;

  const prompt = [
    { role: "system", content: "Tu es un coach d'entretien. Reponds uniquement en JSON valide." },
    {
      role: "user",
      content: `Poste: ${targetRole}\nReponses: ${JSON.stringify(answers)}\nRetourne strictement ce JSON: {\"summary\": string, \"actionPlan\": string[], \"scores\": {\"clarity\": number, \"confidence\": number, \"content\": number}}`
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

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "agent-entretien-backend",
    storage: getStorageMode(),
    date: new Date().toISOString()
  });
});

app.post("/auth/signup/request-code", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Email invalide" });
  const existing = await db.getUserByEmail(email);
  if (existing) return res.status(409).json({ error: "Compte deja existant. Utilise Connexion." });
  const code = setOtp(email, "signup");
  (async () => {
    try {
      const sent = await sendOtpEmail({ email, code, purpose: "signup" });
      if (sent) {
        return res.status(201).json({ ok: true, delivery: "email", expiresInMinutes: otpTtlMinutes });
      }
    } catch {
      // Fallback below
    }
    console.log(`[DEV OTP SIGNUP] ${email}: ${code}`);
    return res.status(201).json({ ok: true, delivery: "dev", devCode: code, expiresInMinutes: otpTtlMinutes });
  })();
});

app.post("/auth/signup/verify-code", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const code = String(req.body?.code || "").trim();
  const checked = validateOtp(email, code, "signup");
  if (!checked.ok) return res.status(checked.status).json({ error: checked.error });
  const existing = await db.getUserByEmail(email);
  if (existing) return res.status(409).json({ error: "Compte deja existant. Utilise Connexion." });

  let created;
  try {
    created = await db.createUser({ email });
  } catch (error) {
    if (String(error.message || "").includes("USER_EXISTS")) {
      return res.status(409).json({ error: "Compte deja existant. Utilise Connexion." });
    }
    return res.status(500).json({ error: `Erreur createUser: ${error.message}` });
  }
  const user = { email: created.email, userId: created.user_id, createdAt: created.created_at };
  const token = crypto.randomUUID();
  authTokens.set(token, user);
  return res.json({ token, user });
});

app.post("/auth/login/request-code", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Email invalide" });
  const existing = await db.getUserByEmail(email);
  if (!existing) return res.status(404).json({ error: "Compte introuvable. Inscris-toi d'abord." });
  const code = setOtp(email, "login");
  (async () => {
    try {
      const sent = await sendOtpEmail({ email, code, purpose: "login" });
      if (sent) {
        return res.status(201).json({ ok: true, delivery: "email", expiresInMinutes: otpTtlMinutes });
      }
    } catch {
      // Fallback below
    }
    console.log(`[DEV OTP LOGIN] ${email}: ${code}`);
    return res.status(201).json({ ok: true, delivery: "dev", devCode: code, expiresInMinutes: otpTtlMinutes });
  })();
});

app.post("/auth/login/verify-code", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const code = String(req.body?.code || "").trim();
  const existing = await db.getUserByEmail(email);
  if (!existing) return res.status(404).json({ error: "Compte introuvable. Inscris-toi d'abord." });
  const checked = validateOtp(email, code, "login");
  if (!checked.ok) return res.status(checked.status).json({ error: checked.error });
  const user = { email: existing.email, userId: existing.user_id, createdAt: existing.created_at };
  const token = crypto.randomUUID();
  authTokens.set(token, user);
  return res.json({ token, user });
});

// Compat old routes -> login flow
app.post("/auth/request-code", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Email invalide" });
  const existing = await db.getUserByEmail(email);
  if (!existing) return res.status(404).json({ error: "Compte introuvable. Inscris-toi d'abord." });
  const code = setOtp(email, "login");
  (async () => {
    try {
      const sent = await sendOtpEmail({ email, code, purpose: "login" });
      if (sent) {
        return res.status(201).json({ ok: true, delivery: "email", expiresInMinutes: otpTtlMinutes });
      }
    } catch {
      // Fallback below
    }
    console.log(`[DEV OTP LOGIN] ${email}: ${code}`);
    return res.status(201).json({ ok: true, delivery: "dev", devCode: code, expiresInMinutes: otpTtlMinutes });
  })();
});

app.post("/auth/verify-code", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const code = String(req.body?.code || "").trim();
  const existing = await db.getUserByEmail(email);
  if (!existing) return res.status(404).json({ error: "Compte introuvable. Inscris-toi d'abord." });
  const checked = validateOtp(email, code, "login");
  if (!checked.ok) return res.status(checked.status).json({ error: checked.error });
  const user = { email: existing.email, userId: existing.user_id, createdAt: existing.created_at };
  const token = crypto.randomUUID();
  authTokens.set(token, user);
  return res.json({ token, user });
});

app.get("/auth/me", requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

app.post("/stt", upload.single("audio"), async (req, res) => {
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

app.post("/payment/checkout", requireAuth, (req, res) => {
  const plan = String(req.body?.plan || "session");
  const amount = plan === "monthly" ? planMonthlyAmount : planSessionAmount;
  const priceId = plan === "monthly" ? stripePriceMonthly : stripePriceSession;
  const paymentId = crypto.randomUUID();
  const payment = {
    paymentId,
    userId: req.user.userId,
    email: req.user.email,
    plan,
    amount,
    currency: paymentCurrency.toUpperCase(),
    status: "pending",
    provider: stripe ? "stripe" : "test",
    stripeSessionId: null,
    createdAt: nowIso(),
    paidAt: null
  };
  paymentStore.set(paymentId, payment);

  if (!stripe) {
    return res.status(201).json({ ...payment, message: "Stripe non configure, mode test." });
  }

  const lineItem = priceId
    ? { price: priceId, quantity: 1 }
    : {
        price_data: {
          currency: paymentCurrency,
          product_data: {
            name: `PrepCoach IA - ${plan === "monthly" ? "Mensuel" : "Session"}`
          },
          unit_amount: Math.round(amount)
        },
        quantity: 1
      };

  stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: req.user.email,
    line_items: [lineItem],
    success_url: `${frontendPublicUrl}/#/payment`,
    cancel_url: `${frontendPublicUrl}/#/payment`,
    metadata: { paymentId, userId: req.user.userId, plan }
  }).then((checkout) => {
    payment.stripeSessionId = checkout.id;
    paymentStore.set(paymentId, payment);
    return res.status(201).json({
      paymentId,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      provider: payment.provider,
      checkoutUrl: checkout.url
    });
  }).catch((error) => {
    payment.status = "failed";
    paymentStore.set(paymentId, payment);
    return res.status(500).json({ error: `Stripe checkout error: ${error.message}` });
  });
});

app.post("/payment/confirm", requireAuth, (req, res) => {
  const paymentId = String(req.body?.paymentId || "").trim();
  if (!paymentStore.has(paymentId)) return res.status(404).json({ error: "Paiement introuvable" });
  const payment = paymentStore.get(paymentId);
  if (payment.userId !== req.user.userId) return res.status(403).json({ error: "Paiement non autorise" });
  if (payment.provider === "stripe") return res.status(400).json({ error: "Utilise le statut Stripe pour confirmation." });
  payment.status = "paid";
  payment.paidAt = nowIso();
  paymentStore.set(paymentId, payment);
  return res.json({ ok: true, payment });
});

app.get("/payment/status/:paymentId", requireAuth, async (req, res) => {
  const paymentId = String(req.params.paymentId || "").trim();
  if (!paymentStore.has(paymentId)) return res.status(404).json({ error: "Paiement introuvable" });
  const payment = paymentStore.get(paymentId);
  if (payment.userId !== req.user.userId) return res.status(403).json({ error: "Paiement non autorise" });

  if (stripe && payment.stripeSessionId && payment.status === "pending") {
    try {
      const session = await stripe.checkout.sessions.retrieve(payment.stripeSessionId);
      if (session.payment_status === "paid") {
        payment.status = "paid";
        payment.paidAt = payment.paidAt || nowIso();
        paymentStore.set(paymentId, payment);
      } else if (session.status === "expired") {
        payment.status = "expired";
        paymentStore.set(paymentId, payment);
      }
    } catch {
      // Keep current status if Stripe read fails.
    }
  }

  return res.json({ payment });
});

app.post("/cv/generate", requireAuth, (req, res) => {
  const cvText = generateCvText({ ...req.body, email: req.user.email });
  return res.json({ cvText });
});

app.post("/session/start", async (req, res) => {
  const targetRole = String(req.body?.targetRole || "Poste non precise").trim();
  const tokenUser = getUserFromToken(req);
  const userId = tokenUser?.userId || String(req.body?.userId || "anonymous").trim() || "anonymous";
  const questionBank = buildQuestionBank(targetRole);
  const sessionId = crypto.randomUUID();

  sessionStore.set(sessionId, {
    sessionId,
    userId,
    targetRole,
    questionBank,
    answers: [],
    index: 0
  });

  try {
    await db.createSession({ sessionId, userId, targetRole });
  } catch (error) {
    return res.status(500).json({ error: `Erreur DB createSession: ${error.message}` });
  }

  return res.status(201).json({
    sessionId,
    userId,
    targetRole,
    currentQuestion: questionBank[0],
    questionIndex: 0,
    totalQuestions: questionBank.length,
    done: false
  });
});

app.post("/session/answer", async (req, res) => {
  const sessionId = String(req.body?.sessionId || "");
  const answer = String(req.body?.answer || "").trim();

  if (!sessionStore.has(sessionId)) {
    return res.status(404).json({ error: "Session introuvable" });
  }

  if (!answer) {
    return res.status(400).json({ error: "Reponse vide" });
  }

  const session = sessionStore.get(sessionId);
  const questionIndex = session.index;
  const question = session.questionBank[questionIndex];

  const answerFeedback = await generateAnswerFeedback({
    question,
    answer,
    targetRole: session.targetRole
  });

  const answerRecord = { question, answer, answerFeedback };
  session.answers.push(answerRecord);

  try {
    await db.saveAnswer({
      sessionId,
      questionIndex,
      question,
      answer,
      feedback: answerFeedback
    });
  } catch (error) {
    return res.status(500).json({ error: `Erreur DB saveAnswer: ${error.message}` });
  }

  session.index += 1;
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

  const feedback = await generateFinalFeedback({
    targetRole: session.targetRole,
    answers: session.answers
  });

  try {
    await db.closeSession({ sessionId, finalFeedback: feedback });
  } catch (error) {
    return res.status(500).json({ error: `Erreur DB closeSession: ${error.message}` });
  }

  return res.json({
    sessionId,
    done: true,
    answerFeedback,
    feedback,
    questionIndex: session.index,
    totalQuestions: session.questionBank.length
  });
});

app.get("/users/:userId/sessions", async (req, res) => {
  const userId = String(req.params.userId || "").trim();
  if (!userId) return res.status(400).json({ error: "userId manquant" });

  try {
    const sessions = await db.listSessionsByUser(userId, 30);
    return res.json({ sessions });
  } catch (error) {
    return res.status(500).json({ error: `Erreur DB listSessionsByUser: ${error.message}` });
  }
});

app.get("/users/:userId/progress", async (req, res) => {
  const userId = String(req.params.userId || "").trim();
  if (!userId) return res.status(400).json({ error: "userId manquant" });

  try {
    const progress = await db.progressByUser(userId);
    return res.json({ progress });
  } catch (error) {
    return res.status(500).json({ error: `Erreur DB progressByUser: ${error.message}` });
  }
});

app.get("/me/sessions", requireAuth, async (req, res) => {
  try {
    const sessions = await db.listSessionsByUser(req.user.userId, 30);
    return res.json({ sessions });
  } catch (error) {
    return res.status(500).json({ error: `Erreur DB listSessionsByUser: ${error.message}` });
  }
});

app.get("/me/progress", requireAuth, async (req, res) => {
  try {
    const progress = await db.progressByUser(req.user.userId);
    return res.json({ progress });
  } catch (error) {
    return res.status(500).json({ error: `Erreur DB progressByUser: ${error.message}` });
  }
});

async function start() {
  try {
    await db.init();
    app.listen(port, () => {
      console.log(`Backend running on http://localhost:${port}`);
      console.log(`Storage mode: ${getStorageMode()}`);
    });
  } catch (error) {
    console.error("Impossible de demarrer le backend:", error.message);
    process.exit(1);
  }
}

start();
