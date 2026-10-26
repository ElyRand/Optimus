import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Task = {
  id: string;
  repo: string;
  objective: string;
  status: string;
  result: string | null;
  approval_id: string | null;
  approval_status: string | null;
};
function Dashboard() {
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState("ElyRand/Optimus");
  const [objective, setObjective] = useState(
    "Investigate the failing CI checks and propose a safe fix.",
  );
  const [tasks, setTasks] = useState<Task[]>([]);
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState("");
  const api = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
    const payload = await r.json();
    if (!r.ok)
      throw Error(
        payload.error ? JSON.stringify(payload.error) : `HTTP ${r.status}`,
      );
    return payload;
  };
  async function refresh() {
    try {
      const x = await api("/api/tasks");
      setTasks(x.tasks);
      setPaused(x.paused);
      setMessage("");
    } catch (e) {
      setMessage(String(e));
    }
  }
  useEffect(() => {
    if (!token) return;
    void refresh();
    const id = setInterval(() => void refresh(), 4000);
    return () => clearInterval(id);
  }, [token]);
  async function create() {
    try {
      const result = await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ repo, objective }),
      });
      setMessage(`Créée : ${result.taskId}`);
      await refresh();
    } catch (e) {
      setMessage(String(e));
    }
  }
  async function togglePause() {
    try {
      await api("/api/control/pause", {
        method: "POST",
        body: JSON.stringify({ paused: !paused }),
      });
      await refresh();
    } catch (e) {
      setMessage(String(e));
    }
  }
  async function cancel(id: string) {
    if (!window.confirm("Annuler cette mission ?")) return;
    try {
      await api(`/api/tasks/${id}/cancel`, { method: "POST" });
      await refresh();
    } catch (e) {
      setMessage(String(e));
    }
  }
  async function decide(task: Task, decision: "approved" | "rejected") {
    if (!task.approval_id) return;
    if (
      !window.confirm(`${decision === "approved" ? "APPROUVER" : "REFUSER"} : ${task.repo} / ${task.id} ?

Cette démonstration ne publie aucun code.`)
    )
      return;
    try {
      await api(`/api/tasks/${task.id}/approval`, {
        method: "POST",
        body: JSON.stringify({ approvalId: task.approval_id, decision }),
      });
      await refresh();
    } catch (e) {
      setMessage(String(e));
    }
  }
  return (
    <main>
      <header>
        <span className="logo">◈</span>
        <div>
          <h1>Optimus</h1>
          <p>Agent personnel local · autonome supervisé · dry-run</p>
        </div>
      </header>
      <section>
        <h2>Connexion à l'API locale</h2>
        <label>
          Jeton local
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="API_ACCESS_TOKEN"
          />
        </label>
        <small>Jeton conservé uniquement en mémoire dans cet onglet.</small>
      </section>
      <section>
        <div className="sectionHead">
          <h2>Contrôle de l'agent</h2>
          <button
            className="secondary"
            disabled={!token}
            onClick={() => void togglePause()}
          >
            {paused ? "Reprendre les initiatives" : "Suspendre Optimus"}
          </button>
        </div>
        <p>
          {paused
            ? "Optimus est en pause : aucune nouvelle mission et aucun acte privilégié."
            : "Optimus est disponible (toutes les publications restent simulées)."}
        </p>
      </section>
      <section>
        <h2>Nouvelle mission</h2>
        <label>
          Dépôt autorisé
          <input value={repo} onChange={(e) => setRepo(e.target.value)} />
        </label>
        <label>
          Objectif
          <textarea
            rows={3}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
          />
        </label>
        <button onClick={() => void create()} disabled={!token || paused}>
          Créer la mission
        </button>
      </section>
      {message && <p className="message">{message}</p>}
      <section>
        <div className="sectionHead">
          <h2>Missions</h2>
          <button
            className="secondary"
            onClick={() => void refresh()}
            disabled={!token}
          >
            Actualiser
          </button>
        </div>
        {!tasks.length ? (
          <p className="muted">Aucune mission chargée.</p>
        ) : (
          tasks.map((t) => (
            <article key={t.id}>
              <div className="taskHead">
                <strong>{t.repo}</strong>
                <span className="pill">{t.status}</span>
              </div>
              <p>{t.objective}</p>
              <small>{t.id}</small>
              {t.result && <p className="result">{t.result}</p>}
              {!["completed", "cancelled", "blocked", "failed"].includes(
                t.status,
              ) && (
                <div className="actions">
                  <button
                    className="secondary"
                    onClick={() => void cancel(t.id)}
                  >
                    Annuler la mission
                  </button>
                </div>
              )}
              {t.status === "waiting_approval" &&
                t.approval_status === "pending" && (
                  <div className="actions">
                    <button onClick={() => void decide(t, "approved")}>
                      Approuver (simulation)
                    </button>
                    <button
                      className="secondary"
                      onClick={() => void decide(t, "rejected")}
                    >
                      Refuser
                    </button>
                  </div>
                )}
              {t.status === "waiting_approval" &&
                (t.approval_status === "approved" ||
                  t.approval_status === "rejected") && (
                  <div className="actions">
                    <button
                      className="secondary"
                      onClick={() =>
                        void decide(
                          t,
                          t.approval_status as "approved" | "rejected",
                        )
                      }
                    >
                      Renvoyer la décision enregistrée
                    </button>
                  </div>
                )}
            </article>
          ))
        )}
      </section>
      <footer>Prototype local — aucun push GitHub ni Computer Use réel</footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>,
);
