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
 *   npx tsx scripts/verify-emails-mv.ts --cycle 2605-06                          # ex-assinantes (default)
 *   npx tsx scripts/verify-emails-mv.ts --cycle 2605-06 --cohort leads-2026-06
 *   npx tsx scripts/verify-emails-mv.ts --single foo@bar.com     # smoke (1 crédito; sem --cycle)
 *   npx tsx scripts/verify-emails-mv.ts --cycle 2605-06 --limit 50               # só os 50 primeiros
 *   npx tsx scripts/verify-emails-mv.ts --cycle 2605-06 --concurrency 20
 *   (--cycle {conteúdo}-{envio} é OBRIGATÓRIO no modo lista; as saídas vivem em {ciclo}/, #1961)
 *
 * Env:
 *   MILLION_VERIFIER_API_KEY   obrigatório (dashboard MV → API)
 *
 * MIGRAÇÃO (#2886 PR3 — SOURCE eliminada, fonte agora é o store): a lista de
 * candidatos a verificar deixou de vir de um CSV (`stripe-export-{cohort}.csv`)
 * e passa a ser derivada DIRETO do store (`clarice_users`), via:
 *
 *   SELECT email, name FROM clarice_users WHERE cohort = ? AND MV_NEVER_VERIFIED_SQL
 *   (MV_NEVER_VERIFIED_SQL = "(mv_bucket IS NULL OR mv_bucket = '')", clarice-db.ts)
 *
 * Semântica de re-verificação (decisão do editor, #2886): um contato que JÁ
 * foi verificado em QUALQUER ciclo anterior (`mv_bucket` preenchido) é
 * PULADO PARA SEMPRE — nunca re-verificado, mesmo em ciclos futuros. Isso é
 * deliberado (mais barato; assume que validade de email não degrada) — NÃO é
 * "pendente neste ciclo": é "nunca verificado, em ciclo nenhum".
 *
 * Interface CLI (mudança de contrato):
 *   ANTES: --input stripe-export-{cohort}.csv   (fonte = arquivo CSV na base)
 *   AGORA: --cohort {cohort}                    (fonte = query no store; default "ex-assinantes";
 *                                                resolvido via `resolveCohortArg` — mesmo helper de
 *                                                clarice-build-waves-store.ts/clarice-build-edition-sends.ts,
 *                                                aceita slug canônico, alias pt-BR ou YYYY-MM, falha alto
 *                                                em valor não reconhecido)
 *   Uma invocação com o `--input` ANTIGO agora aborta com erro explícito (não
 *   cai silenciosamente no --cohort default) — ver `hasLegacyInputFlag`.
 *
 * `assinantes-ativos` (T01): NUNCA elegível como `--cohort` aqui — pagamento
 * Stripe já valida implicitamente (#1297), o cohort é isento de MV inteiro
 * (`isMvExemptCohort`, cohorts.ts — mesmo predicado usado por
 * `classifyEligibility` em clarice-db.ts). Passar esse cohort aborta com erro
 * explícito em vez de silenciosamente gastar créditos à toa.
 *
 * Output (POR-CICLO, em data/clarice-subscribers/{conteúdo}-{envio}/) — INALTERADO,
 * continua CSV como TRANSPORT (import Brevo / auditoria). Proveniência do nome:
 * `mv-export-{cohort}` (sem mais depender do basename de um arquivo de input):
 *   mv-export-ex-assinantes-verified.csv   result ok | catch_all   → MANDAR pro Brevo
 *   mv-export-ex-assinantes-rejected.csv   result invalid | disposable → EXCLUIR
 *   mv-export-ex-assinantes-unknown.csv    unknown | reverify | error  → inconclusivo
 *   .mv-cache-mv-export-ex-assinantes.json checkpoint resumível (gitignored via data/)
 *
 * Stdout: JSON sumário; stderr: progresso humano-legível.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { clariceCycleDir, ensureDir, parseCycleArg } from "./lib/clarice-paths.ts"; // #1961
import { openClariceDb, DEFAULT_DB_PATH, MV_NEVER_VERIFIED_SQL } from "./lib/clarice-db.ts";
import { COHORT_ASSINANTES_ATIVOS, isMvExemptCohort } from "./lib/cohorts.ts";
import { resolveCohortArg } from "./lib/clarice-segment.ts";

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

/**
 * Basename das SAÍDAS do MV a partir do slug de cohort. Proveniência: as saídas
 * são do MillionVerifier, então o prefixo é `mv-export-` (convenção: nome =
 * última ferramenta que processou). #2886 PR3: antes derivado do basename do
 * `--input` CSV (`stripe-export-…` → `mv-export-…`); agora o cohort É a fonte
 * (query no store), então o basename deriva direto do slug do cohort.
 */
export function mvOutputBase(cohort: string): string {
  return `mv-export-${cohort}`;
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
// Candidate selection (store) — #2886 PR3
// ---------------------------------------------------------------------------

/**
 * #2886 PR3: candidatos-a-verificar vêm do STORE, não de um CSV. Query pura
 * (recebe `DatabaseSync` já aberta — produção usa `openClariceDb()`, testes
 * usam `openClariceDb(":memory:")` seeded via INSERT direto, mesmo padrão de
 * `computeMvStatusFromStore` em clarice-mv-status.ts).
 *
 * Semântica "skip forever" (decisão do editor): `MV_NEVER_VERIFIED_SQL`
 * (clarice-db.ts) seleciona SÓ quem nunca foi submetido ao MV em NENHUM
 * ciclo — um contato com `mv_bucket` preenchido (de um ciclo anterior
 * QUALQUER, não só o atual) é excluído do candidate set, mesmo que o
 * `mv_cycle` gravado seja de um ciclo diferente do `--cycle` desta
 * invocação. Isso é INTENCIONAL: nunca re-verificar, não "verificar 1x por
 * ciclo" — por isso o predicado é nomeado/exportado (clarice-db.ts) em vez
 * de um WHERE inline: um 2º consumidor deste candidate set (dashboard,
 * script de auditoria) reusa a constante em vez de reimplementar um WHERE
 * sutilmente diferente (ex: `mv_cycle = ?`, que NÃO é a semântica aqui).
 *
 * Retorna linhas no mesmo shape que `splitRows`/`Papa.unparse` esperam
 * (Record<string,string>) — colunas fixas `email` + `name` (o que o store
 * tem disponível; `OPEN_PROBABILITY` do CSV legado não existe mais aqui).
 */
export function readStoreCandidates(
  db: DatabaseSync,
  cohort: string,
): { rows: Record<string, string>[]; fields: string[]; emailKey: string } {
  const raw = db
    .prepare(
      `SELECT email, name FROM clarice_users WHERE cohort = ? AND ${MV_NEVER_VERIFIED_SQL}`,
    )
    .all(cohort) as Array<{ email: string; name: string | null }>;
  const rows = raw
    .filter((r) => (r.email ?? "").trim().length > 0)
    .map((r) => ({ email: r.email.trim().toLowerCase(), name: r.name ?? "" }));
  return { rows, fields: ["email", "name"], emailKey: "email" };
}

/**
 * Total de contatos do cohort no store, independente de já terem sido
 * verificados (#2886 PR3 review). Usado só pra diferenciar "0 candidatos
 * porque o cohort já foi todo verificado em ciclos anteriores" (nenhum aviso
 * necessário — steady-state normal) de "0 candidatos porque o cohort não tem
 * NENHUM membro no store" (provável typo num slug de forma válida, ex:
 * `leads-2026-07` digitado no lugar de `leads-2026-06` — `resolveCohortArg`
 * não pega esse caso porque as duas formas são igualmente válidas).
 */
export function cohortMemberCount(db: DatabaseSync, cohort: string): number {
  return (
    db.prepare(`SELECT COUNT(*) as n FROM clarice_users WHERE cohort = ?`).get(cohort) as {
      n: number;
    }
  ).n;
}

/**
 * `--input` foi REMOVIDO nesta migração (#2886 PR3 — fonte agora é
 * `--cohort`, query no store). Uma invocação com o `--input` antigo (ex: de
 * um runbook/histórico de shell não atualizado — CLAUDE.md documentava
 * exatamente esse comando antes desta PR) NUNCA deve cair silenciosamente no
 * `--cohort` default: isso verificaria o cohort ERRADO sem aviso nenhum —
 * exatamente o risco de bounce/reputação que este script existe pra evitar
 * (#1297). Pure/testável — main() decide o que fazer com o resultado.
 */
export function hasLegacyInputFlag(argv: string[]): boolean {
  return argv.includes("--input");
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
  cohort: string;
  db: string;
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
    cohort: get("--cohort") ?? "ex-assinantes",
    db: get("--db") ?? DEFAULT_DB_PATH,
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
  // #2886 PR3 review: `--input` foi removido nesta migração. Uma invocação
  // com o comando ANTIGO (`--input stripe-export-{cohort}.csv`, ainda
  // documentado em runbooks/histórico de shell não atualizados) NUNCA deve
  // cair silenciosamente no `--cohort` default — isso verificaria o cohort
  // ERRADO sem aviso. Falha alto e explica a migração em vez de prosseguir.
  if (hasLegacyInputFlag(argv)) {
    console.error(
      "--input foi removido (#2886 PR3) — a fonte agora é o store, não um CSV. " +
        "Use --cohort {slug} no lugar (ex: --cohort ex-assinantes). Ver CLAUDE.md.",
    );
    process.exit(1);
  }
  // #1961: as saídas verificadas + cache são POR-CICLO → vivem em
  // data/clarice-subscribers/{conteúdo}-{envio}/.
  if (!args.cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (saídas em {ciclo}/ — ex: --cycle 2605-06).");
    process.exit(1);
  }
  // #2886 PR3 review: resolve o --cohort via o MESMO helper usado pelos
  // scripts irmãos que já aceitam --cohort (clarice-build-waves-store.ts,
  // clarice-build-edition-sends.ts) — aceita o slug canônico, um alias pt-BR
  // ("junho") ou a forma YYYY-MM, e FALHA ALTO (Error) num valor não
  // reconhecido, em vez de prosseguir silenciosamente rumo a um run de 0
  // candidatos (o comportamento antigo, ad-hoc, só avisava e continuava).
  let cohort: string;
  try {
    cohort = resolveCohortArg(args.cohort);
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }
  // assinantes-ativos (T01) é ISENTO de MV — pagamento Stripe já valida
  // implicitamente (#1297; mesmo predicado de `classifyEligibility` em
  // clarice-db.ts, via `isMvExemptCohort`, cohorts.ts). Nunca deve ser
  // passado aqui: abortar cedo em vez de queimar créditos à toa numa cohort
  // que a pipeline de elegibilidade já trata como N/A.
  if (isMvExemptCohort(cohort)) {
    console.error(
      `--cohort ${COHORT_ASSINANTES_ATIVOS} não é verificável: pagamento Stripe já valida ` +
        `implicitamente (#1297) — este cohort é isento de MV em toda a pipeline.`,
    );
    process.exit(1);
  }
  const cycleDir = clariceCycleDir(args.cycle);
  // #2886 PR3 review: ":memory:" passa direto (mesma exceção de
  // clarice-mv-status.ts) — permite invocar main() com um store in-memory
  // (smoke manual / integração) sem falsamente reportar "não encontrado".
  if (args.db !== ":memory:" && !existsSync(args.db)) {
    console.error(`store não encontrado em ${args.db}. Rode clarice-build-db.ts primeiro, ou use --db para apontar outro path.`);
    process.exit(1);
  }
  // Só cria a pasta do ciclo DEPOIS de validar o store — senão um typo no
  // --cohort/--db deixa um dir de ciclo vazio órfão (que ainda sincroniza pro OneDrive).
  ensureDir(cycleDir);

  // Proveniência: as SAÍDAS são do MillionVerifier → prefixo `mv-export-`
  // (convenção: nome = última ferramenta que processou).
  const base = mvOutputBase(cohort);
  const cpPath = resolve(cycleDir, `.mv-cache-${base}.json`);

  // #2886 PR3 review: try/finally garante db.close() mesmo se a query
  // falhar (store corrompido, erro de schema inesperado) — mesmo padrão de
  // `clarice-mv-status.ts` (`try { ... } finally { db.close(); }`).
  const db = openClariceDb(args.db);
  let rows: Record<string, string>[], fields: string[], emailKey: string, memberCount: number;
  try {
    ({ rows, fields, emailKey } = readStoreCandidates(db, cohort));
    memberCount = cohortMemberCount(db, cohort);
  } finally {
    db.close();
  }
  console.error(`📂 store cohort="${cohort}": ${rows.length} candidatos (nunca verificados)`);
  // #2886 PR3 review: 0 candidatos + 0 membros no store é suspeito — provável
  // typo num slug de FORMA válida (ex: leads-2026-07 no lugar de
  // leads-2026-06; ambos passam resolveCohortArg). Distinto do steady-state
  // normal (cohort com membros, todos já verificados em ciclos anteriores).
  if (rows.length === 0 && memberCount === 0) {
    console.error(
      `⚠️  cohort "${cohort}" não tem NENHUM contato no store (0 candidatos, 0 membros) — ` +
        `provável typo (slug de forma válida mas errado). Confira scripts/lib/cohorts.ts.`,
    );
  }

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
    cohort,
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
