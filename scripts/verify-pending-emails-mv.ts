#!/usr/bin/env node
/**
 * scripts/verify-pending-emails-mv.ts (#4476 item 8)
 *
 * Verifica no MillionVerifier, EM LOTE, os e-mails do pool Pending da
 * Beehiiv reservado pro canal Brevo próprio do editor — antes de que
 * QUALQUER um deles seja ingerido de verdade (`sync-pending-to-brevo.ts
 * --push`). Protege a reputação de IP/domínio da conta Brevo nova contra
 * bounce de endereço que nunca existiu de verdade (mesmo racional do
 * invariante já estabelecido no CLAUDE.md pra cohorts não-assinantes da
 * Clarice, `verify-emails-mv.ts`).
 *
 * ## Por que um script NOVO, não reusar `verify-emails-mv.ts`
 *
 * `verify-emails-mv.ts` está fortemente acoplado ao store SQLite da Clarice
 * (`clarice_users`, cohort, `mv_bucket` "skip forever") — decisão de design
 * já tomada na issue #4476: este canal usa um store JSON simples e
 * independente, sem tocar a maquinaria da parceria comercial da Clarice.
 * Este script reimplementa só o necessário (chamada à API MV com retry,
 * classificação de resultado, checkpoint resumível) sobre uma fonte de
 * dados diferente: um CSV plano, não uma query no store.
 *
 * ## Fonte: `data/pending-reativacao/pending-scored-computed.csv`
 *
 * Saída de `scripts/score-pending-origin.ts` — já ordenado por prioridade,
 * mas este script verifica TODOS (a issue #4476 decidiu 260802: 1 passada
 * em lote sobre o pool inteiro ANTES do 1º envio, não por-backfill — o pool
 * é estático, ~627 e-mails, custo total ~US$1,20, não há vantagem em
 * verificar aos poucos).
 *
 * ## Semântica de re-verificação: skip forever (checkpoint)
 *
 * Mesmo padrão de `verify-emails-mv.ts`: um e-mail já verificado (em
 * QUALQUER rodada anterior) nunca é re-verificado — checkpoint resumível em
 * `data/pending-reativacao/.mv-cache.json`. Falha TRANSITÓRIA (retries
 * esgotados) NUNCA entra no checkpoint — próxima invocação re-tenta
 * automaticamente (mesma semântica de `-error.csv` em `verify-emails-mv.ts`,
 * #4353).
 *
 * ## Saídas (`data/pending-reativacao/`)
 *
 *   mv-verified.csv   result ok | catch_all       → consumido por
 *                     `sync-pending-to-brevo.ts` pra filtrar quem é
 *                     elegível a ingestão (só quem está aqui)
 *   mv-rejected.csv   result invalid | disposable → excluído, nunca ingerido
 *   mv-unknown.csv    unknown | reverify | ""      → inconclusivo, excluído
 *                     por padrão (fail-safe: só manda pra quem tem "ok")
 *   mv-error.csv      falha transitória desta rodada — nunca no checkpoint
 *
 * ## Guard de custo
 *
 * ~627 e-mails > 500 (mesmo teto de `MV_COST_GUARD_THRESHOLD` do script da
 * Clarice, #4347 D8) exige `--confirm` — nunca gasta crédito sem confirmação
 * explícita quando o volume é grande.
 *
 * ## Uso
 *
 *   npx tsx scripts/verify-pending-emails-mv.ts --confirm
 *   npx tsx scripts/verify-pending-emails-mv.ts --confirm --limit 50   # smoke
 *
 * Env: MILLION_VERIFIER_API_KEY (obrigatório).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { getArg, hasFlag, isMainModule, parseArgs } from "./lib/cli-args.ts";
import { DEFAULT_OUTPUT_PATH as SCORED_CSV_PATH } from "./score-pending-origin.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_BASE = "https://api.millionverifier.com/api/v3";
const OUT_DIR = resolve(ROOT, "data/pending-reativacao");
const CHECKPOINT_PATH = resolve(OUT_DIR, ".mv-cache.json");
/** Consumidos por `sync-pending-to-brevo.ts` — `MV_VERIFIED_CSV_PATH` pro
 * filtro de ingestão (`loadMvVerifiedEmails`); os outros 2 só pra medir
 * COBERTURA (quantos do pool já foram processados, independente do
 * resultado) — ver `assertMvGuardAcknowledged` (#4494 review, achado
 * convergente de 4 agentes: "arquivo existe" != "verificação completa"). */
