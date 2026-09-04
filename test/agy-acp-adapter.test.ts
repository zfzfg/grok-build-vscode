import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AgyAcpAdapterServer } from "../src/agy-acp-adapter";

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill() {
    this.killed = true;
    this.emit("exit", 0);
  }
}

describe("AgyAcpAdapterServer", () => {
  it("responds to initialize with ACP protocol version and capabilities", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = new AgyAcpAdapterServer({
      inputStream: input,
      outputStream: output,
    });
    server.start();

    const responses: any[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 10));

    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
      },
    });

    server.dispose();
  });

  it("handles session/new with models and config options", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = new AgyAcpAdapterServer({
      inputStream: input,
      outputStream: output,
    });
    server.start();

    const responses: any[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 10));

    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe(2);
    expect(responses[0].result.sessionId).toBeDefined();
    expect(responses[0].result.models.currentModelId).toBe("gemini-3.8-flash");
    expect(responses[0].result.models.availableModels.length).toBeGreaterThanOrEqual(4);
    expect(responses[0].result.configOptions).toHaveLength(3);

    server.dispose();
  });

  it("handles set_config_option and set_mode", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = new AgyAcpAdapterServer({
      inputStream: input,
      outputStream: output,
    });
    server.start();

    const responses: any[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/set_config_option",
      params: { configId: "model", value: "gemini-3.1-pro" },
    }) + "\n");

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_config_option",
      params: { configId: "reasoning_effort", value: "low" },
    }) + "\n");

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "session/set_mode",
      params: { modeId: "yolo" },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));

    expect(server.currentModelId).toBe("gemini-3.1-pro");
    expect(server.currentEffort).toBe("low");
    expect(server.currentModeId).toBe("yolo");

    server.dispose();
  });

  it("translates session/prompt to NDJSON and streams step updates and prompt result", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let fakeProc: FakeProcess | undefined;

    const server = new AgyAcpAdapterServer({
      inputStream: input,
      outputStream: output,
      spawnFn: () => {
        fakeProc = new FakeProcess();
        return fakeProc as any;
      },
    });
    server.start();

    const messages: any[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line.trim()) messages.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: {
        sessionId: "test-sess",
        prompt: [{ type: "text", text: "Hello Antigravity" }],
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    expect(fakeProc).toBeDefined();

    // Verify agy stdin received NDJSON prompt
    let stdinData = "";
    fakeProc!.stdin.on("data", (d) => { stdinData += d.toString(); });
    await new Promise((r) => setTimeout(r, 10));

    // Simulate agy events
    fakeProc!.stdout.write(JSON.stringify({
      event: "init",
      conversation_id: "conv-12345",
    }) + "\n");

    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "Hi there! ",
        usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 5, total_tokens: 110 },
      },
    }) + "\n");

    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "Ready to assist.\n",
        usage: { input_tokens: 100, output_tokens: 25, thinking_tokens: 10, total_tokens: 125 },
      },
    }) + "\n");

    fakeProc!.stdout.write(JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "Hi there! Ready to assist.\n",
        usage: { input_tokens: 100, output_tokens: 25, thinking_tokens: 10, total_tokens: 125 },
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));

    // Check updates: should have 2 session/update notifications and 1 response for id: 6
    const notifications = messages.filter((m) => m.method === "session/update");
    expect(notifications).toHaveLength(2);
    expect(notifications[0].params.update.content.text).toBe("Hi there! ");
    expect(notifications[1].params.update.content.text).toBe("Ready to assist.\n");

    const promptRes = messages.find((m) => m.id === 6);
    expect(promptRes).toBeDefined();
    expect(promptRes.result).toEqual({
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        thoughtTokens: 10,
        totalTokens: 125,
      },
    });

    server.dispose();
  });

  it("translates tool step updates to ACP tool_call and tool_call_update", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let fakeProc: FakeProcess | undefined;

    const server = new AgyAcpAdapterServer({
      inputStream: input,
      outputStream: output,
      spawnFn: () => {
        fakeProc = new FakeProcess();
        return fakeProc as any;
      },
    });
    server.start();

    const messages: any[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line.trim()) messages.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
      params: {
        sessionId: "sess-tools",
        prompt: [{ type: "text", text: "Create test.md" }],
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    expect(fakeProc).toBeDefined();

    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 3,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: {
          name: "write_to_file",
          parameters: { TargetFile: "C:\\workspace\\test.md" },
        },
      },
    }) + "\n");

    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: {
          name: "write_to_file",
          parameters: { TargetFile: "C:\\workspace\\test.md" },
          output: "Successfully written 20 bytes",
        },
      },
    }) + "\n");

    fakeProc!.stdout.write(JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "File created.",
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));

    const toolCalls = messages.filter((m) => m.params?.update?.sessionUpdate === "tool_call");
    const toolUpdates = messages.filter((m) => m.params?.update?.sessionUpdate === "tool_call_update");

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].params.update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tool-3",
      title: "Create test.md",
      kind: "edit",
      status: "in_progress",
      rawInput: {
        TargetFile: "C:\\workspace\\test.md",
        file_path: "C:\\workspace\\test.md",
      },
    });

    expect(toolUpdates).toHaveLength(1);
    expect(toolUpdates[0].params.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-3",
      title: "Create test.md",
      kind: "edit",
      status: "completed",
      rawInput: {
        TargetFile: "C:\\workspace\\test.md",
        file_path: "C:\\workspace\\test.md",
      },
    });

    // Test run_command normalization
    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 4,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "git status" },
        },
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    const cmdCall = messages.find((m) => m.params?.update?.toolCallId === "tool-4");
    expect(cmdCall).toBeDefined();
    expect(cmdCall.params.update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tool-4",
      title: "git status",
      kind: "execute",
      status: "in_progress",
      rawInput: {
        CommandLine: "git status",
        command: "git status",
        cmd: "git status",
      },
    });

    server.dispose();
  });

  it("updates cwd and passes --add-dir and effort to agy process", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let spawnArgs: string[] = [];
    let spawnOpts: any;

    const server = new AgyAcpAdapterServer({
      inputStream: input,
      outputStream: output,
      spawnFn: (cmd, args, opts) => {
        spawnArgs = args;
        spawnOpts = opts;
        const fakeProc = new FakeProcess();
        return fakeProc as any;
      },
    });
    server.start();

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "session/new",
      params: { cwd: "C:\\my-project\\workspace" },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 10));
    expect(server.cwd).toBe("C:\\my-project\\workspace");

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: "Test prompt" }] },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));

    expect(spawnArgs).toContain("--add-dir");
    expect(spawnArgs).toContain("C:\\my-project\\workspace");
    expect(spawnArgs).toContain("--effort");
    expect(spawnArgs).toContain("high");
    expect(spawnArgs).toContain("--print-timeout");
    expect(spawnArgs).toContain("24h");
    expect(spawnOpts.cwd).toBe("C:\\my-project\\workspace");

    server.dispose();
  });

  it("maps grep_search and find_by_name to kind search with correct titles", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let fakeProc: FakeProcess | undefined;

    const server = new AgyAcpAdapterServer({
      inputStream: input,
      outputStream: output,
      spawnFn: () => {
        fakeProc = new FakeProcess();
        return fakeProc as any;
      },
    });
    server.start();

    const messages: any[] = [];
    output.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        if (line.trim()) messages.push(JSON.parse(line));
      }
    });

    input.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 20,
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: "search test" }] },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));
    expect(fakeProc).toBeDefined();

    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 5,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "grep_search",
        tool_info: {
          name: "grep_search",
          parameters: { Query: "newsession(" },
        },
      },
    }) + "\n");

    fakeProc!.stdout.write(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 6,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "find_by_name",
        tool_info: {
          name: "find_by_name",
          parameters: { Pattern: "*claude*" },
        },
      },
    }) + "\n");

    await new Promise((r) => setTimeout(r, 20));

    const grepCall = messages.find((m) => m.params?.update?.toolCallId === "tool-5");
    expect(grepCall).toBeDefined();
    expect(grepCall.params.update.kind).toBe("search");
    expect(grepCall.params.update.title).toBe('Search "newsession("');

    const findCall = messages.find((m) => m.params?.update?.toolCallId === "tool-6");
    expect(findCall).toBeDefined();
    expect(findCall.params.update.kind).toBe("search");
    expect(findCall.params.update.title).toBe('Find "*claude*"');

    server.dispose();
  });
});
