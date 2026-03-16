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

async function buildProject(
  gitUrl,
  projectId,
  deploymentId,
  envVars = {},
  githubToken = ""
) {
  const tempDir = path.join(TEMP_DIR, projectId);
  const sendSystemLog = (msg) =>
    io.to(deploymentId).emit("build-log", `👉 [System] ${msg}`);

  let dockerEnvString = "";
  for (const [key, value] of Object.entries(envVars)) {
    dockerEnvString += `-e ${key}="${value}" `;
  }

  try {
    await updateStatus(deploymentId, "BUILDING");
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });

    sendSystemLog("Cloning repository...");

    const authenticatedGitUrl = githubToken
      ? gitUrl.replace("https://", `https://${githubToken}@`)
      : gitUrl;

    await runCommandWithLogs(
      "git",
      ["clone", authenticatedGitUrl, `"${tempDir}"`],
      __dirname,
      deploymentId
    );

    sendSystemLog("Booting isolated Docker container...");
    const dockerVolumePath = tempDir.replace(/\\/g, "/");

    sendSystemLog("Analyzing package.json for Node version...");
    let nodeVersion = "20";

    const packageJsonPath = path.join(tempDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkgData = fs.readFileSync(packageJsonPath, "utf8");
        const pkgJson = JSON.parse(pkgData);

        if (pkgJson.engines && pkgJson.engines.node) {
          const match = pkgJson.engines.node.match(/\d+/);
          if (match) {
            nodeVersion = match[0];
            sendSystemLog(`Detected Node.js requirement: v${nodeVersion}`);
          }
        }
      } catch (err) {
        sendSystemLog("Could not parse package.json, using default Node 20.");
      }
    }

    const buildScript = `
if [ -f yarn.lock ]; then
    echo "Yarn detected" && yarn install && yarn build;
elif [ -f pnpm-lock.yaml ]; then
    echo "pnpm detected" && npm install -g pnpm && pnpm install && pnpm run build;
else
    echo "npm detected" && npm install && npm run build;
fi;

BUILD_EXIT=$?
chown -R 1000:1000 /app
exit $BUILD_EXIT
`;
    const buildCommand = `docker run --rm -v "${dockerVolumePath}:/app" -w /app ${dockerEnvString}-e NODE_OPTIONS=--openssl-legacy-provider node:${nodeVersion}-alpine sh -c '${buildScript.replace(
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
  const { gitUrl, projectId, envVars, githubToken } = req.body;
  if (!gitUrl || !projectId)
    return res.status(400).json({ error: "Missing parameters" });

  try {
    const result = await pool.query(
      "INSERT INTO deployments (project_id, git_url, env_vars, status) VALUES ($1, $2, $3, $4) RETURNING id",
      [projectId, gitUrl, envVars || {}, "QUEUED"]
    );
    const deploymentId = result.rows[0].id;

    buildProject(gitUrl, projectId, deploymentId, envVars || {}, githubToken);
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

app.get("/auth/github", (req, res) => {
  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=repo`;
  res.redirect(githubAuthUrl);
});

app.get("/auth/github/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("No code provided");

  try {
    const tokenResponse = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code: code,
        }),
      }
    );

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    res.redirect(`${process.env.FRONTEND_URL}?token=${accessToken}`);
  } catch (error) {
    console.error("OAuth Error:", error);
    res.redirect(`${process.env.FRONTEND_URL}?error=oauth_failed`);
  }
});

app.get("/github/repos", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const reposResponse = await fetch(
      "https://api.github.com/user/repos?sort=updated&per_page=50",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    const repos = await reposResponse.json();
    res.json(repos);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch repositories" });
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
