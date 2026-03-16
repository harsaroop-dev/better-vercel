import { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
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

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";
const socket = io(BACKEND_URL);

function App() {
  const [activeTab, setActiveTab] = useState("deploy");
  const [projects, setProjects] = useState([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);

  const [gitUrl, setGitUrl] = useState("");
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState("IDLE");
  const [deploymentId, setDeploymentId] = useState(null);
  const [liveUrl, setLiveUrl] = useState("");
  const [logs, setLogs] = useState([]);
  const [envKeys, setEnvKeys] = useState([{ key: "", value: "" }]);

  const [githubToken, setGithubToken] = useState(
    localStorage.getItem("github_token") || ""
  );
  const [userRepos, setUserRepos] = useState([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);

  const bottomRef = useRef(null);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get("token");
    if (token) {
      setGithubToken(token);
      localStorage.setItem("github_token", token);

      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (githubToken) {
      const fetchRepos = async () => {
        setIsLoadingRepos(true);
        try {
          const response = await fetch(`${BACKEND_URL}/github/repos`, {
            headers: { Authorization: `Bearer ${githubToken}` },
          });
          if (response.ok) {
            const data = await response.json();
            setUserRepos(data);
          } else {
            setGithubToken("");
            localStorage.removeItem("github_token");
          }
        } catch (error) {
          console.error("Failed to fetch GitHub repos", error);
        }
        setIsLoadingRepos(false);
      };
      fetchRepos();
    }
  }, [githubToken]);

  useEffect(() => {
    if (activeTab === "projects") fetchProjects();
  }, [activeTab]);

  const fetchProjects = async () => {
    setIsLoadingProjects(true);
    try {
      const response = await fetch(`${BACKEND_URL}/projects`);
      const data = await response.json();
      setProjects(data);
    } catch (error) {
      console.error("Failed to fetch projects");
    }
    setIsLoadingProjects(false);
  };

  const handleDeploy = async (e) => {
    e.preventDefault();
    setStatus("STARTING");
    setDeploymentId(null);
    setLogs([]);

    const formattedEnvVars = envKeys.reduce((acc, curr) => {
      if (curr.key && curr.value) acc[curr.key] = curr.value;
      return acc;
    }, {});

    try {
      const response = await fetch(`${BACKEND_URL}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gitUrl,
          projectId,
          envVars: formattedEnvVars,
          githubToken,
        }),
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

    socket.emit("subscribe", deploymentId);

    const handleLog = (message) => setLogs((prev) => [...prev, message]);
    const handleStatus = (newStatus) => setStatus(newStatus);

    socket.on("build-log", handleLog);
    socket.on("status-update", handleStatus);

    return () => {
      socket.off("build-log", handleLog);
      socket.off("status-update", handleStatus);
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

  const handleRepoSelect = (e) => {
    const url = e.target.value;
    setGitUrl(url);
    if (url) {
      const name = url.split("/").pop().replace(".git", "");
      setProjectId(name.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
    } else {
      setProjectId("");
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1>Better-Vercel</h1>
        <p>Deploy your static projects in seconds.</p>
      </div>

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

      {activeTab === "deploy" && (
        <div className="card">
          <form onSubmit={handleDeploy}>
            {/* --- UPGRADED GITHUB REPOSITORY SECTION --- */}
            <div className="input-group">
              <label
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                GitHub Repository
                {!githubToken ? (
                  <button
                    type="button"
                    onClick={() =>
                      (window.location.href = `${BACKEND_URL}/auth/github`)
                    }
                    style={{
                      background: "#24292e",
                      color: "white",
                      border: "none",
                      padding: "4px 12px",
                      borderRadius: "4px",
                      fontSize: "0.75rem",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <Github size={12} /> Connect Account
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setGithubToken("");
                      localStorage.removeItem("github_token");
                      setUserRepos([]);
                      setGitUrl("");
                    }}
                    style={{
                      background: "none",
                      color: "#ef4444",
                      border: "none",
                      fontSize: "0.75rem",
                      cursor: "pointer",
                    }}
                  >
                    Disconnect
                  </button>
                )}
              </label>

              <div className="input-wrapper">
                <Github size={16} className="input-icon" />
                {githubToken ? (
                  <select
                    required
                    value={gitUrl}
                    onChange={handleRepoSelect}
                    className="input-field"
                    disabled={isDeploying || isLoadingRepos}
                    style={{ appearance: "auto", cursor: "pointer" }}
                  >
                    <option value="">
                      {isLoadingRepos
                        ? "Loading your repositories..."
                        : "Select a repository to deploy..."}
                    </option>
                    {userRepos.map((repo) => (
                      <option key={repo.id} value={repo.clone_url}>
                        {repo.full_name} {repo.private ? " 🔒" : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="url"
                    placeholder="https://github.com/username/repo.git"
                    required
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    className="input-field"
                    disabled={isDeploying}
                  />
                )}
              </div>
            </div>
            {/* ------------------------------------------ */}

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

            <div className="input-group" style={{ marginTop: "24px" }}>
              <label
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                Environment Variables (Optional)
                <button
                  type="button"
                  onClick={() =>
                    setEnvKeys([...envKeys, { key: "", value: "" }])
                  }
                  style={{
                    background: "none",
                    border: "none",
                    color: "#3b82f6",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <Plus size={14} /> Add Variable
                </button>
              </label>

              {envKeys.map((env, index) => (
                <div
                  key={index}
                  style={{ display: "flex", gap: "8px", marginBottom: "8px" }}
                >
                  <input
                    type="text"
                    placeholder="KEY (e.g. VITE_API_URL)"
                    value={env.key}
                    onChange={(e) => {
                      const newEnvs = [...envKeys];
                      newEnvs[index].key = e.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9_]/g, "");
                      setEnvKeys(newEnvs);
                    }}
                    className="input-field"
                    style={{ flex: 1, paddingLeft: "16px" }}
                    disabled={isDeploying}
                  />
                  <input
                    type="text"
                    placeholder="VALUE"
                    value={env.value}
                    onChange={(e) => {
                      const newEnvs = [...envKeys];
                      newEnvs[index].value = e.target.value;
                      setEnvKeys(newEnvs);
                    }}
                    className="input-field"
                    style={{ flex: 2, paddingLeft: "16px" }}
                    disabled={isDeploying}
                  />
                  {envKeys.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setEnvKeys(envKeys.filter((_, i) => i !== index))
                      }
                      style={{
                        background: "none",
                        border: "none",
                        color: "#ef4444",
                        cursor: "pointer",
                        padding: "0 8px",
                      }}
                      disabled={isDeploying}
                    >
                      <XCircle size={18} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <button
              type="submit"
              disabled={isDeploying || !gitUrl || !projectId}
              className="deploy-btn"
            >
              {isDeploying ? (
                <>
                  {" "}
                  <Loader2 size={18} className="spin" /> Deploying...{" "}
                </>
              ) : (
                <>
                  {" "}
                  <Rocket size={18} /> Deploy{" "}
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

              {status === "SUCCESS" && liveUrl && (
                <div
                  style={{
                    marginTop: "16px",
                    marginBottom: "16px",
                    padding: "12px",
                    backgroundColor: "#0f172a",
                    borderRadius: "8px",
                    border: "1px solid #1e293b",
                  }}
                >
                  <p
                    style={{
                      margin: "0 0 8px 0",
                      fontSize: "0.875rem",
                      color: "#94a3b8",
                    }}
                  >
                    ✨ Your site is live!
                  </p>
                  <a
                    href={liveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      color: "#3b82f6",
                      textDecoration: "none",
                      fontWeight: "bold",
                    }}
                  >
                    <Globe size={16} /> {liveUrl} <ExternalLink size={14} />
                  </a>
                </div>
              )}

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
            </div>
          )}
        </div>
      )}

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
