require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const util = require("util");
const execAsync = util.promisify(require("child_process").exec);
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 8000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(cors());
app.use(express.json());

const BASE_DIR = path.join(__dirname, "deployments");
const TEMP_DIR = path.join(__dirname, "temp");

async function buildProject(gitUrl, projectId, deploymentId) {
  const outDir = path.join(BASE_DIR, projectId);
  const tempDir = path.join(TEMP_DIR, projectId);

  console.log(`\n🚀 [${projectId}] Picked up from queue! Starting build...`);

  try {
    await supabase
      .from("deployments")
      .update({ status: "BUILDING" })
      .eq("id", deploymentId);

    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });

    console.log(`📥 [${projectId}] Cloning repository...`);
    await execAsync(`git clone ${gitUrl} "${tempDir}"`);

    console.log(`🐳 [${projectId}] Compiling inside Docker container...`);
    const buildCommand = `docker run --rm -v "${tempDir}:/app" -w /app node:18-alpine sh -c "npm install && npm run build"`;
    await execAsync(buildCommand);

    console.log(`📂 [${projectId}] Locating compiled artifacts...`);
    const distPath = path.join(tempDir, "dist");
    const buildPath = path.join(tempDir, "build");

    let finalOutput = "";
    if (fs.existsSync(distPath)) finalOutput = distPath;
    else if (fs.existsSync(buildPath)) finalOutput = buildPath;
    else throw new Error('Could not find "dist" or "build" folder.');

    console.log(`🚚 [${projectId}] Moving to live deployment folder...`);
    if (fs.existsSync(outDir))
      fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.cpSync(finalOutput, outDir, { recursive: true });

    await supabase
      .from("deployments")
      .update({ status: "SUCCESS" })
      .eq("id", deploymentId);
    console.log(
      `\n✅ [${projectId}] Build Complete! Live at: http://${projectId}.lvh.me:${PORT}`
    );
  } catch (error) {
    await supabase
      .from("deployments")
      .update({ status: "FAILED" })
      .eq("id", deploymentId);
    console.error(`\n❌ [${projectId}] Build Failed!`, error.message);
  } finally {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

app.post("/deploy", async (req, res) => {
  const { gitUrl, projectId } = req.body;

  if (!gitUrl || !projectId) {
    return res
      .status(400)
      .json({ error: "Please provide both gitUrl and projectId" });
  }

  try {
    const { data, error } = await supabase
      .from("deployments")
      .insert([{ project_id: projectId, git_url: gitUrl, status: "QUEUED" }])
      .select();

    if (error) throw error;

    const deploymentId = data[0].id;

    buildProject(gitUrl, projectId, deploymentId);

    res.status(200).json({
      message: "Project queued for deployment!",
      deploymentId: deploymentId,
      liveUrl: `http://${projectId}.lvh.me:${PORT}`,
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to queue deployment", details: error.message });
  }
});

app.use((req, res) => {
  const hostname = req.hostname;
  const subdomain = hostname.split(".")[0];

  if (subdomain === "localhost" || subdomain === "api") {
    return res.status(200).send("Welcome to the Mini-Vercel Engine!");
  }

  const projectPath = path.join(BASE_DIR, subdomain);

  if (fs.existsSync(projectPath)) {
    return express.static(projectPath)(req, res, () => {
      res.status(404).send("404 - File not found in project directory.");
    });
  } else {
    return res
      .status(404)
      .send(`404 - Project "${subdomain}" not found on this server.`);
  }
});

app.listen(PORT, () => {
  console.log(`\n🟢 Mini-Vercel Engine is running on port ${PORT}!`);
});
