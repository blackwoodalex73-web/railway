import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "25mb" }));

const PORT = Number(process.env.PORT || 3000);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY;

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !MCP_ACCESS_KEY) {
  console.error("Missing required environment variables. See .env.example");
  process.exit(1);
}

const GH_API = "https://api.github.com";
const GH_VERSION = "2022-11-28";

async function gh(path, options = {}) {
  const response = await fetch(`${GH_API}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": GH_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.message || response.statusText;
    throw new Error(`GitHub API ${response.status}: ${detail}`);
  }
  return body;
}

function repoPath(path = "") {
  const clean = String(path).replace(/^\/+/, "");
  return `/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}${clean ? `/contents/${clean.split("/").map(encodeURIComponent).join("/")}` : "/contents"}`;
}

function makeServer() {
  const server = new McpServer({ name: "railway-github-uploader", version: "1.0.0" });

  server.registerTool("github_repo_info", {
    title: "Get GitHub repository information",
    description: "Check the configured GitHub repository and current default branch.",
    inputSchema: {}
  }, async () => {
    const repo = await gh(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}`);
    return { content: [{ type: "text", text: JSON.stringify({
      full_name: repo.full_name,
      private: repo.private,
      default_branch: repo.default_branch,
      html_url: repo.html_url
    }, null, 2) }] };
  });

  server.registerTool("github_list_files", {
    title: "List files in GitHub repository",
    description: "List files and directories at a path in the configured repository.",
    inputSchema: { path: z.string().optional().default("") }
  }, async ({ path }) => {
    const data = await gh(repoPath(path));
    const items = Array.isArray(data) ? data.map(x => ({ name: x.name, path: x.path, type: x.type, size: x.size })) : [{ name: data.name, path: data.path, type: data.type, size: data.size }];
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
  });

  server.registerTool("github_read_file", {
    title: "Read a file from GitHub",
    description: "Read a UTF-8 text file from the configured GitHub repository.",
    inputSchema: { path: z.string().min(1) }
  }, async ({ path }) => {
    const data = await gh(repoPath(path));
    if (Array.isArray(data) || data.type !== "file") throw new Error("Path is not a file.");
    const content = Buffer.from(data.content || "", "base64").toString("utf8");
    return { content: [{ type: "text", text: content }] };
  });

  server.registerTool("github_push_files", {
    title: "Upload or update multiple files in GitHub",
    description: "Create or update multiple repository files in one commit. Use relative file paths and UTF-8 text content. Existing files are replaced. This writes directly to the configured branch.",
    inputSchema: {
      commit_message: z.string().min(1).default("Upload project files"),
      files: z.array(z.object({
        path: z.string().min(1),
        content: z.string()
      })).min(1).max(100)
    }
  }, async ({ commit_message, files }) => {
    const seen = new Set();
    for (const file of files) {
      const p = file.path.replace(/^\/+/, "");
      if (!p || p.split("/").some(part => part === "..") || p.startsWith(".git/")) {
        throw new Error(`Unsafe file path: ${file.path}`);
      }
      if (seen.has(p)) throw new Error(`Duplicate file path: ${p}`);
      seen.add(p);
    }

    const repo = await gh(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}`);
    const branch = GITHUB_BRANCH || repo.default_branch || "main";
    let parentCommit = null;
    let baseTree = null;

    try {
      const ref = await gh(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/git/ref/heads/${encodeURIComponent(branch)}`);
      parentCommit = ref.object.sha;
      const commit = await gh(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/git/commits/${parentCommit}`);
      baseTree = commit.tree.sha;
    } catch (error) {
      if (!String(error.message).includes("404")) throw error;
    }

    const treeItems = [];
    for (const file of files) {
      const blob = await gh(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: file.content, encoding: "utf-8" })
      });
      treeItems.push({ path: file.path.replace(/^\/+/, ""), mode: "100644", type: "blob", sha: blob.sha });
    }

    const treeBody = { tree: treeItems };
    if (baseTree) treeBody.base_tree = baseTree;
    const tree = await gh(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/git/trees`, {
      method: "POST",
      body: JSON.stringify(treeBody)
    });

    const commitBody = { message: commit_message, tree: tree.sha };
    if (parentCommit) commitBody.parents = [parentCommit];
    const commit = await gh(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/git/commits`, {
      method: "POST",
      body: JSON.stringify(commitBody)
    });

    if (parentCommit) {
      await gh(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false })
      });
    } else {
      await gh(`/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha })
      });
    }

    return { content: [{ type: "text", text: JSON.stringify({
      success: true,
      repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      branch,
      commit: commit.sha,
      files_uploaded: treeItems.map(x => x.path),
      url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/commit/${commit.sha}`
    }, null, 2) }] };
  });

  return server;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "github-railway-uploader" }));

app.all("/mcp", async (req, res) => {
  const supplied = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(MCP_ACCESS_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const mcp = makeServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  res.on("close", () => { transport.close(); mcp.close(); });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GitHub uploader MCP listening on port ${PORT}`);
});