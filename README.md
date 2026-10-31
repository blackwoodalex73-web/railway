# GitHub Railway Uploader (MCP)

A small private MCP server that lets Claude list, read, and upload files to one configured GitHub repository. It uses a fine-grained GitHub token stored only in Railway environment variables.

## Tools exposed to Claude

- `github_repo_info` — verify target repository and default branch.
- `github_list_files` — list files at a path.
- `github_read_file` — read a UTF-8 text file.
- `github_push_files` — create/update up to 100 files in one Git commit, including the first commit in an empty repository.

## Deploy on Railway

1. Create a new Railway project and deploy this folder from a GitHub repository.
2. In Railway → service → Variables, set:
   - `GITHUB_TOKEN`: your fine-grained GitHub token.
   - `GITHUB_OWNER`: `blackwoodalex73-web`
   - `GITHUB_REPO`: `managerstage`
   - `GITHUB_BRANCH`: `main`
   - `MCP_ACCESS_KEY`: a long random secret (at least 32 characters).
3. Railway will deploy the service. Copy its public domain, for example `https://your-service.up.railway.app`.
4. Test `https://your-service.up.railway.app/health`; it should return `{"ok":true,...}`.

## Connect from Claude

Add a custom connector with URL:

`https://YOUR-RAILWAY-DOMAIN/mcp`

Choose **No sign-in**. Add a request header:

- Name: `Authorization`
- Value: `Bearer YOUR_MCP_ACCESS_KEY`

Do not put the GitHub token in Claude. The GitHub token stays in Railway; Claude only receives the separate MCP access key.

If Claude's connector UI does not allow custom headers when "No sign-in" is selected, use the connector's supported custom-header option or a client that supports bearer headers. Do not expose the GitHub token in a public URL.

## Fine-grained GitHub token

Create a fine-grained token restricted to only the target repository.

Required repository permission:
- `Contents: Read and write`

For files under `.github/workflows`, also grant:
- `Workflows: Read and write`

The token owner must have write access to the target repository. GitHub's Contents permission is required for repository content changes. See:
https://docs.github.com/en/rest/repos/contents

## Ask Claude to upload

Example prompt:

"Use `github_push_files` to upload these files to `blackwoodalex73-web/managerstage` on `main`. Commit message: `Upload Stage bot`. Upload every file preserving its relative path. Do not include `.env`, tokens, passwords, or other secrets."

## Security

- Never commit `.env` or the GitHub token.
- Keep `MCP_ACCESS_KEY` private.
- If either token is exposed, revoke it and create a new one.
- This server is intentionally restricted to one repository configured in Railway.
