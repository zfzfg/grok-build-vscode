import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { DEFAULT_GEMINI_MODELS } from "./gemini-backend";

function toolKind(name: string): string {
  switch (name) {
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
      return "edit";
    case "run_command":
      return "execute";
    case "grep_search":
    case "search_web":
    case "find_by_name":
      return "search";
    case "view_file":
    case "list_dir":
    case "read_resource":
    case "read_url_content":
    case "read_browser_page":
      return "read";
    default:
      return "other";
  }
}

export function normalizeToolInput(name: string, params: any): Record<string, any> {
  const p = { ...(params || {}) };
  if (p.CommandLine) {
    p.command = p.CommandLine;
    p.cmd = p.CommandLine;
  }
  if (p.TargetFile) {
    p.file_path = p.TargetFile;
    p.path = p.TargetFile;
    p.target_file = p.TargetFile;
  }
  if (p.AbsolutePath) {
    p.file_path = p.AbsolutePath;
    p.path = p.AbsolutePath;
  }
  if (p.DirectoryPath) {
    p.directory = p.DirectoryPath;
    p.target_directory = p.DirectoryPath;
    p.path = p.DirectoryPath;
  }
  if (p.Query) {
    p.pattern = p.Query;
    p.query = p.Query;
  }
  if (p.Pattern) {
    p.pattern = p.Pattern;
    p.glob_pattern = p.Pattern;
  }
  if (p.SearchDirectory) {
    p.path = p.SearchDirectory;
    p.directory = p.SearchDirectory;
  }
  if (p.Url) {
    p.url = p.Url;
    p.uri = p.Url;
  }
  return p;
}

function toolTitle(name: string, params: any): string {
  const p = params || {};
  switch (name) {
    case "write_to_file": {
      const file = p.TargetFile || p.file_path || p.path ? path.basename(p.TargetFile || p.file_path || p.path) : "file";
      return `Create ${file}`;
    }
    case "replace_file_content":
    case "multi_replace_file_content": {
      const file = p.TargetFile || p.file_path || p.path ? path.basename(p.TargetFile || p.file_path || p.path) : "file";
      return `Edit ${file}`;
    }
    case "view_file": {
      const file = p.AbsolutePath || p.file_path || p.path ? path.basename(p.AbsolutePath || p.file_path || p.path) : "file";
      return `Read ${file}`;
    }
    case "list_dir": {
      const dir = p.DirectoryPath || p.directory || p.path ? path.basename(p.DirectoryPath || p.directory || p.path) : "directory";
      return `List ${dir}`;
    }
    case "grep_search": {
      const q = p.Query || p.pattern || p.query;
      return q ? `Search "${q}"` : "grep_search";
    }
    case "find_by_name": {
      const pattern = p.Pattern || p.pattern || p.Query || p.query;
      return pattern ? `Find "${pattern}"` : "find_by_name";
    }
    case "search_web": {
      const q = p.Query || p.pattern || p.query;
      return q ? `Web search "${q}"` : "search_web";
    }
    case "run_command": {
      const cmd = p.CommandLine || p.command || p.cmd;
      return cmd ? cmd.split(/\r?\n/)[0].slice(0, 80) : "run_command";
    }
    default:
      return name;
  }
}

export interface AgyAdapterOptions {
  agyPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  defaultModelId?: string;
  defaultEffort?: string;
  defaultModeId?: string;
  printTimeout?: string;
  inputStream?: NodeJS.ReadableStream;
  outputStream?: NodeJS.WritableStream;
  spawnFn?: (command: string, args: string[], options: any) => ChildProcessWithoutNullStreams;
}

export interface PromptUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export class AgyAcpAdapterServer {
  private readonly agyPath: string;
  cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: (command: string, args: string[], options: any) => ChildProcessWithoutNullStreams;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly printTimeout: string;

  private rl?: Interface;
  private agyProc?: ChildProcessWithoutNullStreams;
  private agyRl?: Interface;

  sessionId?: string;
  currentModelId: string;
  currentEffort: string;
  currentModeId: string;
  activeConversationId?: string;

