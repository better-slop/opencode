import { tool } from "@opencode-ai/plugin/tool";
import { spawn, ChildProcess, exec } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const execAsync = promisify(exec);

function isFsError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error;
}

function logUnexpectedFsError(
  error: unknown,
  context: string,
  expectedCodes: string[] = ["ENOENT"],
): void {
  if (isFsError(error)) {
    const code = error.code;
    if (code && expectedCodes.includes(code)) {
      return;
    }
    console.error(
      `[background_jobs] ${context} failed with code ${code ?? "UNKNOWN"}:`,
      error,
    );
  } else {
    console.error(`[background_jobs] ${context} failed:`, error);
  }
}

// Global registry to track running processes
const runningProcesses = new Map<string, ChildProcess>();
const SHELLS_DIR = "/home/user/.opencode/background-shells";
const INDEX_FILE = join(SHELLS_DIR, "index.json");

interface ShellMetadata {
  id: string;
  command: string;
  startTime: number;
  status: "running" | "finished";
  exitCode?: number;
  workingDir: string;
}

// Cleanup function called on startup
async function cleanupStaleShells() {
  try {
    if (existsSync(SHELLS_DIR)) {
      const dirs = await fs.readdir(SHELLS_DIR);
      for (const dir of dirs) {
        if (dir !== "index.json") {
          await fs.rm(join(SHELLS_DIR, dir), { recursive: true, force: true });
        }
      }
      if (existsSync(INDEX_FILE)) {
        await fs.unlink(INDEX_FILE);
      }
    }
  } catch (error) {
    console.error("Failed to cleanup stale shells:", error);
  }
}

// Initialize cleanup on first import
cleanupStaleShells();

async function ensureShellsDir() {
  if (!existsSync(SHELLS_DIR)) {
    mkdirSync(SHELLS_DIR, { recursive: true });
  }
}

async function loadIndex(): Promise<ShellMetadata[]> {
  if (!existsSync(INDEX_FILE)) {
    return [];
  }

  try {
    const content = await fs.readFile(INDEX_FILE, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    logUnexpectedFsError(error, "loadIndex");
    return [];
  }
}

async function saveIndex(shells: ShellMetadata[]) {
  await ensureShellsDir();
  await fs.writeFile(INDEX_FILE, JSON.stringify(shells, null, 2));
}

function generateId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const random = randomBytes(3).toString("hex");
  return `task_${timestamp}_${random}`;
}

