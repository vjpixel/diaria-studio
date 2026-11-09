#!/usr/bin/env node
/**
 * audience-run.ts (#5192, reescrito no #10605)
 *
 * Orquestrador determinístico de `/diaria-atualiza-audiencia`. Desde a
 * decisão 10 do editor (08/11/2026, #10605) o perfil de audiência sai SÓ do
 * formulário do onboarding (Worker `workers/onboarding-form`): as respostas
 * da survey antiga da Beehiiv foram descartadas, e o Tally (#466) nunca virou
 * fonte. Por isso o script não tem mais as duas fases MCP da Beehiiv
 * (`--resolve-only`/`--surveys-json`/`--responses`, que existiam porque
 * surveys da Beehiiv não saem por REST): ele lê o formulário sozinho e faz o
 * resto.
 *
 * Fluxo:
 *   1. lê `GET onboarding.followup.form_responses_url` com o token de
 *      `form_responses_token_env` (`fetchOnboardingFormResponsesReal`);
 *   2. converte as respostas para o formato de `data/audience-raw.json`
 *      (`onboardingFormToSurveyResponses`, sem e-mail no id);
 *   3. grava `data/audience-raw.json` e roda `update-audience.ts` (spawn,
 *      `process.execPath --import tsx`, nunca `npx tsx` — guard #4343).
 *
 * Fail-closed: formulário não configurado, leitura falhando (token ausente,
 * HTTP de erro, timeout, payload malformado) ou zero respostas ABORTAM sem
 * tocar em `data/audience-raw.json` (exit 1). Um `audience-raw.json` antigo
 * com a survey da Beehiiv não volta ao perfil: `update-audience.ts` ignora o
 * que não vem do formulário.
 *
 * Flags antigas da Beehiiv (`--resolve-only`, `--surveys-json`,
 * `--responses`) abortam com exit 1 e a explicação, para quem as usava (a
 * skill antiga, `fetch-tally-audience.ts`) saber por que parou, em vez de
 * gerar um perfil que finge incluir uma fonte descartada.
 *
 * Exit codes:
 *   0 — sucesso (ou dry-run)
 *   1 — erro duro (formulário indisponível, 0 respostas, flag antiga, update-audience falhou)
 *   2 — platform.config.json ilegível
 *
 * Uso:
 *   npx tsx scripts/audience-run.ts            # regenera o perfil
 *   npx tsx scripts/audience-run.ts --dry-run  # lê e conta, não grava nada
 *
 * @see .claude/skills/diaria-atualiza-audiencia/SKILL.md (delega pra cá)
 * @see scripts/update-audience.ts (formato exato de data/audience-raw.json)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { fetchAllFormResponses, type FormResponse } from "./lib/onboarding-form-contract.ts";
import { resolveFollowupConfig, type FollowupConfigRaw } from "./lib/onboarding-followup.ts";
import { onboardingFormToSurveyResponses, type SurveyResponseRecord } from "./lib/audience-survey-questions.ts";

// O token do formulário vem do .env/Doppler — precisa estar no PRÓPRIO
// process.env deste processo (mesma lição do clarice-novos-run.ts, #4983).
loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class AudienceAbort extends Error {
  constructor(
    message: string,
    readonly code: 1 | 2 = 1,
  ) {
    super(message);
    this.name = "AudienceAbort";
  }
}

export interface PlatformConfig {
  /** #10605: só `followup.form_responses_url`/`form_responses_token_env` interessam aqui. */
  onboarding?: { followup?: FollowupConfigRaw; [key: string]: unknown };
  [key: string]: unknown;
}

export function parsePlatformConfig(raw: string): PlatformConfig {
  return JSON.parse(raw) as PlatformConfig;
}

export function serializePlatformConfig(cfg: PlatformConfig): string {
  return JSON.stringify(cfg, null, 2) + "\n";
}

/** Flags da survey Beehiiv, descartada pela decisão 10 do editor (#10605). */
export const LEGACY_BEEHIIV_FLAGS = ["resolve-only", "surveys-json", "responses"] as const;

export const LEGACY_FLAG_MESSAGE =
  "a survey da Beehiiv (e o Tally) foi descartada pela decisão 10 do editor (#10605, 08/11/2026): " +
  "o perfil de audiência sai só do formulário do onboarding. Rode `npx tsx scripts/audience-run.ts` sem argumentos.";

/** `null` = formulário não configurado (sem `form_responses_url`). Lança em falha de leitura. */
export type FetchFormResponsesFn = (cfg: PlatformConfig) => Promise<FormResponse[] | null>;

/**
 * Respostas do formulário no formato de `data/audience-raw.json`. Não
 * configurado, leitura falhando ou zero respostas: ABORTA (o perfil não é
 * regenerado — um perfil sem a única fonte declarativa, sem ninguém
 * perceber, seria pior que o perfil anterior).
 */
