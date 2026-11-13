/**
 * scripts/lib/failover/lease-memory.ts (#12982)
 *
 * Memória LOCAL do último lease `infra:scheduler-owner` lido com sucesso
 * nesta máquina (`LeaseMemory` de `scheduler-lease.ts`). Serve a duas
 * decisões do `300`:
 *   - KV ilegível: o fail-open só vale se o último lease conhecido era do
 *     próprio `300` ou ausente; se era do Neo, fail-closed até ler o KV;
 *   - lease do Neo renovado entre duas leituras com o `300` de pé: alarme.
 *
 * Fica FORA do `data/` (sincronizado entre máquinas pelo Drive): é memória da
 * máquina, e a cópia de outra máquina mentiria. Default
 * `~/.diaria/failover-last-lease.json`; `DIARIA_FAILOVER_STATE_FILE`
 * sobrepõe (ensaio, teste manual).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseLease, type LastKnownLease, type LeaseMemory } from "./scheduler-lease.ts";

export function defaultLeaseMemoryPath(env: Record<string, string | undefined> = process.env): string {
  const override = (env.DIARIA_FAILOVER_STATE_FILE ?? "").trim();
  return override || join(homedir(), ".diaria", "failover-last-lease.json");
}

/** Parse do arquivo; qualquer coisa fora do formato vira `null` (sem memória). */
export function parseLastKnown(raw: string): LastKnownLease | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.seenAt !== "string") return null;
  if (r.kind === "absent") return { kind: "absent", seenAt: r.seenAt };
  if (r.kind !== "ok") return null;
  const lease = parseLease(JSON.stringify(r.lease ?? null));
  return lease.kind === "ok" ? { kind: "ok", lease: lease.lease, seenAt: r.seenAt } : null;
}

export function fileLeaseMemory(path: string): LeaseMemory {
  return {
    load() {
      try {
        return parseLastKnown(readFileSync(path, "utf8"));
      } catch {
        return null;
      }
    },
    save(value) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(value), "utf8");
      renameSync(tmp, path);
    },
  };
}
