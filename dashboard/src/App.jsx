import { useState, useEffect } from "react";
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
} from "lucide-react";
import "./App.css";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

function App() {
  const [gitUrl, setGitUrl] = useState("");
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState("IDLE");
  const [deploymentId, setDeploymentId] = useState(null);
  const [liveUrl, setLiveUrl] = useState("");

  const handleDeploy = async (e) => {
    e.preventDefault();
    setStatus("STARTING");
    setDeploymentId(null);

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
        console.error(data.error);
      }
    } catch (error) {
      setStatus("FAILED");
      console.error("Server offline or CORS issue:", error);
    }
  };

  useEffect(() => {
    if (!deploymentId) return;

    const channel = supabase
      .channel("deployment_updates")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "deployments",
          filter: `id=eq.${deploymentId}`,
        },
        (payload) => {
          setStatus(payload.new.status);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [deploymentId]);

  // UI Helpers
  const isDeploying =
    status === "QUEUED" || status === "BUILDING" || status === "STARTING";

  const StatusIcon = () => {
    switch (status) {
      case "QUEUED":
        return <Clock size={18} color="var(--warning)" />;
      case "BUILDING":
        return <Loader2 size={18} color="var(--blue)" className="spin" />;
      case "SUCCESS":
        return <CheckCircle2 size={18} color="var(--success)" />;
      case "FAILED":
        return <XCircle size={18} color="var(--error)" />;
      default:
        return <Loader2 size={18} className="spin" />;
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1>Mini-Vercel</h1>
        <p>Deploy your static projects in seconds.</p>
      </div>

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
              <StatusIcon />
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
    </div>
  );
}

export default App;
