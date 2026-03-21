require("dotenv").config();
const http = require("http");
const https = require("https");
const express = require("express");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const cors = require("cors");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const mime = require("mime-types");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const jwt = require("jsonwebtoken");
const net = require("net");
const httpProxy = require("http-proxy");

process.on("uncaughtException", (err) =>
  console.error("Uncaught Exception:", err)
);
process.on("unhandledRejection", (reason) =>
  console.error("Unhandled Rejection:", reason)
);

const app = express();
const PORT = process.env.PORT || 8000;

const proxy = httpProxy.createProxyServer({});
proxy.on("error", function (err, req, res) {
  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("502 Bad Gateway");
  }
});

const activeNextDeployments = new Map();

let credentials = {};
try {
  credentials = {
    key: fs.readFileSync(
      "/etc/letsencrypt/live/bettervercel.harsaroop.com/privkey.pem",
      "utf8"
    ),
    cert: fs.readFileSync(
      "/etc/letsencrypt/live/bettervercel.harsaroop.com/fullchain.pem",
      "utf8"
    ),
  };
} catch (err) {}

const httpServer = http.createServer(app);
const httpsServer = credentials.key
  ? https.createServer(credentials, app)
  : null;

const io = new Server({ cors: { origin: "*" } });
io.attach(httpServer);
if (httpsServer) io.attach(httpsServer);

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on("error", (err) => console.error("Database Pool Error:", err));

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

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

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
  const sendSystemLog = (msg) => {
    io.to(deploymentId).emit("build-log", `👉 [System] ${msg}`);
  };

  let dockerEnvString = "";
  for (const [key, value] of Object.entries(envVars)) {
    dockerEnvString += `-e ${key}="${value}" `;
  }

  try {
    await updateStatus(deploymentId, "BUILDING");

    if (fs.existsSync(tempDir)) {
      try {
        execSync(`sudo rm -rf "${tempDir}"`);
      } catch (cleanErr) {}
    }

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

    sendSystemLog("Analyzing package.json for Node version and framework...");
    let nodeVersion = "20";
    let isNextJs = false;

    const packageJsonPath = path.join(tempDir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkgData = fs.readFileSync(packageJsonPath, "utf8");
        const pkgJson = JSON.parse(pkgData);

        if (pkgJson.dependencies && pkgJson.dependencies.next) {
          isNextJs = true;
          sendSystemLog(
            "🚀 Next.js framework detected! Switching to stateful pipeline."
          );
        }

        if (pkgJson.engines && pkgJson.engines.node) {
          const match = pkgJson.engines.node.match(/\d+/);
          if (match) {
            nodeVersion = match[0];
            sendSystemLog(`Detected Node.js requirement: v${nodeVersion}`);
          }
        }
      } catch (err) {}
    }

    if (isNextJs) {
      sendSystemLog("⚙️ Generating optimized Next.js Dockerfile...");

      const nextConfigPath = path.join(tempDir, "next.config.js");
      if (!fs.existsSync(nextConfigPath)) {
        fs.writeFileSync(
          nextConfigPath,
          `module.exports = { output: 'standalone' };`
        );
      }

      const dockerfileContent = `
FROM node:${nodeVersion}-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
RUN mkdir -p /app/public

FROM node:${nodeVersion}-slim AS runner
WORKDIR /app
ENV NODE_ENV production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
      `;
      fs.writeFileSync(
        path.join(tempDir, "Dockerfile"),
        dockerfileContent.trim()
      );

      try {
        execSync(`docker rm -f project-${projectId}`, { stdio: "ignore" });
      } catch (e) {}

      sendSystemLog("🔨 Building Docker Image...");

      await runCommandWithLogs(
        `docker build --network host -t image-${projectId} .`,
        [],
        tempDir,
        deploymentId
      );

      const dynamicPort = await getAvailablePort();
      const runCommand = `docker run -d --name project-${projectId} --restart unless-stopped -p ${dynamicPort}:3000 ${dockerEnvString} image-${projectId}`;
      await runCommandWithLogs(runCommand, [], tempDir, deploymentId);

      activeNextDeployments.set(projectId, dynamicPort);

      sendSystemLog(
        `✅ Container running successfully on internal port ${dynamicPort}`
      );
      await updateStatus(deploymentId, "SUCCESS");
    } else {
      sendSystemLog(
        "Booting isolated Docker container for static compilation..."
      );
      const dockerVolumePath = tempDir.replace(/\\/g, "/");

      const buildScript = `
mkdir -p /build_env;
cp -a /app/. /build_env/;
cd /build_env;
if [ -f package.json ]; then
    if [ -f yarn.lock ]; then yarn install && yarn build;
    elif [ -f pnpm-lock.yaml ]; then npm install -g pnpm && pnpm install && pnpm run build;
    elif [ -f package-lock.json ]; then npm ci --no-audit --no-fund --prefer-offline && npm run build;
    else npm install --no-audit --no-fund && npm run build;
    fi;
else
    mkdir -p dist;
    find . -maxdepth 1 ! -name 'dist' ! -name '.' ! -name '..' -exec cp -r {} dist/ \\; ;
fi;
BUILD_EXIT=$?;
if [ -d "dist" ]; then cp -a dist /app/; fi;
if [ -d "build" ]; then cp -a build /app/; fi;
chown -R 1000:1000 /app;
exit $BUILD_EXIT;
`;

      const buildCommand = `docker run --rm --network host -v "${dockerVolumePath}:/app" ${dockerEnvString}node:${nodeVersion}-slim sh -c '${buildScript.replace(
        /\n/g,
        " "
      )}'`;

      await runCommandWithLogs(buildCommand, [], __dirname, deploymentId);

      const distPath = path.join(tempDir, "dist");
      const buildPath = path.join(tempDir, "build");
      const finalOutputDir = fs.existsSync(distPath)
        ? distPath
        : fs.existsSync(buildPath)
        ? buildPath
        : null;

      if (!finalOutputDir)
        throw new Error('Could not find "dist" or "build" folder.');

      await uploadDirectoryToS3(
        finalOutputDir,
        finalOutputDir,
        projectId,
        deploymentId
      );
      await updateStatus(deploymentId, "SUCCESS");
    }
  } catch (error) {
    await updateStatus(deploymentId, "FAILED");
  } finally {
    if (fs.existsSync(tempDir)) {
      try {
        execSync(`sudo rm -rf "${tempDir}"`);
      } catch (cleanErr) {}
    }
  }
}