export const MV_VERIFIED_CSV_PATH = resolve(OUT_DIR, "mv-verified.csv");
export const MV_REJECTED_CSV_PATH = resolve(OUT_DIR, "mv-rejected.csv");
export const MV_UNKNOWN_CSV_PATH = resolve(OUT_DIR, "mv-unknown.csv");

export const MV_COST_PER_1000_USD = 1.9;
export const MV_COST_GUARD_THRESHOLD = 500;
export const TRANSIENT_ERROR_RESULT = "error_transient";

export function estimateMvCostUsd(emailCount: number): number {
  return (emailCount / 1000) * MV_COST_PER_1000_USD;
}

/** Pura — mesma classificação de `verify-emails-mv.ts` (Clarice): conservador
 * de propósito, só exclui o que a MV afirma ser ruim. */
export type Bucket = "verified" | "rejected" | "unknown";
export function classifyResult(result: string | undefined | null): Bucket {
  const r = (result ?? "").trim().toLowerCase();
  if (r === "ok" || r === "catch_all") return "verified";
  if (r === "invalid" || r === "disposable") return "rejected";
  return "unknown";
}

export function buildVerifyUrl(apiKey: string, email: string, timeoutSec = 20): string {
  const u = new URL(API_BASE);
  u.searchParams.set("api", apiKey);
  u.searchParams.set("email", email);
  u.searchParams.set("timeout", String(timeoutSec));
  return u.toString();
}

interface MvResponse {
  email?: string;
  result?: string;
  resultcode?: number;
  quality?: string;
  credits?: number;
  error?: string;
}

interface CachedResult {
  result: string;
  resultcode: number;
  quality: string;
}
type Checkpoint = Record<string, CachedResult>;

export function loadCheckpoint(path: string): Checkpoint {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Checkpoint;
  } catch {
    process.stderr.write(`[verify-pending-emails-mv] AVISO: checkpoint corrompido em ${path} — começando do zero\n`);
    return {};
  }
}

export function saveCheckpoint(path: string, cp: Checkpoint): void {
  writeFileAtomic(path, JSON.stringify(cp, null, 0));
}

class FatalApiError extends Error {}

const RETRYABLE_DELAYS_MS = [1000, 3000, 9000];
async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** I/O — 1 chamada à MV, com retry em erro transitório (429/5xx/rede/JSON
 * malformado) e parada imediata (`FatalApiError`) em erro de config (key
 * inválida/sem crédito) ou 4xx que não é 429 — mesmo padrão de
 * `verify-emails-mv.ts::verifyOne`, reimplementado aqui (não importado —
 * ver header do módulo). `_sleep` injetável pra teste (nunca espera 13s de
 * verdade). */
