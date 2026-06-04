#!/usr/bin/env node
/**
 * verify-emails-mv.ts
 *
 * Verifica uma lista de emails no MillionVerifier antes de mandar pro Brevo,
 * pra proteger a reputação do IP/domínio (bounce alto degrada deliverability
 * de TODAS as listas no mesmo IP — ver #1297).
 *
 * Usa a **Single Verification API** (api.millionverifier.com/api/v3), não a
 * bulk: o contrato JSON por email é determinístico (split confiável por
 * `result`) e o run é **resumível** via checkpoint — se cair no meio, re-rodar
 * não re-verifica (nem re-gasta crédito) o que já foi feito.
 *
 * Uso:
 *   npx tsx scripts/verify-emails-mv.ts                          # T02 (default)
 *   npx tsx scripts/verify-emails-mv.ts --input brevo-import-t03.csv
 *   npx tsx scripts/verify-emails-mv.ts --single foo@bar.com     # smoke (1 crédito)
 *   npx tsx scripts/verify-emails-mv.ts --limit 50               # só os 50 primeiros
 *   npx tsx scripts/verify-emails-mv.ts --concurrency 20
 *
 * Env:
 *   MILLION_VERIFIER_API_KEY   obrigatório (dashboard MV → API)
 *
 * Input  (em data/clarice-subscribers/):
 *   brevo-import-t02.csv       colunas: email,NOME,OPEN_PROBABILITY
 *
 * Output (em data/clarice-subscribers/, basename do input):
 *   brevo-import-t02-verified.csv   result ok | catch_all   → MANDAR pro Brevo
 *   brevo-import-t02-rejected.csv   result invalid | disposable → EXCLUIR
 *   brevo-import-t02-unknown.csv    unknown | reverify | error  → inconclusivo
 *   .mv-cache-brevo-import-t02.json checkpoint resumível (gitignored via data/)
 *
 * Stdout: JSON sumário; stderr: progresso humano-legível.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import Papa from "papaparse";

const ROOT = resolve(import.meta.dirname, "..");
const DATA_DIR = resolve(ROOT, "data/clarice-subscribers");
const API_BASE = "https://api.millionverifier.com/api/v3";

// ---------------------------------------------------------------------------
// Classificação — MV `result` → bucket de ação editorial
// ---------------------------------------------------------------------------

export type Bucket = "verified" | "rejected" | "unknown";

/**
 * Mapeia o `result` da MV pro bucket de ação.
 *   ok | catch_all       → verified  (entregável; mandar)
 *   invalid | disposable → rejected  (bounce garantido / descartável; excluir)
 *   resto                → unknown   (unknown, reverify, unverified, error, "")
 *
 * Conservador de propósito: só exclui o que a MV afirma ser ruim. `catch_all`
 * (domínio aceita tudo) vai pra `verified` porque excluir catch-all derrubaria
 * domínios corporativos legítimos — o risco de bounce de catch_all é baixo.
 */
export function classifyResult(result: string | undefined | null): Bucket {
  const r = (result ?? "").trim().toLowerCase();
  if (r === "ok" || r === "catch_all") return "verified";
  if (r === "invalid" || r === "disposable") return "rejected";
  return "unknown";
}

