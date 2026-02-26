import { Pool } from "pg";

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

class InMemoryStore {
  constructor() {
    this.users = [];
    this.sessions = [];
    this.answers = [];
  }

  async init() {}

  async createUser({ name, email, passwordHash }) {
    if (this.users.some((u) => u.email === email)) {
      throw new Error("USER_EXISTS");
    }
    const user = {
      user_id: email,
      name,
      email,
      password_hash: passwordHash,
      created_at: new Date().toISOString()
    };
    this.users.push(user);
    return user;
  }

  async getUserByEmail(email) {
    return this.users.find((u) => u.email === email) || null;
  }

  async createSession({ sessionId, userId, targetRole }) {
    this.sessions.push({
      id: sessionId,
      user_id: userId,
      target_role: targetRole,
      started_at: new Date().toISOString(),
      ended_at: null,
      final_feedback: null
    });
  }

  async saveAnswer({ sessionId, questionIndex, question, answer, feedback }) {
    this.answers.push({
      session_id: sessionId,
      question_index: questionIndex,
      question,
      answer,
      feedback,
      created_at: new Date().toISOString()
    });
  }

  async closeSession({ sessionId, finalFeedback }) {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    session.ended_at = new Date().toISOString();
    session.final_feedback = finalFeedback;
  }

  async listSessionsByUser(userId, limit = 20) {
    const rows = this.sessions
      .filter((session) => session.user_id === userId)
      .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
      .slice(0, limit)
      .map((session) => {
        const answerCount = this.answers.filter((ans) => ans.session_id === session.id).length;
        return {
          session_id: session.id,
          target_role: session.target_role,
          started_at: session.started_at,
          ended_at: session.ended_at,
          answer_count: answerCount,
          final_feedback: session.final_feedback
        };
      });

    return rows;
  }

  async progressByUser(userId) {
    const completed = this.sessions.filter((s) => s.user_id === userId && s.final_feedback?.scores);
    const totalSessions = this.sessions.filter((s) => s.user_id === userId).length;

    if (!completed.length) {
      return {
        totalSessions,
        completedSessions: 0,
        avgClarity: 0,
        avgConfidence: 0,
        avgContent: 0
      };
    }

    const sum = completed.reduce(
      (acc, session) => {
        acc.clarity += Number(session.final_feedback.scores.clarity || 0);
        acc.confidence += Number(session.final_feedback.scores.confidence || 0);
        acc.content += Number(session.final_feedback.scores.content || 0);
        return acc;
      },
      { clarity: 0, confidence: 0, content: 0 }
    );

    return {
      totalSessions,
      completedSessions: completed.length,
      avgClarity: Number((sum.clarity / completed.length).toFixed(2)),
      avgConfidence: Number((sum.confidence / completed.length).toFixed(2)),
      avgContent: Number((sum.content / completed.length).toFixed(2))
    };
  }
}

class PostgresStore {
  constructor(databaseUrl) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';`);
    await this.pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY,
        user_id TEXT NOT NULL,
        target_role TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        final_feedback JSONB
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS answers (
        id BIGSERIAL PRIMARY KEY,
        session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        question_index INT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        feedback JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);");
    await this.pool.query("CREATE INDEX IF NOT EXISTS idx_answers_session_id ON answers(session_id);");
  }

  async createUser({ name, email, passwordHash }) {
    const { rows } = await this.pool.query(
      `
      INSERT INTO users (user_id, name, email, password_hash)
      VALUES ($1, $2, $3, $4)
      RETURNING user_id, name, email, password_hash, created_at
      `,
      [email, name, email, passwordHash]
    );
    return rows[0] || null;
  }

  async getUserByEmail(email) {
    const { rows } = await this.pool.query(
      `
      SELECT user_id, name, email, password_hash, created_at
      FROM users
      WHERE email = $1
      LIMIT 1
      `,
      [email]
    );
    return rows[0] || null;
  }

  async createSession({ sessionId, userId, targetRole }) {
    await this.pool.query(
      `INSERT INTO sessions (id, user_id, target_role) VALUES ($1, $2, $3)`,
      [sessionId, userId, targetRole]
    );
  }

  async saveAnswer({ sessionId, questionIndex, question, answer, feedback }) {
    await this.pool.query(
      `
      INSERT INTO answers (session_id, question_index, question, answer, feedback)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [sessionId, questionIndex, question, answer, feedback]
    );
  }

  async closeSession({ sessionId, finalFeedback }) {
    await this.pool.query(
      `UPDATE sessions SET ended_at = NOW(), final_feedback = $2 WHERE id = $1`,
      [sessionId, finalFeedback]
    );
  }

  async listSessionsByUser(userId, limit = 20) {
    const { rows } = await this.pool.query(
      `
      SELECT
        s.id AS session_id,
        s.target_role,
        s.started_at,
        s.ended_at,
        COUNT(a.id)::int AS answer_count,
        s.final_feedback
      FROM sessions s
      LEFT JOIN answers a ON a.session_id = s.id
      WHERE s.user_id = $1
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT $2
      `,
      [userId, limit]
    );

    return rows;
  }

  async progressByUser(userId) {
    const { rows } = await this.pool.query(
      `
      SELECT
        COUNT(*)::int AS total_sessions,
        COUNT(*) FILTER (WHERE final_feedback IS NOT NULL)::int AS completed_sessions,
        COALESCE(AVG((final_feedback->'scores'->>'clarity')::numeric), 0)::numeric(10,2) AS avg_clarity,
        COALESCE(AVG((final_feedback->'scores'->>'confidence')::numeric), 0)::numeric(10,2) AS avg_confidence,
        COALESCE(AVG((final_feedback->'scores'->>'content')::numeric), 0)::numeric(10,2) AS avg_content
      FROM sessions
      WHERE user_id = $1
      `,
      [userId]
    );

    const row = rows[0] || {};
    return {
      totalSessions: Number(row.total_sessions || 0),
      completedSessions: Number(row.completed_sessions || 0),
      avgClarity: Number(row.avg_clarity || 0),
      avgConfidence: Number(row.avg_confidence || 0),
      avgContent: Number(row.avg_content || 0)
    };
  }
}

let store;

export function getStore() {
  if (!store) {
    store = hasDatabaseUrl
      ? new PostgresStore(process.env.DATABASE_URL)
      : new InMemoryStore();
  }
  return store;
}

export function getStorageMode() {
  return hasDatabaseUrl ? "postgres" : "memory";
}
