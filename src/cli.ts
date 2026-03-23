#!/usr/bin/env node

import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { buildConfig, normalizeConfig, parseStoredConfigJson } from "./config.js";
import { setGlobalLogLevel, createLogger } from "./logger.js";
import { openDatabase } from "./store/db.js";
import {
  loadAlerts,
  loadInteractions,
  loadCanaryTokens,
  loadPipelineRun,
  savePipelineRun,
  updatePipelineStatus,
} from "./store/checkpoint.js";
import { InProcessBus } from "./bus/in-process.js";
import { createYokaiTaskRegistry } from "./stages/index.js";
import { runOrchestrator } from "./dag/orchestrator.js";
import { generateJsonReport } from "./report/json.js";
import { generateSarifReport } from "./report/sarif.js";
import { loadRequestedOrLatestRunArtifacts } from "./report/persisted.js";
import { scanForNamespaces, extractScopes } from "./discovery/scanner.js";
import { classifyAlert } from "./detection/alert-engine.js";
import { generateTyposquatVariants } from "./typosquat/generator.js";
import { scanForTyposquats } from "./typosquat/monitor.js";
import { generateAllPipelineCanaries } from "./canary/pipeline-tokens.js";
import {
  DEFAULT_PAGERDUTY_EVENTS_V2_URL,
  dispatchWebhook,
  type WebhookConfig,
} from "./integrations/webhooks.js";
import { serve } from "@hono/node-server";
import { createNpmRegistryApp } from "./registries/npm/server.js";
import { createPyPIRegistryApp } from "./registries/pypi/server.js";
import { createMavenRegistryApp } from "./registries/maven/server.js";
import { createGoRegistryApp } from "./registries/go/server.js";
import { createCargoRegistryApp } from "./registries/cargo/server.js";
import { createGitDecoyApp } from "./canary/git-decoy.js";
import { createTransparentProxy } from "./registries/proxy/transparent.js";
import { startContinuousMonitor } from "./typosquat/monitor.js";
import type { DiscoverNamespacesOutput, GenerateCanariesOutput, AlertType, CanaryPackage, CanaryToken } from "./types.js";

const log = createLogger({ stage: "cli" });

const program = new Command()
  .name("yokai")
  .description("Supply chain tripwires. Catch dependency attacks before they land.")
  .version("0.1.0");

// ── yokai scan ──
program
  .command("scan")
  .description("Discover internal package namespaces in a repository")
  .option("--repo <path>", "Repository path to scan", ".")
  .option("--verbose", "Debug logging")
  .action(async (opts: Record<string, unknown>) => {
    if (opts["verbose"]) setGlobalLogLevel("debug");

    const repoPath = resolve(opts["repo"] as string);
    console.log(chalk.bold(`\nScanning ${repoPath} for internal namespaces...\n`));

    const namespaces = scanForNamespaces(repoPath);

    if (namespaces.length === 0) {
      console.log(chalk.yellow("No scoped namespaces found."));
      return;
    }

    console.log(chalk.green(`Found ${namespaces.length} namespace(s):\n`));
    for (const ns of namespaces) {
      const parts = [chalk.cyan(ns.name)];
      if (ns.registry) parts.push(chalk.gray(`registry: ${ns.registry}`));
      parts.push(chalk.gray(`source: ${ns.source}`));
      console.log(`  ${parts.join("  ")}`);
    }

    // Typosquat variants for the first few
    const scopedNames = namespaces
      .filter((ns) => ns.isScoped && !ns.name.endsWith("/*"))
      .slice(0, 3);

    if (scopedNames.length > 0) {
      console.log(chalk.bold(`\nTyposquat variants (first ${scopedNames.length} packages):\n`));
      for (const ns of scopedNames) {
        const variants = generateTyposquatVariants(ns.name, 5);
        if (variants.length > 0) {
          console.log(`  ${chalk.cyan(ns.name)}:`);
          for (const v of variants) {
            console.log(`    ${chalk.red(v.variant)} (${v.technique}, edit distance: ${v.editDistance})`);
          }
        }
      }
    }
  });

