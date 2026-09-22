/**
 * The model catalogue: one namespace over every transport.
 *
 * The point is that a caller selects a *model* and does not care how it is reached. `english` is a
 * checkpoint inside a local HTTP service, `jev-latest` is a hosted model behind an API key, and a
 * served id from a local llama.cpp server is a third kind, but all three are one selector, one
 * request shape, and one response shape.
 *
 * Model ids come from each backend's own health probe rather than a hard-coded list, so a service
 * that loads a different checkpoint is described correctly instead of described from memory.
 *
 * A model can be named three ways:
 *
 * - bare, when unambiguous: `english`
 * - qualified by transport: `laya-mlx:english`, `jev:jev-latest`
 * - by transport alone, which selects that transport's own default
 */

import type { Calibration } from "./types.ts";
import { SystemOneError } from "./errors.ts";
import type { Backend, BackendChain } from "./backends/index.ts";

export interface ModelEntry {
  /** What a caller passes as `model`. Unique across the catalogue. */
  id: string;
  /** Transport that answers: the `backend` value. */
  backend: string;
  /** Provider-side identifier for the checkpoint, model, or hosted model name. */
  checkpoint: string;
  kind: string;
  calibration: Calibration;
  cloud: boolean;
  contextTokens: number;
  detail: string;
}

function qualify(backend: string, checkpoint: string): string {
  return `${backend}:${checkpoint}`;
}

/** Build the catalogue by probing every backend in the chain. */
export async function modelCatalogue(
  chain: BackendChain,
  signal?: AbortSignal
): Promise<ModelEntry[]> {
  const probed = await chain.healthAll(signal);
  const entries: ModelEntry[] = [];

  for (const { backend, health } of probed) {
    if (!health.ok) continue;
    const checkpoints = health.models && health.models.length > 0 ? health.models : [undefined];
    for (const checkpoint of checkpoints) {
      entries.push({
        id: qualify(backend.name, checkpoint ?? "default"),
        backend: backend.name,
        checkpoint: checkpoint ?? "",
        kind: backend.kind,
        calibration: backend.calibration,
        cloud: backend.cloud,
        contextTokens: backend.contextTokensFor(checkpoint),
        detail: health.detail,
      });
    }
  }

  return entries;
}

export interface ResolvedModel {
  backend: Backend;
  /** The checkpoint to pass to the backend, empty when the backend decides. */
  checkpoint: string;
  entry?: ModelEntry;
}

/**
 * Resolve a `model` selector to a backend.
 *
 * Returns null when the selector names nothing in the catalogue and does not look qualified, in
 * which case the caller passes it through to whichever backend the chain selected: a hosted provider
 * may accept a model id this machine cannot enumerate without spending a request.
 */
export async function resolveModel(
  chain: BackendChain,
  selector: string,
  signal?: AbortSignal
): Promise<ResolvedModel | null> {
  // A transport-qualified selector never needs a probe: the transport is named outright.
  const colon = selector.indexOf(":");
  if (colon > 0) {
    const backendName = selector.slice(0, colon);
    const checkpoint = selector.slice(colon + 1);
    // Selecting through the chain keeps the typed reasons honest: a backend that is configured but
    // excluded for privacy is named as such (select reads `skipped`) instead of being reported as
    // missing, and an unknown name lists what can be named.
    return { backend: await chain.select(backendName, signal), checkpoint };
  }

  const catalogue = await modelCatalogue(chain, signal);
  const matches = catalogue.filter(
    (entry) => entry.checkpoint === selector || entry.id === selector
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new SystemOneError(
      "bad_request",
      `model ${JSON.stringify(selector)} is served by more than one backend: ` +
        `${matches.map((entry) => entry.id).join(", ")}. Qualify it with the transport.`
    );
  }
  const entry = matches[0] as ModelEntry;
  const backend = chain.get(entry.backend);
  if (!backend) {
    throw new SystemOneError("bad_request", `model ${JSON.stringify(selector)} names a backend that is not in the chain`, entry.backend);
  }
  return { backend, checkpoint: entry.checkpoint, entry };
}