  private pendingPrompt?: {
    id: number | string;
    resolve: (result: any) => void;
    reject: (error: any) => void;
    usage: PromptUsage;
  };

  constructor(options: AgyAdapterOptions = {}) {
    this.agyPath = options.agyPath || process.env.AGY_PATH || process.env.GEMINI_CLI_EXECUTABLE || "agy";
    this.cwd = options.cwd || process.env.AGY_CWD || process.cwd();
    this.env = options.env || { ...process.env };
    this.currentModelId = options.defaultModelId || "gemini-3.8-flash";
    this.currentEffort = options.defaultEffort || "high";
    this.currentModeId = options.defaultModeId || process.env.AGY_DEFAULT_MODE || "agent";
    this.printTimeout = options.printTimeout || options.env?.AGY_PRINT_TIMEOUT || process.env.AGY_PRINT_TIMEOUT || "24h";
    this.input = options.inputStream || process.stdin;
    this.output = options.outputStream || process.stdout;
    this.spawnFn = options.spawnFn || ((cmd, args, opts) => spawn(cmd, args, opts));
  }

  start(): void {
    this.rl = createInterface({ input: this.input });
    this.rl.on("line", (line) => this.handleClientLine(line));
    this.input.on("end", () => this.dispose());
  }

  dispose(): void {
    this.rl?.close();
    this.rl = undefined;
    this.killAgyProc();
  }

  private killAgyProc(): void {
    if (this.agyRl) {
      this.agyRl.close();
      this.agyRl = undefined;
    }
    if (this.agyProc) {
      try {
        this.agyProc.stdin.end();
      } catch {}
      try {
        this.agyProc.kill();
      } catch {}
      this.agyProc = undefined;
    }
  }

  writeJsonRpc(message: any): void {
    const text = JSON.stringify(message) + "\n";
    this.output.write(text);
  }

