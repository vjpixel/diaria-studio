#!/usr/bin/env npx tsx
/**
 * scripts/fetch-tally-audience.ts (#466 — migração Beehiiv → Kit, #461)
 *
 * Substitui as Fases 1-2 do fluxo `/diaria-atualiza-audiencia` (que hoje
 * dependem de MCP pra listar/paginar a survey Beehiiv) por um pull DIRETO
 * via REST — `GET /forms/{formId}/submissions`, paginado, sem MCP nenhum
 * (achado ao vivo #466: mais simples que o próprio caminho Beehiiv, que só
 * sai por MCP). Delega a Fase 3 inteira (validação + escrita de
 * `data/audience-raw.json` + regenerar `context/audience-profile.md`) pro
 * `scripts/audience-run.ts` já existente — reuso total, zero duplicação.
 *
 * **`--skip-beehiiv-resolve` (achado CRÍTICO do review, PR #6084):**
 * `runAudience` resolve `beehiiv.publicationId`/`beehiiv.profileSurveyId`
 * INCONDICIONALMENTE antes de olhar `--responses` — sem essa flag, esta
 * chamada abortava 100% das vezes (confirmado ao vivo: `platform.config.json`
 * não tem `beehiiv.profileSurveyId`, e nunca vai ter um pra Tally). A flag
 * foi adicionada em `audience-run.ts` especificamente pra este caller.
 *
 * Uso:
 *   npx tsx scripts/fetch-tally-audience.ts               # roda o fluxo completo
 *   npx tsx scripts/fetch-tally-audience.ts --dry-run      # só mostra o que faria
 *
 * Requer `TALLY_API_KEY` (.env) e `platform.config.json` → `kit.tallyFormId`
 * (id do form, ex: "xX5JJy" — visível na URL do editor Tally).
 *
 * Exit codes: 1 uso/erro fatal (config ausente, form id ausente, API Tally
 * falhou); repassa o exit code de `runAudience` (0/1/2) quando chega lá.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  tallySubmissionsPageToSurveyResponses,
  type TallySubmissionsListResponse,
  type SurveyResponseLike,
} from "./lib/shared/tally-audience.ts";
import { runAudience, productionDeps, type PlatformConfig } from "./audience-run.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TALLY_API = "https://api.tally.so";

/** Mesmo espírito de SUBSCRIBE_FETCH_TIMEOUT_MS (workers/poll/src/subscribe.ts)
 *  — nenhum fetch deste módulo deve travar a resposta indefinidamente
 *  (achado do review, #6084). */
const TALLY_FETCH_TIMEOUT_MS = 15_000;

/** Teto de segurança pra paginação — nunca esperado na prática (a survey
 *  de audiência tem baixo volume), só evita loop infinito se a API do
 *  Tally devolver `hasMore: true` indefinidamente por bug/instabilidade
 *  (achado do review, #6084). */
const MAX_PAGES = 200;

export interface FetchTallyDeps {
  fetchImpl?: typeof fetch;
}

/** Pura — valida minimamente o shape antes de usar (achado do review:
 *  `as TallySubmissionsListResponse` sozinho deixava um shape inesperado
 *  (ex: challenge page da Cloudflare, corpo de erro parcial) estourar como
 *  `TypeError` opaco lá na frente, em vez de um erro nomeado aqui). */
function isValidTallyPage(json: unknown): json is TallySubmissionsListResponse {
  if (typeof json !== "object" || json === null) return false;
  const j = json as Record<string, unknown>;
  return Array.isArray(j.questions) && Array.isArray(j.submissions) && typeof j.hasMore === "boolean";
}

/**
 * Pagina `GET /forms/{formId}/submissions` até esgotar (`hasMore: false`),
 * concatenando as respostas já transformadas de cada página. `page` do
 * Tally é 1-indexed. Retorna também `totalSeen`/`totalIncomplete` — achado
 * do review: sem esses números, um form com alta taxa de abandono (muitas
 * submissões incompletas, filtradas por `tallySubmissionsPageToSurveyResponses`)
 * pareceria "saudável" no log final, que só mostrava a contagem de
 * completas.
 */
export async function fetchAllTallyResponses(
  formId: string,
  apiKey: string,
  deps: FetchTallyDeps = {},
): Promise<{ responses: SurveyResponseLike[]; totalSeen: number; totalIncomplete: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const responses: SurveyResponseLike[] = [];
  let totalSeen = 0;
  let page = 1;
  for (;;) {
    if (page > MAX_PAGES) {
      throw new Error(`GET /forms/${formId}/submissions: excedeu ${MAX_PAGES} páginas (hasMore nunca virou false) — abortando, provável bug/instabilidade da API do Tally.`);
    }
    const res = await fetchImpl(`${TALLY_API}/forms/${formId}/submissions?page=${page}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TALLY_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`GET /forms/${formId}/submissions (page ${page}) falhou (${res.status}): ${await res.text()}`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`GET /forms/${formId}/submissions (page ${page}): resposta 2xx não é JSON válido: ${(e as Error).message} (body: ${text.slice(0, 200)})`);
    }
    if (!isValidTallyPage(json)) {
      throw new Error(`GET /forms/${formId}/submissions (page ${page}): resposta 2xx com shape inesperado (questions/submissions/hasMore ausentes) — body: ${text.slice(0, 200)}`);
    }
    totalSeen += json.submissions.length;
    responses.push(...tallySubmissionsPageToSurveyResponses(json));
    if (!json.hasMore) break;
    page++;
  }
  return { responses, totalSeen, totalIncomplete: totalSeen - responses.length };
}

export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const dryRun = hasFlag(process.argv.slice(2), "dry-run");
  const log = (msg: string) => process.stderr.write(`[fetch-tally-audience] ${msg}\n`);

  const apiKey = process.env.TALLY_API_KEY;
  if (!apiKey) {
    log("ERRO: TALLY_API_KEY ausente (.env).");
    process.exitCode = 1;
    return;
  }

  let cfg: PlatformConfig & { kit?: { tallyFormId?: string } };
  try {
    cfg = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8"));
  } catch (e) {
    log(`ERRO: platform.config.json inválido/ilegível: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  const formId = cfg.kit?.tallyFormId;
  if (!formId) {
    log('ERRO: platform.config.json → kit.tallyFormId ausente (id do form, visível na URL do editor Tally).');
    process.exitCode = 1;
    return;
  }

  let result: Awaited<ReturnType<typeof fetchAllTallyResponses>>;
  try {
    result = await fetchAllTallyResponses(formId, apiKey);
  } catch (e) {
    log(`ERRO: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  const { responses, totalSeen, totalIncomplete } = result;
  log(
    `${responses.length}/${totalSeen} resposta(s) completa(s) obtida(s) do form ${formId}` +
      (totalIncomplete > 0 ? ` (${totalIncomplete} incompleta(s) excluída(s))` : "") +
      ".",
  );

  if (dryRun) {
    log(`[dry-run] não grava nada — ${responses.length} resposta(s) seriam processadas.`);
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "fetch-tally-audience-"));
  try {
    const responsesPath = join(tmpDir, "tally-responses.json");
    writeFileSync(responsesPath, JSON.stringify(responses, null, 2), "utf8");
    const audienceResult = await runAudience(["--responses", responsesPath, "--skip-beehiiv-resolve"], productionDeps(rootDir));
    process.exitCode = audienceResult.code;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[fetch-tally-audience] erro fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
