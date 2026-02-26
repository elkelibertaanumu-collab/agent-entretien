import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = "http://localhost:8787";

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function getInitialRoute(token) {
  const hash = window.location.hash.replace("#", "") || "/signup";
  if (!token) return "/signup";
  if (hash === "/signup") return "/home";
  return hash;
}

const NAV_ITEMS = [
  { path: "/simulate", label: "Simulation" },
  { path: "/payment", label: "Abonnement" },
  { path: "/progress", label: "Progression" },
  { path: "/cv", label: "CV Builder" }
];
const INTERVIEW_CATEGORIES = [
  { value: "general", label: "General" },
  { value: "behavioral", label: "Behavioral" },
  { value: "technical", label: "Technical" },
  { value: "case_study", label: "Case Study" },
  { value: "leadership", label: "Leadership" },
  { value: "culture_fit", label: "Culture Fit" }
];

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("auth_token") || "");
  const [route, setRoute] = useState(getInitialRoute(localStorage.getItem("auth_token") || ""));

  const [authMode, setAuthMode] = useState("register");
  const [username, setUsername] = useState("userdemo");
  const [email, setEmail] = useState("user@example.com");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState(null);

  const [targetRole, setTargetRole] = useState("Developpeur frontend junior");
  const [interviewCategory, setInterviewCategory] = useState("general");
  const [session, setSession] = useState(null);
  const [answer, setAnswer] = useState("");
  const [history, setHistory] = useState([]);
  const [recording, setRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");

  const [plan, setPlan] = useState("session");
  const [payment, setPayment] = useState(null);

  const [sessions, setSessions] = useState([]);
  const [progress, setProgress] = useState(null);

  const [cvInput, setCvInput] = useState({
    fullName: "Ton Nom",
    title: "Developpeur Frontend Junior",
    city: "Dakar",
    phone: "+221000000000",
    summary: "Jeune profil motive avec une bonne base technique et des projets concrets.",
    skillsText: "React, JavaScript, HTML, CSS, Git",
    expRole: "Stagiaire Developpeur",
    expCompany: "Startup X",
    expPeriod: "2025",
    expBullets: "Developpement d'interfaces web\nCorrection de bugs\nCollaboration en equipe agile",
    eduDegree: "Licence Informatique",
    eduSchool: "Universite Exemple",
    eduYear: "2025"
  });
  const [cvText, setCvText] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);

  const canSend = useMemo(() => session && answer.trim().length > 0 && !loading, [session, answer, loading]);

  function navigate(path) {
    window.location.hash = path;
    setRoute(path);
  }

  useEffect(() => {
    const onHash = () => {
      const current = window.location.hash.replace("#", "") || "/signup";
      if (!token && current !== "/signup") {
        setRoute("/signup");
        return;
      }
      setRoute(current);
    };

    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    fetchMe();
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const params = new URLSearchParams(window.location.search);
    const paymentId = params.get("paymentId");
    if (!paymentId) return;
    loadPaymentStatus(paymentId);
  }, [token]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [audioUrl]);

  async function fetchMe() {
    try {
      const res = await fetch(`${API_BASE}/auth/me`, { headers: { ...authHeaders(token) } });
      if (!res.ok) throw new Error("Session invalide");
      const data = await res.json();
      setUser(data.user);
      if (route === "/signup") navigate("/home");
    } catch {
      setToken("");
      setUser(null);
      localStorage.removeItem("auth_token");
      navigate("/signup");
    }
  }

  async function register() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password })
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || "Inscription impossible");
      }
      const data = await res.json();
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem("auth_token", data.token);
      navigate("/home");
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  async function login() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || "Connexion impossible");
      }
      const data = await res.json();
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem("auth_token", data.token);
      navigate("/home");
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setToken("");
    setUser(null);
    setSession(null);
    setHistory([]);
    localStorage.removeItem("auth_token");
    navigate("/signup");
  }

  async function startSession() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ targetRole, category: interviewCategory })
      });
      if (!res.ok) throw new Error("Impossible de demarrer la session");
      const data = await res.json();
      setSession(data);
      setHistory([{ type: "question", text: data.currentQuestion }]);
      setAnswer("");
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
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ sessionId: session.sessionId, answer: userAnswer })
      });
      if (!res.ok) throw new Error("Erreur lors de l'envoi");
      const data = await res.json();
      setHistory((prev) => {
        const next = [...prev, { type: "answer", text: userAnswer }];
        if (data.answerFeedback?.summary) next.push({ type: "coach", text: data.answerFeedback.summary });
        if (data.nextQuestion) next.push({ type: "question", text: data.nextQuestion });
        if (data.feedback?.summary) next.push({ type: "feedback", text: data.feedback.summary });
        return next;
      });
      setSession((prev) => ({ ...prev, ...data }));
      setAnswer("");
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
      headers: { ...authHeaders(token) },
      body: formData
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
        if (event.data?.size > 0) chunksRef.current.push(event.data);
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
    } catch {
      setError("Impossible d'acceder au micro");
    }
  }

  function stopRecording() {
    if (!recorderRef.current || !recording) return;
    recorderRef.current.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  async function createPayment() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/payment/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ plan })
      });
      if (!res.ok) throw new Error("Paiement non initialise");
      const data = await res.json();
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      setPayment(data);
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  async function loadPaymentStatus(paymentId) {
    try {
      const res = await fetch(`${API_BASE}/payment/status/${encodeURIComponent(paymentId)}`, {
        headers: { ...authHeaders(token) }
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.payment) setPayment(data.payment);
    } catch {
      // Silent on page load.
    }
  }

  async function confirmPayment() {
    if (!payment?.paymentId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/payment/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ paymentId: payment.paymentId })
      });
      if (!res.ok) throw new Error("Paiement non confirme");
      const data = await res.json();
      setPayment(data.payment);
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  async function loadProgress() {
    setLoading(true);
    setError("");
    try {
      const [sessionsRes, progressRes] = await Promise.all([
        fetch(`${API_BASE}/me/sessions`, { headers: { ...authHeaders(token) } }),
        fetch(`${API_BASE}/me/progress`, { headers: { ...authHeaders(token) } })
      ]);
      if (!sessionsRes.ok || !progressRes.ok) throw new Error("Chargement progression impossible");
      const sessionsData = await sessionsRes.json();
      const progressData = await progressRes.json();
      setSessions(sessionsData.sessions || []);
      setProgress(progressData.progress || null);
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  async function generateCv() {
    setLoading(true);
    setError("");
    try {
      const payload = {
        fullName: cvInput.fullName,
        title: cvInput.title,
        city: cvInput.city,
        phone: cvInput.phone,
        summary: cvInput.summary,
        skills: cvInput.skillsText.split(",").map((s) => s.trim()).filter(Boolean),
        experiences: [{
          role: cvInput.expRole,
          company: cvInput.expCompany,
          period: cvInput.expPeriod,
          bullets: cvInput.expBullets.split("\n").map((s) => s.trim()).filter(Boolean)
        }],
        education: [{
          degree: cvInput.eduDegree,
          school: cvInput.eduSchool,
          year: cvInput.eduYear
        }]
      };
      const res = await fetch(`${API_BASE}/cv/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error("Generation CV impossible");
      const data = await res.json();
      setCvText(data.cvText || "");
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  async function copyCv() {
    if (!cvText) return;
    try {
      await navigator.clipboard.writeText(cvText);
    } catch {
      setError("Impossible de copier automatiquement");
    }
  }

  function exportCvPdf() {
    if (!cvText.trim()) return;
    const safeText = cvText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const popup = window.open("", "_blank");
    if (!popup) {
      setError("Autorise les popups pour exporter le PDF");
      return;
    }
    popup.document.write(`
      <html>
        <head>
          <title>CV - ${cvInput.fullName}</title>
          <style>body{font-family:Arial,sans-serif;margin:28px;} pre{white-space:pre-wrap;}</style>
        </head>
        <body>
          <pre>${safeText}</pre>
          <script>window.onload=function(){window.print();};</script>
        </body>
      </html>
    `);
    popup.document.close();
  }

  const showNav = Boolean(token);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <div className="rf-mark">CP</div>
          <div className="brand-text">
            <strong>CareerPrep</strong>
            <span>Entretiens & CV</span>
          </div>
        </div>
        {showNav && (
          <nav className="topnav">
            <button className={route === "/home" ? "navbtn active" : "navbtn"} onClick={() => navigate("/home")}>Accueil</button>
            {NAV_ITEMS.map((item) => (
              <button key={item.path} className={route === item.path ? "navbtn active" : "navbtn"} onClick={() => navigate(item.path)}>
                {item.label}
              </button>
            ))}
            <button className="navbtn danger" onClick={logout}>Quitter</button>
          </nav>
        )}
        {!showNav ? (
          <div className="auth-switch">
            <button className={authMode === "login" ? "navbtn active" : "navbtn"} onClick={() => setAuthMode("login")}>Connexion</button>
            <button className={authMode === "register" ? "navbtn active" : "navbtn"} onClick={() => setAuthMode("register")}>Inscription</button>
          </div>
        ) : (
          <div className="account-chip">{user?.username || "Mon compte"}</div>
        )}
      </header>

      <section className="stage">
        {error && <p className="error">{error}</p>}

        {route === "/signup" && (
          <section className="auth-layout wix-hero">
            <article className="wix-left">
              <p className="wix-badge">Coach IA carrière</p>
              <h1>Prépare tes entretiens comme un pro</h1>
              <p className="wix-sub">
                Une plateforme simple pour t'entraîner avec des questions pertinentes, un feedback IA clair et un suivi réel de ta progression.
              </p>
              <div className="wix-kpis">
                <div><strong>+1200</strong><span>simulations réalisées</span></div>
                <div><strong>3.7/5</strong><span>note moyenne utilisateurs</span></div>
                <div><strong>6</strong><span>catégories d'entretien</span></div>
              </div>
            </article>
            <article className="panel auth-card wix-card">
              <div className="tabs">
                <button onClick={() => setAuthMode("register")} className={authMode === "register" ? "navbtn active" : "navbtn"}>Inscription</button>
                <button onClick={() => setAuthMode("login")} className={authMode === "login" ? "navbtn active" : "navbtn"}>Connexion</button>
              </div>
              {authMode === "register" && (
                <>
                  <label htmlFor="username">Nom d'utilisateur</label>
                  <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ton_username" />
                </>
              )}
              <label htmlFor="email">Email</label>
              <input id="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
              <label htmlFor="password">Mot de passe</label>
              <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="minimum 6 caracteres" />
              {authMode === "register" ? (
                <button className="primary-btn" onClick={register} disabled={loading || !username.trim() || !email.trim() || password.length < 6}>Créer mon compte</button>
              ) : (
                <button className="primary-btn" onClick={login} disabled={loading || !email.trim() || !password.trim()}>Se connecter</button>
              )}
              <p className="auth-note">En continuant, tu acceptes les conditions d'utilisation et la politique de confidentialité.</p>
            </article>
          </section>
        )}

        {route === "/home" && (
          <section className="home-screen">
            <article className="service-hero">
              <p className="crumb">Accueil &gt; Mon simulateur d'entretiens professionnels</p>
              <h1>Mon simulateur d'entretiens professionnels</h1>
              <p className="subtitle">Simulateur</p>
              <div className="row">
                <button className="cta-main" onClick={() => navigate("/simulate")}>C'est parti !</button>
              </div>
              <div className="hero-rating">Note moyenne des internautes <strong>3.7/5</strong> sur 26 votes</div>
            </article>

            <article className="panel description-panel">
              <h2>Description</h2>
              <p>Repondre aux questions d'un recruteur, parler de son parcours et expliquer sa motivation.</p>
              <p>Ce simulateur te permet de t'entrainer dans des conditions proches de la realite, a ton rythme.</p>
              <div className="grid-cards">
                {NAV_ITEMS.map((item) => (
                  <article key={item.path} className="menu-card" onClick={() => navigate(item.path)}>
                    <h3>{item.label}</h3>
                    <p>Ouvrir la page {item.label.toLowerCase()}.</p>
                  </article>
                ))}
              </div>
            </article>

            <article className="panel reviews-panel">
              <h2>Vous en parlez</h2>
              <p>Note moyenne des internautes : <strong>3.7/5</strong> sur 26 votes</p>
              <div className="review-grid">
                <div className="review-card"><strong>Simulateur d'entretien</strong><p>par ANGELIQUE.F38</p></div>
                <div className="review-card"><strong>Cadre</strong><p>par ANGELINE.I</p></div>
                <div className="review-card"><strong>Notre experience SkillGym</strong><p>par CHAKHMAN.M</p></div>
              </div>
            </article>
          </section>
        )}

        {route === "/simulate" && (
          <section className="panel">
            <h2>Simulation</h2>
            <label htmlFor="role">Poste cible</label>
            <input id="role" value={targetRole} onChange={(e) => setTargetRole(e.target.value)} />
            <label htmlFor="category">Categorie</label>
            <select id="category" value={interviewCategory} onChange={(e) => setInterviewCategory(e.target.value)}>
              {INTERVIEW_CATEGORIES.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <div className="row"><button onClick={startSession} disabled={loading}>Demarrer</button></div>
            <div className="history">
              {history.length === 0 && <p className="muted">Aucune session active.</p>}
              {history.map((item, idx) => <p key={idx}><strong>{item.type.toUpperCase()}:</strong> {item.text}</p>)}
            </div>
            <label htmlFor="answer">Reponse</label>
            <div className="row">
              <button onClick={startRecording} disabled={!session || loading || recording}>
                {recording ? "Enregistrement..." : "Parler (micro)"}
              </button>
              <button onClick={stopRecording} disabled={!recording}>Stop</button>
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
            <button onClick={sendAnswer} disabled={!canSend}>Envoyer</button>
          </section>
        )}

        {route === "/payment" && (
          <section className="panel">
            <h2>Abonnement</h2>
            <div className="pricing">
              <article className={plan === "session" ? "price chosen" : "price"} onClick={() => setPlan("session")}>Session - 1500 XOF</article>
              <article className={plan === "monthly" ? "price chosen" : "price"} onClick={() => setPlan("monthly")}>Mensuel - 5000 XOF</article>
            </div>
            <div className="row">
              <button onClick={createPayment} disabled={loading}>Payer</button>
              <button onClick={confirmPayment} disabled={loading || !payment?.paymentId}>Confirmer test</button>
            </div>
            {payment && <p className="hint">{payment.paymentId} | {payment.status}</p>}
          </section>
        )}

        {route === "/progress" && (
          <section className="panel">
            <h2>Progression</h2>
            <button onClick={loadProgress} disabled={loading}>Rafraichir</button>
            {progress && (
              <div className="grid-stats">
                <div>Sessions: {progress.totalSessions}</div>
                <div>Completees: {progress.completedSessions}</div>
                <div>Clarte: {progress.avgClarity}/10</div>
                <div>Confiance: {progress.avgConfidence}/10</div>
              </div>
            )}
            <div className="history">
              {sessions.map((item) => (
                <article key={item.sessionId} className="session-item">
                  <strong>{item.targetRole}</strong>
                  <p>Categorie: {item.category || "general"}</p>
                  <p>{new Date(item.startedAt).toLocaleString()}</p>
                </article>
              ))}
            </div>
          </section>
        )}

        {route === "/cv" && (
          <section className="panel">
            <h2>CV Builder</h2>
            <label>Nom</label>
            <input value={cvInput.fullName} onChange={(e) => setCvInput((p) => ({ ...p, fullName: e.target.value }))} />
            <label>Titre</label>
            <input value={cvInput.title} onChange={(e) => setCvInput((p) => ({ ...p, title: e.target.value }))} />
            <label>Profil</label>
            <textarea rows={3} value={cvInput.summary} onChange={(e) => setCvInput((p) => ({ ...p, summary: e.target.value }))} />
            <div className="row">
              <button onClick={generateCv} disabled={loading}>Generer</button>
              <button onClick={copyCv} disabled={!cvText}>Copier</button>
              <button onClick={exportCvPdf} disabled={!cvText}>PDF</button>
            </div>
            <textarea rows={14} value={cvText} onChange={(e) => setCvText(e.target.value)} />
          </section>
        )}
      </section>

      {showNav && (
        <footer className="site-footer">
          <section className="support-strip">
            <p>Vous rencontrez un probleme sur ce service ?</p>
            <button>Signaler un probleme</button>
          </section>
          <section className="footer-main">
            <article>
              <h4>LIENS UTILES</h4>
              <p>Francetravail.fr</p>
              <p>Francetravail.io</p>
              <p>Francetravail.org</p>
            </article>
            <article>
              <h4>DECOUVREZ L'EMPLOI STORE</h4>
              <p>Les acteurs de l'Emploi Store</p>
              <p>FAQ (Foire aux Questions)</p>
              <p>Plan du site</p>
            </article>
            <article>
              <h4>EDITEURS DE L'EMPLOI STORE</h4>
              <p>Les conditions de referencement</p>
              <p>Comment referencer mon service ?</p>
            </article>
          </section>
          <section className="footer-bottom">
            <p>Conditions generales d'utilisation</p>
            <p>Protection des donnees</p>
            <p>Cookies</p>
            <p>© 2015-2026 FRANCE TRAVAIL. Tous droits reserves.</p>
          </section>
        </footer>
      )}
    </main>
  );
}