app.post("/deploy", async (req, res) => {
  const { gitUrl, projectId, envVars, githubToken: appToken } = req.body;
  if (!gitUrl || !projectId)
    return res.status(400).json({ error: "Missing parameters" });

  let realGithubToken = "";
  let userId = null;

  if (appToken) {
    try {
      const decoded = jwt.verify(appToken, process.env.JWT_SECRET);
      realGithubToken = decoded.githubToken;
      userId = decoded.userId;
    } catch (err) {
      return res.status(401).json({ error: "Invalid session" });
    }
  }

  try {
    const existingProject = await pool.query(
      "SELECT user_id FROM deployments WHERE project_id = $1 LIMIT 1",
      [projectId]
    );
    if (
      existingProject.rows.length > 0 &&
      existingProject.rows[0].user_id !== userId
    ) {
      return res.status(403).json({ error: "Project name taken." });
    }

    const result = await pool.query(
      "INSERT INTO deployments (project_id, git_url, env_vars, status, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [projectId, gitUrl, envVars || {}, "QUEUED", userId]
    );
    const deploymentId = result.rows[0].id;

    if (realGithubToken) {
      const match = gitUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
      if (match) {
        try {
          await fetch(
            `https://api.github.com/repos/${match[1]}/${match[2]}/hooks`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${realGithubToken}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Better-Vercel-Engine",
              },
              body: JSON.stringify({
                name: "web",
                active: true,
                events: ["push"],
                config: {
                  url: "http://13.127.96.165/webhook",
                  content_type: "json",
                },
              }),
            }
          );
        } catch (webhookErr) {}
      }
    }

    buildProject(
      gitUrl,
      projectId,
      deploymentId,
      envVars || {},
      realGithubToken
    );
    res
      .status(200)
      .json({
        message: "Queued!",
        deploymentId,
        liveUrl: `https://${projectId}.bettervercel.harsaroop.com`,
      });
  } catch (error) {
    res.status(500).json({ error: "Failed", details: error.message });
  }
});

