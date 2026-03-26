# 🚀 Better-Vercel: Custom CI/CD Engine & Cloud PaaS

🔴 **Live Platform:** [https://bettervercel.harsaroop.com](https://bettervercel.harsaroop.com)

A high-performance, automated deployment pipeline and Platform-as-a-Service (PaaS) built entirely from scratch. This project replicates the core infrastructure of platforms like Vercel, orchestrating isolated Docker builds, managing stateful Next.js containers, and operating a custom Layer-7 reverse proxy for dynamic wildcard DNS routing.

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Docker](https://img.shields.io/badge/Docker-2CA5E0?style=for-the-badge&logo=docker&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-232F3E?style=for-the-badge&logo=amazon-aws&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=for-the-badge&logo=socketdotio&logoColor=white)
![Let's Encrypt](https://img.shields.io/badge/Let's_Encrypt-003A70?style=for-the-badge&logo=lets-encrypt&logoColor=white)

---

## ✨ Core Architecture & Features

- **Custom Layer-7 Reverse Proxy:** Completely bypassed standard Nginx setups by building a native Node.js reverse proxy (`http-proxy`). It dynamically reads the `Host` headers of incoming traffic and routes packets either to AWS S3 (for static sites) or directly to internally managed Docker container ports (for SSR apps).
- **Dual Deployment Pipelines:** The engine intelligently parses user `package.json` files:
  - **Static/SPA (React/Vite):** Boots an ephemeral container, compiles the code natively, pushes the `/dist` artifacts to AWS S3, and safely kills the container.
  - **Stateful SSR (Next.js):** Generates a multi-stage `Dockerfile` on the fly, builds the image, and provisions a persistent, auto-restarting Docker container mapped to a dynamically assigned host port.
- **Zero-Downtime CI/CD:** Cryptographically secured GitHub Webhook integration listens for `push` events, automatically fetching and rebuilding projects in the background.
- **Real-Time Telemetry:** Streams standard output from isolated Docker build environments directly to the React frontend dashboard via **WebSockets**.
- **Unified Wildcard SSL:** Automated Let's Encrypt / Certbot integration securing both the root domain and all user-generated `.bettervercel` subdomains.

---

## 🛡️ Enterprise-Grade Security Architecture

Because this platform executes untrusted third-party code, the backend was hardened against critical OWASP vulnerabilities:

- **Host RCE & Command Injection Prevention:** Eradicated `shell: true` from system processes and utilized Node's native `fs` methods to safely orchestrate file destruction and container management without bash evaluation.
- **Path Traversal Sandboxing:** Implemented strict `path.resolve()` boundary mathematical checks to guarantee user-defined root directories cannot escape the `/temp` execution volume to access the EC2 host filesystem.
- **Symlink Data Exfiltration Blocks:** Engineered an `fs.lstatSync().isSymbolicLink()` trap inside the S3 upload recursive loop to prevent malicious Docker pre-build scripts from creating shortcuts to host files (e.g., `/etc/shadow`) and leaking them to public buckets.
- **Cryptographic Webhook Verification:** Prevents CI/CD spoofing and DDoS attacks by validating incoming GitHub payloads using `crypto.timingSafeEqual` and HMAC SHA-256 signatures.
- **OAuth Token Masking:** Implemented regex-based output streaming filters to ensure GitHub access tokens are heavily redacted before being piped through WebSockets to the client UI.

---

## 🧠 Hardware Optimization (1GB AWS `t2.micro`)

Building a deployment engine on a heavily constrained Free-Tier instance required severe system-level optimizations to prevent kernel panics during heavy compilations:

### 1. Bypassing the Linux OOM (Out-Of-Memory) Sniper

**The Problem:** Running `npm install` for modern React apps caused massive memory spikes, triggering the Linux Kernel's OOM killer to silently assassinate the build process.
**The Solution:** - Provisioned **2GB of SSD Swap Space** to act as virtual RAM.

- Implemented strict hard limits on all Docker containers (`--memory="512m" --cpus="0.8"`), forcing Node's V8 engine to trigger aggressive garbage collection instead of crashing the AWS host.

### 2. The Isolated DNS Resolution Fix

**The Problem:** Docker's default virtual network bridge frequently timed out when fetching NPM dependencies due to AWS local DNS constraints. (The initial hack of using `--network host` introduced severe SSRF vulnerabilities by exposing the AWS Metadata endpoint).
**The Solution:** Secured the network isolation boundary by explicitly configuring the EC2 Docker Daemon's `daemon.json` to route through public DNS resolvers (`8.8.8.8`), allowing containers to build securely inside their walled bridge networks without host exposure.

### 3. File System Locking & Storage Orchestration

**The Problem:** Mounting an external volume directly into Docker for the build step caused translation-layer bottlenecks and file-locking errors (`EACCES` / `ENOENT`) when NPM attempted to write thousands of `node_modules`.
**The Solution:** Re-architected the build script to copy source code into a native, internal container directory (`/build_env`). The heavy I/O operations execute natively, and only the final compiled artifacts are slipped back across the volume bridge to the host server.

---

## 🗺️ Future Roadmap

- **Infrastructure Isolation:** Migration of the EC2 instance into a private AWS VPC, sitting behind an Application Load Balancer (ALB).
- **Daemon Hardening:** Implementation of Rootless Docker to further restrict the blast radius of potential container breakouts.
- **Egress Filtering:** Applying strict `iptables` or NAT Gateway routing to restrict outbound container internet access to explicitly allowed domains (NPM, GitHub) to prevent platform abuse via crypto-mining.

---

## 💻 Local Setup & Installation

**Prerequisites:** Node.js, Docker, PM2, PostgreSQL, and an AWS S3 Bucket.

1. Clone the repository: `git clone https://github.com/harsaroop-dev/better-vercel`
2. Install dependencies: `npm install`
3. Configure the `.env` file:
   ```env
   DATABASE_URL=postgres://user:pass@host:5432/db
   AWS_ACCESS_KEY_ID=your_key
   AWS_SECRET_ACCESS_KEY=your_secret
   AWS_REGION=ap-south-1
   AWS_S3_BUCKET_NAME=your_bucket
   GITHUB_CLIENT_ID=your_oauth_id
   GITHUB_CLIENT_SECRET=your_oauth_secret
   GITHUB_WEBHOOK_SECRET=your_crypto_secret
   JWT_SECRET=your_jwt_secret
   FRONTEND_URL=http://localhost:5173
   ```
4. Start the engine: `node index.js`

## 👨‍💻 Author

**Harsaroop Singh Sarao**