// ── yokai deploy ──
program
  .command("deploy")
  .description("Deploy canary registry with discovered namespaces")
  .option("--repo <path>", "Repository path to scan", ".")
  .option("--port <n>", "Registry port", parseInt)
  .option("--host <addr>", "Registry host")
  .option("--callback-url <url>", "Callback base URL for canary tokens")
  .option("-m, --model <spec>", "LLM model for canary generation")
  .option("--mode <mode>", "Deployment mode: standalone, proxy, git-decoy", "standalone")
  .option("--protocol <proto>", "Registry protocol: npm, pypi, maven, go, cargo", "npm")
  .option("--upstream <url>", "Upstream registry URL (proxy mode)")
  .option("--upstream-api <url>", "Upstream API base URL (cargo proxy mode)")
  .option("--upstream-index <url>", "Upstream sparse index base URL (cargo proxy mode)")
  .option("--git-repos <names>", "Comma-separated fake repo names (git-decoy mode)")
  .option("--typosquat-monitor", "Enable continuous typosquat monitoring")
  .option("--baseline-window-ms <n>", "Baseline window before the run is marked ready", parseInt)
  .option("--webhook-slack <url>", "Slack webhook URL for alerts")
  .option("--webhook-teams <url>", "Teams webhook URL for alerts")
  .option("--webhook-pagerduty <url>", "PagerDuty webhook URL for alerts")
  .option("--pagerduty-routing-key <key>", "PagerDuty Events v2 routing key")
  .option("--webhook <url>", "Generic webhook URL for alerts")
  .option("--json <path>", "JSON report output path")
  .option("--sarif <path>", "SARIF report output path")
  .option("--resume <run-id>", "Resume from checkpoint")
  .option("--verbose", "Debug logging")
  .action(async (opts: Record<string, unknown>) => {
    if (opts["verbose"]) setGlobalLogLevel("debug");

    const config = buildConfig({
      mode: opts["mode"] as "standalone" | "proxy" | "git-decoy" | undefined,
      protocol: opts["protocol"] as "npm" | "pypi" | "maven" | "go" | "cargo" | undefined,
      upstreamUrl: opts["upstream"] as string | undefined,
      upstreamApiUrl: opts["upstreamApi"] as string | undefined,
      upstreamIndexUrl: opts["upstreamIndex"] as string | undefined,
      model: opts["model"] as string | undefined,
      port: opts["port"] as number | undefined,
      host: opts["host"] as string | undefined,
      callbackUrl: opts["callbackUrl"] as string | undefined,
      repo: resolve(opts["repo"] as string),
      json: opts["json"] as string | undefined,
      sarif: opts["sarif"] as string | undefined,
      resume: opts["resume"] as string | undefined,
      baselineWindowMs: opts["baselineWindowMs"] as number | undefined,
      verbose: opts["verbose"] as boolean | undefined,
    });

    const runId = config.resumeRunId ?? crypto.randomUUID();
    const db = openDatabase();
    const bus = new InProcessBus();

    // Build webhook configs
    const webhookConfigs: WebhookConfig[] = [];
    if (opts["webhookSlack"]) webhookConfigs.push({ provider: "slack", url: opts["webhookSlack"] as string });
    if (opts["webhookTeams"]) webhookConfigs.push({ provider: "teams", url: opts["webhookTeams"] as string });
    if (opts["webhookPagerduty"] || opts["pagerdutyRoutingKey"]) {
      webhookConfigs.push({
        provider: "pagerduty",
        url: (opts["webhookPagerduty"] as string | undefined) ?? DEFAULT_PAGERDUTY_EVENTS_V2_URL,
        routingKey: opts["pagerdutyRoutingKey"] as string | undefined,
      });
    }
    if (opts["webhook"]) webhookConfigs.push({ provider: "generic", url: opts["webhook"] as string });

    // Subscribe to alert events for live terminal output + webhook dispatch
    bus.subscribe("alert:triggered", async (event) => {
      const payload = (event as {
        payload: {
          alertId: string;
          alertType: AlertType;
          severity: string;
          packageName?: string;
          sourceIp?: string;
        };
      }).payload;
      const severityColor = payload.severity === "critical" ? chalk.bgRed.white
        : payload.severity === "high" ? chalk.red
        : payload.severity === "medium" ? chalk.yellow
        : chalk.gray;

      console.log(`\n${severityColor(`[ALERT ${payload.severity.toUpperCase()}]`)} ${chalk.bold(payload.alertType)}`);
      if (payload.packageName) console.log(`  Package: ${chalk.cyan(payload.packageName)}`);
      if (payload.sourceIp) console.log(`  Source:  ${payload.sourceIp}`);

      // Dispatch to webhooks
      if (webhookConfigs.length > 0) {
        const alerts = loadAlerts(db, runId);
        const latestAlert = alerts.find((a) => a.id === payload.alertId);
        if (latestAlert) {
          for (const wh of webhookConfigs) {
            dispatchWebhook(wh, latestAlert).catch(() => {});
          }
        }
      }
    });

    savePipelineRun(db, runId, JSON.stringify(config));

    const mode = config.mode;
    const protocol = config.protocol;

    console.log(chalk.bold(`\nYokai — Supply Chain Deception Platform`));
    console.log(chalk.gray(`Run ID: ${runId}`));
    console.log(chalk.gray(`Repository: ${config.repoPath}`));
    console.log(chalk.gray(`Registry: ${config.host}:${config.port}`));
    console.log(chalk.gray(`Mode: ${mode} | Protocol: ${protocol}`));
    if (webhookConfigs.length > 0) console.log(chalk.gray(`Webhooks: ${webhookConfigs.map((w) => w.provider).join(", ")}`));
    console.log();

    const registry = createYokaiTaskRegistry();

    try {
      const result = await runOrchestrator({
        runId,
        config,
        bus,
        db,
        registry,
      });

      updatePipelineStatus(db, runId, "complete", result.totalCostUsd);

      // Load data for reports
      const alerts = loadAlerts(db, runId);
      const interactions = loadInteractions(db, runId);
      const tokens = loadCanaryTokens(db, runId);
      const s1 = result.outputs.get("s1-discover-namespaces") as DiscoverNamespacesOutput | undefined;
      const s2 = result.outputs.get("s2-generate-canaries") as GenerateCanariesOutput | undefined;

      if (config.jsonOutput) {
        const jsonPath = resolve(config.jsonOutput);
        const report = generateJsonReport(
          runId, config.repoPath,
          s1?.namespaces ?? [], s2?.packages ?? [],
          tokens, alerts, interactions,
          result.totalCostUsd, result.durationMs,
        );
        writeFileSync(jsonPath, report, "utf-8");
        log.info(`JSON report: ${jsonPath}`);
      }

      if (config.sarifOutput) {
        const sarifPath = resolve(config.sarifOutput);
        const report = generateSarifReport(runId, alerts, config.repoPath);
        writeFileSync(sarifPath, report, "utf-8");
        log.info(`SARIF report: ${sarifPath}`);
      }

      // If mode is proxy or git-decoy, start an additional server with the right protocol
      if (mode === "proxy") {
        const packagesMap = new Map<string, CanaryPackage>();
        const tokensMap = new Map<string, CanaryToken>();
        for (const pkg of s2?.packages ?? []) packagesMap.set(pkg.name, pkg);
        for (const t of s2?.tokens ?? []) tokensMap.set(t.id, t);

        const upstream = resolveProxyUpstreams(config);

        const proxyApp = createTransparentProxy({
          db, bus, runId,
          protocol,
          interceptedPackages: packagesMap,
          tokens: tokensMap,
          upstreamUrl: upstream.upstreamUrl,
          upstreamApiUrl: upstream.upstreamApiUrl,
          upstreamIndexUrl: upstream.upstreamIndexUrl,
          callbackBaseUrl: config.callbackBaseUrl,
        });

        serve({ fetch: proxyApp.fetch, port: config.port, hostname: config.host });
        console.log(chalk.green(`\nProxy deployed: localhost:${config.port} → ${upstream.display}`));
        console.log(chalk.gray(`Intercepting ${packagesMap.size} monitored packages`));
      } else if (mode === "git-decoy") {
        const repoNames = ((opts["gitRepos"] as string) ?? "internal-deploy-scripts,infra-secrets").split(",").map((s) => s.trim());
        const gitApp = createGitDecoyApp({ db, bus, runId, repoNames, callbackBaseUrl: config.callbackBaseUrl });
        serve({ fetch: gitApp.fetch, port: config.port, hostname: config.host });
        console.log(chalk.green(`\nGit decoy deployed: localhost:${config.port}`));
        console.log(chalk.gray(`Serving ${repoNames.length} fake repos: ${repoNames.join(", ")}`));
      } else if (protocol !== "npm") {
        // Start a protocol-specific registry alongside the npm one from S3
        const packagesMap = new Map<string, CanaryPackage>();
        const tokensMap = new Map<string, CanaryToken>();
        for (const pkg of s2?.packages ?? []) packagesMap.set(pkg.name, pkg);
        for (const t of s2?.tokens ?? []) tokensMap.set(t.id, t);

        const extraPort = config.port + 1;
        if (protocol === "pypi") {
          const pypiApp = createPyPIRegistryApp({ db, bus, runId, packages: packagesMap, tokens: tokensMap, callbackBaseUrl: config.callbackBaseUrl });
          serve({ fetch: pypiApp.fetch, port: extraPort, hostname: config.host });
          console.log(chalk.green(`PyPI registry: localhost:${extraPort}`));
        } else if (protocol === "maven") {
          const mavenApp = createMavenRegistryApp({ db, bus, runId, artifacts: packagesMap, tokens: tokensMap, callbackBaseUrl: config.callbackBaseUrl });
          serve({ fetch: mavenApp.fetch, port: extraPort, hostname: config.host });
          console.log(chalk.green(`Maven registry: localhost:${extraPort}`));
        } else if (protocol === "go") {
          const goApp = createGoRegistryApp({ db, bus, runId, modules: packagesMap, tokens: tokensMap, callbackBaseUrl: config.callbackBaseUrl });
          serve({ fetch: goApp.fetch, port: extraPort, hostname: config.host });
          console.log(chalk.green(`Go module proxy: localhost:${extraPort}`));
        } else if (protocol === "cargo") {
          const cargoApp = createCargoRegistryApp({ db, bus, runId, crates: packagesMap, tokens: tokensMap, callbackBaseUrl: config.callbackBaseUrl });
          serve({ fetch: cargoApp.fetch, port: extraPort, hostname: config.host });
          console.log(chalk.green(`Cargo registry: localhost:${extraPort}`));
        }
      }

      // Start continuous typosquat monitor if requested
      if (opts["typosquatMonitor"]) {
        const names = (s1?.namespaces ?? []).filter((ns) => ns.isScoped && !ns.name.endsWith("/*")).map((ns) => ns.name);
        if (names.length > 0) {
          const ac = new AbortController();
          process.on("SIGINT", () => ac.abort());
          startContinuousMonitor({
            packageNames: names,
            model: config.modelExplicitlyConfigured ? config.model : undefined,
            intervalMs: 3_600_000,
            signal: ac.signal,
            onClaim: async (result) => {
              const alert = classifyTyposquatClaim(runId, result);
              const { saveAlert } = await import("./store/checkpoint.js");

              saveAlert(db, alert);
              bus.publish({
                type: "alert:triggered",
                meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId },
                payload: {
                  alertId: alert.id,
                  alertType: alert.alertType,
                  severity: alert.severity,
                  packageName: alert.packageName,
                  sourceIp: alert.sourceIp,
                },
              }).catch(() => {});
            },
          }).catch(() => {});
          console.log(chalk.gray(`Typosquat monitor started (${names.length} packages, 1h interval)`));
        }
      }

      console.log(chalk.green(`\nYokai deployed successfully!`));
      console.log(chalk.bold(`\nRegistry URL: http://localhost:${config.port}`));

      const testHints: Record<string, string> = {
        npm: `  npm install <pkg> --registry http://localhost:${config.port}`,
        pypi: `  pip install <pkg> --index-url http://localhost:${config.port + 1}/simple/`,
        maven: `  mvn dependency:resolve -DremoteRepositories=http://localhost:${config.port + 1}`,
        go: `  GOPROXY=http://localhost:${config.port + 1},direct go get <module>`,
        cargo: `  cargo install <crate> --registry http://localhost:${config.port + 1}`,
      };
      console.log(chalk.gray(`\nTest with:`));
      console.log(chalk.cyan(testHints[protocol] ?? testHints.npm));
      if (mode === "git-decoy") {
        console.log(chalk.cyan(`  git clone http://localhost:${config.port}/<repo>.git`));
      }
      console.log(chalk.gray(`\nPress Ctrl+C to stop.\n`));

      // Keep the process alive for the registry server
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => {
          console.log(chalk.yellow("\nShutting down..."));

          // Generate final report
          const finalAlerts = loadAlerts(db, runId);
          const finalInteractions = loadInteractions(db, runId);

          console.log(chalk.bold(`\nSession Summary:`));
          console.log(`  Alerts:       ${finalAlerts.length}`);
          console.log(`  Interactions: ${finalInteractions.length}`);

          if (finalAlerts.length > 0) {
            console.log(chalk.bold(`\n  Alerts by type:`));
            const byType: Record<string, number> = {};
            for (const a of finalAlerts) {
              byType[a.alertType] = (byType[a.alertType] ?? 0) + 1;
            }
            for (const [type, count] of Object.entries(byType)) {
              console.log(`    ${type}: ${count}`);
            }
          }

          resolve();
        });
      });
    } catch (error) {
      updatePipelineStatus(db, runId, "error");
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Pipeline failed: ${msg}`);
      process.exit(1);
    } finally {
      await bus.close();
      db.close();
    }
  });

// ── yokai monitor ──
program
  .command("monitor")
  .description("Show live alerts from a running Yokai instance")
  .option("--run-id <id>", "Run ID to monitor")
  .option("--verbose", "Debug logging")
  .action(async (opts: Record<string, unknown>) => {
    if (opts["verbose"]) setGlobalLogLevel("debug");

    const db = openDatabase();
    const runId = opts["runId"] as string | undefined;

    const persisted = loadRequestedOrLatestRunArtifacts(db, runId);
    if (!persisted) {
      const message = runId
        ? `Run ${runId} was not found.`
        : "No runs found. Run `yokai deploy` first.";
      console.log(chalk.yellow(message));
      db.close();
      return;
    }

    console.log(chalk.bold(`\nRun: ${persisted.run.runId}`));
    console.log(`Status: ${persisted.run.status}`);
    console.log(`Started: ${persisted.run.startedAt}`);
    if (persisted.run.completedAt) {
      console.log(`Completed: ${persisted.run.completedAt}`);
    }
    console.log();

    console.log(chalk.bold(`Alerts (${persisted.alerts.length}):`));
    for (const alert of persisted.alerts.slice(0, 20)) {
      const color = alert.severity === "critical" ? chalk.red
        : alert.severity === "high" ? chalk.yellow
        : chalk.gray;
      console.log(`  ${color(`[${alert.severity}]`)} ${alert.alertType}: ${alert.title}`);
    }

    console.log(chalk.bold(`\nInteractions (${persisted.interactions.length}):`));
    for (const interaction of persisted.interactions.slice(0, 20)) {
      console.log(`  ${interaction.method} ${interaction.path} from ${interaction.sourceIp} (${interaction.createdAt})`);
    }

    db.close();
  });

// ── yokai report ──
program
  .command("report")
  .description("Generate a report from a completed run")
  .option("--run-id <id>", "Run ID (defaults to latest)")
  .option("--format <fmt>", "Output format: json, sarif", "json")
  .option("-o, --output <path>", "Output file path")
  .option("--verbose", "Debug logging")
  .action(async (opts: Record<string, unknown>) => {
    if (opts["verbose"]) setGlobalLogLevel("debug");

    const db = openDatabase();
    const persisted = loadRequestedOrLatestRunArtifacts(db, opts["runId"] as string | undefined);
    if (!persisted) {
      console.error(opts["runId"] ? `Run ${opts["runId"] as string} was not found.` : "No runs found.");
      db.close();
      process.exit(1);
    }

    const format = opts["format"] as string;

    let report: string;
    if (format === "sarif") {
      report = generateSarifReport(
        persisted.run.runId,
        persisted.alerts,
        persisted.config?.repoPath,
      );
    } else {
      report = generateJsonReport(
        persisted.run.runId,
        persisted.config?.repoPath,
        persisted.namespaces,
        persisted.packages,
        persisted.tokens,
        persisted.alerts,
        persisted.interactions,
        persisted.run.totalCostUsd,
        persisted.durationMs,
      );
    }

    const outputPath = opts["output"] as string | undefined;
    if (outputPath) {
      writeFileSync(resolve(outputPath), report, "utf-8");
      console.log(`Report written to: ${outputPath}`);
    } else {
      process.stdout.write(report);
    }

    db.close();
  });

// ── yokai resume ──
program
  .command("resume <runId>")
  .description("Resume a paused or failed run from checkpoint")
  .option("--port <n>", "Registry port", parseInt)
  .option("--baseline-window-ms <n>", "Override the baseline window", parseInt)
  .option("--verbose", "Debug logging")
  .action(async (runId: string, opts: Record<string, unknown>) => {
    if (opts["verbose"]) setGlobalLogLevel("debug");

    const db = openDatabase();
    const bus = new InProcessBus();
    const registry = createYokaiTaskRegistry();

    const storedRun = loadPipelineRun(db, runId);
    if (!storedRun) {
      console.error(`Run ${runId} was not found.`);
      await bus.close();
      db.close();
      process.exit(1);
    }

    const storedConfig = parseStoredConfigJson(storedRun.configJson);
    if (!storedConfig) {
      console.error(`Run ${runId} has invalid stored configuration and cannot be resumed.`);
      await bus.close();
      db.close();
      process.exit(1);
    }

    const config = normalizeConfig({
      ...storedConfig,
      resumeRunId: runId,
      port: (opts["port"] as number | undefined) ?? storedConfig.port,
      baselineWindowMs: (opts["baselineWindowMs"] as number | undefined) ?? storedConfig.baselineWindowMs,
      verbose: storedConfig.verbose || opts["verbose"] === true,
    });

    console.log(chalk.bold(`Resuming run: ${runId}\n`));

    try {
      const result = await runOrchestrator({
        runId,
        config,
        bus,
        db,
        registry,
      });

      updatePipelineStatus(db, runId, "complete", result.totalCostUsd);
      console.log(chalk.green(`\nRun ${runId} resumed and complete.`));
    } catch (error) {
      updatePipelineStatus(db, runId, "error");
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Resume failed: ${msg}`);
      process.exit(1);
    } finally {
      await bus.close();
      db.close();
    }
  });

