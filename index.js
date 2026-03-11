require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const mime = require("mime-types"); // Added for cloud uploads

const app = express();
const PORT = process.env.PORT || 8000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(cors());
app.use(express.json());

const TEMP_DIR = path.join(__dirname, "temp");

// --- THE LOG STREAMING ENGINE ---
function runCommandWithLogs(command, args, cwd, logChannel, deploymentId) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: true });

    const streamOutput = (data) => {
      const text = data.toString().trim();
      if (!text) return;
      console.log(`[${deploymentId}] ${text}`);
      logChannel.send({
        type: "broadcast",
        event: "build-log",
        payload: { message: text },
      });
    };

    child.stdout.on("data", streamOutput);
    child.stderr.on("data", streamOutput);

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });
  });
}

// --- NEW: RECURSIVE CLOUD UPLOADER ---
async function uploadDirectory(localPath, bucketPath, logChannel) {
  const files = fs.readdirSync(localPath);

  for (const file of files) {
    const fullPath = path.join(localPath, file);
    const relativePath = path.posix.join(bucketPath, file); // posix ensures forward slashes in cloud

    if (fs.statSync(fullPath).isDirectory()) {
      await uploadDirectory(fullPath, relativePath, logChannel);
    } else {
      const fileBody = fs.readFileSync(fullPath);
      const contentType = mime.lookup(fullPath) || "application/octet-stream";

      // Stream the upload status to the frontend!
      logChannel.send({
        type: "broadcast",
        event: "build-log",
        payload: { message: `☁️ [System] Uploading ${file}...` },
      });

      const { error } = await supabase.storage
        .from("deployments")
        .upload(relativePath, fileBody, {
          contentType: contentType,
          upsert: true, // Overwrite if the file already exists (for updates)
        });

      if (error) throw new Error(`Upload failed for ${file}: ${error.message}`);
    }
  }
}

// --- 1. THE ASYNC BUILD ENGINE ---
async function buildProject(gitUrl, projectId, deploymentId) {
  const tempDir = path.join(TEMP_DIR, projectId);

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const logChannel = supabase.channel(`logs-${deploymentId}`);

  const sendSystemLog = (msg) => {
    logChannel.send({
      type: "broadcast",
      event: "build-log",
      payload: { message: `👉 [System] ${msg}` },
    });
  };

  try {
    await supabase
      .from("deployments")
      .update({ status: "BUILDING" })
      .eq("id", deploymentId);

    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });

    sendSystemLog("Cloning repository...");
    await runCommandWithLogs(
      "git",
      ["clone", gitUrl, `"${tempDir}"`],
      __dirname,
      logChannel,
      deploymentId
    );

    sendSystemLog("Booting isolated Docker container...");
    const dockerVolumePath = tempDir.replace(/\\/g, "/");
    const buildCommand = `docker run --rm -v "${dockerVolumePath}:/app" -w /app node:18-alpine sh -c "npm install && npm run build"`;
    await runCommandWithLogs(
      buildCommand,
      [],
      __dirname,
      logChannel,
      deploymentId
    );

    sendSystemLog("Locating compiled artifacts...");
    const distPath = path.join(tempDir, "dist");
    const buildPath = path.join(tempDir, "build");

    let finalOutput = "";
    if (fs.existsSync(distPath)) finalOutput = distPath;
    else if (fs.existsSync(buildPath)) finalOutput = buildPath;
    else throw new Error('Could not find "dist" or "build" folder.');

    // WE NO LONGER MOVE FILES LOCALLY. WE SEND THEM TO SPACE.
    sendSystemLog("Connecting to Supabase Cloud Storage...");
    await uploadDirectory(finalOutput, projectId, logChannel);

    await supabase
      .from("deployments")
      .update({ status: "SUCCESS" })
      .eq("id", deploymentId);
    sendSystemLog("Build Complete! Site is live globally.");
  } catch (error) {
    await supabase
      .from("deployments")
      .update({ status: "FAILED" })
      .eq("id", deploymentId);
    sendSystemLog(`Build Failed: ${error.message}`);
  } finally {
    // Destroy the local evidence. We don't need it anymore!
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
    supabase.removeChannel(logChannel);
  }
}

// --- 2. THE QUEUE API ENDPOINT ---
app.post("/deploy", async (req, res) => {
  const { gitUrl, projectId } = req.body;
  if (!gitUrl || !projectId)
    return res.status(400).json({ error: "Missing parameters" });

  try {
    const { data, error } = await supabase
      .from("deployments")
      .insert([{ project_id: projectId, git_url: gitUrl, status: "QUEUED" }])
      .select();

    if (error) throw error;
    const deploymentId = data[0].id;

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

// --- 3. THE REVERSE PROXY TRAFFIC COP ---
app.use(async (req, res) => {
  const subdomain = req.hostname.split(".")[0];
  if (subdomain === "localhost" || subdomain === "api")
    return res.status(200).send("Welcome to the Mini-Vercel Cloud Engine!");

  // Default to index.html if they visit the root URL
  let filePath = req.path;
  if (filePath === "/") filePath = "/index.html";

  // Construct the public URL for the file in your Supabase Bucket
  const supabaseFileUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/deployments/${subdomain}${filePath}`;

  try {
    const response = await fetch(supabaseFileUrl);

    if (!response.ok) {
      return res.status(404).send(`404 - File not found in cloud storage.`);
    }

    // Pass along the exact content type so the browser knows if it's CSS, JS, or HTML
    const contentType = response.headers.get("content-type");
    res.setHeader("Content-Type", contentType);

    // Serve the file data directly to the user
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    res.status(500).send("500 - Cloud Proxy Error");
  }
});

app.listen(PORT, () =>
  console.log(`\n☁️ Mini-Vercel Cloud Engine is running on port ${PORT}!`)
);