app.post("/webhook", async (req, res) => {
  const payload = req.body;
  if (payload.ref !== "refs/heads/main" && payload.ref !== "refs/heads/master")
    return res.status(200).send("Ignoring.");

  try {
    const result = await pool.query(
      "SELECT DISTINCT project_id, env_vars, user_id FROM deployments WHERE git_url = $1",
      [payload.repository.clone_url]
    );
    if (result.rows.length === 0)
      return res.status(200).send("Not registered.");

    for (const project of result.rows) {
      const deployResult = await pool.query(
        "INSERT INTO deployments (project_id, git_url, env_vars, status, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [
          project.project_id,
          payload.repository.clone_url,
          project.env_vars,
          "QUEUED",
          project.user_id,
        ]
      );
      buildProject(
        payload.repository.clone_url,
        project.project_id,
        deployResult.rows[0].id,
        project.env_vars,
        ""
      );
    }
    res.status(200).send("Triggered.");
  } catch (error) {
    res.status(500).send("Error");
  }
});

app.get("/projects", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded = jwt.verify(
      authHeader.split(" ")[1],
      process.env.JWT_SECRET
    );
    const result = await pool.query(
      "SELECT * FROM deployments WHERE user_id = $1 ORDER BY created_at DESC",
      [decoded.userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Fetch failed" });
  }
});

app.get("/auth/github", (req, res) => {
  if (!process.env.GITHUB_CLIENT_ID) {
    return res
      .status(500)
      .send(
        "Server Configuration Error: GITHUB_CLIENT_ID is missing from AWS .env"
      );
  }
  res.redirect(
    `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}&scope=repo`
  );
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
          code,
        }),
      }
    );

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token)
      throw new Error("GitHub rejected the verification code.");

    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "User-Agent": "Better-Vercel-Engine",
      },
    });
    const userData = await userResponse.json();

    if (!userData || !userData.id)
      throw new Error("Failed to fetch user data from GitHub.");

    const dbResult = await pool.query(
      `INSERT INTO users (github_id, username, avatar_url) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET username = $2, avatar_url = $3 RETURNING id`,
      [userData.id.toString(), userData.login, userData.avatar_url]
    );

    const appToken = jwt.sign(
      {
        userId: dbResult.rows[0].id,
        githubToken: tokenData.access_token,
        username: userData.login,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.redirect(`${process.env.FRONTEND_URL}?token=${appToken}`);
  } catch (error) {
    console.error("OAuth Catch Block Error:", error);
    res.redirect(
      `${
        process.env.FRONTEND_URL || "http://localhost:5173"
      }?error=oauth_failed`
    );
  }
});

app.get("/github/repos", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded = jwt.verify(
      authHeader.split(" ")[1],
      process.env.JWT_SECRET
    );
    const reposResponse = await fetch(
      "https://api.github.com/user/repos?sort=updated&per_page=50",
      {
        headers: {
          Authorization: `Bearer ${decoded.githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "Better-Vercel-Engine",
        },
      }
    );

    const repos = await reposResponse.json();
    if (!Array.isArray(repos))
      return res.status(400).json({ error: "GitHub API error" });
    res.json(repos);
  } catch (error) {
    res.status(500).json({ error: "Fetch failed" });
  }
});

app.use(async (req, res) => {
  const subdomain = req.hostname.split(".")[0];
  if (subdomain === "localhost" || subdomain === "api")
    return res.status(200).send("Welcome to the Better-Vercel Cloud Engine!");

  if (activeNextDeployments.has(subdomain)) {
    return proxy.web(req, res, {
      target: `http://127.0.0.1:${activeNextDeployments.get(subdomain)}`,
    });
  }

  let filePath = req.path === "/" ? "/index.html" : req.path;
  const s3Url = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/deployments/${subdomain}${filePath}`;

  try {
    const response = await fetch(s3Url);
    if (!response.ok)
      return res
        .status(404)
        .send(`404 - File not found in AWS S3 or Container inactive.`);

    const exactContentType = mime.lookup(filePath) || "text/plain";
    res.setHeader(
      "Content-Type",
      exactContentType === "text/html"
        ? "text/html; charset=utf-8"
        : exactContentType
    );
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.status(500).send("500 - Cloud Proxy Error");
  }
});

httpServer.listen(PORT, () =>
  console.log(`\n🚀 HTTP Engine running on port ${PORT}`)
);
if (httpsServer)
  httpsServer.listen(8443, () =>
    console.log(`🔒 HTTPS Engine running securely on port 8443`)
  );
