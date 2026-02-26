import { useMemo, useRef, useState } from "react";

const API_BASE = "http://localhost:8787";

export default function App() {
  const [view, setView] = useState("simulate");
  const [userId, setUserId] = useState("demo-user");
  const [targetRole, setTargetRole] = useState("Developpeur frontend junior");
  const [session, setSession] = useState(null);
  const [answer, setAnswer] = useState("");
  const [history, setHistory] = useState([]);
  const [pastSessions, setPastSessions] = useState([]);
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const [error, setError] = useState("");

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);

  const canSend = useMemo(() => session && answer.trim().length > 0 && !loading, [session, answer, loading]);

  async function loadDashboard() {
    if (!userId.trim()) return;
    try {
      const [sessionsRes, progressRes] = await Promise.all([
        fetch(`${API_BASE}/users/${encodeURIComponent(userId)}/sessions`),
        fetch(`${API_BASE}/users/${encodeURIComponent(userId)}/progress`)
      ]);

      if (!sessionsRes.ok || !progressRes.ok) {
        throw new Error("Impossible de charger l'historique");
      }

      const sessionsData = await sessionsRes.json();
      const progressData = await progressRes.json();
      setPastSessions(sessionsData.sessions || []);
      setProgress(progressData.progress || null);
    } catch (e) {
      setError(e.message || "Erreur de chargement historique");
    }
  }

  async function startSession() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetRole, userId }),
      });
      if (!res.ok) throw new Error("Impossible de demarrer la session");
      const data = await res.json();
      setSession(data);
      setHistory([{ type: "question", text: data.currentQuestion }]);
      setAnswer("");
      setView("simulate");
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  async function sendAnswer() {
    if (!canSend) return;
    setLoading(true);
    setError("");
    const userAnswer = answer.trim();
    try {
      const res = await fetch(`${API_BASE}/session/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          answer: userAnswer,
        }),
      });
      if (!res.ok) throw new Error("Erreur lors de l'envoi de reponse");
      const data = await res.json();
      setHistory((prev) => {
        const next = [...prev, { type: "answer", text: userAnswer }];
        if (data.answerFeedback?.summary) {
          next.push({ type: "coach", text: data.answerFeedback.summary });
        }
        if (data.nextQuestion) next.push({ type: "question", text: data.nextQuestion });
        if (data.feedback) next.push({ type: "feedback", text: data.feedback.summary });
        return next;
      });
      setSession((prev) => ({ ...prev, ...data }));
      setAnswer("");

      if (data.done) {
        await loadDashboard();
      }
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  async function transcribeAudio(audioBlob) {
    const formData = new FormData();
    formData.append("audio", audioBlob, "answer.webm");

    const res = await fetch(`${API_BASE}/stt`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || "Echec de transcription");
    }

    const data = await res.json();
    setAnswer(data.text || "");
  }

  async function startRecording() {
    if (!session || recording || loading) return;
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data?.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        const nextAudioUrl = URL.createObjectURL(audioBlob);
        setAudioUrl(nextAudioUrl);
        setLoading(true);
        try {
          await transcribeAudio(audioBlob);
        } catch (e) {
          setError(e.message || "Transcription impossible");
        } finally {
          setLoading(false);
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
      };

      recorder.start();
      setRecording(true);
    } catch (_e) {
      setError("Impossible d'acceder au micro");
    }
  }

  function stopRecording() {
    if (!recorderRef.current || !recording) return;
    recorderRef.current.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  return (
    <main className="page">
      <section className="card full-width">
        <h1>Coach Entretien IA</h1>
        <div className="actions actions-row">
          <button className={view === "simulate" ? "tab active" : "tab"} onClick={() => setView("simulate")}>
            Simulation
          </button>
          <button
            className={view === "history" ? "tab active" : "tab"}
            onClick={async () => {
              setView("history");
              await loadDashboard();
            }}
          >
            Historique & progression
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Profil</h2>
        <label htmlFor="userId">Identifiant utilisateur</label>
        <input
          id="userId"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="Ex: etudiant-001"
        />

        <label htmlFor="role">Poste cible</label>
        <input
          id="role"
          value={targetRole}
          onChange={(e) => setTargetRole(e.target.value)}
          placeholder="Ex: Data Analyst Junior"
        />

        <div className="actions">
          <button onClick={startSession} disabled={loading || !targetRole.trim() || !userId.trim()}>
            {loading ? "Chargement..." : "Demarrer la session"}
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </section>

      {view === "simulate" && (
        <section className="card">
          <h2>Simulation</h2>
          <div className="history">
            {history.length === 0 && <p className="muted">Aucune session active.</p>}
            {history.map((item, idx) => (
              <p key={idx} className={`msg ${item.type}`}>
                <strong>{item.type.toUpperCase()}:</strong> {item.text}
              </p>
            ))}
          </div>

          <label htmlFor="answer">Ta reponse</label>
          <div className="actions actions-row">
            <button onClick={startRecording} disabled={!session || loading || recording}>
              {recording ? "Enregistrement..." : "Parler (micro)"}
            </button>
            <button onClick={stopRecording} disabled={!recording}>
              Stop
            </button>
          </div>
          {audioUrl && (
            <audio className="audio-preview" controls src={audioUrl}>
              Ton navigateur ne supporte pas l'audio.
            </audio>
          )}
          <textarea
            id="answer"
            rows={4}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Le texte transcrit apparait ici (modifiable)"
            disabled={!session || loading}
          />

          <div className="actions">
            <button onClick={sendAnswer} disabled={!canSend}>
              Envoyer la reponse
            </button>
          </div>
        </section>
      )}

      {view === "history" && (
        <section className="card">
          <h2>Historique & progression</h2>
          {!progress && <p className="muted">Aucune donnee pour l'instant.</p>}
          {progress && (
            <div className="progress-grid">
              <p><strong>Sessions totales:</strong> {progress.totalSessions}</p>
              <p><strong>Sessions completees:</strong> {progress.completedSessions}</p>
              <p><strong>Moyenne clarte:</strong> {progress.avgClarity}/10</p>
              <p><strong>Moyenne confiance:</strong> {progress.avgConfidence}/10</p>
              <p><strong>Moyenne contenu:</strong> {progress.avgContent}/10</p>
            </div>
          )}

          <div className="history-list">
            {pastSessions.map((item) => (
              <article className="history-item" key={item.session_id}>
                <p><strong>Poste:</strong> {item.target_role}</p>
                <p><strong>Date:</strong> {new Date(item.started_at).toLocaleString()}</p>
                <p><strong>Reponses:</strong> {item.answer_count}</p>
                <p><strong>Feedback final:</strong> {item.final_feedback?.summary || "Session non terminee"}</p>
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
