import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import multer from "multer";
import { getStore, getStorageMode } from "./db.js";

const app = express();
const port = Number(process.env.PORT || 8787);
const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const sttModel = process.env.STT_MODEL || "whisper-1";
const llmModel = process.env.LLM_MODEL || "gpt-4o-mini";

app.use(cors({ origin: frontendOrigin }));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });
const sessionStore = new Map();
const db = getStore();

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

app.post("/session/start", async (req, res) => {
  const targetRole = String(req.body?.targetRole || "Poste non precise").trim();
  const userId = String(req.body?.userId || "anonymous").trim() || "anonymous";
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
