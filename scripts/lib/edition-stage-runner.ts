/**
 * scripts/lib/edition-stage-runner.ts (#5744, extraído de
 * `scripts/overnight/run-scheduled-edicao.ts` do #5738)
 *
 * Laço "uma sessão `claude` por stage" — o efeito de um `/clear` entre os
 * stages da edição diária.
 *
 * **Por que isto existe como módulo próprio.** O #5738 implementou o laço
 * dentro do runner AGENDADO. O #5744 precisa do mesmo laço no caminho
 * INTERATIVO (`/diaria-edicao` digitado pelo editor), e duas implementações
 * do mesmo laço divergem na primeira mudança — a segunda cópia é sempre a
 * que esquece o `--no-gates`, o guard de sentinela ou o `resolveEditionDir`.
 * Então o laço mora aqui e os dois caminhos o chamam.
 *
 * **O que o laço resolve, e o que não dá para resolver.** `/clear` é comando
 * de usuário do CLI: uma sessão não limpa a própria janela. Mas cada
 * `claude --print` é um PROCESSO NOVO, portanto uma sessão com contexto
 * limpo por construção. Quem tem esse poder é sempre o processo de fora —
 * o driver agendado, ou a sessão do editor chamando isto via `Bash`.
 *
 * **Ganho medido** (`_internal/stage-status.json` de 14 edições, #5738): o
 * Stage 4 sozinho, 40-60% do custo de uma edição, cai de uma mediana de 581M
 * para 163M tokens de entrada quando começa com contexto limpo.
 *
 * O estado entre stages viaja por DISCO, nunca pela conversa — é exatamente
 * o que o #5414 destravou ao persistir os 17 valores que antes só existiam
 * no contexto da sessão.
 *
 * **Contrato de saída (#5744).** `runEditionStages` NUNCA devolve o stdout
 * dos stages para quem a chamou — só um resumo por stage. Isso não é
 * economia de bytes: no caminho interativo, quem lê a saída é a sessão do
 * editor, e despejar o `--print` inteiro de 3 stages na conversa recriaria
 * na sessão-mãe exatamente o contexto que o laço existe para evitar. O
 * stdout completo só é preservado no caminho de FALHA, e ainda assim
 * truncado (ver `FAILURE_TAIL_LINES`).
 */

import { execFileSync } from "node:child_process";
import { sentinelExists as sentinelExistsImpl } from "./pipeline-state.ts";

/** Um stage do pipeline e a skill que o executa. */
export interface EditionStage {
  stage: number;
  skill: string;
}

/**
 * Stages que um driver externo pode executar, com a skill de cada um.
 *
 * **Stages 5 (publicação) e 6 (agendamento) NÃO estão aqui, e é deliberado.**
 * O guard de publicação do runner agendado é estrutural justamente por isso:
 * não há flag a respeitar nem a esquecer, os stages simplesmente não existem
 * neste plano. O caminho interativo tem outra razão para a mesma exclusão —
 * é onde ficam os dois gates humanos de projeto (revisão e agendamento), que
 * precisam da sessão do editor e não podem rodar num spawn headless.
 *
 * O Stage 0 (preflight) não tem entrada porque não tem skill própria:
 * `/diaria-1-pesquisa` já refresca dedup e drena o inbox editorial.
 */
export const STAGE_PLAN: ReadonlyArray<EditionStage> = [
  { stage: 1, skill: "diaria-1-pesquisa" },
  { stage: 2, skill: "diaria-2-escrita" },
  { stage: 3, skill: "diaria-3-imagens" },
  { stage: 4, skill: "diaria-4-revisao" },
];

