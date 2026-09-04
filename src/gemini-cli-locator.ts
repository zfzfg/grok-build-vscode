import { existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";

export interface GeminiLocatorFs {
  exists(path: string): boolean;
  isFile(path: string): boolean;
}

export interface GeminiLocatorOptions {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  fs?: GeminiLocatorFs;
  which?: (name: string) => string | undefined;
}

const defaultFs: GeminiLocatorFs = {
  exists: existsSync,
  isFile: (file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  },
};

function defaultWhich(name: string, platform: NodeJS.Platform): string | undefined {
  try {
    const command = platform === "win32" ? `where ${name}` : `command -v ${name}`;
    return execSync(command, { encoding: "utf8" }).trim().split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function isAntigravityCli(cliPath: string): boolean {
  if (!cliPath) return false;
  const basename = path.basename(cliPath).toLowerCase();
  return (
    basename === "agy" ||
    basename === "agy.exe" ||
    basename === "agy.cmd" ||
    basename === "antigravity" ||
    basename === "antigravity.exe" ||
    basename === "antigravity.cmd" ||
    basename.startsWith("agy-") ||
    basename.startsWith("agy.")
  );
}

/** Known Antigravity CLI binary locations (modern official standard) */
function wellKnownAgyBins(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
    return [
      p.join(home, ".gemini", "bin", "agy.exe"),
      p.join(home, ".gemini", "bin", "agy.cmd"),
      p.join(localAppData, "Programs", "agy", "agy.exe"),
      p.join(home, ".local", "bin", "agy.exe"),
    ];
  }
  return [
    p.join(home, ".gemini", "bin", "agy"),
    p.join(home, ".local", "bin", "agy"),
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy",
  ];
}

/** Known Gemini CLI binary locations (legacy) */
function wellKnownGeminiBins(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
    const appData = env.APPDATA || p.join(home, "AppData", "Roaming");
    return [
      p.join(home, ".gemini", "bin", "gemini.exe"),
      p.join(home, ".gemini", "bin", "gemini.cmd"),
      p.join(localAppData, "Programs", "gemini", "gemini.exe"),
      p.join(appData, "npm", "gemini.cmd"),
      p.join(home, ".local", "bin", "gemini.exe"),
    ];
  }
  return [
    p.join(home, ".gemini", "bin", "gemini"),
    p.join(home, ".local", "bin", "gemini"),
    "/usr/local/bin/gemini",
    "/opt/homebrew/bin/gemini",
  ];
}

export function locateGeminiCli(options: GeminiLocatorOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? defaultFs;
  const env = options.env ?? process.env;
  const configured = options.configuredPath?.trim();
  if (configured) {
    return fs.isFile(configured) ? configured : undefined;
  }

  const which = options.which ?? ((candidate) => defaultWhich(candidate, platform));
  const home = options.home || (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();

  // 1. Prefer Antigravity CLI (agy) on PATH
  const agyNames = platform === "win32" ? ["agy.exe", "agy.cmd", "agy"] : ["agy"];
  for (const name of agyNames) {
    const found = which(name);
    if (found && fs.isFile(found)) return found;
  }

  // 2. Antigravity CLI in well-known locations (e.g. ~/.gemini/bin/agy.exe)
  for (const candidate of wellKnownAgyBins(home, env, platform)) {
    if (fs.isFile(candidate)) return candidate;
  }

  // 3. Fallback to legacy gemini on PATH
  const geminiNames = platform === "win32" ? ["gemini.exe", "gemini.cmd", "gemini"] : ["gemini"];
  for (const name of geminiNames) {
    const found = which(name);
    if (found && fs.isFile(found)) return found;
  }

  // 4. Legacy gemini in well-known locations
  for (const candidate of wellKnownGeminiBins(home, env, platform)) {
    if (fs.isFile(candidate)) return candidate;
  }

  return undefined;
}

export function parseGeminiVersionOutput(output: string): string {
  return /(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output.trim())?.[1] ?? "";
}

export const parseAgyVersionOutput = parseGeminiVersionOutput;
