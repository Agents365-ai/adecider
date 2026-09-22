/**
 * Backend registry and selection.
 *
 * Two different questions, deliberately answered by two different lists:
 *
 * - **Which model may I name?** Everything configured and allowed, including a cloud backend. Naming
 *   a model is an explicit act, so a cloud model that is named is a cloud model that was wanted.
 * - **Which model answers when nobody names one?** Only the ordered chain, which is local by default.
 *   Automatic selection never escalates to the cloud, because a local service being down is not
 *   consent to send source code to a hosted API.
 *
 * Selection uses a short health cache, so an agent loop does not re-probe on every call but a service
 * that goes down is noticed within a few seconds. An explicitly named backend always wins and never
 * silently falls back: a caller that asked for a specific backend gets that backend or a typed error.
 */

import type { SystemOneRequest, SystemOneResponse } from "../types.ts";
import { SystemOneError } from "../errors.ts";
import type { SystemOneConfig } from "../config.ts";
import { createJevBackend } from "./jev.ts";
import { createLayaBackend } from "./laya.ts";
import { createOpenAiBackend } from "./openai.ts";
import type { Backend, BackendSpec, Health } from "./types.ts";

export type { Backend, BackendSpec, Health } from "./types.ts";

const HEALTH_TTL_MS = 5_000;

export interface SkippedBackend {
  name: string;
  reason: string;
}

function build(spec: BackendSpec): Backend {
  if (spec.kind === "laya") return createLayaBackend(spec);
  if (spec.kind === "jev") return createJevBackend(spec);
  return createOpenAiBackend(spec);
}

export function createBackend(spec: BackendSpec): Backend {
  return build(spec);
}

export class BackendChain {
  /** Every backend that may be named. */
  readonly backends: Backend[];
  /** The ordered subset that answers when no backend is named. */
  readonly chain: Backend[];
  readonly skipped: SkippedBackend[];
  private readonly healthCache = new Map<string, { at: number; health: Health }>();

  constructor(backends: Backend[], chain: Backend[], skipped: SkippedBackend[]) {
    this.backends = backends;
    this.chain = chain;
    this.skipped = skipped;
  }

  static fromConfig(config: SystemOneConfig): BackendChain {
    const chain: Backend[] = [];
    const skipped: SkippedBackend[] = [];
    const allowed = new Map<string, Backend>();

    // Everything configured and permitted, whether or not it is in the chain.
    for (const name of Object.keys(config.backends)) {
      const spec = config.backends[name];
      if (!spec) continue;
      const backend = build(spec);
      if (backend.cloud && !config.allowCloud) continue;
      allowed.set(name, backend);
    }

    for (const name of config.chain) {
      if (!config.backends[name]) {
        skipped.push({ name, reason: "unknown backend name; add it to `backends` in the config file" });
        continue;
      }
      const backend = allowed.get(name);
      if (!backend) {
        skipped.push({
          name,
          reason: "sends state off this machine; set allowCloud in the config file or ADECIDER_ALLOW_CLOUD=1",
        });
        continue;
      }
      chain.push(backend);
    }

    return new BackendChain(Array.from(allowed.values()), chain, skipped);
  }

  /** The automatic selection order. */
  names(): string[] {
    return this.chain.map((backend) => backend.name);
  }

  /** Every backend that can be named. */
  allNames(): string[] {
    return this.backends.map((backend) => backend.name);
  }

  get(name: string): Backend | undefined {
    return this.backends.find((backend) => backend.name === name);
  }

  inChain(name: string): boolean {
    return this.chain.some((backend) => backend.name === name);
  }

  /** Probe one backend, reusing a result younger than the TTL. */
  async health(name: string, signal?: AbortSignal): Promise<Health> {
    const backend = this.get(name);
    if (!backend) {
      return { ok: false, detail: `no backend named ${JSON.stringify(name)} in the chain` };
    }
    const cached = this.healthCache.get(name);
    const now = Date.now();
    if (cached && now - cached.at < HEALTH_TTL_MS) return cached.health;

    const health = await backend.health(signal);
    this.healthCache.set(name, { at: now, health });
    return health;
  }

  /** Probe every nameable backend, for status and for the model catalogue. */
  async healthAll(
    signal?: AbortSignal
  ): Promise<Array<{ backend: Backend; inChain: boolean; health: Health }>> {
    return Promise.all(
      this.backends.map(async (backend) => ({
        backend,
        inChain: this.inChain(backend.name),
        health: await this.health(backend.name, signal),
      }))
    );
  }

  /**
   * Pick a backend. With an explicit name the chain order and health are irrelevant: the caller
   * asked for that backend, so a failure must surface as a failure.
   */
  async select(explicit?: string, signal?: AbortSignal): Promise<Backend> {
    if (explicit) {
      const named = this.get(explicit);
      if (named) return named;
      const skippedEntry = this.skipped.find((entry) => entry.name === explicit);
      if (skippedEntry) {
        throw new SystemOneError(
          "unconfigured",
          `backend ${JSON.stringify(explicit)} is configured but unusable: ${skippedEntry.reason}`,
          explicit
        );
      }
      const known = this.allNames();
      throw new SystemOneError(
        "bad_request",
        known.length > 0
          ? `no backend named ${JSON.stringify(explicit)}; available backends are ${known.join(", ")}`
          : `no backend named ${JSON.stringify(explicit)} and none are configured` +
            (this.skipped.length > 0
              ? ` (skipped: ${this.skipped.map((s) => `${s.name}: ${s.reason}`).join("; ")})`
              : "")
      );
    }

    const failures: string[] = [];
    for (const backend of this.chain) {
      const health = await this.health(backend.name, signal);
      if (health.ok) return backend;
      failures.push(`${backend.name}: ${health.detail}`);
    }

    const extras = this.backends.filter((backend) => !this.inChain(backend.name)).map((b) => b.name);
    throw new SystemOneError(
      "unreachable",
      this.chain.length === 0
        ? "no backend is available" +
          (this.skipped.length > 0
            ? `; skipped ${this.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}`
            : "; check ~/.pi/agent/adecider.json")
        : `no backend in the chain answered a health probe: ${failures.join("; ")}` +
          (extras.length > 0
            ? `. Configured but not in the chain, so not used automatically: ${extras.join(", ")}`
            : "")
    );
  }

  /** Select and judge in one step. */
  async decide(request: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResponse> {
    const backend = await this.select(request.backend, signal);
    return backend.decide(request, signal);
  }
}