  private sendResponse(id: number | string | undefined, result: any): void {
    if (id == null) return;
    this.writeJsonRpc({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: number | string | undefined, code: number, message: string): void {
    if (id == null) return;
    this.writeJsonRpc({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private sendNotification(method: string, params: any): void {
    this.writeJsonRpc({ jsonrpc: "2.0", method, params });
  }

  getConfigOptions(): any[] {
    return [
      {
        id: "model",
        currentValue: this.currentModelId,
        options: DEFAULT_GEMINI_MODELS.map((m) => ({
          value: m.modelId,
          name: m.name,
          description: m.description,
        })),
      },
      {
        id: "reasoning_effort",
        currentValue: this.currentEffort || "default",
        options: [
          { value: "default", name: "Default" },
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
      {
        id: "mode",
        currentValue: this.currentModeId,
        options: [
          { value: "agent", name: "Agent" },
          { value: "yolo", name: "Auto accept" },
          { value: "plan", name: "Plan" },
        ],
      },
    ];
  }

  async handleClientLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: any;
    try {
      req = JSON.parse(trimmed);
    } catch {
      return;
    }
    const { id, method, params } = req;
    if (!method) return;

    switch (method) {
      case "initialize": {
        this.sendResponse(id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
          },
        });
        break;
      }

      case "session/new": {
        if (typeof params?.cwd === "string" && params.cwd) {
          const prevCwd = this.cwd;
          this.cwd = params.cwd;
          if (prevCwd !== this.cwd && this.agyProc) {
            this.killAgyProc();
          }
        }
        this.sessionId = randomUUID();
        this.sendResponse(id, {
          sessionId: this.sessionId,
          models: {
            currentModelId: this.currentModelId,
            availableModels: DEFAULT_GEMINI_MODELS,
          },
          configOptions: this.getConfigOptions(),
        });
        break;
      }

      case "session/load": {
        if (typeof params?.cwd === "string" && params.cwd) {
          const prevCwd = this.cwd;
          this.cwd = params.cwd;
          if (prevCwd !== this.cwd && this.agyProc) {
            this.killAgyProc();
          }
        }
        const loadedSessionId = typeof params?.sessionId === "string" ? params.sessionId : randomUUID();
        this.sessionId = loadedSessionId;
        this.sendResponse(id, {
          sessionId: this.sessionId,
          models: {
            currentModelId: this.currentModelId,
            availableModels: DEFAULT_GEMINI_MODELS,
          },
          configOptions: this.getConfigOptions(),
        });
        break;
      }

      case "session/set_config_option": {
        const configId = params?.configId;
        const value = params?.value;
        if (configId === "model" && typeof value === "string") {
          const prevModel = this.currentModelId;
          this.currentModelId = value;
          if (prevModel !== value && this.agyProc) {
            this.killAgyProc();
          }
        } else if ((configId === "reasoning_effort" || configId === "effort") && typeof value === "string") {
          const prevEffort = this.currentEffort;
          this.currentEffort = value === "default" ? "" : value;
          if (prevEffort !== this.currentEffort && this.agyProc) {
            this.killAgyProc();
          }
        } else if (configId === "mode" && typeof value === "string") {
          const prevMode = this.currentModeId;
          this.currentModeId = (value === "yolo" || value === "agent-full-access" || value === "bypassPermissions")
            ? "yolo"
            : value === "plan"
              ? "plan"
              : "agent";
          if (prevMode !== this.currentModeId && this.agyProc) {
            this.killAgyProc();
          }
        }
        this.sendResponse(id, {
          configOptions: this.getConfigOptions(),
        });
        break;
      }

      case "session/set_mode": {
        const rawModeId = typeof params?.modeId === "string" ? params.modeId : "agent";
        const modeId = (rawModeId === "yolo" || rawModeId === "agent-full-access" || rawModeId === "bypassPermissions")
          ? "yolo"
          : rawModeId === "plan"
            ? "plan"
            : "agent";
        const prevMode = this.currentModeId;
        this.currentModeId = modeId;
        if (prevMode !== modeId && this.agyProc) {
          this.killAgyProc();
        }
        this.sendResponse(id, {
          modes: {
            currentModeId: this.currentModeId,
          },
        });
        break;
      }

      case "session/prompt": {
        const promptBlocks = Array.isArray(params?.prompt) ? params.prompt : [];
        let promptText = "";
        for (const block of promptBlocks) {
          if (typeof block === "string") {
            promptText += block;
          } else if (block && typeof block.text === "string") {
            promptText += (promptText ? "\n" : "") + block.text;
          }
        }
        if (!promptText && typeof params?.text === "string") {
          promptText = params.text;
        }

        try {
          await this.executePrompt(id, promptText);
        } catch (error) {
          this.sendError(id, -32603, (error as Error).message || "Prompt execution failed");
        }
        break;
      }

      case "session/list": {
        this.sendResponse(id, { sessions: [] });
        break;
      }

      default: {
        if (id != null) {
          this.sendResponse(id, {});
        }
        break;
      }
    }
  }

  private ensureAgyProc(): ChildProcessWithoutNullStreams {
    if (this.agyProc && !this.agyProc.killed && this.agyProc.stdin.writable) {
      return this.agyProc;
    }

    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--print-timeout", this.printTimeout,
    ];

    if (this.cwd) {
      args.push("--add-dir", this.cwd);
    }

    if (this.currentModelId) {
      args.push("--model", this.currentModelId);
    }
    const effort = this.currentEffort && this.currentEffort !== "default" ? this.currentEffort : "high";
    args.push("--effort", effort);
    if (this.currentModeId === "yolo") {
      args.push("--dangerously-skip-permissions");
    } else if (this.currentModeId === "plan") {
      args.push("--mode", "plan");
    }
    if (this.activeConversationId) {
      args.push("--conversation", this.activeConversationId);
    }

    const proc = this.spawnFn(this.agyPath, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.agyProc = proc;
    this.agyRl = createInterface({ input: proc.stdout });
    this.agyRl.on("line", (line) => this.handleAgyLine(line));

    proc.on("exit", (code) => {
      if (this.pendingPrompt) {
        const pending = this.pendingPrompt;
        this.pendingPrompt = undefined;
        if (code !== 0) {
          pending.reject(new Error(`Antigravity CLI exited with code ${code}`));
        } else {
          pending.resolve({
            stopReason: "end_turn",
            usage: pending.usage,
          });
        }
      }
      this.agyProc = undefined;
    });

    proc.on("error", (err) => {
      if (this.pendingPrompt) {
        const pending = this.pendingPrompt;
        this.pendingPrompt = undefined;
        pending.reject(err);
      }
      this.agyProc = undefined;
    });

    return proc;
  }

  handleAgyLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (ev.event === "init") {
      if (typeof ev.conversation_id === "string" && ev.conversation_id) {
        this.activeConversationId = ev.conversation_id;
      }
      return;
    }

    if (ev.event === "step_update") {
      const step = ev.step_update;
      if (!step) return;

      if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
        this.sendNotification("session/update", {
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: step.text_delta,
            },
          },
        });
      }

      if (step.step_type === "tool") {
        const toolCallId = `tool-${step.step_index}`;
        const name = step.tool_name || step.tool_info?.name || "tool";
        const rawParams = step.tool_info?.parameters || {};
        const params = normalizeToolInput(name, rawParams);
        const kind = toolKind(name);
        const title = toolTitle(name, params);

        if (step.state === "ACTIVE") {
          this.sendNotification("session/update", {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title,
              kind,
              status: "in_progress",
              rawInput: params,
            },
          });
        } else {
          const isError = step.state === "ERROR";
          const output = step.tool_info?.output ?? step.tool_info?.error?.message ?? (isError ? "Tool execution failed" : "completed");
          this.sendNotification("session/update", {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              title,
              kind,
              status: isError ? "failed" : "completed",
              rawInput: params,
              rawOutput: typeof output === "string" ? { output } : output,
            },
          });
        }
      }