function formatRuntime(startTime: number): string {
  const elapsed = Date.now() - startTime;
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

async function getShellsList(): Promise<string> {
  const shells = await loadIndex();
  if (shells.length === 0) {
    return "Currently running Background Shells:\nNo background shells running.";
  }

  let output = "Currently running Background Shells:\n";
  for (const shell of shells) {
    const runtime =
      shell.status === "running" ? formatRuntime(shell.startTime) : "finished";
    const outputPath = join(SHELLS_DIR, shell.id, "output.txt");
    let outputSize = 0;
    try {
      const stats = await fs.stat(outputPath);
      outputSize = stats.size;
    } catch (error) {
      logUnexpectedFsError(error, `stat output for shell ${shell.id}`);
    }

    output += `- ShellId: ${shell.id}\n`;
    output += `  Command: ${shell.command}\n`;
    output += `  Status: ${shell.status === "running" ? "Running" : "Finished"}\n`;
    output += `  ${shell.status === "running" ? "RunningFor" : "CompletedAfter"}: ${runtime}\n`;
    output += `  Current output size: ${outputSize} bytes\n`;
    if (shell.status === "finished" && shell.exitCode !== undefined) {
      output += `  Exit code: ${shell.exitCode}\n`;
    }
    output += "\n";
  }
  return output.trim();
}

// ----------------------------------------
// Zod argument schemas
// ----------------------------------------

const z = tool.schema;

type BackgroundJobsAction = "start" | "list" | "read" | "kill";

type OutputMethod = "full" | "grep" | "head" | "tail";

const BackgroundJobsStartSchema = z.object({
  action: z.literal("start"),
  command: z.string(),
});

const BackgroundJobsListSchema = z.object({
  action: z.literal("list"),
});

const BackgroundJobsReadSchema = z.object({
  action: z.literal("read"),
  id: z.string(),
  method: z.enum(["full", "grep", "head", "tail"]).default("full"),
  pattern: z.string().optional(),
  lines: z.number().optional(),
});

const BackgroundJobsKillSchema = z.object({
  action: z.literal("kill"),
  id: z.string(),
});

const BackgroundJobsArgsSchema = z.discriminatedUnion("action", [
  BackgroundJobsStartSchema,
  BackgroundJobsListSchema,
  BackgroundJobsReadSchema,
  BackgroundJobsKillSchema,
]);

type BackgroundJobsStart = {
  action: "start";
  command: string;
};

type BackgroundJobsList = {
  action: "list";
};

type BackgroundJobsRead = {
  action: "read";
  id: string;
  method?: OutputMethod;
  pattern?: string;
  lines?: number;
};

type BackgroundJobsKill = {
  action: "kill";
  id: string;
};

type BackgroundJobsArgs =
  | BackgroundJobsStart
  | BackgroundJobsList
  | BackgroundJobsRead
  | BackgroundJobsKill;

// ----------------------------------------
// Per-action handlers
// ----------------------------------------

async function handleStart(args: BackgroundJobsStart): Promise<string> {
  await ensureShellsDir();

  const id = generateId();
  const shellDir = join(SHELLS_DIR, id);
  const outputFile = join(shellDir, "output.txt");

  mkdirSync(shellDir, { recursive: true });

  const metadata: ShellMetadata = {
    id,
    command: args.command,
    startTime: Date.now(),
    status: "running",
    workingDir: process.cwd(),
  };

  const childProcess = spawn("bash", ["-c", args.command], {
    detached: false, // Keep it in opencode process space
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
  });

  runningProcesses.set(id, childProcess);

  const outputStream = await fs.open(outputFile, "w");

  childProcess.stdout?.on("data", async (data) => {
    await outputStream.write(data);
  });

  childProcess.stderr?.on("data", async (data) => {
    await outputStream.write(data);
  });

  childProcess.on("close", async (code) => {
    await outputStream.close();
    runningProcesses.delete(id);

    metadata.status = "finished";
    metadata.exitCode = code || 0;

    const shells = await loadIndex();
    const index = shells.findIndex((s) => s.id === id);
    if (index >= 0) {
      shells[index] = metadata;
    }
    await saveIndex(shells);
  });

  const shells = await loadIndex();
  shells.push(metadata);
  await saveIndex(shells);

  return `Started background shell with ID: ${id}\nCommand: ${args.command}\n\n${await getShellsList()}`;
}

async function handleList(_args: BackgroundJobsList): Promise<string> {
  return await getShellsList();
}

async function handleRead(args: BackgroundJobsRead): Promise<string> {
  const shells = await loadIndex();
  const shell = shells.find((s) => s.id === args.id);

  if (!shell) {
    return `Background shell with ID ${args.id} not found.\n\n${await getShellsList()}`;
  }

  const outputFile = join(SHELLS_DIR, args.id, "output.txt");

  if (!existsSync(outputFile)) {
    return `Output file for ${args.id} not found or not created yet.`;
  }

  const method: OutputMethod = (args.method ?? "full") as OutputMethod;

  try {
    const stats = await fs.stat(outputFile);
    const fileSizeBytes = stats.size;
    const fileSizeKB = (fileSizeBytes / 1024).toFixed(2);

    let content: string;
    let command: string;

    switch (method) {
      case "full":
        if (fileSizeBytes > 102400) {
          // 100KB
          return `Output file is too large (${fileSizeKB}KB). Please use grep, head, or tail methods to filter the content.`;
        }
        content = await fs.readFile(outputFile, "utf-8");
        break;

      case "grep":
        if (!args.pattern) {
          return "Pattern is required for grep method";
        }
        const escapedPattern = args.pattern.replace(/"/g, '\\"');
        command = `grep "${escapedPattern}" "${outputFile}"`;

        try {
          const { stdout } = await execAsync(command);
          content = stdout;
        } catch (error: any) {
          if (error.code === 1) {
            content = "";
          } else {
            throw error;
          }
        }
        break;

      case "head": {
        const headLines = args.lines || 10;
        command = `head -n ${headLines} "${outputFile}"`;

        const headResult = await execAsync(command);
        content = headResult.stdout;
        break;
      }

      case "tail": {
        const tailLines = args.lines || 10;
        command = `tail -n ${tailLines} "${outputFile}"`;

        const tailResult = await execAsync(command);
        content = tailResult.stdout;
        break;
      }

      default:
        if (fileSizeBytes > 102400) {
          // 100KB
          return `Output file is too large (${fileSizeKB}KB). Please use grep, head, or tail methods to filter the content.`;
        }
        content = await fs.readFile(outputFile, "utf-8");
    }

    if (content.length > 102400) {
      // 100KB in characters (roughly)
      return `Filtered output is still too large (${(content.length / 1024).toFixed(2)}KB). Try using more specific grep patterns or fewer lines for head/tail.`;
    }

    const methodDesc =
      method === "grep"
        ? `grep pattern: "${args.pattern}"`
        : method === "head"
          ? `head ${args.lines || 10} lines`
          : method === "tail"
            ? `tail ${args.lines || 10} lines`
            : "full output";

    return `Output for ${args.id} (${methodDesc}) - File size: ${fileSizeKB}KB:\n\n${content}`;
  } catch (error) {
    if (isFsError(error) && error.code === "ENOENT") {
      return `Output file for ${args.id} not found or not created yet.`;
    }
    logUnexpectedFsError(error, `read output for ${args.id}`, ["ENOENT"]);
    return `Error reading output for ${args.id}: ${error}`;
  }
}

async function handleKill(args: BackgroundJobsKill): Promise<string> {
  const shells = await loadIndex();
  const shell = shells.find((s) => s.id === args.id);

  if (!shell) {
    return `Background shell with ID ${args.id} not found.\n\n${await getShellsList()}`;
  }

  const process = runningProcesses.get(args.id);
  if (process) {
    process.kill("SIGTERM");
    runningProcesses.delete(args.id);
  }

  const updatedShells = shells.filter((s) => s.id !== args.id);
  await saveIndex(updatedShells);

  const shellDir = join(SHELLS_DIR, args.id);
  try {
    await fs.rm(shellDir, { recursive: true, force: true });
  } catch (error) {
    logUnexpectedFsError(error, `cleanup shell directory ${args.id}`);
  }

  return `Killed and cleaned up background shell ${args.id}\n\n${await getShellsList()}`;
}

// ----------------------------------------
// Unified tool definition
// ----------------------------------------

const BackgroundJobsArgsZod = {
  action: z
    .enum(["start", "list", "read", "kill"])
    .describe("Which background job action to perform"),
  command: z
    .string()
    .optional()
    .describe(
      'Shell command to execute in background (required for action="start")',
    ),
  id: z
    .string()
    .optional()
    .describe('Background shell ID (required for action="read" and "kill")'),
  method: z
    .enum(["full", "grep", "head", "tail"])
    .optional()
    .describe('How to read output for action="read"; defaults to "full"'),
  pattern: z
    .string()
    .optional()
    .describe('Pattern for grep method when action="read" and method="grep"'),
  lines: z
    .number()
    .optional()
    .describe('Number of lines for head/tail methods when action="read"'),
};

export default tool({
  description:
    "Manage background shell processes (start, list, read, kill) via a single background_jobs tool.",
  args: BackgroundJobsArgsZod,
  async execute(rawArgs) {
    const args = BackgroundJobsArgsSchema.parse(rawArgs) as BackgroundJobsArgs;

    switch (args.action as BackgroundJobsAction) {
      case "start":
        return handleStart(args);
      case "list":
        return handleList(args);
      case "read":
        return handleRead(args);
      case "kill":
        return handleKill(args);
      default:
        throw new Error(
          `Unknown background_jobs action: ${(args as any).action}`,
        );
    }
  },
});
