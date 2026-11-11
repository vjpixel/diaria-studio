/**
 * d1-locks-setup.ts (#12842) — provisiona o banco D1 dos locks entre máquinas
 * e roda o teste real mínimo contra ele.
 *
 *   npx tsx scripts/d1-locks-setup.ts            # cria (se faltar) + schema + teste
 *   npx tsx scripts/d1-locks-setup.ts --check    # só o teste, no banco do config (sem CREATE TABLE)
 *
 * Passos: acha o banco `d1_locks.database_name` (default `diaria-locks`) pela
 * API ou cria; aplica `D1_LOCKS_SCHEMA_SQL` (idempotente); roda o teste
 * mínimo com uma linha `smoke:{aleatório}` — adquire como A, confere que B
 * é recusado, que B não solta o lock de A, solta como A, confere que a linha
 * sumiu — e apaga a linha de teste em qualquer desfecho. No fim imprime o
 * `database_id` para gravar em `platform.config.json` → `d1_locks.database_id`.
 *
 * Custo: D1 está incluído no plano Workers Paid da conta; o banco é reversível
 * (`DELETE /accounts/{id}/d1/database/{db}`). Token: `CLOUDFLARE_D1_TOKEN`
 * (permissão "D1 Edit") ou `CLOUDFLARE_API_TOKEN`. Nunca imprime o token.
 *
 * Exit: 0 ok · 1 falha de API/teste · 2 credencial/uso.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  D1_LOCKS_SCHEMA_SQL,
  type D1Client,
  createD1RestClient,
  d1AcquireLock,
  d1ReadLock,
  d1ReleaseLock,
} from "./lib/d1-locks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.cloudflare.com/client/v4";

interface Cf<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

async function cf<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Cf<T>;
  if (!res.ok || json.success === false || json.result === undefined) {
    const msg = (json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`${method} ${path.replace(/accounts\/[^/]+/, "accounts/…")}: HTTP ${res.status} ${msg}`);
  }
  return json.result;
}

/** Teste mínimo real: devolve a lista de checagens que falharam (vazia = ok). */
export async function runSmokeTest(d1: D1Client, name = `smoke:${randomUUID()}`): Promise<string[]> {
  const fails: string[] = [];
  try {
    const a = await d1AcquireLock(d1, name, "smoke-A", 60_000);
    if (!a.ok || !a.value.acquired) fails.push(`A não adquiriu: ${JSON.stringify(a)}`);
    const b = await d1AcquireLock(d1, name, "smoke-B", 60_000);
    if (!b.ok || b.value.acquired || b.value.current?.holder !== "smoke-A") fails.push(`B não foi recusado: ${JSON.stringify(b)}`);
    const rb = await d1ReleaseLock(d1, name, "smoke-B");
    if (!rb.ok || rb.value !== "held_by_other") fails.push(`release por B não recusou: ${JSON.stringify(rb)}`);
    const ra = await d1ReleaseLock(d1, name, "smoke-A");
    if (!ra.ok || ra.value !== "released") fails.push(`release por A falhou: ${JSON.stringify(ra)}`);
    const after = await d1ReadLock(d1, name);
    if (!after.ok || after.value !== null) fails.push(`linha ainda presente após release: ${JSON.stringify(after)}`);
  } finally {
    // Nunca deixa a linha de teste para trás, passe ou falhe — e, se a
    // limpeza falhar, diz qual linha ficou (ela vence sozinha em 60 s).
    await d1.query("DELETE FROM locks WHERE name = ?1", [name]).catch((e: unknown) => {
      console.error(
        `[d1-locks-setup] aviso: não apaguei a linha de teste "${name}" (${(e as Error)?.message ?? String(e)}); ela vence em 60 s.`,
      );
    });
  }
  return fails;
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const { flags } = parseArgs(process.argv.slice(2));
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const token = (process.env.CLOUDFLARE_D1_TOKEN ?? "").trim() || (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  if (!accountId || !token) {
    console.error("[d1-locks-setup] CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_D1_TOKEN (ou CLOUDFLARE_API_TOKEN) são obrigatórios.");
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as {
    d1_locks?: { database_id?: string | null; database_name?: string };
  };
  const dbName = cfg.d1_locks?.database_name || "diaria-locks";
  let databaseId = cfg.d1_locks?.database_id || "";
  const acct = `/accounts/${encodeURIComponent(accountId)}`;

  if (flags.has("check")) {
    if (!databaseId) {
      console.error("[d1-locks-setup] --check sem d1_locks.database_id no platform.config.json.");
      process.exit(2);
    }
  } else if (!databaseId) {
    const list = await cf<Array<{ uuid: string; name: string }>>(token, "GET", `${acct}/d1/database?name=${encodeURIComponent(dbName)}`);
    const existing = list.find((d) => d.name === dbName);
    if (existing) {
      databaseId = existing.uuid;
      console.log(`[d1-locks-setup] banco existente: ${dbName} (${databaseId})`);
    } else {
      const created = await cf<{ uuid: string }>(token, "POST", `${acct}/d1/database`, { name: dbName });
      databaseId = created.uuid;
      console.log(`[d1-locks-setup] banco criado: ${dbName} (${databaseId})`);
    }
  }
  const d1 = createD1RestClient({ accountId, token, databaseId, timeoutMs: 15_000 });
  if (flags.has("check")) {
    console.log("[d1-locks-setup] --check: schema não aplicado (só o teste; tabela ausente falha como `no such table`)");
  } else {
    await d1.query(D1_LOCKS_SCHEMA_SQL, []);
    console.log("[d1-locks-setup] schema ok (tabela locks)");
  }
  const fails = await runSmokeTest(d1);
  if (fails.length > 0) {
    console.error(`[d1-locks-setup] teste FALHOU:\n  - ${fails.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("[d1-locks-setup] teste ok: A adquiriu, B recusado, B não soltou o lock de A, A soltou, linha apagada.");
  console.log(JSON.stringify({ database_name: dbName, database_id: databaseId }));
  if (cfg.d1_locks?.database_id !== databaseId) {
    console.log(`Grave em platform.config.json → d1_locks.database_id: "${databaseId}"`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[d1-locks-setup] erro: ${(e as Error).message}`);
    process.exit(1);
  });
}
