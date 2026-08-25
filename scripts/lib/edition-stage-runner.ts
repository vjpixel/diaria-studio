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
import { existsSync, readFileSync } from "node:fs";
import { assertSentinel as assertSentinelImpl, type AssertResult } from "./pipeline-state.ts";
import { resolveRunLogPath } from "./run-log.ts";

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

/**
 * Diretiva anti-background anexada a TODO prompt headless (#6045).
 *
 * `claude --print` é single-turn: depois da resposta do turno, o processo
 * encerra. Se o playbook do stage leva a sessão a disparar algo via
 * `run_in_background=true` e "esperar a notificação", essa notificação nunca
 * chega — não existe turno seguinte — e o wrapper reporta FALHOU mesmo quando
 * o trabalho real terminou (observado ao vivo na edição 260825, Stages 1 e 2).
 * A instrução abaixo é preventiva; `looksLikeBackgroundWaitExit` + o retry
 * único são a defesa em profundidade para quando ela não bastar.
 */
export const NO_BACKGROUND_DIRECTIVE =
  "IMPORTANTE (sessão single-turn): esta sessão NÃO receberá turnos seguintes. " +
  "Nunca use tarefas em segundo plano (run_in_background/background tasks) nem espere " +
  "notificação de task — execute TODA ferramenta em primeiro plano (foreground), " +
  "bloqueando até terminar, antes de escrever sua resposta final.";

/**
 * Detecta a assinatura do #6045 no stdout de uma sub-sessão que saiu sem
 * completar: ela despachou uma task em background e encerrou "esperando" a
 * notificação que jamais chegaria. Case-insensitive de propósito.
 */
export function looksLikeBackgroundWaitExit(stdout: string): boolean {
  const s = stdout.toLowerCase();
  return (
    (s.includes("background") && (s.includes("waiting") || s.includes("wait for"))) ||
    s.includes("waiting for the background task")
  );
}

/** Tentativas por stage quando o sintoma do #6045 é detectado (1 original + 1 retry). */
export const BACKGROUND_WAIT_MAX_ATTEMPTS = 2;

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
  /**
   * #6088: servidores MCP que logaram `mcp_disconnect` com reason
   * `permission_not_granted_noninteractive` no `data/run-log.jsonl` durante
   * ESTA execução do laço. Sessão `-p` nunca consegue aprovar permissão de
   * MCP — o playbook trata como "indisponível" e pula em fail-soft (regra
   * escrita para indisponibilidade REAL, não para este determinismo). O
   * defasamento aqui é só VISIBILIDADE: nunca muda exitCode, mas aparece
   * destacado no resumo pra deixar de ser silencioso.
   */
  mcpPermissionWarnings: string[];
}

/**
 * #6088 (pure, testável): dado um bloco de linhas JSONL do run-log, retorna a
 * lista dedup de servidores MCP que falharam por permissão não-aprovável em
 * sessão não-interativa. Linhas malformadas são ignoradas (fail-soft).
 */
export function collectMcpPermissionFailures(jsonlLines: string[]): string[] {
  const servers = new Set<string>();
  for (const line of jsonlLines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let evt: { message?: unknown; details?: { server?: unknown; reason?: unknown } };
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof evt?.message === "string" &&
      evt.message.includes("mcp_disconnect") &&
      evt.details?.reason === "permission_not_granted_noninteractive" &&
      typeof evt.details?.server === "string"
    ) {
      servers.add(evt.details.server);
    }
  }
  return [...servers];
}

