import { useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function initialRoute(token) {
  const hash = window.location.hash.replace("#", "") || "/signup";
  if (!token) return hash === "/login" ? "/login" : "/signup";
  return hash === "/signup" ? "/home" : hash;
}

const FEATURES = [
  { path: "/simulate", title: "Simulation", subtitle: "Entretien IA en conditions reelles" },
  { path: "/payment", title: "Abonnement", subtitle: "Paiement et activation premium" },
  { path: "/progress", title: "Progression", subtitle: "Scores et historique de sessions" },
  { path: "/cv", title: "Generateur CV", subtitle: "CV optimise et export PDF" }
];

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("auth_token") || "");
  const [route, setRoute] = useState(initialRoute(localStorage.getItem("auth_token") || ""));

  const [email, setEmail] = useState("user@example.com");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [user, setUser] = useState(null);

  const [targetRole, setTargetRole] = useState("Developpeur frontend junior");
  const [session, setSession] = useState(null);
  const [answer, setAnswer] = useState("");
  const [history, setHistory] = useState([]);

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

  const canSend = useMemo(() => session && answer.trim().length > 0 && !loading, [session, answer, loading]);

  function navigate(path) {
    window.location.hash = path;
    setRoute(path);
  }

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace("#", "") || "/signup";
      if (!token && hash !== "/signup" && hash !== "/login") {
        setRoute("/signup");
        return;
      }
      setRoute(hash);
    };

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    fetchMe();
  }, [token]);

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

  async function requestCode(action) {
    setLoading(true);
    setError("");
    try {
      const endpoint = action === "signup" ? "/auth/signup/request-code" : "/auth/login/request-code";
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      if (!res.ok) throw new Error("Impossible d'envoyer le code");
      const data = await res.json();
      setDevCode(data.devCode || "");
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(action) {
    setLoading(true);
    setError("");
    try {
      const endpoint = action === "signup" ? "/auth/signup/verify-code" : "/auth/login/verify-code";
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code })
      });
      if (!res.ok) throw new Error("Code incorrect");
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
        body: JSON.stringify({ targetRole })
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
      setPayment(data);
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  }

  async function checkPaymentStatus() {
    if (!payment?.paymentId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/payment/status/${payment.paymentId}`, {
        headers: { ...authHeaders(token) }
      });
      if (!res.ok) throw new Error("Impossible de verifier le paiement");
      const data = await res.json();
      setPayment(data.payment || payment);
    } catch (e) {
      setError(e.message || "Erreur inconnue");
    } finally {
      setLoading(false);
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
        <head><title>CV - ${cvInput.fullName}</title></head>
        <body style="font-family:Arial,sans-serif;padding:28px;"><pre style="white-space:pre-wrap;">${safeText}</pre><script>window.onload=function(){window.print();};</script></body>
      </html>
    `);
    popup.document.close();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand-dot" />
          <div>
            <strong className="brand">PrepCoach IA</strong>
            <p className="brand-sub">Simulateur d'entretiens professionnels</p>
          </div>
        </div>
        {token && (
          <nav className="nav">
            <button className={route === "/home" ? "nav-btn active" : "nav-btn"} onClick={() => navigate("/home")}>Accueil</button>
            {FEATURES.map((f) => (
              <button key={f.path} className={route === f.path ? "nav-btn active" : "nav-btn"} onClick={() => navigate(f.path)}>{f.title}</button>
            ))}
            <button className="nav-btn ghost" onClick={logout}>Deconnexion</button>
          </nav>
        )}
      </header>

      <section className="hero-band" />

      <section className="content">
        {error && <p className="error">{error}</p>}

        {route === "/signup" && (
          <section className="card card-auth">
            <h1>Inscription</h1>
            <p>Cree ton compte pour acceder a ton espace d'entrainement.</p>
            <label htmlFor="email">Email</label>
            <input id="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
            <div className="row"><button onClick={() => requestCode("signup")} disabled={loading || !email.trim()}>Recevoir un code</button></div>
            {devCode && <p className="hint">Code dev: <strong>{devCode}</strong></p>}
            <label htmlFor="code">Code OTP</label>
            <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            <button onClick={() => verifyCode("signup")} disabled={loading || !code.trim()}>Valider et entrer</button>
            <p className="auth-switch">Tu as deja un compte ? <button className="link-btn" onClick={() => navigate("/login")}>Se connecter</button></p>
          </section>
        )}

        {route === "/login" && (
          <section className="card card-auth">
            <h1>Connexion</h1>
            <p>Entre avec ton email et un code OTP.</p>
            <label htmlFor="email-login">Email</label>
            <input id="email-login" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
            <div className="row"><button onClick={() => requestCode("login")} disabled={loading || !email.trim()}>Recevoir un code</button></div>
            {devCode && <p className="hint">Code dev: <strong>{devCode}</strong></p>}
            <label htmlFor="code-login">Code OTP</label>
            <input id="code-login" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            <button onClick={() => verifyCode("login")} disabled={loading || !code.trim()}>Se connecter</button>
            <p className="auth-switch">Pas encore de compte ? <button className="link-btn" onClick={() => navigate("/signup")}>S'inscrire</button></p>
          </section>
        )}

        {route === "/home" && (
          <section className="card">
            <h2>Tableau de bord</h2>
            <p>Bienvenue {user?.email}. Choisis une section.</p>
            <div className="grid-cards">
              {FEATURES.map((item) => (
                <article key={item.path} className="feature-card" onClick={() => navigate(item.path)}>
                  <h3>{item.title}</h3>
                  <p>{item.subtitle}</p>
                  <span>Ouvrir</span>
                </article>
              ))}
            </div>
          </section>
        )}

        {route === "/simulate" && (
          <section className="card">
            <h2>Simulation</h2>
            <label htmlFor="role">Poste cible</label>
            <input id="role" value={targetRole} onChange={(e) => setTargetRole(e.target.value)} />
            <div className="row"><button onClick={startSession} disabled={loading}>Demarrer la session</button></div>
            <div className="history">
              {history.length === 0 && <p className="muted">Aucune session active.</p>}
              {history.map((item, idx) => <p key={idx}><strong>{item.type.toUpperCase()}:</strong> {item.text}</p>)}
            </div>
            <label htmlFor="answer">Ta reponse</label>
            <textarea id="answer" rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={!session || loading} />
            <button onClick={sendAnswer} disabled={!canSend}>Envoyer</button>
          </section>
        )}

        {route === "/payment" && (
          <section className="card">
            <h2>Abonnement</h2>
            <div className="pricing-grid">
              <article className={plan === "session" ? "pricing-card selected" : "pricing-card"} onClick={() => setPlan("session")}>
                <h3>Session</h3><p>2000 XOF</p>
              </article>
              <article className={plan === "monthly" ? "pricing-card selected" : "pricing-card"} onClick={() => setPlan("monthly")}>
                <h3>Mensuel</h3><p>5000 XOF</p>
              </article>
            </div>
            <div className="row">
              <button onClick={createPayment} disabled={loading}>Payer</button>
              <button onClick={checkPaymentStatus} disabled={loading || !payment?.paymentId}>Verifier statut</button>
              <button onClick={confirmPayment} disabled={loading || !payment?.paymentId}>Confirmer test</button>
            </div>
            {payment && <p className="hint">ID: {payment.paymentId} | Statut: {payment.status}</p>}
          </section>
        )}

        {route === "/progress" && (
          <section className="card">
            <h2>Progression</h2>
            <button onClick={loadProgress} disabled={loading}>Rafraichir</button>
            {progress && (
              <div className="stats-grid">
                <div>Sessions: {progress.totalSessions}</div>
                <div>Completees: {progress.completedSessions}</div>
                <div>Clarte: {progress.avgClarity}/10</div>
                <div>Confiance: {progress.avgConfidence}/10</div>
                <div>Contenu: {progress.avgContent}/10</div>
              </div>
            )}
            <div className="history">
              {sessions.map((item) => (
                <article key={item.sessionId} className="session-item">
                  <strong>{item.targetRole}</strong>
                  <p>{new Date(item.startedAt).toLocaleString()}</p>
                </article>
              ))}
            </div>
          </section>
        )}

        {route === "/cv" && (
          <section className="card">
            <h2>Generateur CV</h2>
            <label>Nom complet</label>
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
            <textarea rows={14} value={cvText} onChange={(e) => setCvText(e.target.value)} placeholder="Le CV genere apparait ici" />
          </section>
        )}
      </section>

      <footer className="footer">
        <div className="footer-top">
          <p>Vous rencontrez un probleme sur ce service ?</p>
          <button className="signal-btn">Signaler un probleme</button>
        </div>
        <div className="footer-grid">
          <div><h4>Liens utiles</h4><p>Prepcoach.app</p><p>FAQ</p><p>Support</p></div>
          <div><h4>Produit</h4><p>Simulation</p><p>CV Builder</p><p>Abonnement</p></div>
          <div><h4>Contact</h4><p>support@prepcoach.app</p><p>+221 77 000 00 00</p></div>
        </div>
      </footer>
    </main>
  );
}