/**
 * `--no-gates` em todo stage spawnado — requisito de correção, não
 * conveniência (achado P0 do review do #5739).
 *
 * `/diaria-edicao` setava `auto_approve = true` internamente para os Stages
 * 1-3 ("pre-gate mode", #1523) e resolvia o gate do Stage 4 pelo próprio
 * `--no-gates`. Ao trocar essa invocação por skills standalone, esse
 * auto-approve DESAPARECE: `orchestrator-stage-0-preflight` recebe
 * `auto_approve` com default `false`. Em `--print` não há quem responda ao
 * gate — a sessão gastaria seus turnos tentando e morreria sem escrever
 * sentinela nenhuma.
 *
 * **Só é seguro porque o alcance é limitado por `STAGE_PLAN`**: "auto-aprovar
 * tudo" aqui nunca chega perto de publicação. Quem chamar este módulo com um
 * plano que inclua Stage 5/6 quebra essa garantia — ver `assertNoPublishStage`.
 */
export const HEADLESS_FLAGS = "--no-gates";

/** Teto de turnos POR STAGE (era o teto da edição inteira antes do #5738). */
export const MAX_TURNS = "120";

/** Linhas de stdout/stderr preservadas quando um stage falha. */
export const FAILURE_TAIL_LINES = 20;

/** Resultado de um stage individual — nunca inclui o stdout de sucesso. */
export interface StageOutcome {
  stage: number;
  skill: string;
  /** `skipped` = sentinela já presente; o stage não chegou a spawnar. */
  status: "ok" | "skipped" | "failed";
  exitCode: number;
  durationMs: number;
  /** Só preenchido em `failed`, e truncado. */
  failureTail?: string;
}

export interface RunEditionStagesResult {
  outcomes: StageOutcome[];
  exitCode: number;
  failedStage: number | null;
}

export interface RunEditionStagesOptions {
  aammdd: string;
  /** Diretório REAL da edição, já resolvido (flat legado OU nested). */
  editionDir: string;
  repoRootAbs: string;
  /**
   * Resolvedor do binário `claude` — FUNÇÃO, não string já resolvida.
   *
   * É chamado DENTRO do `try` de cada stage de propósito (#5549): resolver
   * fora faria uma falha de resolução (PATH mínimo sob systemd, `claude` não
   * instalado) virar exceção não-tratada no chamador, em vez de cair no mesmo
   * caminho de log de falha do resto — com a mensagem acionável que o #5549
   * construiu, no lugar de um `ENOENT` opaco.
   */
  resolveClaudeBin: () => string;
  /** Ambiente já saneado (sem as vars de auth de API, #5608). */
  env: NodeJS.ProcessEnv;
  /** Subconjunto de `STAGE_PLAN` a executar. */
  plan?: ReadonlyArray<EditionStage>;
  execFn?: typeof execFileSync;
  sentinelExistsFn?: typeof sentinelExistsImpl;
  /** Callback de progresso — o chamador decide se imprime e como. */
  onProgress?: (message: string) => void;
  nowMs?: () => number;
}

/**
 * Guard de blast radius: nenhum plano passado a este módulo pode conter os
 * Stages 5/6.
 *
 * Existe porque `HEADLESS_FLAGS` auto-aprova gates. Enquanto o plano parar no
 * Stage 4 isso é inofensivo — nenhum canal é dispatchado. Um plano que
 * incluísse o Stage 5 transformaria a mesma flag num disparo de publicação
 * sem supervisão, e o invariante #1326 diz que o DEFAULT do Stage 5 sem
 * `--skip` é justamente "tudo automático". O erro seria silencioso: a edição
 * publicaria e o log dinha "ok". Por isso é exceção, não aviso.
 */
export function assertNoPublishStage(plan: ReadonlyArray<EditionStage>): void {
  const offending = plan.filter((p) => p.stage >= 5);
  if (offending.length > 0) {
    throw new Error(
      `edition-stage-runner: plano contém stage(s) de publicação/agendamento (${offending
        .map((p) => p.stage)
        .join(", ")}). ` +
        `Estes stages spawnariam com ${HEADLESS_FLAGS}, auto-aprovando o gate de publicação — ` +
        `o default do Stage 5 sem --skip é dispatchar todos os canais (#1326). Publicação exige ação explícita do editor.`,
    );
  }
}

