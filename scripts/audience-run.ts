#!/usr/bin/env node
/**
 * audience-run.ts (#5192)
 *
 * Orquestrador determinístico de `/diaria-atualiza-audiencia` — mesmo
 * padrão de `clarice-novos-run.ts` (#4941): a skill em prosa tinha o LLM
 * como *glue*, extraindo valor de um passo (survey escolhida, respostas
 * paginadas) e injetando no próximo. #5192 pediu a conversão desse glue em
 * código, seguindo o precedente do #4941.
 *
 * **Achado ao vivo desta unidade — o script NÃO é 100% REST, ao contrário
 * do que a issue assumia por analogia com `refresh-dedup.ts`.** A issue
 * citava `refresh-dedup.ts` como prova de que "o mesmo dado sai por REST" —
 * mas aquele script cobre POSTS, um recurso documentado na API REST pública
 * da Beehiiv. Surveys não são. Verificado nesta sessão por dois caminhos
 * independentes, sem tocar nenhuma credencial real:
 *
 *   1. Busca na documentação pública (`developers.beehiiv.com`,
 *      `openapi.json`, `llms-full.txt`) — zero menção a endpoints REST de
 *      listagem/leitura de surveys ou survey responses. O único hit pra
 *      "survey" é um WEBHOOK (`survey.response.submitted`), não um
 *      endpoint de leitura.
 *   2. Sondagem HTTP sem API key (roteamento acontece antes da
 *      autenticação — 401 confirma que a rota existe, 404 confirma que
 *      não): `GET /v2/publications` → 401 (existe), `GET
 *      /v2/publications/{id}/custom_fields` → 401 (existe), `GET
 *      /v2/publications/{id}/polls` → 401 (existe) — mas TODA variante de
 *      path testada pra surveys (`/v2/publications/{id}/surveys`,
 *      `/v2/surveys`, `/v2/surveys/{id}/responses`,
 *      `/v2/publications/{id}/surveys/{id}/responses`) → 404 (não existe).
 *
 * Ou seja: `mcp__claude_ai_Beehiiv__list_surveys` e
 * `mcp__claude_ai_Beehiiv__list_survey_responses` não têm equivalente REST
 * público — são capacidade exclusiva do conector MCP da Beehiiv (mesma
 * classe que `list_post_clicks`/`list_post_subscriber_engagement`, já
 * documentada como MCP-only em `backup-beehiiv.ts` `MCP_ONLY_GAPS` — essa
 * lista estava incompleta, surveys também pertence a ela).
 *
 * **Design resultante — glue determinístico ao REDOR do que só MCP
 * consegue buscar, não substituindo o MCP:**
 *
 *   - `publicationId`: resolvível 100% via REST (`GET /publications`
 *     existe e é documentado) — este script faz essa chamada sozinho
 *     quando `platform.config.json` não tem `beehiiv.publicationId`.
 *   - `profileSurveyId`: **não pode ser descoberto por este script** (a
 *     listagem de surveys é MCP-only). Fonte de verdade é
 *     `platform.config.json` → `beehiiv.profileSurveyId`, resolvido uma
 *     vez (#5192). Se ausente, o script aceita opcionalmente
 *     `--surveys-json <arquivo>` — o dump bruto de `list_surveys` que um
 *     CALLER com acesso a MCP (sessão LLM, ou um subagente futuro no
 *     molde de `beehiiv-clicks-enricher`) já colheu — e resolve
 *     automaticamente se houver exatamente 1 survey (persistindo em
 *     `platform.config.json` pra próxima vez); com >1, ABORTA listando os
 *     candidatos, nunca adivinha.
 *   - Respostas da survey: **também não podem ser buscadas por este
 *     script** — precisa de `--responses <arquivo>`, o dump bruto (array
 *     JSON) de `list_survey_responses` já paginado e concatenado pelo
 *     caller. O script valida cada item (fail-soft: item malformado é
 *     logado e pulado, nunca trava o lote inteiro), grava
 *     `data/audience-raw.json` no formato que `update-audience.ts` espera,
 *     e spawna esse script.
 *
 * Fluxo de 2 fases pro caller (LLM/subagente com MCP):
 *
 *   1. `npx tsx scripts/audience-run.ts --resolve-only [--surveys-json <dump-list-surveys.json>]`
 *      → imprime `{publicationId, profileSurveyId}` em stdout (JSON) —
 *      esses são os IDs a passar pro MCP `list_survey_responses`.
 *   2. Caller pagina `list_survey_responses` (survey_id do passo 1),
 *      concatena todas as páginas num único array JSON, salva num arquivo.
 *   3. `npx tsx scripts/audience-run.ts --responses <arquivo>` → valida,
 *      grava `data/audience-raw.json`, roda `update-audience.ts`, imprime
 *      o topo do profile gerado.
 *
 * Cada sub-script downstream (`update-audience.ts`) é invocado por SPAWN
 * (`process.execPath --import tsx`, nunca `npx tsx` — guard #4343), nunca
 * por import.
 *
 * Exit codes:
 *   0 — sucesso (resolve-only, dry-run, ou fluxo completo)
 *   1 — erro duro (ambiguidade não resolvida, arquivo inválido, spawn falhou,
 *       0 respostas válidas após normalização)
 *   2 — config/env inválida (platform.config.json ilegível, ou
 *       publicationId ausente + BEEHIIV_API_KEY ausente pra resolver)
 *
 * Uso:
 *   npx tsx scripts/audience-run.ts --resolve-only [--surveys-json <arquivo>]
 *   npx tsx scripts/audience-run.ts --responses <arquivo> [--dry-run]
 *
 * @see .claude/skills/diaria-atualiza-audiencia/SKILL.md (delega pra cá)
 * @see scripts/update-audience.ts (formato exato de data/audience-raw.json)
 * @see scripts/clarice-novos-run.ts (mesmo padrão de orquestrador determinístico, #4941)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { beehiivApiBase } from "./lib/beehiiv-config.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";

// #4983 (mesma lição do clarice-novos-run.ts): este é o processo
// ORQUESTRADOR — precisa de BEEHIIV_API_KEY no PRÓPRIO process.env pra
// resolver publicationId via REST, não só nos sub-scripts spawnados.
// Chamada em module scope, antes de qualquer outro código.
loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BEEHIIV_API = beehiivApiBase();

// ---------------------------------------------------------------------------
// Abort tipado — code 1 (erro duro) ou 2 (config/env inválida), mesma
// distinção usada por refresh-dedup.ts/backup-beehiiv.ts.
// ---------------------------------------------------------------------------

export class AudienceAbort extends Error {
  constructor(
    message: string,
    readonly code: 1 | 2 = 1,
  ) {
    super(message);
    this.name = "AudienceAbort";
  }
}

// ---------------------------------------------------------------------------
// platform.config.json — leitura/escrita mínima do bloco `beehiiv`.
// ---------------------------------------------------------------------------

export interface PlatformConfig {
  beehiiv?: {
    publicationId?: string;
    profileSurveyId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function parsePlatformConfig(raw: string): PlatformConfig {
  return JSON.parse(raw) as PlatformConfig;
}

export function serializePlatformConfig(cfg: PlatformConfig): string {
  return JSON.stringify(cfg, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Passo 1 — publicationId. Único dos 3 valores MCP-dependentes que TEM
// equivalente REST público (GET /publications, confirmado 401 sem key —
// rota existe).
// ---------------------------------------------------------------------------

export interface PublicationCandidate {
  id: string;
  name?: string;
}

export interface FetchPublicationsDeps {
  apiKey: string | undefined;
  fetchPublications: () => Promise<PublicationCandidate[]>;
}

export async function resolvePublicationId(
  cfg: PlatformConfig,
  deps: FetchPublicationsDeps,
): Promise<{ publicationId: string; persisted: boolean }> {
  const existing = cfg.beehiiv?.publicationId;
  if (existing) return { publicationId: existing, persisted: false };

  if (!deps.apiKey) {
    throw new AudienceAbort(
      "beehiiv.publicationId ausente em platform.config.json e BEEHIIV_API_KEY não definida — " +
        "não dá pra resolver via GET /publications. Configure BEEHIIV_API_KEY ou beehiiv.publicationId manualmente.",
      2,
    );
  }

  const pubs = await deps.fetchPublications();
  if (pubs.length === 0) {
    throw new AudienceAbort(
      "GET /publications não retornou nenhuma publicação — configure beehiiv.publicationId manualmente em platform.config.json.",
    );
  }
  if (pubs.length > 1) {
    const list = pubs.map((p) => `${p.id}${p.name ? ` (${p.name})` : ""}`).join(", ");
    throw new AudienceAbort(
      `GET /publications retornou ${pubs.length} publicações (${list}) — ambíguo. ` +
        "Configure beehiiv.publicationId manualmente em platform.config.json.",
    );
  }
  return { publicationId: pubs[0].id, persisted: true };
}

// ---------------------------------------------------------------------------
// Passo 3 — profileSurveyId. NÃO tem equivalente REST (achado desta
// unidade, ver docstring do topo) — resolvido só de config, ou de um dump
// `--surveys-json` que o caller já colheu via MCP.
// ---------------------------------------------------------------------------

export interface SurveyCandidate {
  id: string;
  name?: string;
  title?: string;
}

export function resolveProfileSurveyId(
  cfg: PlatformConfig,
  surveysJson: unknown[] | undefined,
): { surveyId: string; persisted: boolean } {
  const existing = cfg.beehiiv?.profileSurveyId;
  if (existing) return { surveyId: existing, persisted: false };

  if (!surveysJson) {
    throw new AudienceAbort(
      "beehiiv.profileSurveyId ausente em platform.config.json e --surveys-json não foi fornecido. " +
        "Surveys não têm endpoint REST público (achado #5192) — rode --surveys-json com o dump de " +
        "list_surveys (MCP) pra resolver automaticamente (se houver só 1 survey) ou ver a lista de candidatos.",
    );
  }

  const candidates: SurveyCandidate[] = surveysJson
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null && "id" in s)
    .map((s) => ({
      id: String((s as Record<string, unknown>).id),
      name: typeof (s as Record<string, unknown>).name === "string" ? ((s as Record<string, unknown>).name as string) : undefined,
      title: typeof (s as Record<string, unknown>).title === "string" ? ((s as Record<string, unknown>).title as string) : undefined,
    }));

  if (candidates.length === 0) {
    throw new AudienceAbort("--surveys-json não contém nenhuma survey com campo 'id' válido.");
  }
  if (candidates.length > 1) {
    const list = candidates.map((c) => `${c.id}${c.name || c.title ? ` (${c.name ?? c.title})` : ""}`).join(", ");
    throw new AudienceAbort(
      `${candidates.length} surveys encontradas (${list}) — ambíguo, não adivinho. ` +
        "Configure beehiiv.profileSurveyId manualmente em platform.config.json com o ID da survey principal de perfil.",
    );
  }
  return { surveyId: candidates[0].id, persisted: true };
}

// ---------------------------------------------------------------------------
// Passo 4 — normalização fail-soft das respostas brutas (--responses).
// Item malformado é logado e pulado — nunca trava o lote inteiro (mesma
// regra da SKILL.md original, preservada aqui).
// ---------------------------------------------------------------------------

export interface BeehiivSurveyAnswer {
  question_id: string;
  question_prompt: string;
  answer: string;
}

export interface BeehiivSurveyResponse {
  id: string;
  status?: string;
  answers: BeehiivSurveyAnswer[];
}

export interface NormalizeResult {
  valid: BeehiivSurveyResponse[];
  skipped: number;
  skipReasons: string[];
}

/** Retorna o motivo do descarte, ou `null` se o item é válido. */
function invalidResponseReason(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return "não é um objeto";
  const obj = item as Record<string, unknown>;
  if (typeof obj.id !== "string" && typeof obj.id !== "number") return "campo 'id' ausente/inválido";
  if (!Array.isArray(obj.answers)) return "campo 'answers' ausente ou não é array";
  for (let j = 0; j < obj.answers.length; j++) {
    const a = obj.answers[j];
    if (typeof a !== "object" || a === null) return `answers[${j}] não é um objeto`;
    const ao = a as Record<string, unknown>;
    if (typeof ao.question_id !== "string" && typeof ao.question_id !== "number") return `answers[${j}].question_id ausente`;
    if (typeof ao.question_prompt !== "string") return `answers[${j}].question_prompt ausente`;
    if (typeof ao.answer !== "string") return `answers[${j}].answer ausente`;
  }
  return null;
}