/** Lê as linhas do run-log (fail-soft: arquivo ausente/ilegível → vazio). */
function readRunLogLines(runLogPath: string): string[] {
  try {
    if (!existsSync(runLogPath)) return [];
    return readFileSync(runLogPath, "utf8").split("\n");
  } catch {
    return [];
  }
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
  /**
   * `assertSentinel`, NÃO `sentinelExists` (achados P0/P1 do review da PR #5753).
   *
   * A versão fraca só pergunta "o arquivo `.step-N-done.json` existe?".
   * `assertSentinel` também confere se os outputs que o sentinel declara
   * continuam em disco. A diferença morde nos dois sentidos:
   *
   *   - **pular**: um sentinel órfão — output apagado por edição manual, ou
   *     escrito à mão num debug — faria o stage inteiro ser pulado como
   *     "já pronto", e o pipeline seguiria para o gate de revisão sobre
   *     conteúdo ausente.
   *   - **confirmar**: ver abaixo, é o que fecha o buraco do `--max-turns`.
   */
  assertSentinelFn?: typeof assertSentinelImpl;
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
  const flattened = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(-FAILURE_TAIL_LINES)
    .join(" | ");
  // Um traço nu no resumo ("FALHOU exit=1 — ") é pior que verboso: o leitor
  // não sabe se não houve saída ou se ela se perdeu no caminho.
  return flattened === "" ? "(sem stdout/stderr/message capturados — checar o log do processo claude)" : flattened;
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
    assertSentinelFn = assertSentinelImpl,
    onProgress = () => {},
    nowMs = () => Date.now(),
  } = opts;

  assertNoPublishStage(plan);

  const outcomes: StageOutcome[] = [];
  let exitCode = 0;
  let failedStage: number | null = null;

  // #6088: snapshot do run-log antes/depois — só linhas NOVAS desta execução
  // geram aviso (um mcp_disconnect de ontem não é culpa deste laço).
  const runLogPath = resolveRunLogPath(repoRootAbs);
  const runLogBefore = readRunLogLines(runLogPath);

  for (const { stage, skill } of plan) {
    // Resumabilidade no nível do DRIVER: stage concluído nem chega a
    // spawnar, em vez de gastar uma sessão inteira só para o orquestrador
    // constatar que não há o que fazer.
    const before = assertSentinelFn(editionDir, stage);
    if (before.ok) {
      onProgress(`SKIP stage ${stage} (/${skill}) — sentinela e outputs já em disco`);
      outcomes.push({ stage, skill, status: "skipped", exitCode: 0, durationMs: 0 });
      continue;
    }

    // #6045: a diretiva anti-background vai NO PROMPT — é o único canal
    // garantido de alcançar a sub-sessão (o playbook do stage pode levar
    // o modelo a disparar task em background; a instrução explícita de
    // single-turn previne o sintoma na origem).
    const prompt = `/${skill} ${aammdd} ${HEADLESS_FLAGS} ${NO_BACKGROUND_DIRECTIVE}`;
    onProgress(`Stage ${stage}: claude -p '${prompt.slice(0, 80)}…'`);

    let stageOutcome: StageOutcome | null = null;
    // Defesa em profundidade (#6045): se MESMO com a diretiva a sub-sessão
    // sair com a assinatura "despachei background e estou esperando", repete
    // o stage UMA vez antes de declarar falha. A resumabilidade por sentinela
    // torna o retry barato: trabalho já gravado em disco não é refeito pelo
    // orquestrador da skill.
    for (let attempt = 1; attempt <= BACKGROUND_WAIT_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        onProgress(
          `Stage ${stage}: retry (tentativa ${attempt}/${BACKGROUND_WAIT_MAX_ATTEMPTS}) — saída anterior com sintoma background-wait (#6045)`,
        );
      }
      const startedAt = nowMs();
      try {
      // Capturado sempre (#5791), mesmo que o caminho feliz descarte a
      // variável logo abaixo sem nunca a incluir em `outcomes`. O ponto do
      // #5791 é exatamente este: no branch de sucesso-mas-sentinela-ausente
      // (ver a checagem de pós-condição abaixo), até agora não havia NENHUMA
      // visibilidade do que o processo filho realmente escreveu — achado ao
      // vivo 260821, Stage 1 saiu com exit 0 em 62s sem gravar nenhum output
      // (rodando o mesmo comando manualmente no shell, completou em ~13min).
      // `execFileSync` só devolve STDOUT no caminho de sucesso (stderr só é
      // populado em `err.stderr` quando o processo lança) — a captura aqui é
      // parcial por essa limitação da API, não por escolha; `stdio: "pipe"`
      // já custava o mesmo antes, o que muda é só usar ou não o buffer.
      const stdout = execFn(
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
      // O stdout do sucesso é DESCARTADO no caminho feliz, e é o ponto
      // central do #5744: devolvê-lo recriaria na sessão-mãe o contexto que
      // o laço evita. Só é reaproveitado (truncado) abaixo, quando a
      // pós-condição falha.

      // PÓS-CONDIÇÃO (achado P0 do review da PR #5753). Sair com código 0 não
      // prova que o stage fez o trabalho — prova só que o processo terminou
      // sem erro. O caso concreto que isso fecha: uma sessão que esgota
      // `--max-turns 120` no meio do stage pode muito bem sair 0, e o
      // comportamento do CLI aqui não é verificável a partir deste repo. Sem
      // esta checagem, o laço marcaria "ok", seguiria para o próximo stage, e
      // o editor chegaria ao gate de revisão sobre uma edição incompleta —
      // exatamente o pior desfecho possível deste mecanismo. A verificação é
      // barata e não depende de adivinhar a semântica de exit code do harness.
      const after = assertSentinelFn(editionDir, stage);
      if (!after.ok) {
        const detail =
          after.reason === "outputs_missing"
            ? `outputs declarados ausentes: ${after.missingOutputs.join(", ")}`
            : "sentinela não foi escrita";
        // #5791/#6045: instrumentação de observabilidade + detecção do
        // sintoma background-wait. Com o sintoma presente e retry restante,
        // NÃO declara falha ainda — repete o stage.
        const stdoutText = typeof stdout === "string" ? stdout : "";
        if (looksLikeBackgroundWaitExit(stdoutText) && attempt < BACKGROUND_WAIT_MAX_ATTEMPTS) {
          continue;
        }
        const tail = summarizeFailure(stdoutText);
        exitCode = 1;
        failedStage = stage;
        stageOutcome = {
          stage,
          skill,
          status: "failed",
          exitCode: 1,
          durationMs: nowMs() - startedAt,
          failureTail: `stage ${stage} saiu com código 0 mas não completou — ${detail} | últimas linhas de stdout: ${tail}`,
        };
        break;
      }

      outcomes.push({ stage, skill, status: "ok", exitCode: 0, durationMs: nowMs() - startedAt });
      stageOutcome = null;
      break;
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
      const combined = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
      // #6045: mesmo tratamento no caminho de exceção — retry único quando a
      // assinatura background-wait está presente.
      if (looksLikeBackgroundWaitExit(combined) && attempt < BACKGROUND_WAIT_MAX_ATTEMPTS) {
        continue;
      }
      exitCode = err.status ?? 1;
      failedStage = stage;
      stageOutcome = {
        stage,
        skill,
        status: "failed",
        exitCode,
        durationMs: nowMs() - startedAt,
        failureTail: summarizeFailure(combined),
      };
      break;
    }
    }
    if (stageOutcome !== null) {
      outcomes.push(stageOutcome);
      break;
    }
  }

  // #6088: servidores MCP que falharam por permissão nesta execução —
  // visibilidade, não bloqueio (fail-soft do playbook permanece).
  // Diff por CONTEÚDO (set), não por contagem de linhas: o elemento vazio
  // final do split("\n") desloca slice(by-length) em 1 e perde a última linha.
  const runLogAfter = readRunLogLines(runLogPath);
  const beforeSet = new Set(runLogBefore);
  const newLines = runLogAfter.filter((l) => !beforeSet.has(l));
  const mcpPermissionWarnings = collectMcpPermissionFailures(newLines);
  if (mcpPermissionWarnings.length > 0) {
    onProgress(
      `⚠ MCP sem permissão aprovável em sessão -p (#6088): ${mcpPermissionWarnings.join(", ")} — ` +
        `seções que dependem deles foram PULADAS pelo playbook, não indisponíveis.`,
    );
  }

  return { outcomes, exitCode, failedStage, mcpPermissionWarnings };
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
  // #6088: banner de MCP pulado por permissão — nunca muda o veredito dos
  // stages, mas NÃO pode ficar enterrado: é perda de dado real silenciosa.
  // `?? []` tolera resultados montados por código anterior à #6088.
  const mcpWarnings = result.mcpPermissionWarnings ?? [];
  if (mcpWarnings.length > 0) {
    lines.push(
      `⚠ ATENÇÃO (#6088): os seguintes MCPs falharam por permissão não-aprovável em sessão headless ` +
        `-p nesta execução: ${mcpWarnings.join(", ")}.`,
    );
    lines.push(
      `  Seções que dependem deles (ex: §0-replies via Gmail, inbox drain, Beehiiv sem fallback) foram PULADAS ` +
        `pelo playbook — isto é perda de função, não indisponibilidade transitória. ` +
        `Rodar as seções afetadas na sessão interativa (top-level), onde a aprovação de permissão é possível.`,
    );
  }
  return lines.join("\n");
}