// ── yokai typosquat ──
program
  .command("typosquat")
  .description("Scan public registries for typosquat claims of your packages")
  .option("--repo <path>", "Repository path to scan for package names", ".")
  .option("-m, --model <spec>", "LLM model for typosquat generation")
  .option("--max-variants <n>", "Max variants per package", parseInt)
  .option("--verbose", "Debug logging")
  .action(async (opts: Record<string, unknown>) => {
    if (opts["verbose"]) setGlobalLogLevel("debug");

    const repoPath = resolve(opts["repo"] as string);
    const maxVariants = (opts["maxVariants"] as number) ?? 20;
    const model = opts["model"] as string | undefined;

    console.log(chalk.bold(`\nScanning for typosquat claims...\n`));

    const namespaces = scanForNamespaces(repoPath);
    const scopedNames = namespaces
      .filter((ns) => ns.isScoped && !ns.name.endsWith("/*"))
      .map((ns) => ns.name);

    if (scopedNames.length === 0) {
      console.log(chalk.yellow("No scoped packages found to monitor."));
      return;
    }

    console.log(`Checking typosquat variants for ${scopedNames.length} packages...`);

    const results = await scanForTyposquats({
      packageNames: scopedNames,
      maxVariantsPerPackage: maxVariants,
      model,
      onClaim: async (result) => {
        console.log(chalk.red(`  CLAIMED: ${result.variant}`) +
          chalk.gray(` (variant of ${result.packageName}, technique: ${result.technique}, `) +
          chalk.gray(`published by: ${result.registryStatus.maintainers?.join(", ") ?? "unknown"})`));
      },
    });

    console.log(chalk.bold(`\nResults: ${results.length} claimed typosquat variant(s) found`));
    if (results.length === 0) {
      console.log(chalk.green("No typosquat claims detected."));
    }
  });