      if (step.usage && this.pendingPrompt) {
        const u = step.usage;
        this.pendingPrompt.usage.inputTokens = u.input_tokens ?? this.pendingPrompt.usage.inputTokens;
        this.pendingPrompt.usage.outputTokens = u.output_tokens ?? this.pendingPrompt.usage.outputTokens;
        this.pendingPrompt.usage.thoughtTokens = u.thinking_tokens ?? this.pendingPrompt.usage.thoughtTokens;
        this.pendingPrompt.usage.totalTokens = u.total_tokens ?? this.pendingPrompt.usage.totalTokens;
      }
      return;
    }

    if (ev.event === "result") {
      const res = ev.result;
      if (this.pendingPrompt) {
        const pending = this.pendingPrompt;
        this.pendingPrompt = undefined;

        if (res?.usage) {
          pending.usage.inputTokens = res.usage.input_tokens ?? pending.usage.inputTokens;
          pending.usage.outputTokens = res.usage.output_tokens ?? pending.usage.outputTokens;
          pending.usage.thoughtTokens = res.usage.thinking_tokens ?? pending.usage.thoughtTokens;
          pending.usage.totalTokens = res.usage.total_tokens ?? pending.usage.totalTokens;
        }

        if (res?.status === "ERROR") {
          pending.reject(new Error(res.error || "Antigravity reported an error"));
        } else {
          this.sendResponse(pending.id, {
            stopReason: "end_turn",
            usage: pending.usage,
          });
        }
      }
    }
  }

  private executePrompt(id: number | string, promptText: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = this.ensureAgyProc();
      this.pendingPrompt = {
        id,
        resolve: (val) => {
          this.sendResponse(id, val);
          resolve();
        },
        reject: (err) => {
          this.sendError(id, -32603, (err as Error).message || "Prompt error");
          reject(err);
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          thoughtTokens: 0,
          totalTokens: 0,
        },
      };

      const payload = JSON.stringify({
        event: "user",
        message: {
          role: "user",
          content: promptText,
        },
      }) + "\n";

      proc.stdin.write(payload, (err) => {
        if (err) {
          this.pendingPrompt = undefined;
          this.sendError(id, -32603, `Failed to write prompt to Antigravity stdin: ${err.message}`);
          reject(err);
        }
      });
    });
  }
}

// When invoked directly as a standalone Node script
if (require.main === module) {
  const server = new AgyAcpAdapterServer();
  server.start();

  process.on("SIGINT", () => {
    server.dispose();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.dispose();
    process.exit(0);
  });
}
