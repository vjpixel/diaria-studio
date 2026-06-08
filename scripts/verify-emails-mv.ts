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
 *   npx tsx scripts/verify-emails-mv.ts --cycle 2605-06                          # T02 (default)
 *   npx tsx scripts/verify-emails-mv.ts --cycle 2605-06 --input stripe-export-t03-leads-2026-jan-abr.csv
 *   npx tsx scripts/verify-emails-mv.ts --single foo@bar.com     # smoke (1 crédito; sem --cycle)
 *   npx tsx scripts/verify-emails-mv.ts --cycle 2605-06 --limit 50               # só os 50 primeiros
 *   npx tsx scripts/verify-emails-mv.ts --cycle 2605-06 --concurrency 20
 *   (--cycle {conteúdo}-{envio} é OBRIGATÓRIO no modo lista; as saídas vivem em {ciclo}/, #1961)
 *
 * Env:
 *   MILLION_VERIFIER_API_KEY   obrigatório (dashboard MV → API)
 *
 * Input  (BASE, no root data/clarice-subscribers/):
 *   stripe-export-t02-ex-assinantes.csv   colunas: email,NOME,OPEN_PROBABILITY
 *
 * Output (POR-CICLO, em data/clarice-subscribers/{conteúdo}-{envio}/, basename do input):
 *   stripe-export-t02-ex-assinantes-verified.csv   result ok | catch_all   → MANDAR pro Brevo
 *   stripe-export-t02-ex-assinantes-rejected.csv   result invalid | disposable → EXCLUIR
 *   stripe-export-t02-ex-assinantes-unknown.csv    unknown | reverify | error  → inconclusivo
 *   .mv-cache-stripe-export-t02-ex-assinantes.json checkpoint resumível (gitignored via data/)
 *
 * Stdout: JSON sumário; stderr: progresso humano-legível.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { clariceBaseFile, clariceCycleDir, ensureDir, parseCycleArg } from "./lib/clarice-paths.ts"; // #1961

// .env.local (precedência) + .env — loader canônico do projeto (#923).
// Bare `dotenv/config` não carrega .env.local, onde os secrets costumam morar.
loadProjectEnv();
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

/** Lê o input preservando TODAS as colunas. Retorna linhas + colunas + nome da coluna de email. */
export function readInput(path: string): {
  rows: Record<string, string>[];
  fields: string[];
  emailKey: string;
} {
  const text = readFileSync(path, "utf-8");
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const fields = parsed.meta.fields ?? [];
  // Coluna de email: nome contendo "email"/"e-mail" (case-insensitive).
  // Sem fallback pra fields[0]: mandar a coluna errada (ex: NOME) pro MV
  // queimaria 1 crédito por linha em lixo. Melhor falhar alto.
  const emailKey = fields.find((f) => /e-?mail/i.test(f.trim()));
  if (!emailKey) {
    throw new Error(
      `CSV sem coluna de email (colunas: ${fields.join(", ") || "nenhuma"}): ${path}`,
    );
  }
  return { rows: parsed.data, fields, emailKey };
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
      // 429 / 5xx = transitório → retry (libera o socket antes de continuar).
      if (resp.status === 429 || resp.status >= 500) {
        await resp.body?.cancel().catch(() => {});
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }
      // Outro 4xx (401/403/400) = auth/config — não adianta retry. Corpo pode
      // ser HTML (não-JSON), então NÃO chamar resp.json() aqui: trata como fatal
      // pra parar o run em vez de jogar a lista inteira em `unknown`.
      if (resp.status >= 400) {
        const body = await resp.text().catch(() => "");
        throw new FatalApiError(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
      }
      let json: MvResponse;
      try {
        json = (await resp.json()) as MvResponse;
      } catch {
        lastErr = new Error("resposta não-JSON da API");
        continue;
      }
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
  // Atômico (tmp+fsync+rename): SIGINT/SIGKILL no meio de um writeFileSync
  // normal deixaria o checkpoint truncado → loadCheckpoint descarta tudo →
  // todos os créditos já gastos são perdidos no re-run.
  writeFileAtomic(path, JSON.stringify(cp, null, 0));
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
  cycle: string;
}

/** parseInt com fallback: rejeita NaN e ≤0 (senão `--concurrency abc` → NaN
 *  → 0 workers → pool não faz nada e tudo vira `unknown` silenciosamente). */
function posInt(v: string | undefined, fallback: number): number {
  if (v == null) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const rawLimit = get("--limit");
  const parsedLimit = rawLimit != null ? parseInt(rawLimit, 10) : NaN;
  return {
    input: get("--input") ?? "stripe-export-t02-ex-assinantes.csv",
    concurrency: posInt(get("--concurrency"), 12),
    timeout: posInt(get("--timeout"), 20),
    // --limit aceita 0 (no-op proposital); só null quando ausente/inválido.
    limit: Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : null,
    single: get("--single") ?? null,
    // #1961: valida formato/semântica do ciclo (igual import-waves); "" se inválido → main aborta limpo.
    cycle: parseCycleArg(argv),
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
  // #1961: input é a BASE (tier no root, output da merge); as saídas verificadas
  // + cache são POR-CICLO → vivem em data/clarice-subscribers/{conteúdo}-{envio}/.
  if (!args.cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (saídas em {ciclo}/ — ex: --cycle 2605-06).");
    process.exit(1);
  }
  const cycleDir = clariceCycleDir(args.cycle);
  const inputPath = clariceBaseFile(args.input);
  if (!existsSync(inputPath)) {
    console.error(`input não encontrado: ${inputPath}`);
    process.exit(1);
  }
  // Só cria a pasta do ciclo DEPOIS de validar o input — senão um typo no
  // --input deixa um dir de ciclo vazio órfão (que ainda sincroniza pro OneDrive).
  ensureDir(cycleDir);

  const base = basename(args.input).replace(/\.csv$/i, "");
  const cpPath = resolve(cycleDir, `.mv-cache-${base}.json`);

  const { rows, fields, emailKey } = readInput(inputPath);
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
          // Mínimo visto (não o último): sob concorrência as respostas chegam
          // fora de ordem, então `último` poderia "subir" e superestimar o saldo.
          if (typeof res.credits === "number") {
            lastCredits = lastCredits == null ? res.credits : Math.min(lastCredits, res.credits);
          }
          dirty++;
        } catch (e) {
          if (e instanceof FatalApiError) {
            aborting = true; // sinaliza os workers irmãos a pararem de queimar crédito
            throw e;
          }
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
  // Colunas fixas (originais + MV_*) pra header SEMPRE sair, mesmo em bucket
  // vazio — Papa.unparse([]) gera string vazia (CSV sem header) que quebra import.
  const outFields = [...fields, "MV_RESULT", "MV_QUALITY", "MV_CODE"];
  const writeBucket = (bucket: Bucket): number => {
    const path = resolve(cycleDir, `${base}-${bucket}.csv`);
    writeFileSync(path, Papa.unparse({ fields: outFields, data: split[bucket] }), "utf-8");
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
    // Quantos emails foram efetivamente verificados via API NESTE run (≠ bucket
    // verified, que reflete o checkpoint inteiro incluindo runs anteriores).
    processed_this_run: done - failures.length,
    failed_this_run: failures.length,
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