// ── yokai canary-configs ──
program
  .command("canary-configs")
  .description("Generate CI/CD canary config files (.npmrc, pip.conf, settings.xml, etc.)")
  .option("--registry-url <url>", "Canary registry URL", "http://localhost:4873")
  .option("--scope <scope>", "Package scope (e.g., @myorg)")
  .option("--auth-token <token>", "Auth token to embed")
  .option("-o, --output-dir <dir>", "Directory to write config files to")
  .option("--verbose", "Debug logging")
  .action(async (opts: Record<string, unknown>) => {
    if (opts["verbose"]) setGlobalLogLevel("debug");

    const registryUrl = opts["registryUrl"] as string;
    const scope = opts["scope"] as string | undefined;
    const authToken = opts["authToken"] as string | undefined;
    const outputDir = opts["outputDir"] as string | undefined;

    console.log(chalk.bold(`\nGenerating CI/CD canary configs\n`));
    console.log(`Registry: ${registryUrl}`);
    if (scope) console.log(`Scope: ${scope}`);

    const configs = generateAllPipelineCanaries({ registryUrl, scope, authToken });

    if (outputDir) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const absDir = resolve(outputDir);
      mkdirSync(absDir, { recursive: true });

      for (const [filename, content] of Object.entries(configs)) {
        if (filename === "GOPROXY") {
          writeFileSync(resolve(absDir, "goproxy.env"), `GOPROXY=${content}\n`, "utf-8");
          console.log(`  ${chalk.green("wrote")} ${resolve(absDir, "goproxy.env")}`);
        } else {
          writeFileSync(resolve(absDir, filename), content, "utf-8");
          console.log(`  ${chalk.green("wrote")} ${resolve(absDir, filename)}`);
        }
      }
    } else {
      for (const [filename, content] of Object.entries(configs)) {
        console.log(chalk.cyan(`\n── ${filename} ──`));
        console.log(content);
      }
    }
  });