/** Monta a URL da single-verification API (testável sem rede). */
export function buildVerifyUrl(
  apiKey: string,
  email: string,
  timeoutSec = 20,
): string {
  const u = new URL(API_BASE);
  u.searchParams.set("api", apiKey);
  u.searchParams.set("email", email);
  u.searchParams.set("timeout", String(timeoutSec));
  return u.toString();
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface MvResponse {
  email?: string;
  result?: string;
  resultcode?: number;
  quality?: string;
  subresult?: string;
  credits?: number;
  error?: string;
}

/** Estado persistido por email no checkpoint. */
interface CachedResult {
  result: string;
  resultcode: number;
  quality: string;
}

type Checkpoint = Record<string, CachedResult>;

// ---------------------------------------------------------------------------
// Erro que sinaliza "pare tudo" (key inválida, sem crédito) — diferente de um
// erro transitório de rede que deve ser retried.
// ---------------------------------------------------------------------------

class FatalApiError extends Error {}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/** Lê o input preservando TODAS as colunas. Retorna linhas + nome da coluna de email. */
export function readInput(path: string): {
  rows: Record<string, string>[];
  emailKey: string;
} {
  const text = readFileSync(path, "utf-8");
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const fields = parsed.meta.fields ?? [];
  // Coluna de email: "email" (case-insensitive) ou a 1ª coluna como fallback.
  const emailKey =
    fields.find((f) => f.trim().toLowerCase() === "email") ?? fields[0];
  if (!emailKey) {
    throw new Error(`CSV sem colunas detectáveis: ${path}`);
  }
  return { rows: parsed.data, emailKey };
}

/**
 * Divide as linhas do input nos 3 buckets usando os resultados do checkpoint.
 * Anexa colunas MV_RESULT / MV_QUALITY / MV_CODE preservando as originais.
 * Email sem resultado no checkpoint cai em `unknown` (não verificado ainda).
 */
export function splitRows(
  rows: Record<string, string>[],
  emailKey: string,
  results: Checkpoint,
): Record<Bucket, Record<string, string>[]> {
  const out: Record<Bucket, Record<string, string>[]> = {
    verified: [],
    rejected: [],
    unknown: [],
  };
  for (const row of rows) {
    const email = (row[emailKey] ?? "").trim().toLowerCase();
    const res = results[email];
    const bucket = classifyResult(res?.result);
    out[bucket].push({
      ...row,
      MV_RESULT: res?.result ?? "",
      MV_QUALITY: res?.quality ?? "",
      MV_CODE: res?.resultcode != null ? String(res.resultcode) : "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP — single verification com retry em erro transitório
// ---------------------------------------------------------------------------

const RETRYABLE_DELAYS_MS = [1000, 3000, 9000];

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function verifyOne(
  apiKey: string,
  email: string,
  timeoutSec: number,
): Promise<MvResponse> {
  const url = buildVerifyUrl(apiKey, email, timeoutSec);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= RETRYABLE_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRYABLE_DELAYS_MS[attempt - 1]);
    const ctrl = new AbortController();
    // Abort client-side um pouco depois do timeout que a MV honra server-side.
    const t = setTimeout(() => ctrl.abort(), (timeoutSec + 10) * 1000);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      // 4xx (exceto 429) é provavelmente config — não adianta retry.
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }
      const json = (await resp.json()) as MvResponse;
      const err = (json.error ?? "").trim();
      if (err) {
        // Erros fatais conhecidos: key inválida / sem crédito → parar tudo.
        const low = err.toLowerCase();
        if (
          low.includes("api key") ||
          low.includes("apikey") ||
          low.includes("credit") ||
          low.includes("not enough")
        ) {
          throw new FatalApiError(err);
        }
        lastErr = new Error(err);
        continue;
      }
      return json;
    } catch (e) {
      if (e instanceof FatalApiError) throw e;
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(
    `falha ao verificar ${email} após ${RETRYABLE_DELAYS_MS.length + 1} tentativas: ${String(lastErr)}`,
  );
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

function loadCheckpoint(path: string): Checkpoint {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Checkpoint;
  } catch {
    console.error(`⚠️  checkpoint corrompido em ${path} — começando do zero`);
    return {};
  }
}

function saveCheckpoint(path: string, cp: Checkpoint): void {
  writeFileSync(path, JSON.stringify(cp, null, 0), "utf-8");
}

// ---------------------------------------------------------------------------
// Pool de concorrência limitada
// ---------------------------------------------------------------------------

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function loop(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      await worker(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => loop()));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  input: string;
  concurrency: number;
  timeout: number;
  limit: number | null;
  single: string | null;
}

export function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    input: get("--input") ?? "brevo-import-t02.csv",
    concurrency: parseInt(get("--concurrency") ?? "12", 10),
    timeout: parseInt(get("--timeout") ?? "20", 10),
    limit: get("--limit") ? parseInt(get("--limit")!, 10) : null,
    single: get("--single") ?? null,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const apiKey = process.env.MILLION_VERIFIER_API_KEY;
  if (!apiKey) {
    console.error(
      "MILLION_VERIFIER_API_KEY não definida. Configure no .env (veja .env.example) " +
        "ou no ambiente. Pegue a key no dashboard MillionVerifier → API.",
    );
    process.exit(1);
  }

  const args = parseArgs(argv);

  // --- Modo smoke: verifica 1 email e imprime a resposta crua (1 crédito) ---
  if (args.single) {
    try {
      const res = await verifyOne(apiKey, args.single, args.timeout);
      console.error(
        `✅ ${args.single} → result=${res.result} quality=${res.quality} ` +
          `code=${res.resultcode} bucket=${classifyResult(res.result)} ` +
          `(créditos restantes: ${res.credits ?? "?"})`,
      );
      console.log(JSON.stringify(res, null, 2));
    } catch (e) {
      console.error(`❌ ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // --- Modo lista ---
  const inputPath = resolve(DATA_DIR, args.input);
  if (!existsSync(inputPath)) {
    console.error(`input não encontrado: ${inputPath}`);
    process.exit(1);
  }

  const base = basename(args.input).replace(/\.csv$/i, "");
  const cpPath = resolve(DATA_DIR, `.mv-cache-${base}.json`);

  const { rows, emailKey } = readInput(inputPath);
  console.error(`📂 ${args.input}: ${rows.length} linhas (coluna email="${emailKey}")`);

  // Emails únicos, normalizados.
  const allEmails = [
    ...new Set(
      rows
        .map((r) => (r[emailKey] ?? "").trim().toLowerCase())
        .filter((e) => e.length > 0),
    ),
  ];

  const checkpoint = loadCheckpoint(cpPath);
  const cached = Object.keys(checkpoint).length;

  let todo = allEmails.filter((e) => !(e in checkpoint));
  if (args.limit != null) todo = todo.slice(0, args.limit);

  console.error(
    `📊 ${allEmails.length} emails únicos · ${cached} já no checkpoint · ` +
      `${todo.length} a verificar${args.limit != null ? ` (limit ${args.limit})` : ""}`,
  );

  // Flush periódico + em SIGINT (protege os créditos já gastos).
  let dirty = 0;
  const flush = () => {
    if (dirty > 0) {
      saveCheckpoint(cpPath, checkpoint);
      dirty = 0;
    }
  };
  let aborting = false;
  const onSignal = () => {
    aborting = true;
    flush();
    console.error("\n⏸️  interrompido — checkpoint salvo. Re-rode pra continuar.");
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let done = 0;
  let lastCredits: number | null = null;
  const failures: string[] = [];

  if (todo.length > 0) {
    try {
      await runPool(todo, args.concurrency, async (email) => {
        if (aborting) return;
        try {
          const res = await verifyOne(apiKey, email, args.timeout);
          checkpoint[email] = {
            result: res.result ?? "",
            resultcode: res.resultcode ?? -1,
            quality: res.quality ?? "",
          };
          if (typeof res.credits === "number") lastCredits = res.credits;
          dirty++;
        } catch (e) {
          if (e instanceof FatalApiError) throw e;
          failures.push(email);
        }
        done++;
        if (done % 100 === 0) {
          flush();
          console.error(
            `  …${done}/${todo.length}` +
              (lastCredits != null ? ` (créditos: ${lastCredits})` : ""),
          );
        }
      });
    } catch (e) {
      if (e instanceof FatalApiError) {
        flush();
        console.error(`❌ erro fatal da API MillionVerifier: ${e.message}`);
        console.error("   checkpoint salvo — corrija e re-rode pra retomar.");
        process.exit(1);
      }
      throw e;
    }
  }

  flush();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  // --- Split + write outputs ---
  const split = splitRows(rows, emailKey, checkpoint);
  const writeBucket = (bucket: Bucket): number => {
    const path = resolve(DATA_DIR, `${base}-${bucket}.csv`);
    writeFileSync(path, Papa.unparse(split[bucket]), "utf-8");
    return split[bucket].length;
  };
  const counts = {
    verified: writeBucket("verified"),
    rejected: writeBucket("rejected"),
    unknown: writeBucket("unknown"),
  };

  if (failures.length) {
    console.error(
      `⚠️  ${failures.length} emails falharam (erro transitório, ficam em unknown até re-rodar)`,
    );
  }

  const summary = {
    input: args.input,
    total_rows: rows.length,
    unique_emails: allEmails.length,
    verified_now: done - failures.length,
    failed_now: failures.length,
    credits_remaining: lastCredits,
    buckets: counts,
    outputs: {
      verified: `${base}-verified.csv`,
      rejected: `${base}-rejected.csv`,
      unknown: `${base}-unknown.csv`,
    },
  };
  console.error(
    `\n✅ verified=${counts.verified} · rejected=${counts.rejected} · unknown=${counts.unknown}` +
      (lastCredits != null ? ` · créditos restantes=${lastCredits}` : ""),
  );
  console.log(JSON.stringify(summary, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
