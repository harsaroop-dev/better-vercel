require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
// We wrap Express in a standard HTTP server to attach WebSockets
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// --- DATABASE CONNECTION (Neon Serverless Postgres) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for secure cloud databases
});

// --- WEBSOCKET ROOMS ---
io.on("connection", (socket) => {
  console.log("Frontend connected to WebSockets!");
  // When a user deploys, they join a "room" specifically for that deployment ID
  socket.on("subscribe", (deploymentId) => {
    socket.join(deploymentId);
  });
});

const TEMP_DIR = path.join(__dirname, "temp");

// --- THE LOG STREAMING ENGINE (Now powered by Socket.io) ---
function runCommandWithLogs(command, args, cwd, deploymentId) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: true });

    const streamOutput = (data) => {
      const text = data.toString().trim();
      if (!text) return;
      console.log(`[${deploymentId}] ${text}`);
      // Broadcast the log directly to the React frontend!
      io.to(deploymentId).emit("build-log", text);
    };

    child.stdout.on("data", streamOutput);
    child.stderr.on("data", streamOutput);

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });
  });
}

// Database Helper Function
async function updateStatus(deploymentId, status) {
  await pool.query("UPDATE deployments SET status = $1 WHERE id = $2", [
    status,
    deploymentId,
  ]);
  io.to(deploymentId).emit("status-update", status);
}

// --- 1. THE ASYNC BUILD ENGINE ---
async function buildProject(gitUrl, projectId, deploymentId) {
  const tempDir = path.join(TEMP_DIR, projectId);
  const sendSystemLog = (msg) =>
    io.to(deploymentId).emit("build-log", `👉 [System] ${msg}`);

  try {
    await updateStatus(deploymentId, "BUILDING");
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });

    sendSystemLog("Cloning repository...");
    await runCommandWithLogs(
      "git",
      ["clone", gitUrl, `"${tempDir}"`],
      __dirname,
      deploymentId
    );

    sendSystemLog("Booting isolated Docker container...");
    const dockerVolumePath = tempDir.replace(/\\/g, "/");
    const buildCommand = `docker run --rm -v "${dockerVolumePath}:/app" -w /app -e NODE_OPTIONS=--openssl-legacy-provider node:18-alpine sh -c "npm install && npm run build"`;
    await runCommandWithLogs(buildCommand, [], __dirname, deploymentId);

    sendSystemLog("Locating compiled artifacts...");

    // We are temporarily skipping the upload function to verify WebSockets work!
    sendSystemLog(
      "Skipping Cloud Upload temporarily. AWS S3 integration is next!"
    );

    await updateStatus(deploymentId, "SUCCESS");
    sendSystemLog("Build Complete! Docker successfully ran on local engine.");
  } catch (error) {
    await updateStatus(deploymentId, "FAILED");
    sendSystemLog(`Build Failed: ${error.message}`);
  } finally {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// --- 2. THE REST API ENDPOINTS ---

// Deploy Endpoint
app.post("/deploy", async (req, res) => {
  const { gitUrl, projectId } = req.body;
  if (!gitUrl || !projectId)
    return res.status(400).json({ error: "Missing parameters" });

  try {
    // Pure SQL to insert into Neon Database
    const result = await pool.query(
      "INSERT INTO deployments (project_id, git_url, status) VALUES ($1, $2, $3) RETURNING id",
      [projectId, gitUrl, "QUEUED"]
    );
    const deploymentId = result.rows[0].id;

    buildProject(gitUrl, projectId, deploymentId);
    res
      .status(200)
      .json({
        message: "Queued!",
        deploymentId,
        liveUrl: `http://${projectId}.lvh.me:${PORT}`,
      });
  } catch (error) {
    res.status(500).json({ error: "Failed", details: error.message });
  }
});

// NEW: Fetch Projects Endpoint (Replaces Supabase Frontend Fetching)
app.get("/projects", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM deployments ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

server.listen(PORT, () =>
  console.log(`\n🚀 Mini-Vercel WebSocket Engine is running on port ${PORT}!`)
);