/** Últimas `FAILURE_TAIL_LINES` linhas não-vazias, achatadas em uma linha. */
export function summarizeFailure(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(-FAILURE_TAIL_LINES)
    .join(" | ");
}

/**
 * Executa o plano, um `claude --print` por stage, parando no primeiro erro.
 *
 * Para no primeiro erro de propósito: sem o `break`, os stages seguintes
 * rodariam sobre o output ausente do que falhou, gerando artefatos parciais
 * em disco que parecem progresso legítimo na próxima retomada.
 */
export function runEditionStages(opts: RunEditionStagesOptions): RunEditionStagesResult {
  const {
    aammdd,
    editionDir,
    repoRootAbs,
    resolveClaudeBin,
    env,
    plan = STAGE_PLAN,
    execFn = execFileSync,
    sentinelExistsFn = sentinelExistsImpl,
    onProgress = () => {},
    nowMs = () => Date.now(),
  } = opts;

  assertNoPublishStage(plan);

  const outcomes: StageOutcome[] = [];
  let exitCode = 0;
  let failedStage: number | null = null;

  for (const { stage, skill } of plan) {
    // Resumabilidade no nível do DRIVER: stage concluído nem chega a
    // spawnar, em vez de gastar uma sessão inteira só para o orquestrador
    // constatar que não há o que fazer.
    if (sentinelExistsFn(editionDir, stage)) {
      onProgress(`SKIP stage ${stage} (/${skill}) — sentinela já presente`);
      outcomes.push({ stage, skill, status: "skipped", exitCode: 0, durationMs: 0 });
      continue;
    }

    const prompt = `/${skill} ${aammdd} ${HEADLESS_FLAGS}`;
    onProgress(`Stage ${stage}: claude -p '${prompt}'`);
    const startedAt = nowMs();

    try {
      execFn(
        resolveClaudeBin(),
        [
          "--print",
          "--permission-mode",
          "acceptEdits",
          "--max-turns",
          MAX_TURNS,
          "--output-format",
          "text",
          "--no-session-persistence",
          prompt,
        ],
        {
          cwd: repoRootAbs,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env,
        },
      );
      // O stdout do sucesso é DESCARTADO aqui, e é o ponto central do #5744:
      // devolvê-lo recriaria na sessão-mãe o contexto que o laço evita.
      outcomes.push({ stage, skill, status: "ok", exitCode: 0, durationMs: nowMs() - startedAt });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
      exitCode = err.status ?? 1;
      failedStage = stage;
      outcomes.push({
        stage,
        skill,
        status: "failed",
        exitCode,
        durationMs: nowMs() - startedAt,
        failureTail: summarizeFailure([err.stdout, err.stderr, err.message].filter(Boolean).join("\n")),
      });
      break;
    }
  }

  return { outcomes, exitCode, failedStage };
}

/**
 * Resumo compacto para consumo humano ou de sessão. Deliberadamente curto —
 * é isto que a sessão do editor lê no lugar do stdout dos stages.
 */
export function formatStagesSummary(result: RunEditionStagesResult, aammdd: string): string {
  const lines = [`Edição ${aammdd} — ${result.outcomes.length} stage(s) processado(s)`];
  for (const o of result.outcomes) {
    const secs = (o.durationMs / 1000).toFixed(0);
    if (o.status === "skipped") lines.push(`  stage ${o.stage} /${o.skill}: SKIP (sentinela já presente)`);
    else if (o.status === "ok") lines.push(`  stage ${o.stage} /${o.skill}: OK (${secs}s)`);
    else lines.push(`  stage ${o.stage} /${o.skill}: FALHOU exit=${o.exitCode} (${secs}s) — ${o.failureTail ?? ""}`);
  }
  if (result.failedStage !== null) {
    lines.push(`Interrompido no stage ${result.failedStage}. Stages seguintes não rodaram.`);
  }
  return lines.join("\n");
}