program.parse();

function classifyTyposquatClaim(
  runId: string,
  result: Awaited<ReturnType<typeof scanForTyposquats>>[number],
) {
  return classifyAlert({
    runId,
    packageName: result.variant,
    method: "GET",
    path: "/_yokai/typosquat-monitor",
    metadata: {
      action: "typosquat-claim",
      originalPackageName: result.packageName,
      technique: result.technique,
      publishedAt: result.registryStatus.publishedAt,
      maintainers: result.registryStatus.maintainers,
    },
  });
}

function resolveProxyUpstreams(config: ReturnType<typeof normalizeConfig>): {
  upstreamUrl: string;
  upstreamApiUrl?: string;
  upstreamIndexUrl?: string;
  display: string;
} {
  if (config.protocol === "cargo") {
    const upstreamApiUrl = config.upstreamApiUrl ?? config.upstreamUrl ?? "https://crates.io";
    const upstreamIndexUrl = config.upstreamIndexUrl ?? "https://index.crates.io";
    return {
      upstreamUrl: upstreamApiUrl,
      upstreamApiUrl,
      upstreamIndexUrl,
      display: `${upstreamApiUrl} | ${upstreamIndexUrl}`,
    };
  }

  const defaults: Record<string, string> = {
    npm: "https://registry.npmjs.org",
    pypi: "https://pypi.org",
    maven: "https://repo1.maven.org/maven2/",
    go: "https://proxy.golang.org",
  };
  const upstreamUrl = config.upstreamUrl ?? defaults[config.protocol] ?? defaults.npm;
  return { upstreamUrl, display: upstreamUrl };
}
