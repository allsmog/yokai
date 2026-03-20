# Yokai (妖怪) — Supply Chain Deception Platform

> Supply chain tripwires. Catch dependency attacks before they land.

Yokai deploys deception infrastructure at the package registry layer — fake registries, canary packages, and dependency traps that detect attackers probing your software supply chain in real time.

**Socket/Phylum/Snyk = alarm systems. Yokai = tripwires and landmines.**

## Quick Start

```bash
# Install
pnpm install
pnpm build

# Discover internal namespaces
yokai scan --repo ./your-project

# Deploy canary registry
yokai deploy --repo ./your-project --port 4873

# Test it — this triggers an alert
npm install @yourorg/internal-pkg --registry http://localhost:4873

# Generate SARIF report
yokai report --format sarif -o results.sarif
```

## What It Does

### Detection Scenarios

| Attack | Detection | MITRE ATT&CK |
|--------|-----------|---------------|
| Dependency confusion (`@yourco/internal-utils` v99 on public npm) | Namespace monitor + proxy intercept | T1195.002 |
| Typosquatting (`loadash` instead of `lodash`) | Edit-distance variant monitoring + LLM assessment | T1195.002 |
| Internal namespace probing (`npm info @yourco/*`) | Canary registry returns synthetic metadata, alerts on external IPs | T1592 |
| Stolen credentials used to publish | Canary publish endpoint detects unauthorized PUT | T1078 |
| CI/CD resolving from unexpected registry | Proxy baseline deviation detection | T1195.001 |
| `.npmrc` tampering in build pipeline | Canary registry URL accessed = config was read | T1195.001 |

### Registry Protocols

| Protocol | Endpoints |
|----------|-----------|
| **npm** | `GET /:pkg` metadata, `GET /:pkg/-/:tarball` download, `PUT /:pkg` publish detect |
| **PyPI** | `GET /simple/`, `GET /simple/<pkg>/`, `GET /packages/<file>`, `POST /` upload detect |
| **Maven** | `GET maven-metadata.xml`, `GET .jar/.pom` download, `PUT` deploy detect |
| **Go** | `GET /@v/list`, `GET /@v/<ver>.info`, `GET /@v/<ver>.mod`, `GET /@v/<ver>.zip` |
| **Cargo** | `GET /api/v1/crates/<name>`, `GET /<name>/<ver>/download`, `PUT /api/v1/crates/new` |
| **Git** | Smart HTTP refs, `git-upload-pack` (clone/fetch), `git-receive-pack` (push detect) |

### Deployment Modes

| Mode | Use Case |
|------|----------|
| **Standalone** | Run canary registries directly; any resolution triggers alerts |
| **Proxy** | Transparent proxy between CI/CD and upstream; intercepts monitored names |
| **Git Decoy** | Fake Git endpoints that log all clone/fetch/push attempts |

## CLI Reference

```
yokai scan [--repo <path>]
    Discover internal package namespaces from package.json, .npmrc, workspaces

yokai deploy [--repo <path>] [--port 4873] [--mode standalone|proxy|git-decoy]
             [--protocol npm|pypi|maven|go|cargo] [--upstream <url>]
             [--git-repos <names>] [--typosquat-monitor]
             [--webhook-slack <url>] [--webhook-teams <url>]
             [--webhook-pagerduty <url>] [--webhook <url>]
             [--json <path>] [--sarif <path>]
    Deploy canary infrastructure with live alerting

yokai monitor [--run-id <id>]
    Show alerts and interactions from the latest or specified run

yokai report [--run-id <id>] [--format json|sarif] [-o <path>]
    Generate a report from a completed run

yokai resume <runId> [--port <n>]
    Resume a paused or failed run from checkpoint

yokai typosquat [--repo <path>] [--max-variants <n>]
    Scan public registries for typosquat claims of your packages

yokai canary-configs [--registry-url <url>] [--scope <scope>] [-o <dir>]
    Generate CI/CD canary config files (.npmrc, pip.conf, settings.xml, .yarnrc.yml, GOPROXY)
```

## Docker

```bash
# Quick start with Docker Compose
YOKAI_REPO_PATH=./your-project docker compose up

# Or build directly
docker build -t yokai .
docker run -p 4873:4873 -v ./your-project:/repo:ro yokai deploy --repo /repo
```

## Architecture

```
S1 Discover Namespaces → S2 Generate Canaries → S3 Deploy Registries → S4 Configure Monitoring → S5 Baseline Traffic
```

- **Runtime**: Node.js / TypeScript
- **HTTP**: Hono (Node + Cloudflare Workers compatible)
- **LLM**: pi-ai (vendor-agnostic, used for canary generation + typosquat analysis)
- **Database**: SQLite with WAL mode (checkpoint/resume)
- **Event Bus**: InProcessBus with typed EventEnvelopes

### Alert Pipeline

```
Registry Request → Interaction Log → Alert Classification → Severity Scoring → MITRE Mapping → SQLite + Terminal + Webhooks
```

All alerts include:
- Alert type and severity (critical/high/medium/low)
- MITRE ATT&CK technique ID and tactic
- Source IP and User-Agent
- Full request metadata

## Webhook Integrations

Alerts can be dispatched in real time to:

- **Slack** — Block Kit formatted messages with severity badges
- **Microsoft Teams** — MessageCard with color-coded severity
- **PagerDuty** — Events API v2 with proper severity mapping
- **Generic** — JSON payload with optional HMAC-SHA256 signature

```bash
yokai deploy --repo . --webhook-slack https://hooks.slack.com/services/... \
                       --webhook-pagerduty https://events.pagerduty.com/v2/enqueue
```

## GitHub Actions

```yaml
jobs:
  supply-chain-audit:
    uses: allsmog/yokai/.github/workflows/yokai-action.yml@main
    with:
      repo-path: "."
      sarif-output: "yokai-results.sarif"
```

## License

MIT
