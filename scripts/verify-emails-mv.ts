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
 *   mv-export-ex-assinantes-unknown.csv    unknown | reverify | (checkpoint) → inconclusivo
 *   mv-export-ex-assinantes-error.csv      falha TRANSITÓRIA (retries esgotados) desta
 *                                          rodada (#4353) — NÃO é o mesmo que `unknown`:
 *                                          estes emails NUNCA entram no checkpoint de
 *                                          propósito (semântica "retry no próximo run",
 *                                          #2886), então não aparecem em NENHUM dos 3
 *                                          buckets acima. Ficam auditáveis aqui só nesta
 *                                          rodada — uma invocação futura do mesmo
 *                                          --cycle/--cohort os retenta automaticamente
 *                                          (não estão no checkpoint) e este arquivo é
 *                                          sobrescrito a cada rodada (reflete só o
 *                                          `failures[]` da execução atual, não histórico).
 *   .mv-cache-mv-export-ex-assinantes.json checkpoint resumível (gitignored via data/)
 *
 * Stdout: JSON sumário (inclui `transient_errors` e `reconciled` — #4353); stderr:
 * progresso humano-legível.
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
import { getArg, getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";

// .env — loader canônico do projeto (#923, consolidado pra arquivo único #4820).
// Bare `dotenv/config` não carrega .env, onde os secrets costumam morar.
loadProjectEnv();
const API_BASE = "https://api.millionverifier.com/api/v3";

// ---------------------------------------------------------------------------
// Classificação — MV `result` → bucket de ação editorial
// ---------------------------------------------------------------------------

export type Bucket = "verified" | "rejected" | "unknown";

/**
 * #4353 — sentinela de MV_RESULT pras linhas do `-error.csv` (falha
 * transitória, retries esgotados). Nunca é um `result` real vindo da API MV
 * (que só devolve `ok|catch_all|invalid|disposable|unknown|reverify|""`) —
 * serve pra deixar óbvio, ao inspecionar o CSV, que a linha não reflete uma
 * resposta da MV, e sim a ausência de uma (rede/timeout esgotados). Estas
 * linhas nunca são escritas no checkpoint (ver `buildErrorRows`).
 */
export const TRANSIENT_ERROR_RESULT = "error_transient";

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
 *
 * #5169: `ORDER BY created DESC` (achado ao vivo 12/08/2026) — antes desta
 * mudança a query não tinha ORDER BY nenhum, então dentro de um cohort a
 * ordem era a de rowid do SQLite (arbitrária em relação a recência de
 * cadastro). `runMvOnDemandPlan` (clarice-mv-ondemand.ts) chama esta função
 * e corta as `alloc.count` primeiras (`verifyCohortList`, `todo.slice(0,
 * limit)`) — pra um cohort GIGANTE (dezenas de milhares) só parcialmente
 * coberto pelo déficit diário (~1-5k), QUAIS contatos entram na fatia de
 * hoje não tinha relação nenhuma com recência real, mesmo já ordenando os
 * COHORTS certos (`cohortSendRank`/`planMvOnDemand`) do mais novo pro mais
 * antigo — a mesma classe de lacuna que `contactRecencyRank`
 * (`scripts/lib/cohorts.ts`) fecha do lado da fila de envio
 * (`segmentRampWarm`). `created` NULL fica por último em `DESC` (semântica
 * padrão do SQLite) — contato sem data de cadastro conhecida nunca fura a
 * frente de quem tem. `email ASC` como desempate determinístico final.
 */
export function readStoreCandidates(
  db: DatabaseSync,
  cohort: string,
): { rows: Record<string, string>[]; fields: string[]; emailKey: string } {
  const raw = db
    .prepare(
      `SELECT email, name FROM clarice_users WHERE cohort = ? AND ${MV_NEVER_VERIFIED_SQL} ORDER BY created DESC, email ASC`,
    )
    .all(cohort) as Array<{ email: string; name: string | null }>;
  const rows = raw
    .filter((r) => (r.email ?? "").trim().length > 0)
    .map((r) => ({ email: r.email.trim().toLowerCase(), name: r.name ?? "" }));
  return { rows, fields: ["email", "name"], emailKey: "email" };
}

/**
 * #4347 Etapa 2d — variante de `readStoreCandidates` restrita a `created >=
 * sinceIso` (janela do laço Stripe→MV→envio da skill `/diaria-clarice-novos`).
 * Mesma semântica "skip forever" (`MV_NEVER_VERIFIED_SQL`) — nunca re-verifica
 * quem já tem `mv_bucket` preenchido de QUALQUER ciclo anterior. `ORDER BY
 * created DESC` (#5169) pelo mesmo motivo de `readStoreCandidates` — aqui o
 * impacto prático é menor (janela já estreita, poucos dias), mas mantém a
 * mesma garantia sem custo real.
 */
export function readStoreCandidatesSince(
  db: DatabaseSync,
  cohort: string,
  sinceIso: string,
): { rows: Record<string, string>[]; fields: string[]; emailKey: string } {
  const raw = db
    .prepare(
      `SELECT email, name FROM clarice_users WHERE cohort = ? AND created >= ? AND ${MV_NEVER_VERIFIED_SQL} ORDER BY created DESC, email ASC`,
    )
    .all(cohort, sinceIso) as Array<{ email: string; name: string | null }>;
  const rows = raw
    .filter((r) => (r.email ?? "").trim().length > 0)
    .map((r) => ({ email: r.email.trim().toLowerCase(), name: r.name ?? "" }));
  return { rows, fields: ["email", "name"], emailKey: "email" };
}

/**
 * #4347 Etapa 2d — cohorts DISTINTOS com pelo menos 1 contato `created >=
 * sinceIso` (o "recorte particionado por cohort" da issue #4347). `cohort`
 * NULL é ignorado (nada a verificar sem cohort conhecido).
 */
export function distinctCohortsSince(db: DatabaseSync, sinceIso: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT cohort FROM clarice_users WHERE cohort IS NOT NULL AND created IS NOT NULL AND created >= ?`,
    )
    .all(sinceIso) as Array<{ cohort: string }>;
  return rows.map((r) => r.cohort).sort();
}

// ---------------------------------------------------------------------------
// Guard de custo (#4347 D8) — 500 e-mails A VERIFICAR exige --confirm
// ---------------------------------------------------------------------------

/** Custo aproximado do MillionVerifier (~US$1,90/1000 e-mails — CLAUDE.md §MV). */
export const MV_COST_PER_1000_USD = 1.9;
/** Teto do guard de custo (D8) — distinto do teto D13 (que mede o TAMANHO
 *  da lista final de envio, não os e-mails a VERIFICAR). Mesmo valor numérico
 *  por coincidência do dimensionamento típico de uma rodada, não por serem o
 *  mesmo guard. */
export const MV_COST_GUARD_THRESHOLD = 500;

export function estimateMvCostUsd(emailCount: number): number {
  return (emailCount / 1000) * MV_COST_PER_1000_USD;
}

/**
 * Pura/testável: `emailCount > MV_COST_GUARD_THRESHOLD` sem `--confirm` →
 * aborta ANTES de qualquer chamada à API MV (zero crédito gasto). `--confirm`
 * destrava. Chamado só no modo `--since` (a issue não pede este guard pro
 * `--cohort` clássico, que já é uma invocação explícita e escopada pelo
 * editor).
 */
export function checkMvCostGuard(
  emailCount: number,
  confirmed: boolean,
): { ok: true } | { ok: false; message: string } {
  if (confirmed || emailCount <= MV_COST_GUARD_THRESHOLD) return { ok: true };
  return {
    ok: false,
    message:
      `❌ ${emailCount} e-mail(s) a verificar ≈ US$ ${estimateMvCostUsd(emailCount).toFixed(2)} — acima do teto de ` +
      `${MV_COST_GUARD_THRESHOLD} (D8, #4347). Confirme com --confirm pra prosseguir (nenhum crédito foi gasto ainda).`,
  };
}

/**
 * #4347 Etapa 2d — planeja o `--since` SEM gastar crédito: pra cada cohort
 * distinto com `created >= sinceIso`, resolve candidatos (não-isentos) e o
 * `todo` (candidatos menos o que já está no checkpoint do ciclo), aplicando
 * `--limit` por cohort (mesma semântica do modo `--cohort` clássico).
 * Cohorts MV-isentos (`isMvExemptCohort`) entram com `exempt:true`,
 * `candidates:[]`, `todoCount:0` — log explícito, custo zero (D2/G4). Nunca
 * chama a API MV — só leitura de store + checkpoint em disco.
 */
export interface SinceCohortPlan {
  cohort: string;
  exempt: boolean;
  candidates: Record<string, string>[];
  allCohortRows: Record<string, string>[];
  fields: string[];
  emailKey: string;
  todoCount: number;
}

export function planSinceVerification(
  db: DatabaseSync,
  sinceIso: string,
  cycleDir: string,
  limit: number | null,
): SinceCohortPlan[] {
  const cohorts = distinctCohortsSince(db, sinceIso);
  return cohorts.map((cohort): SinceCohortPlan => {
    if (isMvExemptCohort(cohort)) {
      return { cohort, exempt: true, candidates: [], allCohortRows: [], fields: ["email", "name"], emailKey: "email", todoCount: 0 };
    }
    const { rows: candidates, fields, emailKey } = readStoreCandidatesSince(db, cohort, sinceIso);
    const { rows: allCohortRows } = readAllCohortRows(db, cohort);
    const cpPath = resolve(cycleDir, `.mv-cache-${mvOutputBase(cohort)}.json`);
    const checkpoint = loadCheckpoint(cpPath);
    const allEmails = [...new Set(candidates.map((r) => r[emailKey]).filter((e) => e.length > 0))];
    let todo = allEmails.filter((e) => !(e in checkpoint));
    if (limit != null) todo = todo.slice(0, limit);
    return { cohort, exempt: false, candidates, allCohortRows, fields, emailKey, todoCount: todo.length };
  });
}

/**
 * TODOS os contatos do cohort no store (verificados ou não) — usado pra
 * recompor `name` de emails que já saíram do candidate-set de
 * `readStoreCandidates` (mv_bucket já preenchido) mas ainda precisam
 * aparecer nos 3 CSVs de saída porque o checkpoint DESTE ciclo os contém
 * (#4071 — materializar o checkpoint completo nos outputs, não só
 * `processed_this_run`/candidatos ainda pendentes). Mesmo shape de
 * `readStoreCandidates` pra dar drop-in em `splitRows`.
 */
export function readAllCohortRows(
  db: DatabaseSync,
  cohort: string,
): { rows: Record<string, string>[]; fields: string[]; emailKey: string } {
  const raw = db
    .prepare(`SELECT email, name FROM clarice_users WHERE cohort = ?`)
    .all(cohort) as Array<{ email: string; name: string | null }>;
  const rows = raw
    .filter((r) => (r.email ?? "").trim().length > 0)
    .map((r) => ({ email: r.email.trim().toLowerCase(), name: r.name ?? "" }));
  return { rows, fields: ["email", "name"], emailKey: "email" };
}

/**
 * Materializa o conjunto final de linhas pra escrever nos 3 CSVs de saída a
 * partir do CHECKPOINT COMPLETO do ciclo (`.mv-cache-*.json`), não só dos
 * candidatos desta rodada (#4071). Um contato verificado numa rodada
 * anterior do MESMO ciclo já pode ter saído do candidate-set de
 * `readStoreCandidates` (o store foi re-ingerido entre as rodadas e seu
 * `mv_bucket` já está preenchido) — sem essa materialização, o CSV final
 * reflete só `processed_this_run`/pendentes, descartando resultado pago.
 *
 * `name` vem, em ordem de preferência: (1) `currentRows` (candidatos desta
 * rodada, fresh do store), (2) `allCohortRows` (todo o cohort, cobre quem
 * já saiu do candidate-set), (3) string vazia (email do checkpoint que não
 * está mais no cohort — trocou de cohort, ou foi removido do store; ainda
 * assim precisa aparecer no CSV, já que crédito MV foi gasto nele).
 */
/** Shared por `buildOutputRows`/`buildErrorRows` — resolve `name` de um email a
 *  partir do snapshot mais fresco disponível (candidatos desta rodada > todo o
 *  cohort > vazio, se o email já saiu do store). */
function buildNameByEmail(
  currentRows: Record<string, string>[],
  allCohortRows: Record<string, string>[],
  emailKey: string,
): Map<string, string> {
  const nameByEmail = new Map<string, string>();
  for (const r of allCohortRows) nameByEmail.set(r[emailKey], r.name ?? "");
  for (const r of currentRows) nameByEmail.set(r[emailKey], r.name ?? ""); // fresh > all-cohort snapshot
  return nameByEmail;
}

export function buildOutputRows(
  checkpoint: Checkpoint,
  currentRows: Record<string, string>[],
  allCohortRows: Record<string, string>[],
  emailKey: string,
): Record<string, string>[] {
  const nameByEmail = buildNameByEmail(currentRows, allCohortRows, emailKey);
  return Object.keys(checkpoint).map((email) => ({
    [emailKey]: email,
    name: nameByEmail.get(email) ?? "",
  }));
}

/**
 * #4353 — materializa as linhas de FALHA TRANSITÓRIA (retries esgotados) desta
 * rodada num shape drop-in pro CSV de auditoria (`-error.csv`). Distinto de
 * `buildOutputRows`: a fonte aqui é `failures[]` (in-memory, desta execução),
 * NUNCA o checkpoint — persistir estes emails no checkpoint quebraria a
 * semântica "retry no próximo run" (#2886/#4353). `TRANSIENT_ERROR_RESULT` é
 * usado como sentinela de MV_RESULT (distinto de qualquer `result` real da
 * API MV) pra deixar claro, olhando só a linha, que ela não veio de uma
 * resposta da API — veio da falta de uma.
 */
export function buildErrorRows(
  failures: string[],
  currentRows: Record<string, string>[],
  allCohortRows: Record<string, string>[],
  emailKey: string,
): Record<string, string>[] {
  const nameByEmail = buildNameByEmail(currentRows, allCohortRows, emailKey);
  return failures.map((email) => ({
    [emailKey]: email,
    name: nameByEmail.get(email) ?? "",
  }));
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
  // #4353: injetável (mesmo padrão de `_sleep` em scripts/lib/brevo-client.ts)
  // — testes de retry-esgotado não esperam 13s (1+3+9s) de verdade.
  _sleep: (ms: number) => Promise<void> = sleep,
): Promise<MvResponse> {
  const url = buildVerifyUrl(apiKey, email, timeoutSec);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= RETRYABLE_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await _sleep(RETRYABLE_DELAYS_MS[attempt - 1]);
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
  /** #4347 Etapa 2d — modo `--since` (particiona por cohort), alternativo ao `--cohort` único. */
  since: string | null;
  /** #4347 D8 — destrava o guard de custo do MV acima de MV_COST_GUARD_THRESHOLD. */
  confirm: boolean;
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
  return {
    cohort: get("--cohort") ?? "ex-assinantes",
    db: get("--db") ?? DEFAULT_DB_PATH,
    concurrency: posInt(get("--concurrency"), 12),
    timeout: posInt(get("--timeout"), 20),
    // --limit aceita 0 (no-op proposital); ausente vira null. Usa getIntArg
    // (não mais Number(rawLimit) manual) porque LANÇA num typo de valor em
    // vez de degradar silenciosamente pro mesmo sentinela de "ausente"
    // (#4497 — mesma classe do incidente #4476/#4496: uma rodada real que
    // devia processar 625 e-mails processou 0 sem erro).
    limit: getIntArg(argv, "limit") ?? null,
    single: get("--single") ?? null,
    // #1961: valida formato/semântica do ciclo (igual import-waves); "" se inválido → main aborta limpo.
    cycle: parseCycleArg(argv),
    since: get("--since") ?? null,
    confirm: argv.includes("--confirm"),
  };
}

// ---------------------------------------------------------------------------
// verifyCohortList — núcleo reusável (1 cohort × N candidatos → 3 CSVs)
// ---------------------------------------------------------------------------
//
// #4347 Etapa 2d: extraído do corpo de `main()` (que antes só suportava
// `--cohort` único) pra ser reusado tanto pelo modo `--cohort` clássico (1
// chamada) quanto pelo modo novo `--since` (N chamadas, uma por cohort
// distinto no recorte — ver `planSinceVerification`). Mesmo comportamento de
// antes: checkpoint resumível, flush periódico + em SIGINT, retry
// transitório, erro fatal aborta tudo.

export interface CohortVerifySummary {
  cohort: string;
  total_rows: number;
  unique_emails: number;
  processed_this_run: number;
  failed_this_run: number;
  /** #4353 — alias explícito de `failed_this_run`, nomeado pro contrato da
   *  issue: deixa claro (sem precisar ler o código) que estes emails são
   *  falhas TRANSITÓRIAS que NÃO foram persistidas no checkpoint (por
   *  design — ver `buildErrorRows`) e que por isso entram na reconciliação
   *  de `buckets` (ver `reconciled`). Sempre igual a `failed_this_run`;
   *  mantido como campo próprio em vez de substituí-lo pra não quebrar
   *  nenhum consumidor que já leia `failed_this_run`. */
  transient_errors: number;
  credits_remaining: number | null;
  buckets: Record<Bucket, number>;
  outputs: Record<Bucket, string> & { error: string };
  /** #4353 — `buckets.verified+rejected+unknown+transient_errors === (o que já
   *  estava no checkpoint antes desta rodada) + (o que foi de fato atacado
   *  nesta rodada, já respeitando --limit)`. Deve ser SEMPRE `true`; um
   *  `false` aqui indica que algum email ATACADO nesta rodada sumiu
   *  silenciosamente dos outputs (a classe de bug desta issue) — logado como
   *  warning caso aconteça, nunca deveria acontecer com o fix aplicado.
   *  Nota: não compara contra `unique_emails` — com `--limit` ativo,
   *  `unique_emails` inclui candidatos deixados de fora DE PROPÓSITO, o que
   *  faria essa comparação falso-positivar sempre que `--limit` é usado. */
  reconciled: boolean;
}

export async function verifyCohortList(params: {
  apiKey: string;
  cohort: string;
  cycleDir: string;
  rows: Record<string, string>[];
  fields: string[];
  emailKey: string;
  allCohortRows: Record<string, string>[];
  concurrency: number;
  timeout: number;
  limit: number | null;
  /** #4353: injetável — testes de retry-esgotado não esperam 13s de verdade. */
  _sleep?: (ms: number) => Promise<void>;
}): Promise<CohortVerifySummary> {
  const { apiKey, cohort, cycleDir, rows, fields, emailKey, allCohortRows, concurrency, timeout, limit, _sleep } = params;

  const base = mvOutputBase(cohort);
  const cpPath = resolve(cycleDir, `.mv-cache-${base}.json`);

  const allEmails = [
    ...new Set(rows.map((r) => (r[emailKey] ?? "").trim().toLowerCase()).filter((e) => e.length > 0)),
  ];

  const checkpoint = loadCheckpoint(cpPath);
  const cached = Object.keys(checkpoint).length;

  let todo = allEmails.filter((e) => !(e in checkpoint));
  if (limit != null) todo = todo.slice(0, limit);

  console.error(
    `📊 [${cohort}] ${allEmails.length} emails únicos · ${cached} já no checkpoint · ` +
      `${todo.length} a verificar${limit != null ? ` (limit ${limit})` : ""}`,
  );

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
      await runPool(todo, concurrency, async (email) => {
        if (aborting) return;
        try {
          const res = await verifyOne(apiKey, email, timeout, _sleep);
          checkpoint[email] = {
            result: res.result ?? "",
            resultcode: res.resultcode ?? -1,
            quality: res.quality ?? "",
          };
          if (typeof res.credits === "number") {
            lastCredits = lastCredits == null ? res.credits : Math.min(lastCredits, res.credits);
          }
          dirty++;
        } catch (e) {
          if (e instanceof FatalApiError) {
            aborting = true;
            throw e;
          }
          failures.push(email);
        }
        done++;
        if (done % 100 === 0) {
          flush();
          console.error(`  …[${cohort}] ${done}/${todo.length}` + (lastCredits != null ? ` (créditos: ${lastCredits})` : ""));
        }
      });
    } catch (e) {
      if (e instanceof FatalApiError) {
        flush();
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
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

  const outputRows = buildOutputRows(checkpoint, rows, allCohortRows, emailKey);
  const split = splitRows(outputRows, emailKey, checkpoint);
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

  // #4353 — falhas transitórias (retries esgotados) NUNCA entram no checkpoint
  // (de propósito — ver `buildErrorRows`), então precisam do próprio arquivo
  // pra não sumir silenciosamente dos 3 CSVs acima. `failures` já não tem
  // duplicatas: 1 push por email de `todo`, que por sua vez vem de `allEmails`
  // deduplicado via `Set`.
  const errorRows = buildErrorRows(failures, rows, allCohortRows, emailKey).map((r) => ({
    ...r,
    MV_RESULT: TRANSIENT_ERROR_RESULT,
    MV_QUALITY: "",
    MV_CODE: "",
  }));
  const errorPath = resolve(cycleDir, `${base}-error.csv`);
  writeFileSync(errorPath, Papa.unparse({ fields: outFields, data: errorRows }), "utf-8");

  // #4353 — reconciliação determinística: todo email de `todo` (o subconjunto
  // efetivamente ATACADO nesta rodada — já reflete o corte de `--limit`,
  // então comparar contra `allEmails.length` daria falso-positivo sempre que
  // `--limit` deixa candidatos de fora de propósito) termina OU no checkpoint
  // (→ 1 dos 3 buckets, somado a `cached` = o que já estava lá antes desta
  // rodada) OU em `failures` (→ error.csv) — nunca em nenhum dos dois (a
  // menos que um erro FATAL tenha abortado o processo antes, caso em que
  // este trecho nem é alcançado).
  const bucketTotal = counts.verified + counts.rejected + counts.unknown;
  const reconciled = bucketTotal + failures.length === cached + todo.length;

  if (failures.length) {
    console.error(
      `⚠️  [${cohort}] ${failures.length} email(s) falharam (erro transitório, retries esgotados) — ` +
        `NÃO persistidos no checkpoint (serão retentados na próxima invocação), mas visíveis ` +
        `nesta rodada em ${base}-error.csv para auditoria.`,
    );
  }
  if (!reconciled) {
    console.error(
      `⚠️  [${cohort}] contagens não reconciliam: verified+rejected+unknown+error ` +
        `(${bucketTotal}+${failures.length}=${bucketTotal + failures.length}) ≠ cached+todo ` +
        `(${cached}+${todo.length}=${cached + todo.length}) — investigar.`,
    );
  }

  console.error(
    `✅ [${cohort}] verified=${counts.verified} · rejected=${counts.rejected} · unknown=${counts.unknown} · error=${errorRows.length}` +
      (lastCredits != null ? ` · créditos restantes=${lastCredits}` : ""),
  );

  return {
    cohort,
    total_rows: rows.length,
    unique_emails: allEmails.length,
    processed_this_run: done - failures.length,
    failed_this_run: failures.length,
    transient_errors: failures.length,
    credits_remaining: lastCredits,
    buckets: counts,
    outputs: {
      verified: `${base}-verified.csv`,
      rejected: `${base}-rejected.csv`,
      unknown: `${base}-unknown.csv`,
      error: `${base}-error.csv`,
    },
    reconciled,
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
  // #4347: --data-root é OPCIONAL, uso interno de teste (mesmo padrão de
  // --data-root em clarice-build-segment.ts / --out-dir em
  // clarice-stripe-delta.ts) — substitui CLARICE_BASE na resolução do dir do
  // ciclo, pra testes de main() não tocarem data/clarice-subscribers/ real.
  const dataRootArg = getArg(argv, "data-root");
  const cycleDir = clariceCycleDir(args.cycle, dataRootArg || undefined);
  // #2886 PR3 review: ":memory:" passa direto (mesma exceção de
  // clarice-mv-status.ts) — permite invocar main() com um store in-memory
  // (smoke manual / integração) sem falsamente reportar "não encontrado".
  if (args.db !== ":memory:" && !existsSync(args.db)) {
    console.error(`store não encontrado em ${args.db}. Rode clarice-build-db.ts primeiro, ou use --db para apontar outro path.`);
    process.exit(1);
  }
  // Só cria a pasta do ciclo DEPOIS de validar o store — senão um typo no
  // --cohort/--db/--since deixa um dir de ciclo vazio órfão (que ainda sincroniza pro OneDrive).
  ensureDir(cycleDir);

  // #4347 Etapa 2d: --since particiona o recorte por cohort (modo NOVO,
  // alternativo ao --cohort único). Mutuamente exclusivo em espírito — se
  // --since foi passado, ele governa; --cohort é ignorado (não há como
  // combinar "1 cohort" com "particionar por cohort" na mesma invocação).
  if (args.since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.since) || Number.isNaN(Date.parse(args.since))) {
      console.error(`❌ --since inválido: "${args.since}" (esperado YYYY-MM-DD).`);
      process.exit(1);
    }
    const db = openClariceDb(args.db);
    let plan: SinceCohortPlan[];
    try {
      plan = planSinceVerification(db, args.since, cycleDir, args.limit);
    } finally {
      db.close();
    }

    const exemptCohorts = plan.filter((p) => p.exempt).map((p) => p.cohort);
    if (exemptCohorts.length > 0) {
      console.error(
        `⏭️  cohort(s) MV-isento(s) (#1297/#3826) pulado(s) com custo ZERO: ${exemptCohorts.join(", ")}`,
      );
    }
    const nonExempt = plan.filter((p) => !p.exempt);
    if (nonExempt.length === 0 && exemptCohorts.length === 0) {
      console.error(`ℹ️  nenhum cohort com contato criado desde ${args.since} — nada a verificar.`);
      console.log(JSON.stringify({ mode: "since", since: args.since, cohorts: [], total_verified: 0 }, null, 2));
      return;
    }

    // #4347 D8: guard de custo — soma o `todo` de TODOS os cohorts não-isentos
    // ANTES de qualquer chamada à API MV (zero crédito gasto até aqui).
    const totalToVerify = nonExempt.reduce((sum, p) => sum + p.todoCount, 0);
    console.error(
      `💰 ${totalToVerify} e-mail(s) a verificar em ${nonExempt.length} cohort(s) ≈ US$ ${estimateMvCostUsd(totalToVerify).toFixed(2)}`,
    );
    const costGuard = checkMvCostGuard(totalToVerify, args.confirm);
    if (!costGuard.ok) {
      console.error(costGuard.message);
      process.exit(1);
    }

    const perCohort: CohortVerifySummary[] = [];
    for (const p of nonExempt) {
      const summary = await verifyCohortList({
        apiKey,
        cohort: p.cohort,
        cycleDir,
        rows: p.candidates,
        fields: p.fields,
        emailKey: p.emailKey,
        allCohortRows: p.allCohortRows,
        concurrency: args.concurrency,
        timeout: args.timeout,
        limit: args.limit,
      });
      perCohort.push(summary);
    }

    const totalVerifiedNow = perCohort.reduce((sum, s) => sum + s.processed_this_run, 0);
    console.error(`\n✅ --since ${args.since}: ${perCohort.length} cohort(s) processado(s), ${totalVerifiedNow} e-mail(s) verificado(s) nesta rodada.`);
    console.log(
      JSON.stringify(
        { mode: "since", since: args.since, exempt_cohorts: exemptCohorts, cohorts: perCohort, total_verified: totalVerifiedNow },
        null,
        2,
      ),
    );
    return;
  }

  // --- Modo clássico: --cohort único ---
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

  // #2886 PR3 review: try/finally garante db.close() mesmo se a query
  // falhar (store corrompido, erro de schema inesperado) — mesmo padrão de
  // `clarice-mv-status.ts` (`try { ... } finally { db.close(); }`).
  const db = openClariceDb(args.db);
  let rows: Record<string, string>[],
    fields: string[],
    emailKey: string,
    memberCount: number,
    allCohortRows: Record<string, string>[];
  try {
    ({ rows, fields, emailKey } = readStoreCandidates(db, cohort));
    memberCount = cohortMemberCount(db, cohort);
    // #4071: snapshot de TODO o cohort (não só candidatos) — dá `name` pra
    // quem já saiu do candidate-set mas ainda está no checkpoint deste ciclo.
    ({ rows: allCohortRows } = readAllCohortRows(db, cohort));
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

  const summary = await verifyCohortList({
    apiKey,
    cohort,
    cycleDir,
    rows,
    fields,
    emailKey,
    allCohortRows,
    concurrency: args.concurrency,
    timeout: args.timeout,
    limit: args.limit,
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
