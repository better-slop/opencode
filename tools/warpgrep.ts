import { WarpGrepClient } from "@morphllm/morphsdk";
import { tool } from "@opencode-ai/plugin/tool";
import { promises as fs } from "fs";
import { resolve } from "path";

const z = tool.schema;

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 250;
const MAX_CONTEXTS = 20;
const MAX_OUTPUT_CHARS = 50000;

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
]);
const TRANSIENT_STATUS = new Set([429, 500, 502, 503]);

function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as Record<string, unknown>;
  if (typeof err.code === "string" && TRANSIENT_CODES.has(err.code))
    return true;
  if (typeof err.status === "number" && TRANSIENT_STATUS.has(err.status))
    return true;
  if (
    typeof err.statusCode === "number" &&
    TRANSIENT_STATUS.has(err.statusCode)
  )
    return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientError(err) || attempt === MAX_RETRIES - 1) {
        throw err;
      }
      const delay = BASE_DELAY_MS * 2 ** attempt;
      await sleep(delay);
    }
  }
  throw new Error("Retry loop exited unexpectedly");
}

function formatError(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("rg") &&
      (msg.includes("not found") || msg.includes("command not found"))
    ) {
      return "WarpGrep requires ripgrep (rg) installed and on PATH. Install rg and try again.";
    }
    return error.message;
  }
  return String(error);
}

const argumentDescriptions = {
  path: `(OPTIONAL) Repository root directory to run WarpGrep in (defaults to the current working directory, which is currently "${process.cwd()}"). Must be an absolute path (always expand the path properly: ~/Documents/notes.txt --expanded-to--> /home/<user>/Documents/notes.txt). **No relative paths are allowed**.`,
  question:
    "(REQUIRED) Natural-language search question for WarpGrep (e.g., 'How is the system prompt formulated?', 'Where are websocket connections managed?'). **MUST** be posed as a question --  never arbitrary keywords or a statement -- **always end in a question mark**. *** ALWAYS POSE THE QUERY AS A QUESTION ***",
};

export default tool({
  description: `**WarpGrep = AI-based tool that greps, reads, follows connections, returns synthesized context with line numbers.**
                Returns file paths and direct code snippets.
                Use this tool when you need to find specific concepts or methods within a codebase.
                ***TOOL USE:***
                Decision: Can you write the grep pattern?
                - Yes --> grep
                - No, you have a question --> warpgrep
                **WarpGrep queries (natural language, unknown location)**:
                *** ALWAYS POSE THE QUERY AS A QUESTION ***
                - "How does the moderation appeals flow work?"
                - "Where are websocket connections managed?"
                - "What happens when a user submits a post?"
                - "Where is rate limiting implemented?"
                - "How does authg session get validated on API routes?"
                - "What services touch the moderationDecisions table?"
                **What WarpGrep does internally:**
                - One query --> 8-30 operations: greps multiple patterns --> reads relevant sections --> follows imports/references --> returns focused line ranges.
                **When WarpGrep wins:**
                - Tracing data flow across files (API --> Service --> schema --> types).
                - Understanding unfamiliar systems before modifying them.
                - Answering "how" questions that span 3+ files.
                - Finding all touching points for a cross-cutting concern.
                **WarpGrep Tool Arguments**:
                - path: ${argumentDescriptions.path}
                - question: ${argumentDescriptions.question}`,
  args: {
    path: z.string().optional().describe(`${argumentDescriptions.path}`),
    question: z.string().describe(`${argumentDescriptions.question}`),
  },
  async execute(args) {
    const { question } = args;
    const repoRoot = args.path ? resolve(args.path) : process.cwd();

    const apiKey = process.env.MORPH_API_KEY;
    if (!apiKey) {
      return "[warpgrep] Error: MORPH_API_KEY environment variable is not set. Please export MORPH_API_KEY and try again.";
    }

    try {
      const stat = await fs.stat(repoRoot);
      if (!stat.isDirectory()) {
        return `[warpgrep] Error: Path is not a directory: ${repoRoot}`;
      }
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        return `[warpgrep] Error: Path not found: ${repoRoot}`;
      }
      if (error.code === "EACCES" || error.code === "EPERM") {
        return `[warpgrep] Error: Permission denied when accessing path: ${repoRoot}`;
      }
      return `[warpgrep] Error: Failed to access path: ${formatError(err)}`;
    }

    // Execute WarpGrep
    try {
      const client = new WarpGrepClient({ apiKey });
      const result = await executeWithRetry(() =>
        client.execute({ query: question, repoRoot }),
      );

      if (!result.success) {
        const errorMsg =
          (result as { error?: string }).error ??
          "Unknown error from Morph WarpGrep";
        return `[warpgrep] Search failed: ${errorMsg}`;
      }

      const contexts = result.contexts ?? [];
      const summary = result.summary ?? "";

      if (contexts.length === 0) {
        return `[warpgrep] No results for: "${question}"\n${summary ? `\nSummary: ${summary}` : ""}`;
      }

      const lines: string[] = [
        `[warpgrep] Found ${contexts.length} match${contexts.length === 1 ? "" : "es"} for: "${question}"`,
      ];

      if (summary) {
        lines.push(`\nSummary: ${summary}`);
      }

      lines.push("");

      const displayContexts = contexts.slice(0, MAX_CONTEXTS);
      for (const ctx of displayContexts) {
        lines.push(`--- ${ctx.file} ---`);
        lines.push(ctx.content);
        lines.push("");
      }

      if (contexts.length > MAX_CONTEXTS) {
        lines.push(
          `... (${contexts.length - MAX_CONTEXTS} more contexts omitted; refine your query for fewer matches)`,
        );
      }

      let output = lines.join("\n");
      if (output.length > MAX_OUTPUT_CHARS) {
        output =
          output.slice(0, MAX_OUTPUT_CHARS) +
          "\n\n... (truncated; refine your query for fewer matches)";
      }

      return output;
    } catch (err) {
      console.error("[warpgrep] Error:", err);
      return `[warpgrep] Request failed: ${formatError(err)}`;
    }
  },
});
