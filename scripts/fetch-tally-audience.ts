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

export interface FetchTallyDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Pagina `GET /forms/{formId}/submissions` até esgotar (`hasMore: false`),
 * concatenando as respostas já transformadas de cada página. `page` do
 * Tally é 1-indexed.
 */
export async function fetchAllTallyResponses(
  formId: string,
  apiKey: string,
  deps: FetchTallyDeps = {},
): Promise<SurveyResponseLike[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const all: SurveyResponseLike[] = [];
  let page = 1;
  for (;;) {
    const res = await fetchImpl(`${TALLY_API}/forms/${formId}/submissions?page=${page}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`GET /forms/${formId}/submissions (page ${page}) falhou (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as TallySubmissionsListResponse;
    all.push(...tallySubmissionsPageToSurveyResponses(json));
    if (!json.hasMore) break;
    page++;
  }
  return all;
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

  const cfg = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8")) as PlatformConfig & {
    kit?: { tallyFormId?: string };
  };
  const formId = cfg.kit?.tallyFormId;
  if (!formId) {
    log('ERRO: platform.config.json → kit.tallyFormId ausente (id do form, visível na URL do editor Tally).');
    process.exitCode = 1;
    return;
  }

  let responses: SurveyResponseLike[];
  try {
    responses = await fetchAllTallyResponses(formId, apiKey);
  } catch (e) {
    log(`ERRO: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  log(`${responses.length} resposta(s) completa(s) obtida(s) do form ${formId}.`);

  if (dryRun) {
    log(`[dry-run] não grava nada — ${responses.length} resposta(s) seriam processadas.`);
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "fetch-tally-audience-"));
  try {
    const responsesPath = join(tmpDir, "tally-responses.json");
    writeFileSync(responsesPath, JSON.stringify(responses, null, 2), "utf8");
    const result = await runAudience(["--responses", responsesPath], productionDeps(rootDir));
    process.exitCode = result.code;
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
