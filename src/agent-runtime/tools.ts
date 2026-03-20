import { execFile } from "node:child_process";
import { globSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Type, type Tool } from "@mariozechner/pi-ai";
import { toErrorMessage } from "../utils.js";

const execFileAsync = promisify(execFile);
const DEFAULT_BASH_TIMEOUT = 120_000;
const MAX_BASH_TIMEOUT = 300_000;
const BASH_MAX_BUFFER = 64 * 1024 * 1024;

const DEFAULT_READ_LIMIT = 200;
const DEFAULT_GLOB_LIMIT = 200;
const DEFAULT_GREP_LIMIT = 200;

const ReadParameters = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "File path to read" })),
    file_path: Type.Optional(Type.String({ description: "File path to read" })),
    filePath: Type.Optional(Type.String({ description: "File path to read" })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "0-based line offset" })),
    start_line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based starting line" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Lines to return" })),
  },
  { additionalProperties: true },
);

const GlobParameters = Type.Object(
  {
    pattern: Type.String({ description: "Glob pattern (e.g. src/**/*.ts)" }),
    path: Type.Optional(Type.String({ description: "Directory to search from" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
  },
  { additionalProperties: true },
);

const GrepParameters = Type.Object(
  {
    pattern: Type.String({ description: "Regex pattern" }),
    path: Type.Optional(Type.String({ description: "Directory to search from" })),
    glob: Type.Optional(Type.String({ description: "File glob filter", default: "**/*" })),
    case_sensitive: Type.Optional(Type.Boolean()),
    literal: Type.Optional(Type.Boolean()),
    max_matches: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  },
  { additionalProperties: true },
);

const BashParameters = Type.Object(
  {
    command: Type.String({ description: "Shell command to execute" }),
    timeout: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000, description: "Timeout in ms" })),
  },
  { additionalProperties: true },
);

export const PI_AI_TOOL_DEFINITIONS: Tool[] = [
  { name: "Read", description: "Read a file with line numbers.", parameters: ReadParameters },
  { name: "Glob", description: "Find files by glob pattern.", parameters: GlobParameters },
  { name: "Grep", description: "Search file contents by regex.", parameters: GrepParameters },
  { name: "Bash", description: "Execute a shell command.", parameters: BashParameters },
];

export const KNOWN_TOOL_NAMES = new Set(["Read", "Glob", "Grep", "Bash"]);

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  if (name === "Read") return executeRead(args, cwd);
  if (name === "Glob") return executeGlob(args, cwd);
  if (name === "Grep") return executeGrep(args, cwd);
  if (name === "Bash") return executeBash(args, cwd);
  throw new Error(`Unsupported tool: ${name}`);
}

function executeRead(args: Record<string, unknown>, cwd: string): string {
  const inputPath = getString(args, ["path", "file_path", "filePath"]);
  if (!inputPath) throw new Error("Read requires a file path");

  const absolutePath = resolvePath(cwd, inputPath);
  const fileStats = statSync(absolutePath, { throwIfNoEntry: false });
  if (!fileStats || !fileStats.isFile()) throw new Error(`Read path is not a file: ${inputPath}`);

  const fileContent = readFileSync(absolutePath, "utf8");
  const lines = fileContent.split(/\r?\n/);
  const totalLines = lines.length;

  const explicitOffset = toNonNegativeInt(args["offset"]);
  const explicitStartLine = toPositiveInt(args["start_line"]);

  let startOffset = explicitOffset ?? 0;
  if (explicitOffset == null && explicitStartLine != null) {
    startOffset = Math.max(0, explicitStartLine - 1);
  }

  const lineLimit = toPositiveInt(args["limit"]) ?? DEFAULT_READ_LIMIT;
  if (startOffset >= totalLines) {
    return `No lines available at offset ${startOffset}.`;
  }

  const selected = lines.slice(startOffset, startOffset + lineLimit);
  const maxLineNumber = startOffset + selected.length;
  const width = Math.max(1, String(maxLineNumber).length);
  const numbered = selected.map((line, index) => {
    const lineNumber = String(startOffset + index + 1).padStart(width, " ");
    return `${lineNumber} | ${line}`;
  });

  if (startOffset + selected.length < totalLines) {
    numbered.push(`... (${totalLines - (startOffset + selected.length)} more lines)`);
  }
  return numbered.join("\n");
}

function executeGlob(args: Record<string, unknown>, cwd: string): string {
  const pattern = getString(args, ["pattern"]);
  if (!pattern) throw new Error("Glob requires a pattern");

  const searchRoot = resolvePath(cwd, getString(args, ["path"]) ?? ".");
  const limit = toPositiveInt(args["limit"]) ?? DEFAULT_GLOB_LIMIT;

  const rawMatches = globSync(pattern, { cwd: searchRoot, exclude: ["**/.git/**", "**/node_modules/**"] });
  const sorted = rawMatches
    .map((match) => path.relative(cwd, path.resolve(searchRoot, match)).split(path.sep).join("/"))
    .sort()
    .slice(0, limit);

  return sorted.length === 0 ? "No files matched." : sorted.join("\n");
}

function executeGrep(args: Record<string, unknown>, cwd: string): string {
  const pattern = getString(args, ["pattern"]);
  if (!pattern) throw new Error("Grep requires a pattern");

  const searchRoot = resolvePath(cwd, getString(args, ["path"]) ?? ".");
  const filePattern = getString(args, ["glob"]) ?? "**/*";
  const caseSensitive = toBoolean(args["case_sensitive"]) ?? false;
  const literal = toBoolean(args["literal"]) ?? false;
  const limit = toPositiveInt(args["max_matches"]) ?? DEFAULT_GREP_LIMIT;

  const regexFlags = caseSensitive ? "g" : "gi";
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
  const matcher = new RegExp(source, regexFlags);

  const files = globSync(filePattern, { cwd: searchRoot, exclude: ["**/.git/**", "**/node_modules/**"] });
  const output: string[] = [];

  for (const file of files) {
    const absolutePath = path.resolve(searchRoot, file);
    const fileStats = statSync(absolutePath, { throwIfNoEntry: false });
    if (!fileStats || !fileStats.isFile()) continue;

    let fileContent: string;
    try { fileContent = readFileSync(absolutePath, "utf8"); } catch { continue; }

    const lines = fileContent.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      matcher.lastIndex = 0;
      if (!matcher.test(lines[i])) continue;
      output.push(`${path.relative(cwd, absolutePath).split(path.sep).join("/")}:${i + 1}:${lines[i]}`);
      if (output.length >= limit) return output.join("\n") + `\n... (truncated to ${limit} matches)`;
    }
  }

  return output.length === 0 ? "No matches found." : output.join("\n");
}

async function executeBash(args: Record<string, unknown>, cwd: string): Promise<string> {
  const command = getString(args, ["command"]);
  if (!command) throw new Error("Bash requires a command");

  const timeout = Math.min(toPositiveInt(args["timeout"]) ?? DEFAULT_BASH_TIMEOUT, MAX_BASH_TIMEOUT);

  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
      cwd,
      encoding: "utf-8",
      timeout,
      maxBuffer: BASH_MAX_BUFFER,
    });
    return [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    const combined = [err.stdout, err.stderr].filter(Boolean).join("\n");
    if (combined) return combined;
    throw error;
  }
}

function resolvePath(cwd: string, targetPath: string): string {
  const root = path.resolve(cwd);
  const resolved = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);
  const isInsideRoot = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!isInsideRoot) throw new Error(`Path escapes repository root: ${targetPath}`);
  return resolved;
}

function getString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toPositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : undefined;
}

function toNonNegativeInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
