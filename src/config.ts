/**
 * Configuration resolution.
 *
 * Local-only by default: the chain ships with the two local Laya services, and a backend that sends
 * state off this machine is skipped unless cloud use is explicitly enabled. Verified on 2026-09-21:
 * `laya-mlx` answers on 8317 under launchd, `laya` on 8318 only when started, and this machine has
 * no TypeSafe key at all.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BackendSpec } from "./backends/types.ts";

export const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "adecider.json");

export interface SystemOneConfig {
  chain: string[];
  backends: Record<string, BackendSpec>;
  allowCloud: boolean;
  configPath: string;
}

/**
 * Backends known to this machine. A config file merges over these by name.
 *
 * Only endpoints this project can actually account for are here. The two Laya services are the
 * premise of the local-first default, and Jev is the one hosted model with a documented setup path.
 * An OpenAI-compatible server is deliberately **not** a default: advertising whatever answers on a
 * port another project manages would put a model into `adecider models` that nobody declared, and a
 * model list is a claim about what can be reached. Declare it in the config file to use it:
 *
 *   "backends": { "local27b": { "kind": "openai", "baseUrl": "http://127.0.0.1:8090/v1", "model": "..." } }
 */
const KNOWN_BACKENDS: Record<string, BackendSpec> = {
  "laya-mlx": {
    name: "laya-mlx",
    kind: "laya",
    baseUrl: "http://127.0.0.1:8317",
    timeoutMs: 20_000,
  },
  laya: {
    name: "laya",
    kind: "laya",
    baseUrl: "http://127.0.0.1:8318",
    timeoutMs: 30_000,
  },
  jev: { name: "jev", kind: "jev", model: "jev-latest" },
};

export const DEFAULT_CHAIN = ["laya-mlx", "laya"];

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

interface ConfigFile {
  chain?: unknown;
  backends?: unknown;
  allowCloud?: unknown;
}

export function loadConfig(overrides?: { configPath?: string }): SystemOneConfig {
  const configPath = overrides?.configPath ?? process.env["ADECIDER_CONFIG"] ?? CONFIG_PATH;
  const backends: Record<string, BackendSpec> = { ...KNOWN_BACKENDS };
  let chain = [...DEFAULT_CHAIN];
  let allowCloud = false;

  let file: ConfigFile | null = null;
  try {
    file = JSON.parse(fs.readFileSync(configPath, "utf8")) as ConfigFile;
  } catch {
    // Missing or unreadable config is the normal case; defaults stand.
  }

  if (file) {
    if (Array.isArray(file.chain)) {
      chain = file.chain.filter((name): name is string => typeof name === "string");
    }
    if (file.allowCloud === true) allowCloud = true;
    if (file.backends && typeof file.backends === "object") {
      for (const [name, raw] of Object.entries(file.backends as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue;
        const spec = raw as Partial<BackendSpec>;
        if (spec.kind !== "laya" && spec.kind !== "jev" && spec.kind !== "openai") continue;
        backends[name] = {
          name,
          kind: spec.kind,
          ...(typeof spec.baseUrl === "string" ? { baseUrl: spec.baseUrl } : {}),
          ...(typeof spec.apiKey === "string" ? { apiKey: spec.apiKey } : {}),
          ...(typeof spec.model === "string" ? { model: spec.model } : {}),
          ...(typeof spec.timeoutMs === "number" ? { timeoutMs: spec.timeoutMs } : {}),
        };
      }
    }
  }

  const envChain = process.env["ADECIDER_CHAIN"];
  if (envChain && envChain.trim().length > 0) {
    chain = envChain.split(",").map((name) => name.trim()).filter(Boolean);
  }
  const envCloud = parseBoolean(process.env["ADECIDER_ALLOW_CLOUD"]);
  if (envCloud !== undefined) allowCloud = envCloud;

  return { chain, backends, allowCloud, configPath };
}
