/**
 * test/_helpers/make-poll-env.ts
 *
 * Env stub para o Worker de poll — fixture repetida (byte-similar, mesma
 * forma) em poll-hardening-2188-2189-2190-2191.test.ts, poll-snapshot-2123.test.ts
 * e poll-snapshot-2152-2129.test.ts (#2836). Secrets têm default de
 * "test-secret"/"test-admin" (poll-snapshot-*); poll-hardening usa valores
 * próprios via overrides.
 */
import type { Env } from "../../workers/poll/src/index.ts";
import type { makeTrackedKv } from "./make-tracked-kv.ts";

export function makePollEnv(
  kv: ReturnType<typeof makeTrackedKv>,
  overrides: { pollSecret?: string; adminSecret?: string } = {},
): Env {
  return {
    POLL: kv as unknown as KVNamespace,
    POLL_SECRET: overrides.pollSecret ?? "test-secret",
    ADMIN_SECRET: overrides.adminSecret ?? "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}