export async function verifyOne(
  apiKey: string,
  email: string,
  timeoutSec: number,
  fetchImpl: typeof fetch = fetch,
  _sleep: (ms: number) => Promise<void> = sleep,
): Promise<MvResponse> {
  const url = buildVerifyUrl(apiKey, email, timeoutSec);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= RETRYABLE_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await _sleep(RETRYABLE_DELAYS_MS[attempt - 1]);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), (timeoutSec + 10) * 1000);
    try {
      const resp = await fetchImpl(url, { signal: ctrl.signal });
      if (resp.status === 429 || resp.status >= 500) {
        await resp.body?.cancel().catch(() => {});
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }
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
        const low = err.toLowerCase();
        if (low.includes("api key") || low.includes("apikey") || low.includes("credit") || low.includes("not enough")) {
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
  throw new Error(`falha ao verificar ${email} após ${RETRYABLE_DELAYS_MS.length + 1} tentativas: ${String(lastErr)}`);
}

/** Pura — lê os e-mails do CSV de score (só a coluna `email`, dedup).
 * `delimiter: ","` explícito — auto-detect do Papa.parse falha em silêncio
 * quando o CSV de entrada tem só 1 coluna útil (nenhuma vírgula no arquivo);
 * achado ao vivo 260802, ver #4494. */
export function readCandidateEmails(csvText: string): string[] {
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true, delimiter: "," });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of parsed.data) {
    const email = (row.email ?? "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** Pura — guard de custo: bloqueia ANTES de qualquer chamada à API se o
 * volume a verificar excede o teto, sem `--confirm`. */
export function checkMvCostGuard(emailCount: number, confirmed: boolean): { ok: true } | { ok: false; message: string } {
  if (confirmed || emailCount <= MV_COST_GUARD_THRESHOLD) return { ok: true };
  return {
    ok: false,
    message:
      `${emailCount} e-mail(s) a verificar ≈ US$ ${estimateMvCostUsd(emailCount).toFixed(2)} — acima do teto de ` +
      `${MV_COST_GUARD_THRESHOLD}. Confirme com --confirm pra prosseguir (nenhum crédito foi gasto ainda).`,
  };
}

function toCsv(emails: string[]): string {
  return Papa.unparse({ fields: ["email"], data: emails.map((email) => ({ email })) }) + "\n";
}

/**
 * Pura — resolve `--limit` como inteiro não-negativo ou `undefined` (flag
 * ausente = sem limite, processa o pool `todo` inteiro).
 *
 * Usa `parseArgs` (não `getArg`) de propósito: `getArg` retorna `""` — nunca
 * `undefined` — quando a flag está ausente (ver JSDoc em lib/cli-args.ts).
 * Achado ao vivo 260802: uma rodada real que devia processar 625 e-mails
 * processou 0 sem erro, porque a validação anterior checava
 * `getArg(...) !== undefined` (sempre true) e `Number("") === 0` passa a
 * checagem de inteiro não-negativo. `parseArgs(argv).values["limit"]` é de
 * fato `undefined` quando a flag não foi passada — só essa distinção
 * preserva o comportamento default (sem --limit → processa tudo) e ainda
 * falha alto num typo tipo `--limit fifty` (`Number.isInteger(NaN)` é
 * false, `NaN < 0` também é false — sem essa checagem explícita o typo
 * silenciosamente processaria 0, indistinguível de "pool já verificado").
 */
export function parseLimitArg(argv: string[]): number | undefined {
  const limitArg = parseArgs(argv).values["limit"];
  if (limitArg === undefined) return undefined;
  const limit = Number(limitArg);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`--limit deve ser um inteiro não-negativo, recebido "${limitArg}".`);
  }
  return limit;
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const log = (msg: string) => process.stderr.write(`[verify-pending-emails-mv] ${msg}\n`);

  const apiKey = process.env.MILLION_VERIFIER_API_KEY;
  if (!apiKey) {
    log("ERRO: MILLION_VERIFIER_API_KEY não definido no ambiente.");
    process.exit(2);
  }

  const inputPath = getArg(argv, "input") || SCORED_CSV_PATH;
  if (!existsSync(inputPath)) {
    log(`ERRO: input não encontrado em ${inputPath}. Rode scripts/score-pending-origin.ts primeiro.`);
    process.exit(2);
  }

  const allEmails = readCandidateEmails(readFileSync(inputPath, "utf8"));
  log(`${allEmails.length} e-mail(s) únicos no pool.`);

  const checkpoint = loadCheckpoint(CHECKPOINT_PATH);
  const todo = allEmails.filter((e) => !(e in checkpoint));

  let limit: number | undefined;
  try {
    limit = parseLimitArg(argv);
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
    process.exit(2);
  }
  const limited = limit !== undefined ? todo.slice(0, limit) : todo;
  log(`${todo.length} ainda não verificado(s) (skip-forever pelo checkpoint); processando ${limited.length} nesta rodada.`);

  const guard = checkMvCostGuard(limited.length, hasFlag(argv, "confirm"));
  if (!guard.ok) {
    log(`ERRO: ${guard.message}`);
    process.exit(2);
  }

  let verified = 0;
  let rejected = 0;
  let unknown = 0;
  let transientErrors = 0;
  const errorEmails: string[] = [];

  for (const email of limited) {
    try {
      const res = await verifyOne(apiKey, email, 20);
      const bucket = classifyResult(res.result);
      checkpoint[email] = { result: res.result ?? "", resultcode: res.resultcode ?? 0, quality: res.quality ?? "" };
      if (bucket === "verified") verified++;
      else if (bucket === "rejected") rejected++;
      else unknown++;
      log(`${email}: ${res.result ?? "(vazio)"} → ${bucket}`);
    } catch (e) {
      transientErrors++;
      errorEmails.push(email);
      log(`FALHA TRANSITÓRIA em ${email}: ${(e as Error).message} — não entra no checkpoint, retry na próxima rodada.`);
    }
    saveCheckpoint(CHECKPOINT_PATH, checkpoint);
  }

  // Materializa os 3 buckets a partir do checkpoint COMPLETO (não só desta
  // rodada, nem só do `allEmails` desta invocação) — mesmo racional de
  // `verify-emails-mv.ts` #4071: uma rodada anterior parcial não deve
  // desaparecer do CSV final. #4494 review (silent-failure-hunter, achado
  // ao vivo): a versão anterior iterava `allEmails` (o CSV de INPUT desta
  // rodada), não `Object.keys(checkpoint)` — um `--input` errado/desatualizado
  // faria os CSVs de saída ENCOLHEREM silenciosamente, derrubando do
  // mv-verified.csv gente já verificada em rodada anterior. Iterar o
  // checkpoint em si é a fonte de verdade real.
  const verifiedEmails: string[] = [];
  const rejectedEmails: string[] = [];
  const unknownEmails: string[] = [];
  for (const email of Object.keys(checkpoint)) {
    const cached = checkpoint[email];
    const bucket = classifyResult(cached.result);
    if (bucket === "verified") verifiedEmails.push(email);
    else if (bucket === "rejected") rejectedEmails.push(email);
    else unknownEmails.push(email);
  }

  writeFileAtomic(MV_VERIFIED_CSV_PATH, toCsv(verifiedEmails));
  writeFileAtomic(MV_REJECTED_CSV_PATH, toCsv(rejectedEmails));
  writeFileAtomic(MV_UNKNOWN_CSV_PATH, toCsv(unknownEmails));
  writeFileAtomic(resolve(OUT_DIR, "mv-error.csv"), toCsv(errorEmails));

  log(
    `resumo desta rodada: ${verified} verificado(s), ${rejected} rejeitado(s), ${unknown} inconclusivo(s), ` +
      `${transientErrors} falha(s) transitória(s). Total acumulado no checkpoint: ${verifiedEmails.length} verified, ` +
      `${rejectedEmails.length} rejected, ${unknownEmails.length} unknown de ${allEmails.length} no pool.`,
  );
  if (verifiedEmails.length + rejectedEmails.length + unknownEmails.length < allEmails.length) {
    log(
      `AVISO: ${allEmails.length - verifiedEmails.length - rejectedEmails.length - unknownEmails.length} e-mail(s) ` +
        `ainda não verificado(s) — rode de novo (sem --limit, ou com --limit maior) até completar o pool.`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[verify-pending-emails-mv] erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