export function normalizeSurveyResponses(raw: unknown[]): NormalizeResult {
  const valid: BeehiivSurveyResponse[] = [];
  const skipReasons: string[] = [];
  let skipped = 0;

  raw.forEach((item, i) => {
    const reason = invalidResponseReason(item);
    if (reason) {
      skipped++;
      skipReasons.push(`item[${i}]: ${reason}`);
      return;
    }
    const obj = item as Record<string, unknown>;
    valid.push({
      id: String(obj.id),
      status: typeof obj.status === "string" ? obj.status : undefined,
      answers: (obj.answers as Record<string, unknown>[]).map((a) => ({
        question_id: String(a.question_id),
        question_prompt: String(a.question_prompt),
        answer: String(a.answer),
      })),
    });
  });

  return { valid, skipped, skipReasons };
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export interface AudienceRunOptions {
  resolveOnly: boolean;
  surveysJsonPath?: string;
  responsesPath?: string;
  dryRun: boolean;
  /** #466 (achado do review, PR #6084): pula Passo 1/3 (publicationId/
   *  profileSurveyId da Beehiiv) — pra callers cuja fonte de respostas não
   *  é a survey Beehiiv (ex: `fetch-tally-audience.ts`), pra quem esses 2
   *  IDs não existem e nunca vão existir. Sem essa flag, `runAudience`
   *  aborta ANTES de sequer olhar `--responses`, porque
   *  `resolveProfileSurveyId` exige `beehiiv.profileSurveyId` (ou
   *  `--surveys-json`) incondicionalmente — confirmado ao vivo que
   *  `fetch-tally-audience.ts` quebrava 100% das vezes por causa disso. */
  skipBeehiivResolve: boolean;
}

export function parseAudienceRunArgs(argv: string[]): AudienceRunOptions {
  return {
    resolveOnly: hasFlag(argv, "resolve-only"),
    surveysJsonPath: getStringArg(argv, "surveys-json", { example: "data/_tmp/surveys.json" }),
    responsesPath: getStringArg(argv, "responses", { example: "data/_tmp/survey-responses.json" }),
    dryRun: hasFlag(argv, "dry-run"),
    skipBeehiivResolve: hasFlag(argv, "skip-beehiiv-resolve"),
  };
}

// ---------------------------------------------------------------------------
// Spawn de sub-script — mesmo padrão de realExec em clarice-novos-run.ts.
// ---------------------------------------------------------------------------

export interface StepResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (scriptRelPath: string, args: string[]) => StepResult;

export function realExec(rootDir: string): ExecFn {
  return (scriptRelPath, args) => {
    const abs = resolve(rootDir, ...scriptRelPath.split("/"));
    const result = spawnSync(process.execPath, ["--import", "tsx", abs, ...args], {
      cwd: rootDir,
      encoding: "utf8",
    });
    if (result.error || result.status === null) {
      return {
        code: 1,
        stdout: result.stdout ?? "",
        stderr: (result.stderr ?? "") + `\nERRO: o passo nao executou (falha de spawn): ${result.error?.message ?? "status null"}\n`,
      };
    }
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

// ---------------------------------------------------------------------------
// Deps injetáveis — produção usa os reais; testes injetam fakes (sem
// spawn/fetch real, ver test/audience-run.test.ts).
// ---------------------------------------------------------------------------

export interface AudienceRunDeps {
  rootDir: string;
  apiKey: string | undefined;
  fetchPublications: () => Promise<PublicationCandidate[]>;
  exec: ExecFn;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
}

async function fetchPublicationsReal(apiKey: string | undefined): Promise<PublicationCandidate[]> {
  const res = await fetch(`${BEEHIIV_API}/publications`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new AudienceAbort(`GET /publications falhou (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
  const data = Array.isArray(json.data) ? json.data : [];
  return data.map((p) => ({ id: String(p.id), name: p.name ? String(p.name) : undefined }));
}

export function productionDeps(rootDir: string = ROOT): AudienceRunDeps {
  return {
    rootDir,
    apiKey: process.env.BEEHIIV_API_KEY,
    fetchPublications: () => fetchPublicationsReal(process.env.BEEHIIV_API_KEY),
    exec: realExec(rootDir),
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, c) => writeFileSync(p, c, "utf8"),
  };
}

// ---------------------------------------------------------------------------
// Orquestração principal.
// ---------------------------------------------------------------------------

export interface AudienceRunResult {
  code: 0 | 1 | 2;
}

export async function runAudience(argv: string[], deps: AudienceRunDeps): Promise<AudienceRunResult> {
  const opts = parseAudienceRunArgs(argv);
  const configPath = resolve(deps.rootDir, "platform.config.json");

  let cfg: PlatformConfig;
  try {
    cfg = parsePlatformConfig(deps.readFile(configPath));
  } catch (e) {
    console.error(`[audience-run] platform.config.json inválido/ilegível (${configPath}): ${(e as Error).message}`);
    return { code: 2 };
  }

  // #466 (achado do review, PR #6084): Passo 1/3 resolvem IDs que só fazem
  // sentido pra fonte Beehiiv — um caller cuja fonte de respostas nunca vai
  // ter publicationId/profileSurveyId (ex: fetch-tally-audience.ts) precisa
  // pular os dois inteiramente, senão `resolveProfileSurveyId` aborta ANTES
  // de sequer olhar `--responses`. `--skip-beehiiv-resolve` implica também
  // pular `--resolve-only` (não há o que resolver) — só `pub`/`survey`
  // ficam `undefined`, threadados como tal no resto da função.
  let pub: { publicationId: string; persisted: boolean } | undefined;
  let survey: { surveyId: string; persisted: boolean } | undefined;

  try {
    if (!opts.skipBeehiivResolve) {
      // --- Passo 1: publicationId ---
      // NUNCA gravar em platform.config.json sob --dry-run (#5298) — mesmo
      // quando o valor ainda não está configurado e precisa ser resolvido, o
      // dry-run só reporta o que TERIA sido resolvido/gravado.
      pub = await resolvePublicationId(cfg, deps);
      if (pub.persisted) {
        cfg = { ...cfg, beehiiv: { ...cfg.beehiiv, publicationId: pub.publicationId } };
        if (opts.dryRun) {
          console.error(
            `[audience-run] --dry-run: beehiiv.publicationId resolveria para ${pub.publicationId} via GET /publications (NÃO gravado em platform.config.json).`,
          );
        } else {
          deps.writeFile(configPath, serializePlatformConfig(cfg));
          console.error(`[audience-run] beehiiv.publicationId resolvido via GET /publications e persistido: ${pub.publicationId}`);
        }
      }

      // --- Passo 3: profileSurveyId ---
      let surveysJson: unknown[] | undefined;
      if (opts.surveysJsonPath) {
        const surveysPath = resolve(deps.rootDir, opts.surveysJsonPath);
        let parsed: unknown;
        try {
          parsed = JSON.parse(deps.readFile(surveysPath));
        } catch (e) {
          throw new AudienceAbort(`--surveys-json (${opts.surveysJsonPath}) não é JSON válido: ${(e as Error).message}`);
        }
        if (!Array.isArray(parsed)) {
          throw new AudienceAbort(`--surveys-json (${opts.surveysJsonPath}) deve conter um array JSON — recebido ${typeof parsed}.`);
        }
        surveysJson = parsed;
      }
      // Mesma disciplina do Passo 1 — resolver em memória (pra reportar/usar no
      // resto do fluxo) sem persistir nada em disco sob --dry-run.
      survey = resolveProfileSurveyId(cfg, surveysJson);
      if (survey.persisted) {
        cfg = { ...cfg, beehiiv: { ...cfg.beehiiv, profileSurveyId: survey.surveyId } };
        if (opts.dryRun) {
          console.error(
            `[audience-run] --dry-run: beehiiv.profileSurveyId resolveria para ${survey.surveyId} (única survey candidata; NÃO gravado em platform.config.json).`,
          );
        } else {
          deps.writeFile(configPath, serializePlatformConfig(cfg));
          console.error(`[audience-run] beehiiv.profileSurveyId resolvido (única survey candidata) e persistido: ${survey.surveyId}`);
        }
      }
    }

    if (opts.resolveOnly) {
      if (opts.skipBeehiivResolve) {
        throw new AudienceAbort("--resolve-only não faz sentido com --skip-beehiiv-resolve — não há publicationId/profileSurveyId pra resolver.");
      }
      console.log(JSON.stringify({ publicationId: pub!.publicationId, profileSurveyId: survey!.surveyId }));
      return { code: 0 };
    }

    // --- Passo 4-5: respostas brutas (--responses, obrigatório fora de --resolve-only) ---
    if (!opts.responsesPath) {
      throw new AudienceAbort(
        opts.skipBeehiivResolve
          ? "--responses <arquivo> é obrigatório fora de --resolve-only."
          : "--responses <arquivo> é obrigatório fora de --resolve-only — passe o dump de list_survey_responses " +
              `(publication_id=${pub!.publicationId}, survey_id=${survey!.surveyId}, paginado e concatenado num array JSON único).`,
      );
    }
    const responsesPath = resolve(deps.rootDir, opts.responsesPath);
    let rawResponses: unknown;
    try {
      rawResponses = JSON.parse(deps.readFile(responsesPath));
    } catch (e) {
      throw new AudienceAbort(`--responses (${opts.responsesPath}) não é JSON válido: ${(e as Error).message}`);
    }
    if (!Array.isArray(rawResponses)) {
      throw new AudienceAbort(`--responses (${opts.responsesPath}) deve conter um array JSON — recebido ${typeof rawResponses}.`);
    }

    const normalized = normalizeSurveyResponses(rawResponses);
    if (normalized.skipped > 0) {
      console.error(`[audience-run] ${normalized.skipped} resposta(s) malformada(s) ignorada(s) (fail-soft, não travou o lote):`);
      for (const reason of normalized.skipReasons.slice(0, 20)) console.error(`  - ${reason}`);
      if (normalized.skipReasons.length > 20) {
        console.error(`  ... e mais ${normalized.skipReasons.length - 20} não listada(s).`);
      }
    }
    console.error(`[audience-run] ${normalized.valid.length} resposta(s) válida(s) de ${rawResponses.length} total.`);

    if (normalized.valid.length === 0) {
      throw new AudienceAbort("Nenhuma resposta válida após normalização — 0 respostas não gera profile novo.");
    }

    const audienceRawPath = resolve(deps.rootDir, "data/audience-raw.json");

    if (opts.dryRun) {
      console.error(
        `[audience-run] --dry-run: pararia aqui — escreveria ${normalized.valid.length} resposta(s) em ` +
          `${audienceRawPath} e rodaria update-audience.ts. Nenhum arquivo tocado.`,
      );
      return { code: 0 };
    }

    // --- Passo 5: grava data/audience-raw.json no formato de update-audience.ts ---
    mkdirSync(dirname(audienceRawPath), { recursive: true });
    deps.writeFile(audienceRawPath, JSON.stringify(normalized.valid, null, 2) + "\n");
    console.error(`[audience-run] ${normalized.valid.length} resposta(s) gravada(s) em ${audienceRawPath}`);

    // --- Passo 6: roda update-audience.ts (spawn, nunca import — #4343) ---
    const updateResult = deps.exec("scripts/update-audience.ts", [audienceRawPath]);
    if (updateResult.stderr.trim()) console.error(updateResult.stderr.trim());
    if (updateResult.stdout.trim()) console.error(updateResult.stdout.trim());
    if (updateResult.code !== 0) {
      throw new AudienceAbort(`update-audience.ts falhou (exit ${updateResult.code}).`);
    }

    // --- Passo 8: mostra o topo do profile gerado, pra confirmação ---
    const profilePath = resolve(deps.rootDir, "context/audience-profile.md");
    if (existsSync(profilePath)) {
      const head = deps.readFile(profilePath).split("\n").slice(0, 12).join("\n");
      console.log(head);
    }

    return { code: 0 };
  } catch (e) {
    const abort = e instanceof AudienceAbort ? e : new AudienceAbort(`erro inesperado: ${(e as Error).message}`);
    console.error(`[audience-run] ❌ ${abort.message}`);
    return { code: abort.code };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const deps = productionDeps(ROOT);
  runAudience(process.argv.slice(2), deps)
    .then((r) => {
      // process.exitCode (não process.exit()) — deixa o event loop drenar
      // sozinho, mesmo padrão/motivo de clarice-novos-run.ts (#4949/#1401/#4653).
      process.exitCode = r.code;
    })
    .catch((e) => {
      console.error(String((e as Error)?.stack || e));
      process.exitCode = 1;
    });
}
