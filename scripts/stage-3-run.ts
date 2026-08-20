#!/usr/bin/env node
/**
 * stage-3-run.ts (#5415, incremento 2/3 — Stage 3, ESCOPO PARCIAL)
 *
 * Orquestrador DETERMINÍSTICO de parte do Stage 3 (Imagens) do orchestrator
 * diar.ia.br (`.claude/agents/orchestrator-stage-3.md`) — mesmo padrão de
 * `scripts/stage-0-run.ts` (#5415 incremento 1/3), `scripts/clarice-novos-run.ts`
 * (#4941) e `scripts/audience-run.ts` (#5192).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POR QUE ESCOPO PARCIAL (achado ao vivo, comentário da issue #5415 em
 * 260820 04:13:30 — "a premissa 'Stage 0 e 3 são limpos' não bate com o
 * playbook atual")
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Diferente do que a auditoria original da #5415 assumia, o playbook do
 * Stage 3 INTEIRO não é "sequência fixa de npx tsx sem julgamento": §3a-bis
 * dispatcha `Skill("humanizador", ...)` + `mcp__clarice__correct_text` com
 * um filtro de julgamento semântico explícito ("na dúvida, descartar a
 * correção duvidosa"), e o fim de §3b dispatcha `Agent("image-crop-reviewer",
 * ...)` seguido de um GATE HUMANO real. Nenhum desses três é alcançável de
 * dentro de um `spawnSync` — script Node puro não chama MCP, Skill, Agent,
 * nem para pra esperar resposta do editor.
 *
 * Este script cobre só o MIOLO DETERMINÍSTICO de §3b — a parte que a
 * própria issue já apontava como "geração já é script, sem Agent no meio":
 * lint pre-flight, `image-generate.ts` (2x1/1x1 + 4x5 nativo) por destaque,
 * composição do card 4:5, fetch do leaderboard, injeção do box de campeões,
 * e as invariantes pré-gate. **Ele roda independente de §3a/§3a-bis** — a
 * geração de imagens de destaque não depende do É IA? ter terminado, só do
 * sentinel da Etapa 2 (destaques escritos).
 *
 * COBERTO:
 *   Assert do sentinel Stage 2 (02-reviewed.md, 03-social.md).
 *   Leitura de destaque_count (`_internal/01-approved-capped.json`).
 *   Checagem de saúde do ComfyUI, quando `platform.config.json.image_generator
 *     === "comfyui"` (HALT se indisponível — mesma severidade do playbook).
 *   Por destaque presente (d1, d2, e d3 só se destaque_count === 3):
 *     lint-image-prompt.ts → image-generate.ts (2x1/1x1) → image-generate.ts
 *     --ratio 4x5 (nativo). Falha de lint pausa SÓ aquele destaque (report,
 *     não hard-abort); falha de `image-generate.ts` (qualquer ratio) é
 *     BLOQUEANTE — para o Stage 3 inteiro, igual ao playbook (#4090).
 *   gen-social-card-4x5.ts (compõe os cards de todos os destaques prontos) —
 *     BLOQUEANTE (#4090) se falhar.
 *   fetch-leaderboard-top1.ts — fail-soft (#1753, não-bloqueante).
 *   inject-champions-callout.ts — no-op/injected tratados como sucesso;
 *     exit 1 (raffle stale, #4583) vira HALT, nunca publica data errada.
 *   check-invariants.ts --stage 3 — reportado no resultado (invariantsPassed
 *     + invariantsViolations), NUNCA aborta o script (é pre-gate report, o
 *     gate em si é do orchestrator).
 *   run-image-crop-reviewer.ts em modo DESCOBERTA (sem --input-json) — só a
 *     parte determinística (scan de disco); os pares descobertos voltam em
 *     `cropReviewPairs` no JSON de saída, junto com um `pendingAgentDispatch`
 *     pronto pro orchestrator montar a chamada `Agent("image-crop-reviewer")`.
 *
 * NÃO COBERTO — delegado ao orchestrator, NUNCA simulado aqui (ver
 * `DELEGATED_STEPS` abaixo para o texto completo):
 *   §3a — polling do eia-compose.ts em background + retry/skip em timeout
 *     de 10min (decisão do editor no timeout).
 *   §3a-bis — Skill("humanizador") + mcp__clarice__correct_text + filtro de
 *     julgamento semântico sobre a descrição do É IA?.
 *   §3b (crop-reviewer) — dispatch `Agent("image-crop-reviewer", ...)` e a
 *     chamada `--input-json` que persiste o veredito. Este script só faz a
 *     DESCOBERTA dos pares (devolvidos em `cropReviewPairs`).
 *   §3b (gate humano final) — aprovar/regenerar + escrever o sentinel do
 *     Stage 3 (`pipeline-sentinel.ts write --step 3`) — só acontece DEPOIS
 *     da aprovação do editor, então nunca é responsabilidade deste script.
 *
 * Cada sub-script é invocado por SPAWN (`process.execPath --import tsx`,
 * nunca `npx tsx` — guard #4343), nunca por import.
 *
 * Exit codes:
 *   0 — sucesso (mesmo com destaque(s) pausado(s) por violação de lint, ou
 *       invariantes falhando — isso não é erro do script, é trabalho que o
 *       orchestrator/editor ainda precisa fazer antes do gate)
 *   1 — erro duro (sentinel Stage 2 ausente, sub-script obrigatório com
 *       exit inesperado, `image-generate.ts`/`gen-social-card-4x5.ts`
 *       falhando — BLOQUEANTE #4090)
 *   2 — HALT obrigatório (ComfyUI indisponível quando configurado,
 *       `inject-champions-callout.ts` FATAL por raffle stale #4583 — banner
 *       já renderizado, incluído em `haltRequired` no JSON de saída)
 *
 * Uso:
 *   npx tsx scripts/stage-3-run.ts --edition AAMMDD [--only d1,d2] [--force]
 *
 * @see .claude/agents/orchestrator-stage-3.md (playbook em prosa — este
 *      script cobre só o miolo de §3b; NÃO editado nesta unidade — cutover
 *      do orchestrator é decisão separada, mesmo padrão do stage-0-run.ts)
 * @see scripts/stage-0-run.ts (padrão de referência mais próximo, #5415 1/3)
 * @see scripts/clarice-novos-run.ts (padrão original, #4941)
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";

// Mesma disciplina do #4983 — carregar .env ANTES de qualquer outro código.
loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Spawn de sub-script — mesmo helper de stage-0-run.ts.
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

/** Extrai o primeiro bloco JSON de stdout — mesmo helper de stage-0-run.ts/clarice-novos-run.ts. */
export function parseStepJson<T = unknown>(stdout: string): T | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const start = Math.min(...["{", "["].map((c) => trimmed.indexOf(c)).filter((i) => i >= 0));
  if (!Number.isFinite(start)) return undefined;
  try {
    return JSON.parse(trimmed.slice(start)) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Abort tipado.
// ---------------------------------------------------------------------------

export class Stage3Abort extends Error {
  readonly code = 1 as const;
  constructor(message: string) {
    super(message);
    this.name = "Stage3Abort";
  }
}

// ---------------------------------------------------------------------------
// Opções da CLI
// ---------------------------------------------------------------------------

export type DestaqueId = "d1" | "d2" | "d3";
const AAMMDD_RE = /^\d{6}$/;
const VALID_DESTAQUES: DestaqueId[] = ["d1", "d2", "d3"];

export interface Stage3RunOptions {
  edition: string;
  only?: DestaqueId[];
  force: boolean;
}

export function parseStage3RunArgs(argv: string[]): Stage3RunOptions {
  const edition = getStringArg(argv, "edition", { example: "260423" });
  if (!edition || !AAMMDD_RE.test(edition)) {
    throw new Stage3Abort('--edition AAMMDD é obrigatório (6 dígitos, ex: "260423").');
  }

  const onlyRaw = getStringArg(argv, "only", { example: "d1,d2" });
  let only: DestaqueId[] | undefined;
  if (onlyRaw !== undefined) {
    const parts = onlyRaw.split(",").map((s) => s.trim());
    for (const p of parts) {
      if (!(VALID_DESTAQUES as string[]).includes(p)) {
        throw new Stage3Abort(`--only inválido: "${p}" — esperado d1, d2 ou d3.`);
      }
    }
    only = parts as DestaqueId[];
  }

  return { edition, only, force: hasFlag(argv, "force") };
}

// ---------------------------------------------------------------------------
// Deps injetáveis.
// ---------------------------------------------------------------------------

export interface Stage3RunDeps {
  rootDir: string;
  exec: ExecFn;
  existsSync: (p: string) => boolean;
  readFile: (p: string) => string;
  /** Checa se o ComfyUI local está no ar (`http://127.0.0.1:8188/system_stats`).
   * Só é chamado quando `platform.config.json.image_generator === "comfyui"`.
   * Injetável pra teste — a implementação real usa `curl` com timeout curto
   * (mesmo comando que o playbook prescreve, #4090 §3b). */
  checkComfyUi: () => boolean;
}

export function productionDeps(rootDir: string = ROOT): Stage3RunDeps {
  return {
    rootDir,
    exec: realExec(rootDir),
    existsSync: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, "utf8"),
    checkComfyUi: () => {
      try {
        const result = spawnSync("curl", ["-sf", "--max-time", "3", "http://127.0.0.1:8188/system_stats"], { encoding: "utf8" });
        return result.status === 0;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Report — acumula texto humano-legível pra devolver no JSON final.
// ---------------------------------------------------------------------------

class ReportBuilder {
  readonly notes: string[] = [];
  note(line: string): void {
    this.notes.push(line);
    console.error(line);
  }
}

function softStep(
  deps: Stage3RunDeps,
  report: ReportBuilder,
  label: string,
  scriptRelPath: string,
  args: string[],
): { result: StepResult; json: unknown } {
  report.note(`▶ ${label} (fail-soft)`);
  const result = deps.exec(scriptRelPath, args);
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.code !== 0) {
    report.note(`⚠️  ${label} falhou (exit ${result.code}) — fail-soft, não bloqueia Stage 3.`);
  }
  return { result, json: parseStepJson(result.stdout) };
}

function logEvent(
  deps: Stage3RunDeps,
  edition: string,
  level: "info" | "warn" | "error",
  message: string,
  opts: { details?: unknown; informational?: boolean } = {},
): void {
  const args = ["--edition", edition, "--stage", "3", "--agent", "orchestrator", "--level", level, "--message", message];
  if (opts.details !== undefined) args.push("--details", JSON.stringify(opts.details));
  if (opts.informational) args.push("--informational");
  const result = deps.exec("scripts/log-event.ts", args);
  if (result.code !== 0) {
    console.error(`⚠️  log-event.ts falhou (exit ${result.code}) ao registrar: ${message}`);
  }
}

/** Últimas linhas de stderr — mesmo corte de stage-0-run.ts pra mensagem de erro compacta. */
function tailStderr(stderr: string, n = 6): string {
  return stderr.trim().split("\n").slice(-n).join(" | ") || "(sem stderr)";
}

// ---------------------------------------------------------------------------
// destaque_count — mesmo cálculo (não-exportado) de
// scripts/lib/invariant-checks/stage-3.ts readDestaqueCount, reimplementado
// aqui como helper puro pra não importar um símbolo interno de outro módulo
// (mesmo padrão de stage-0-run.ts: pequenas funções puras vivem localmente).
// ---------------------------------------------------------------------------

export function readDestaqueCountFromDisk(deps: Stage3RunDeps, editionDir: string): 2 | 3 {
  const p = resolve(deps.rootDir, editionDir, "_internal", "01-approved-capped.json");
  if (!deps.existsSync(p)) return 3; // default; invariante do Stage 1 cobre ausência
  try {
    const data = JSON.parse(deps.readFile(p)) as { highlights?: unknown[] };
    if (!Array.isArray(data.highlights)) return 3;
    const n = data.highlights.length;
    if (n === 2) return 2;
    if (n === 3) return 3;
    return 3; // fora do intervalo já é rejeitado pelo invariante do Stage 1
  } catch {
    return 3;
  }
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

export interface DestaqueOutcome {
  destaque: DestaqueId;
  lintOk: boolean;
  lintViolations?: string;
  imageGenerated: boolean;
  nativeArt4x5Generated: boolean;
  error?: string;
}

export interface PendingAgentDispatch {
  step: string;
  agent: string;
  detail: string;
  manifestPath?: string;
}

export interface HaltRequired {
  stage: string;
  reason: string;
  action: string;
}

export type ChampionsInjectedState = "injected" | "noop" | "skipped-existing-callout";

export interface Stage3RunResult {
  code: 0 | 1 | 2;
  editionDir?: string;
  destaqueCount?: 2 | 3;
  destaques: DestaqueOutcome[];
  cardsGenerated: boolean;
  leaderboardFetched: boolean;
  championsInjected?: ChampionsInjectedState;
  invariantsPassed?: boolean;
  invariantsViolations?: unknown[];
  cropReviewPairs?: unknown[];
  pendingAgentDispatch: PendingAgentDispatch[];
  haltRequired?: HaltRequired;
  delegatedSteps: string[];
  notes: string[];
}

const DELEGATED_STEPS = [
  '3a — É IA? (coleta do dispatch em background + polling com retry/skip em timeout de 10min, decisão do editor) — nunca executado por este script.',
  '3a-bis — Skill("humanizador") + mcp__clarice__correct_text + filtro de julgamento semântico sobre a descrição do É IA? — nunca executado por este script.',
  '3b (crop-reviewer) — dispatch Agent("image-crop-reviewer", { edition, pairs: cropReviewPairs, out_path }) e a chamada --input-json que persiste o veredito — este script só faz a DESCOBERTA dos pares (cropReviewPairs no resultado).',
  '3b (gate humano final) — aprovar/regenerar imagens + escrever o sentinel do Stage 3 (pipeline-sentinel.ts write --step 3) — nunca executado por este script.',
];

// ---------------------------------------------------------------------------
// Orquestração principal.
// ---------------------------------------------------------------------------

export async function runStage3(argv: string[], deps: Stage3RunDeps): Promise<Stage3RunResult> {
  const report = new ReportBuilder();
  const pendingAgentDispatch: PendingAgentDispatch[] = [];
  try {
    const opts = parseStage3RunArgs(argv);

    // --- resolver EDITION_DIR (idempotente, mesma chamada do Stage 0/playbook) ---
    const resolveResult = deps.exec("scripts/lib/find-current-edition.ts", ["--resolve", opts.edition]);
    const editionDir = resolveResult.stdout.trim();
    if (resolveResult.code !== 0 || !editionDir) {
      throw new Stage3Abort(`❌ find-current-edition.ts --resolve não devolveu um path (exit ${resolveResult.code}): ${tailStderr(resolveResult.stderr)}`);
    }

    // --- pré-condição: sentinel Stage 2 ---
    const sentinelResult = deps.exec("scripts/pipeline-sentinel.ts", [
      "assert",
      "--edition",
      opts.edition,
      "--step",
      "2",
      "--outputs",
      "02-reviewed.md,03-social.md",
    ]);
    if (sentinelResult.code === 1) {
      throw new Stage3Abort(`❌ Etapa 2 não completou (sentinel ausente). Re-rodar /diaria-2-escrita ${opts.edition} antes de continuar.`);
    }
    if (sentinelResult.code === 2) {
      throw new Stage3Abort(`❌ Outputs do Stage 2 ausentes (02-reviewed.md/03-social.md). Re-rodar Etapa 2.`);
    }
    if (sentinelResult.code === 3) {
      logEvent(deps, opts.edition, "warn", "stage2_sentinel_missing_legacy");
      report.note("⚠️  stage2_sentinel_missing_legacy — outputs presentes mas sentinel ausente (edição legada).");
    } else if (sentinelResult.code !== 0) {
      throw new Stage3Abort(`❌ pipeline-sentinel assert --step 2 erro inesperado (exit ${sentinelResult.code}): ${tailStderr(sentinelResult.stderr)}`);
    }

    logEvent(deps, opts.edition, "info", "etapa 3 imagens started");
    report.note("▶ etapa 3 imagens started");

    // --- destaque_count + lista de destaques a processar ---
    const destaqueCount = readDestaqueCountFromDisk(deps, editionDir);
    const allDestaques: DestaqueId[] = destaqueCount === 3 ? ["d1", "d2", "d3"] : ["d1", "d2"];
    if (opts.only) {
      for (const d of opts.only) {
        if (!allDestaques.includes(d)) report.note(`⚠️  --only incluiu ${d} mas destaque_count=${destaqueCount} — ignorado.`);
      }
    }
    const destaquesToRun = (opts.only ? opts.only.filter((d) => allDestaques.includes(d)) : allDestaques);

    // --- ComfyUI health check (só se configurado — mesmo gate do playbook) ---
    let imageGenerator = "gemini";
    try {
      const cfg = JSON.parse(deps.readFile(resolve(deps.rootDir, "platform.config.json"))) as { image_generator?: string };
      imageGenerator = cfg.image_generator ?? "gemini";
    } catch {
      report.note("⚠️  platform.config.json ilegível — assumindo image_generator=gemini (default).");
    }
    if (imageGenerator === "comfyui" && !deps.checkComfyUi()) {
      const reason = 'ComfyUI configurado (platform.config.json → image_generator="comfyui") mas http://127.0.0.1:8188/system_stats não respondeu.';
      const action = "iniciar o ComfyUI local (ver docs/comfyui-setup.md) e rodar de novo.";
      const banner = deps.exec("scripts/render-halt-banner.ts", ["--stage", "3 — Imagens", "--reason", reason, "--action", action]);
      report.note(banner.stdout.trim() || `HALT: ${reason}`);
      logEvent(deps, opts.edition, "error", "comfyui_unavailable", { details: { reason } });
      return {
        code: 2,
        editionDir,
        destaqueCount,
        destaques: [],
        cardsGenerated: false,
        leaderboardFetched: false,
        pendingAgentDispatch,
        haltRequired: { stage: "3 — Imagens", reason, action },
        delegatedSteps: DELEGATED_STEPS,
        notes: report.notes,
      };
    }

    // --- por destaque: lint → image-generate 2x1/1x1 → image-generate 4x5 nativo ---
    const destaques: DestaqueOutcome[] = [];
    for (const d of destaquesToRun) {
      const promptRel = `${editionDir}/_internal/02-${d}-prompt.md`;
      if (!deps.existsSync(resolve(deps.rootDir, promptRel))) {
        report.note(`⚠️  ${d}: prompt ausente (${promptRel}) — pulando (Stage 2 deveria ter gerado).`);
        destaques.push({ destaque: d, lintOk: false, imageGenerated: false, nativeArt4x5Generated: false, error: "prompt_missing" });
        continue;
      }

      const lintResult = deps.exec("scripts/lint-image-prompt.ts", [promptRel]);
      if (lintResult.code === 2) {
        throw new Stage3Abort(`❌ lint-image-prompt.ts ${d}: erro de I/O (exit 2): ${tailStderr(lintResult.stderr)}`);
      }
      if (lintResult.code === 1) {
        report.note(`⏸️  ${d}: lint encontrou violação(ões) — geração pausada até o editor corrigir o prompt.`);
        destaques.push({ destaque: d, lintOk: false, lintViolations: lintResult.stderr.trim(), imageGenerated: false, nativeArt4x5Generated: false });
        continue; // pausa SÓ este destaque — próximo segue normalmente
      }

      const genArgs = ["--editorial", promptRel, "--out-dir", `${editionDir}/`, "--destaque", d];
      if (opts.force) genArgs.push("--force");
      const genResult = deps.exec("scripts/image-generate.ts", genArgs);
      if (genResult.code !== 0) {
        throw new Stage3Abort(`❌ image-generate.ts ${d} (2x1) falhou (exit ${genResult.code}): ${tailStderr(genResult.stderr)}`);
      }

      const gen4x5Result = deps.exec("scripts/image-generate.ts", [...genArgs, "--ratio", "4x5"]);
      if (gen4x5Result.code !== 0) {
        throw new Stage3Abort(`❌ image-generate.ts ${d} (4x5 nativo) falhou (exit ${gen4x5Result.code}) — BLOQUEANTE (#4090): ${tailStderr(gen4x5Result.stderr)}`);
      }

      destaques.push({ destaque: d, lintOk: true, imageGenerated: true, nativeArt4x5Generated: true });
      report.note(`✅ ${d}: lint ok, imagens 2x1/1x1/4x5-nativo geradas.`);
    }

    // --- card 4:5 do feed (compõe TODOS os destaques prontos de uma vez, #4114) ---
    const anyReady = destaques.some((d) => d.imageGenerated && d.nativeArt4x5Generated);
    let cardsGenerated = false;
    if (anyReady) {
      const cardResult = deps.exec("scripts/gen-social-card-4x5.ts", ["--edition-dir", `${editionDir}/`]);
      if (cardResult.code !== 0) {
        throw new Stage3Abort(
          `❌ gen-social-card-4x5.ts falhou (exit ${cardResult.code}) — BLOQUEANTE (#4090). Causa comum: assertBrandSerifAvailable ` +
            `(fonte Georgia ausente) — instalar a fonte ou setar DIARIA_ALLOW_FONT_FALLBACK=1. Stderr: ${tailStderr(cardResult.stderr, 8)}`,
        );
      }
      cardsGenerated = true;
      report.note("✅ cards 4:5 do feed compostos.");
    } else {
      report.note("↷ nenhum destaque com imagens prontas — pulando gen-social-card-4x5.ts.");
    }

    // --- leaderboard top1 (fail-soft, #1753) ---
    const leaderboardOut = `${editionDir}/_internal/04-leaderboard-top1.json`;
    const leaderboardStep = softStep(deps, report, "fetch-leaderboard-top1", "scripts/fetch-leaderboard-top1.ts", ["--edition", opts.edition, "--out", leaderboardOut]);
    const leaderboardFetched = leaderboardStep.result.code === 0;

    // --- box de campeões (#2725) — exit 1 (#4583 raffle stale) é FATAL, nunca no-op silencioso ---
    const championsResult = deps.exec("scripts/inject-champions-callout.ts", ["--edition", opts.edition, "--edition-dir", `${editionDir}/`]);
    let championsInjected: ChampionsInjectedState | undefined;
    if (championsResult.code === 1) {
      const reason = `inject-champions-callout.ts FATAL (exit 1): ${tailStderr(championsResult.stderr, 4)}`;
      const action =
        "confirmar com o editor o dia do sorteio deste mês e atualizar platform.config.json → raffle.sorteio_do_mes " +
        '{ "mes": "{YYYY-MM da edição}", "dia": N } (ou checar se 02-reviewed.md está presente); então re-rodar.';
      const banner = deps.exec("scripts/render-halt-banner.ts", ["--stage", "3 — Imagens", "--reason", reason, "--action", action]);
      report.note(banner.stdout.trim() || `HALT: ${reason}`);
      logEvent(deps, opts.edition, "error", "inject_champions_callout_fatal", { details: { stderr: championsResult.stderr.trim() } });
      return {
        code: 2,
        editionDir,
        destaqueCount,
        destaques,
        cardsGenerated,
        leaderboardFetched,
        pendingAgentDispatch,
        haltRequired: { stage: "3 — Imagens", reason, action },
        delegatedSteps: DELEGATED_STEPS,
        notes: report.notes,
      };
    }
    if (championsResult.code === 2) {
      throw new Stage3Abort(`❌ inject-champions-callout.ts erro de uso (exit 2): ${tailStderr(championsResult.stderr)}`);
    }
    if (championsResult.code !== 0) {
      throw new Stage3Abort(`❌ inject-champions-callout.ts erro inesperado (exit ${championsResult.code}): ${tailStderr(championsResult.stderr)}`);
    }
    if (/callout já presente/.test(championsResult.stdout)) {
      championsInjected = "skipped-existing-callout";
    } else if (/injetado em/.test(championsResult.stdout)) {
      championsInjected = "injected";
    } else {
      championsInjected = "noop";
    }
    report.note(`ℹ️  inject-champions-callout: ${championsInjected}.`);

    // --- pre-gate invariants (#1007 Fase 1) — reporta, nunca aborta o script ---
    const invariantsResult = deps.exec("scripts/check-invariants.ts", ["--stage", "3", "--edition-dir", editionDir]);
    if (invariantsResult.code === 2) {
      throw new Stage3Abort(`❌ check-invariants --stage 3 erro de uso (exit 2): ${tailStderr(invariantsResult.stderr)}`);
    }
    const invariantsPassed = invariantsResult.code === 0;
    let invariantsViolations: unknown[] | undefined;
    if (!invariantsPassed) {
      const parsed = parseStepJson<{ violations?: unknown[] }>(invariantsResult.stdout);
      invariantsViolations = parsed?.violations ?? [];
      report.note(`⚠️  check-invariants --stage 3: ${invariantsViolations.length} violação(ões) — gate deve exigir fix antes de aprovar.`);
      logEvent(deps, opts.edition, "warn", "stage3_invariants_failed", { details: { violations: invariantsViolations } });
    } else {
      report.note("✅ check-invariants --stage 3: ok.");
    }

    // --- crop-reviewer: só a DESCOBERTA (script), dispatch do Agent fica pro orchestrator ---
    let cropReviewPairs: unknown[] | undefined;
    const cropDiscovery = deps.exec("scripts/run-image-crop-reviewer.ts", ["--edition-dir", `${editionDir}/`]);
    if (cropDiscovery.code === 0) {
      const parsed = parseStepJson<{ edition?: string; pairs?: unknown[]; out_path?: string }>(cropDiscovery.stdout);
      if (parsed?.pairs && parsed.pairs.length > 0) {
        cropReviewPairs = parsed.pairs;
        pendingAgentDispatch.push({
          step: "3b-crop-reviewer",
          agent: "image-crop-reviewer",
          detail: `${parsed.pairs.length} par(es) de imagem pra revisar — dispatch via Agent("image-crop-reviewer", { edition: "${opts.edition}", pairs: cropReviewPairs, out_path: "${parsed.out_path}" }); depois persistir com "run-image-crop-reviewer.ts --edition-dir ${editionDir}/ --input-json <output-do-agent>".`,
          manifestPath: parsed.out_path,
        });
      }
    } else {
      report.note("↷ run-image-crop-reviewer (descoberta): nenhum par encontrado — pulando revisor de crop (warn, não bloqueia).");
      logEvent(deps, opts.edition, "warn", "crop_reviewer_no_pairs", { informational: true });
    }

    return {
      code: 0,
      editionDir,
      destaqueCount,
      destaques,
      cardsGenerated,
      leaderboardFetched,
      championsInjected,
      invariantsPassed,
      invariantsViolations,
      cropReviewPairs,
      pendingAgentDispatch,
      delegatedSteps: DELEGATED_STEPS,
      notes: report.notes,
    };
  } catch (e) {
    const abort = e instanceof Stage3Abort ? e : new Stage3Abort(`erro inesperado: ${(e as Error).message}`);
    report.note(`❌ ${abort.message}`);
    return {
      code: abort.code,
      destaques: [],
      cardsGenerated: false,
      leaderboardFetched: false,
      pendingAgentDispatch,
      delegatedSteps: DELEGATED_STEPS,
      notes: report.notes,
    };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const deps = productionDeps(ROOT);
  runStage3(process.argv.slice(2), deps).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.code;
  });
}
