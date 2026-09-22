/**
 * The extension-to-extension RPC channel used to reach a subagent runner.
 *
 * These event names are not part of pi's public API: they are a convention between this adapter and
 * a subagents extension, and pi-jev uses exactly these strings. Keeping them identical is deliberate,
 * so this adapter interops with the same runner rather than inventing a second protocol.
 *
 * Nothing here assumes the runner exists. A missing runner produces an error, not a hang: the
 * request waits on the reply event with a bounded timeout.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RPC_REQUEST = "subagents:rpc:v1:request";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const ASYNC_COMPLETE = "subagent:async-complete";

export const RPC_TIMEOUT_MS = 10_000;

export interface RpcReply {
  success?: boolean;
  data?: { runId?: string; id?: string; output?: string; result?: unknown };
  error?: { message?: string };
}

/** Send one request and wait for its reply, or time out. Never throws. */
export async function rpcCall(
  pi: ExtensionAPI,
  method: string,
  params: Record<string, unknown>,
  source: string
): Promise<RpcReply> {
  const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;

  return await new Promise<RpcReply>((resolve) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolve({ success: false, error: { message: "no reply from the subagent runner (timed out)" } });
    }, RPC_TIMEOUT_MS);

    unsubscribe = pi.events.on(replyEvent, (reply: unknown) => {
      clearTimeout(timer);
      unsubscribe();
      resolve((reply ?? {}) as RpcReply);
    });

    pi.events.emit(RPC_REQUEST, {
      version: 1,
      requestId,
      method,
      source: { extension: source },
      params,
    });
  });
}
