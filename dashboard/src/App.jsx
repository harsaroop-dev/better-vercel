import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  Rocket,
  Github,
  FolderGit2,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Globe,
  Terminal,
  LayoutGrid,
  Plus,
  Calendar,
  ExternalLink,
} from "lucide-react";
import "./App.css";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

function App() {
  const [activeTab, setActiveTab] = useState("deploy"); // 'deploy' | 'projects'
  const [projects, setProjects] = useState([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);

  // Deploy State
  const [gitUrl, setGitUrl] = useState("");
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState("IDLE");
  const [deploymentId, setDeploymentId] = useState(null);
  const [liveUrl, setLiveUrl] = useState("");
  const [logs, setLogs] = useState([]);

  const bottomRef = useRef(null);

  // Fetch Projects when tab changes
  useEffect(() => {
    if (activeTab === "projects") {
      fetchProjects();
    }
  }, [activeTab]);

  const fetchProjects = async () => {
    setIsLoadingProjects(true);
    const { data, error } = await supabase
      .from("deployments")
      .select("*")
      .order("created_at", { ascending: false });

    if (!error && data) {
      setProjects(data);
    }
    setIsLoadingProjects(false);
  };

  const handleDeploy = async (e) => {
    e.preventDefault();
    setStatus("STARTING");
    setDeploymentId(null);
    setLogs([]);

    try {
      const response = await fetch("http://localhost:8000/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gitUrl, projectId }),
      });

      const data = await response.json();

      if (response.ok) {
        setDeploymentId(data.deploymentId);
        setLiveUrl(data.liveUrl);
        setStatus("QUEUED");
      } else {
        setStatus("FAILED");
        setLogs((prev) => [...prev, `[Error] ${data.error}`]);
      }
    } catch (error) {
      setStatus("FAILED");
      setLogs((prev) => [...prev, `[System] Server offline or unreachable.`]);
    }
  };

  useEffect(() => {
    if (!deploymentId) return;

    const statusChannel = supabase
      .channel("deployment_status")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "deployments",
          filter: `id=eq.${deploymentId}`,
        },
        (payload) => setStatus(payload.new.status)
      )
      .subscribe();

    const logChannel = supabase
      .channel(`logs-${deploymentId}`)
      .on("broadcast", { event: "build-log" }, (payload) => {
        setLogs((prev) => [...prev, payload.payload.message]);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(statusChannel);
      supabase.removeChannel(logChannel);
    };
  }, [deploymentId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const isDeploying =
    status === "QUEUED" || status === "BUILDING" || status === "STARTING";

  const StatusIcon = ({ stat }) => {
    switch (stat) {
      case "QUEUED":
        return <Clock size={14} />;
      case "BUILDING":
        return <Loader2 size={14} className="spin" />;
      case "SUCCESS":
        return <CheckCircle2 size={14} />;
      case "FAILED":
        return <XCircle size={14} />;
      default:
        return <Clock size={14} />;
    }
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="container">
      <div className="header">
        <h1>Mini-Vercel</h1>
        <p>Deploy your static projects in seconds.</p>
      </div>

      {/* NAVIGATION TABS */}
      <div className="nav-tabs">
        <button
          className={`nav-btn ${activeTab === "deploy" ? "active" : ""}`}
          onClick={() => setActiveTab("deploy")}
        >
          <Plus size={18} /> New Deployment
        </button>
        <button
          className={`nav-btn ${activeTab === "projects" ? "active" : ""}`}
          onClick={() => setActiveTab("projects")}
        >
          <LayoutGrid size={18} /> My Projects
        </button>
      </div>

      {/* VIEW 1: DEPLOYMENT FORM */}
      {activeTab === "deploy" && (
        <div className="card">
          <form onSubmit={handleDeploy}>
            <div className="input-group">
              <label>GitHub Repository</label>
              <div className="input-wrapper">
                <Github size={16} className="input-icon" />
                <input
                  type="url"
                  placeholder="https://github.com/username/repo.git"
                  required
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  className="input-field"
                  disabled={isDeploying}
                />
              </div>
            </div>

            <div className="input-group">
              <label>Project Name</label>
              <div className="input-wrapper">
                <FolderGit2 size={16} className="input-icon" />
                <input
                  type="text"
                  placeholder="my-awesome-app"
                  required
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="input-field"
                  pattern="[a-z0-9-]+"
                  title="Only lowercase letters, numbers, and dashes"
                  disabled={isDeploying}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isDeploying || !gitUrl || !projectId}
              className="deploy-btn"
            >
              {isDeploying ? (
                <>
                  <Loader2 size={18} className="spin" /> Deploying...
                </>
              ) : (
                <>
                  <Rocket size={18} /> Deploy
                </>
              )}
            </button>
          </form>

          {status !== "IDLE" && (
            <div className="status-card">
              <div className="status-header">
                <StatusIcon stat={status} />
                <span>
                  Status:{" "}
                  <strong
                    style={{
                      color: `var(--${
                        status === "SUCCESS"
                          ? "success"
                          : status === "FAILED"
                          ? "error"
                          : status === "QUEUED"
                          ? "warning"
                          : "text-main"
                      })`,
                    }}
                  >
                    {status}
                  </strong>
                </span>
              </div>

              {(logs.length > 0 || isDeploying) && (
                <div className="terminal-window">
                  <div
                    style={{
                      color: "#3b82f6",
                      marginBottom: "8px",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <Terminal size={14} /> System Build Output
                  </div>
                  {logs.map((log, index) => (
                    <div key={index} className="terminal-line">
                      {log}
                    </div>
                  ))}
                  <div ref={bottomRef} />
                </div>
              )}

              {status === "SUCCESS" && (
                <a
                  href={liveUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="live-link"
                >
                  <Globe size={16} /> Visit Live Deployment
                </a>
              )}
            </div>
          )}
        </div>
      )}

      {/* VIEW 2: MY PROJECTS HISTORY */}
      {activeTab === "projects" && (
        <div className="history-grid">
          {isLoadingProjects ? (
            <div
              style={{
                textAlign: "center",
                padding: "40px",
                color: "var(--text-muted)",
              }}
            >
              <Loader2
                className="spin"
                size={24}
                style={{ margin: "0 auto 12px auto", display: "block" }}
              />
              Loading history...
            </div>
          ) : projects.length === 0 ? (
            <div className="card" style={{ textAlign: "center" }}>
              <FolderGit2
                size={32}
                color="var(--text-muted)"
                style={{ margin: "0 auto 16px auto", display: "block" }}
              />
              <h3 style={{ margin: "0 0 8px 0" }}>No deployments yet</h3>
              <p
                style={{
                  margin: 0,
                  color: "var(--text-muted)",
                  fontSize: "0.875rem",
                }}
              >
                Your past deployments will show up here.
              </p>
            </div>
          ) : (
            projects.map((proj) => (
              <div key={proj.id} className="history-card">
                <div className="history-header">
                  <div>
                    <h3 className="history-title">{proj.project_id}</h3>
                    <div className="history-url">
                      <Github size={14} />{" "}
                      {proj.git_url.replace("https://github.com/", "")}
                    </div>
                  </div>
                  <div className={`badge ${proj.status}`}>
                    <StatusIcon stat={proj.status} /> {proj.status}
                  </div>
                </div>

                <div className="history-footer">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <Calendar size={14} /> {formatDate(proj.created_at)}
                  </div>
                  {proj.status === "SUCCESS" && (
                    <a
                      href={`http://${proj.project_id}.lvh.me:8000`}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        color: "var(--text-main)",
                        textDecoration: "none",
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                        fontWeight: "500",
                      }}
                    >
                      Visit <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default App;
