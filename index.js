require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const mime = require("mime-types");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

io.on("connection", (socket) => {
  socket.on("subscribe", (deploymentId) => {
    socket.join(deploymentId);
  });
});

const TEMP_DIR = path.join(__dirname, "temp");

function runCommandWithLogs(command, args, cwd, deploymentId) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: true });

    const streamOutput = (data) => {
      const text = data.toString().trim();
      if (!text) return;
      io.to(deploymentId).emit("build-log", text);
    };

    child.stdout.on("data", streamOutput);
    child.stderr.on("data", streamOutput);

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Exit code ${code}`));
    });
  });
}

async function updateStatus(deploymentId, status) {
  await pool.query("UPDATE deployments SET status = $1 WHERE id = $2", [
    status,
    deploymentId,
  ]);
  io.to(deploymentId).emit("status-update", status);
}

async function uploadDirectoryToS3(dirPath, basePath, projectId, deploymentId) {
  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      await uploadDirectoryToS3(fullPath, basePath, projectId, deploymentId);
    } else {
      const relativePath = path
        .relative(basePath, fullPath)
        .replace(/\\/g, "/");
      const s3Key = `deployments/${projectId}/${relativePath}`;
      const contentType = mime.lookup(fullPath) || "application/octet-stream";

      const fileStream = fs.createReadStream(fullPath);

      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET_NAME,
          Key: s3Key,
          Body: fileStream,
          ContentType: contentType,
        })
      );

      io.to(deploymentId).emit(
        "build-log",
        `☁️ Uploaded to S3: ${relativePath}`
      );
    }
  }
}

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

    const buildScript = `
if [ -f yarn.lock ]; then
    console.log "Yarn detected" && yarn install && yarn build;
elif [ -f pnpm-lock.yaml ]; then
    console.log "pnpm detected" && npm install -g pnpm && pnpm install && pnpm run build;
else
    console.log "npm detected" && npm install && npm run build;
fi
`;

    const buildCommand = `docker run --rm -v "${dockerVolumePath}:/app" -w /app -e NODE_OPTIONS=--openssl-legacy-provider node:18-alpine sh -c '${buildScript.replace(
      /\n/g,
      " "
    )}'`;
    await runCommandWithLogs(buildCommand, [], __dirname, deploymentId);

    sendSystemLog("Locating compiled artifacts...");
    const distPath = path.join(tempDir, "dist");
    const buildPath = path.join(tempDir, "build");
    const finalOutputDir = fs.existsSync(distPath)
      ? distPath
      : fs.existsSync(buildPath)
      ? buildPath
      : null;

    if (!finalOutputDir)
      throw new Error('Could not find "dist" or "build" folder.');

    sendSystemLog("Initiating AWS S3 Cloud Upload...");
    await uploadDirectoryToS3(
      finalOutputDir,
      finalOutputDir,
      projectId,
      deploymentId
    );

    await updateStatus(deploymentId, "SUCCESS");
    sendSystemLog("Deployment Complete! Project is now live globally.");
  } catch (error) {
    await updateStatus(deploymentId, "FAILED");
    sendSystemLog(`Build Failed: ${error.message}`);
  } finally {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

app.post("/deploy", async (req, res) => {
  const { gitUrl, projectId } = req.body;
  if (!gitUrl || !projectId)
    return res.status(400).json({ error: "Missing parameters" });

  try {
    const result = await pool.query(
      "INSERT INTO deployments (project_id, git_url, status) VALUES ($1, $2, $3) RETURNING id",
      [projectId, gitUrl, "QUEUED"]
    );
    const deploymentId = result.rows[0].id;

    buildProject(gitUrl, projectId, deploymentId);
    res.status(200).json({
      message: "Queued!",
      deploymentId,
      liveUrl: `http://${projectId}.${req.hostname}.nip.io:${PORT}`,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed", details: error.message });
  }
});

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

app.use(async (req, res) => {
  const subdomain = req.hostname.split(".")[0];
  if (subdomain === "localhost" || subdomain === "api")
    return res.status(200).send("Welcome to the Mini-Vercel Cloud Engine!");

  let filePath = req.path;
  if (filePath === "/") filePath = "/index.html";

  const s3Url = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/deployments/${subdomain}${filePath}`;

  try {
    const response = await fetch(s3Url);

    if (!response.ok) {
      return res.status(404).send(`404 - File not found in AWS S3.`);
    }

    const exactContentType = mime.lookup(filePath) || "text/plain";
    if (exactContentType === "text/html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
    } else {
      res.setHeader("Content-Type", exactContentType);
    }

    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    res.status(500).send("500 - Cloud Proxy Error");
  }
});

server.listen(PORT, () =>
  console.log(`\n🚀 Mini-Vercel AWS S3 Engine is running on port ${PORT}!`)
);
