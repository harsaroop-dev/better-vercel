const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function buildProject(gitUrl, projectId) {
  const outDir = path.join(__dirname, "deployments", projectId);
  const tempDir = path.join(__dirname, "temp", projectId);

  console.log(`\n🚀 Starting build process for project: ${projectId}`);
  console.log(`🔗 Repository: ${gitUrl}`);

  try {
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });

    console.log("\n📥 [1/4] Cloning repository...");
    execSync(`git clone ${gitUrl} "${tempDir}"`, { stdio: "inherit" });

    console.log("\n🐳 [2/4] Compiling inside Docker container...");
    const buildCommand = `docker run --rm -v "${tempDir}:/app" -w /app node:18-alpine sh -c "npm install && npm run build"`;
    execSync(buildCommand, { stdio: "inherit" });

    console.log("\n📂 [3/4] Locating compiled artifacts...");
    const distPath = path.join(tempDir, "dist");
    const buildPath = path.join(tempDir, "build");

    let finalOutput = "";
    if (fs.existsSync(distPath)) finalOutput = distPath;
    else if (fs.existsSync(buildPath)) finalOutput = buildPath;
    else
      throw new Error(
        'Could not find "dist" or "build" folder. Is this a React/Vite project?'
      );

    console.log("\n🚚 [4/4] Moving to live deployment folder...");
    if (fs.existsSync(outDir))
      fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    fs.cpSync(finalOutput, outDir, { recursive: true });

    console.log(`\n✅ Build Complete!`);
    console.log(`🌐 Your site is live at: http://${projectId}.lvh.me:8000\n`);
  } catch (error) {
    console.error("\n❌ Build Failed!", error.message);
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

const testRepo = "https://github.com/vitejs/vite-plugin-react-swc.git";

const simpleReactRepo = "https://github.com/bradtraversy/react-crash-2024.git";

buildProject(simpleReactRepo, "my-react-app");