export async function loadOnboardingFormSurveyResponses(cfg: PlatformConfig, fetchFn: FetchFormResponsesFn): Promise<SurveyResponseRecord[]> {
  let responses: FormResponse[] | null;
  try {
    responses = await fetchFn(cfg);
  } catch (e) {
    throw new AudienceAbort(
      `respostas do formulário do onboarding não lidas: ${(e as Error).message}. Perfil NÃO regenerado — corrija o acesso ao Worker.`,
    );
  }
  if (responses == null) {
    throw new AudienceAbort(
      "formulário do onboarding não configurado (onboarding.followup.form_responses_url ausente) — ele é a única fonte do perfil (#10605). Perfil NÃO regenerado.",
    );
  }
  const converted = onboardingFormToSurveyResponses(responses);
  if (converted.unknownAnswers > 0) {
    console.error(
      `[audience-run] ⚠ ${converted.unknownAnswers} resposta(s) do formulário a pergunta(s) que não existem mais em FORM_QUESTIONS — descartada(s).`,
    );
  }
  if (converted.legacyAnswers > 0) {
    console.error(
      `[audience-run] ⚠ ${converted.legacyAnswers} resposta(s) a perguntas de versões anteriores do formulário (nível, seções, inglês, preço, sugestão) — ignorada(s) no perfil.`,
    );
  }
  if (converted.legacyOptionAnswers > 0) {
    console.error(
      `[audience-run] ⚠ ${converted.legacyOptionAnswers} opção(ões) marcada(s) que não existem mais nas perguntas atuais (respostas v1/v2 de área, formato ou tema) — ignorada(s) no perfil.`,
    );
  }
  if (converted.emptyResponses > 0) {
    console.error(`[audience-run] ⚠ ${converted.emptyResponses} resposta(s) sem nenhuma resposta a pergunta atual — não contam como respondente.`);
  }
  if (converted.responses.length === 0) {
    throw new AudienceAbort("o formulário do onboarding ainda não tem respostas — 0 respostas não gera perfil novo.");
  }
  console.error(`[audience-run] ${converted.responses.length} resposta(s) do formulário do onboarding.`);
  return converted.responses;
}

export interface FormFetchEnv {
  fetchImpl?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}

/**
 * Lê `GET form_responses_url` com o token de `form_responses_token_env`.
 * `null` só quando a URL não está configurada; qualquer outra falha LANÇA
 * (token ausente, HTTP de erro, timeout, payload malformado).
 */
export async function fetchOnboardingFormResponsesReal(cfg: PlatformConfig, io: FormFetchEnv = {}): Promise<FormResponse[] | null> {
  const fetchImpl = io.fetchImpl ?? fetch;
  const env = io.env ?? process.env;
  const fc = resolveFollowupConfig(cfg.onboarding?.followup);
  if (fc.formResponsesUrl == null) return null;
  const token = env[fc.formResponsesTokenEnv];
  if (!token) throw new Error(`${fc.formResponsesTokenEnv} ausente no ambiente`);
  // #12509: segue as páginas (`next_cursor`) até a última.
  return fetchAllFormResponses(fc.formResponsesUrl, token, { fetchImpl, timeoutMs: io.timeoutMs });
}

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

export interface AudienceRunDeps {
  rootDir: string;
  exec: ExecFn;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  fetchFormResponses: FetchFormResponsesFn;
}

export function productionDeps(rootDir: string = ROOT): AudienceRunDeps {
  return {
    rootDir,
    exec: realExec(rootDir),
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, c) => writeFileSync(p, c, "utf8"),
    fetchFormResponses: (cfg) => fetchOnboardingFormResponsesReal(cfg),
  };
}

export interface AudienceRunResult {
  code: 0 | 1 | 2;
}

export async function runAudience(argv: string[], deps: AudienceRunDeps): Promise<AudienceRunResult> {
  const legacy = LEGACY_BEEHIIV_FLAGS.filter((f) => argv.some((a) => a === `--${f}` || a.startsWith(`--${f}=`)));
  if (legacy.length > 0) {
    console.error(`[audience-run] ❌ --${legacy.join(", --")}: ${LEGACY_FLAG_MESSAGE}`);
    return { code: 1 };
  }
  const dryRun = hasFlag(argv, "dry-run");
  const configPath = resolve(deps.rootDir, "platform.config.json");

  let cfg: PlatformConfig;
  try {
    cfg = parsePlatformConfig(deps.readFile(configPath));
  } catch (e) {
    console.error(`[audience-run] platform.config.json inválido/ilegível (${configPath}): ${(e as Error).message}`);
    return { code: 2 };
  }

  try {
    const responses = await loadOnboardingFormSurveyResponses(cfg, deps.fetchFormResponses);
    const audienceRawPath = resolve(deps.rootDir, "data/audience-raw.json");

    if (dryRun) {
      console.error(
        `[audience-run] --dry-run: pararia aqui — escreveria ${responses.length} resposta(s) do formulário em ` +
          `${audienceRawPath} e rodaria update-audience.ts. Nenhum arquivo tocado.`,
      );
      return { code: 0 };
    }

    mkdirSync(dirname(audienceRawPath), { recursive: true });
    deps.writeFile(audienceRawPath, JSON.stringify(responses, null, 2) + "\n");
    console.error(`[audience-run] ${responses.length} resposta(s) gravada(s) em ${audienceRawPath}`);

    const updateResult = deps.exec("scripts/update-audience.ts", [audienceRawPath]);
    if (updateResult.stderr.trim()) console.error(updateResult.stderr.trim());
    if (updateResult.stdout.trim()) console.error(updateResult.stdout.trim());
    if (updateResult.code !== 0) {
      throw new AudienceAbort(`update-audience.ts falhou (exit ${updateResult.code}).`);
    }

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
