#!/usr/bin/env node
/**
 * scripts/overnight/run-scheduled-edicao.ts (#4998, reativação do #2068/#3259;
 * #5611 tornou este runner o núcleo compartilhado das duas vias)
 *
 * Runner MULTIPLATAFORMA da edição diária agendada — toda a lógica de
 * negócio (cálculo de data D+1, guard de idempotência, invocação do
 * `claude`, logging) vive aqui e só aqui. Duas vias invocam este mesmo
 * script, nunca duplicando a lógica:
 *   - Linux/systemd: timer `diaria-edicao-diaria.timer` (ver
 *     `scripts/lib/edicao-systemd-units.ts`) — desabilitado desde #5611
 *     (via ativa voltou a ser o Windows, que depende do navegador/Claude
 *     in Chrome; o par systemd continua no repo pronto pra reativação).
 *   - Windows: wrapper fino `scripts/overnight/run-scheduled-edicao.ps1`
 *     (Task Scheduler, VIA ATIVA — restaurado no #5611 revertendo parte
 *     do cutover #5115/#5162, mas como wrapper que delega 100% pra este
 *     runner em vez de reimplementar a lógica em PowerShell).
 * Ver docs/scheduled-edicao-setup.md pro estado operacional completo de
 * cada via.
 *
 * Fluxo:
 *   1. Calcula AAMMDD = amanhã em America/Sao_Paulo (`nextEditionDate`).
 *   2. GUARD DE IDEMPOTÊNCIA (novo na reativação 260811, pedido do editor):
 *      se `data/editions/{AAMMDD}/` já existe — a edição já foi iniciada,
 *      manualmente pelo editor ou por uma run anterior desta mesma task —
 *      loga SKIP e sai sem invocar `claude`. Nunca reprocessa/duplica
 *      trabalho; a resumabilidade normal de `/diaria-edicao` (CLAUDE.md,
 *      "Retomar edição interrompida") já cobre o caso de retomar uma run
 *      que ficou pela metade — esse guard é sobre não DISPARAR de novo
 *      quando não há motivo.
 *   3. Senão, sincroniza o código UMA vez e roda UM `claude --print` POR
 *      STAGE (`STAGE_PLAN`, #5738) — `/diaria-1-pesquisa`,
 *      `/diaria-2-escrita`, `/diaria-3-imagens`, `/diaria-4-revisao`.
 *      Cada spawn é uma sessão nova, portanto contexto limpo: é o efeito
 *      de um `/clear` entre stages, que a própria sessão não consegue
 *      produzir em si mesma. Stage concluído (sentinela em disco) nem
 *      chega a spawnar. Falha em um stage interrompe o laço e o log
 *      registra QUAL stage falhou.
 *   4. Loga resultado em data/overnight-schedule.log (linha simples,
 *      compartilhado com o runner Windows) e data/run-log.jsonl (via
 *      scripts/log-event.ts, agent="scheduled-edicao").
 *
 * GUARD DE PUBLICAÇÃO: este script prepara conteúdo (Stages 0-3) e
 * pré-renderiza o Stage 4, mas NÃO dispatcha nenhum canal — publicação
 * requer ação explícita do editor (/diaria-5-publicacao). Desde #5738 essa
 * garantia é ESTRUTURAL: os Stages 5/6 não estão em `STAGE_PLAN` e nunca
 * são invocados, em vez de depender de um `--skip` respeitado lá dentro.
 *
 * @see scripts/overnight/setup-edicao-schedule-systemd.ts (gera os units que invocam este script)
 * @see docs/scheduled-edicao-setup.md
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../lib/cli-args.ts";
import { nextEditionDate } from "../lib/next-edition-date.ts";
import { resolveClaudeBin } from "../lib/resolve-claude-bin.ts";
import { assertSentinel } from "../lib/pipeline-state.ts";
import { resolveEditionDir } from "../lib/find-current-edition.ts";
import { STAGE_PLAN as STAGE_PLAN_IMPL, runEditionStages } from "../lib/edition-stage-runner.ts";
import { runTsx } from "../lib/run-tsx.ts";

/**
 * `STAGE_PLAN` e `HEADLESS_FLAGS` mudaram de casa no #5744.
 *
 * O laço "uma sessão por stage" nasceu aqui (#5738) e passou a ser necessário
 * também no caminho INTERATIVO (`/diaria-edicao`). Duas cópias do mesmo laço
 * divergem na primeira mudança — e a segunda cópia é sempre a que esquece o
 * `--no-gates`, o guard de sentinela ou o `resolveEditionDir`. Então o laço,
 * o plano e as flags moram em `lib/edition-stage-runner.ts` e este runner os
 * consome. Re-exportados para não quebrar quem importava daqui.
 */
export { STAGE_PLAN, HEADLESS_FLAGS } from "../lib/edition-stage-runner.ts";

/**
 * Vars de auth da API que, se presentes no ambiente, o CLI `claude` PREFERE
 * sobre o login claude.ai — e que precisam sair antes do spawn (#5608).
 *
 * O unit systemd faz `EnvironmentFile=-.env` (#5114, necessário: sem isso o
 * `${CLARICE_API_KEY}` do `.mcp.json` não resolve), e o `.env` deste repo tem
 * `ANTHROPIC_API_KEY` legitimamente — `geo-citation-monitor.ts` e
 * `audit-context-tokens.ts` consomem a API direto. O efeito colateral é que a
 * edição agendada herdava a key e o CLI trocava a assinatura por uma conta
 * pay-per-token, com duas consequências fatais, ambas vistas ao vivo em
 * 17/08/2026 na edição 260818:
 *
 *   1. `Credit balance is too low` — a rodada morre com exit 1.
 *   2. `claude.ai connectors are disabled because ANTHROPIC_API_KEY or another
 *      auth source is set and takes precedence over your claude.ai login` —
 *      Beehiiv e Gmail são conectores nativos e o Stage 0 depende dos dois,
 *      então mesmo COM crédito a rodada bateria no fail-fast do #738.
 *
 * O filtro fica aqui, e não no gerador de unit (`edicao-systemd-units.ts`),
 * de propósito: vale pra qualquer caminho de invocação — unit systemd, `npx
 * tsx` à mão, ou um agendador futuro — e é testável sem ler arquivo de unit.
 * `CLAUDE_CODE_OAUTH_TOKEN` **não** entra na lista: esse É o login claude.ai,
 * removê-lo desautenticaria a sessão em vez de consertá-la.
 *
 * **A lista é enumerada, não exaustiva** (achado do review do PR #5609). A
 * própria mensagem do CLI diz "ANTHROPIC_API_KEY **or another auth source**",
 * e a superfície de auth do Claude Code inclui outras vars que roteiam pra
 * um provider diferente do login. As 4 abaixo cobrem o incidente observado
 * (as 2 de key) mais o roteamento Bedrock/Vertex — nenhuma delas aparece em
 * `.env.example` hoje, então remover é no-op no ambiente atual e blindagem
 * pra quando alguma entrar no `.env` por outro motivo. `ANTHROPIC_BASE_URL`
 * ficou de FORA de propósito: ela não autentica sozinha, e um proxy
 * legítimo configurado no futuro seria quebrado em silêncio por um filtro
 * que ninguém lembraria de estar aqui. Se aparecer um caso novo de auth
 * shadowing, o conserto é acrescentar a var a esta lista — com o motivo.
 */
export const CLAUDE_CLI_STRIPPED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

/** Cópia do ambiente sem as vars acima. Não muta o `process.env` do runner —
 * só o filho vê o ambiente filtrado (outros passos do mesmo processo, se
 * existirem no futuro, continuam enxergando a key). */
export function claudeCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of CLAUDE_CLI_STRIPPED_ENV_VARS) delete copy[key];
  return copy;
}

function nowIso(): string {
  return new Date().toISOString();
}

function writeScheduleLog(dataDir: string, message: string): void {
  const logFile = join(dataDir, "overnight-schedule.log");
  if (!existsSync(dataDir)) {
    console.warn(`data/ não encontrado. Log de schedule não gravado. Mensagem: ${message}`);
    return;
  }
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(logFile, `${nowIso()} | ${message}\n`, "utf8");
  } catch (e) {
    console.warn(`writeScheduleLog: falha ao gravar em ${logFile} — ${(e as Error).message}`);
  }
}

function writeRunLog(
  repoRootAbs: string,
  dataDir: string,
  aammdd: string,
  level: "info" | "warn" | "error",
  message: string,
  details: string = "{}",
): void {
  if (!existsSync(dataDir)) return;
  const scriptPath = resolve(repoRootAbs, "scripts/log-event.ts");
  // Guard existsSync antes do spawn (não só try/catch em volta): sem isso,
  // um repoRootAbs sem scripts/log-event.ts (repo incompleto/de teste)
  // ainda tenta spawnar `node --import tsx <path-inexistente>`, que imprime
  // um stack trace feio no stderr HERDADO (runTsx stdout:"ignore" só
  // silencia stdout) antes de lançar — engolido do mesmo jeito, mas com
  // ruído evitável.
  if (!existsSync(scriptPath)) return;
  try {
    runTsx(
      scriptPath,
      ["--edition", aammdd, "--agent", "scheduled-edicao", "--level", level, "--message", message, "--details", details],
      { cwd: repoRootAbs, stdout: "ignore" },
    );
  } catch {
    // Log de run-log falhou — não propagar; já temos o schedule log.
  }
}

function log(
  repoRootAbs: string,
  dataDir: string,
  aammdd: string,
  scheduleMsg: string,
  level: "info" | "warn" | "error",
  runMsg: string,
  details: string = "{}",
): void {
  writeScheduleLog(dataDir, scheduleMsg);
  writeRunLog(repoRootAbs, dataDir, aammdd, level, runMsg, details);
}

/**
 * `aammddOverride` é injetável (default = `nextEditionDate()` real) — mesmo
 * padrão de `exec`/`execFn` injetável usado no resto do repo — para permitir
 * testar o guard de idempotência sem depender da data real do sistema.
 */
export function main(
  repoRootAbs: string,
  execFn: typeof execFileSync = execFileSync,
  aammddOverride?: string,
  // Injetável pelo mesmo motivo que `execFn` (#5549): sem isto, os testes que
  // exercitam o caminho de invocação passariam a depender de existir um
  // `claude` de VERDADE no host — o CI (ubuntu-latest, sem o CLI instalado)
  // quebraria, e na máquina do editor passaria por acidente. Justamente a
  // divergência de ambiente que este módulo existe pra blindar.
  resolveClaudeBinFn: typeof resolveClaudeBin = resolveClaudeBin,
  // Injetável pelo mesmo motivo que `execFn` (#5738): permite testar o laço
  // resumível — "stage 2 já concluído, pula direto pro 3" — sem montar uma
  // árvore de sentinelas em disco a cada caso de teste. `assertSentinel` e não
  // `sentinelExists` desde o #5744: sentinela órfã (output apagado) não conta
  // como stage concluído.
  assertSentinelFn: typeof assertSentinel = assertSentinel,
): number {
  const dataDir = join(repoRootAbs, "data");
  const aammdd = aammddOverride ?? nextEditionDate();
  const pid = process.pid;

  log(
      repoRootAbs,
    dataDir,
      aammdd,
    `START edition=${aammdd} pid=${pid}`,
    "info",
    "scheduled-edicao: início",
    `{"edition":"${aammdd}","trigger":"systemd-timer"}`,
  );

  // -------------------------------------------------------------------
  // Guard de idempotência (#4998): não disparar se a edição já existe.
  // -------------------------------------------------------------------
  // Layout flat legado E nested (`{AAMM}/{AAMMDD}`, #3025/#3530) — o guard
  // antigo só olhava o flat, o que era inofensivo enquanto ele apenas
  // respondia "existe?". Agora este mesmo path resolve SENTINELAS: no layout
  // nested, um path flat faria `sentinelExists` retornar false para todos os
  // stages, e a retomada re-rodaria trabalho já concluído em silêncio.
  const editionDir = resolveEditionDir(join(dataDir, "editions"), aammdd);
  // O guard mudou de PERGUNTA no #5738, e a diferença importa.
  //
  // Antes: "o diretório da edição existe?" → SKIP. Isso funcionava enquanto
  // uma invocação era tudo-ou-nada. Com um spawn por stage, passou a ser um
  // bug: o Stage 1 cria o diretório assim que começa, então QUALQUER
  // reinvocação (retry após falha no meio do laço, segunda passada da task)
  // batia aqui e saía — a retomada por sentinela nunca era alcançada, e o
  // laço só pulava stages dentro de um mesmo processo, onde nunca há
  // sentinela pré-existente. O mecanismo inteiro era letra morta.
  //
  // Agora: "todos os stages do plano já concluíram?" → SKIP. É a mesma
  // intenção declarada no #4998 ("não DISPARAR quando não há motivo"),
  // só que respondida com precisão: sabemos exatamente o que falta, em vez
  // de inferir a partir da existência de um diretório. Edição pela metade
  // é retomada de onde parou; edição completa não gasta uma sessão para
  // constatar que não há o que fazer.
  const pendingStages = STAGE_PLAN_IMPL.filter(({ stage }) => !assertSentinelFn(editionDir, stage).ok);
  if (existsSync(editionDir) && pendingStages.length === 0) {
    log(
      repoRootAbs,
      dataDir,
      aammdd,
      `SKIP  edition=${aammdd} reason=already-complete end=${nowIso()}`,
      "info",
      "scheduled-edicao: pulado (todos os stages do plano já concluídos)",
      `{"edition":"${aammdd}","reason":"already-complete"}`,
    );
    console.log(`[${nowIso()}] SKIP — todos os stages de STAGE_PLAN já têm sentinela. Nada a fazer.`);
    return 0;
  }
  if (existsSync(editionDir)) {
    console.log(
      `[${nowIso()}] Edição já iniciada — retomando nos stages pendentes: ${pendingStages
        .map((p: { stage: number }) => p.stage)
        .join(", ")}`,
    );
  }

  // -------------------------------------------------------------------
  // Sync de código UMA vez, antes do laço (#5738).
  //
  // CLAUDE.md manda sincronizar "só no início, nunca mid-edição". Com uma
  // sessão por stage, deixar cada skill sincronizar por conta própria
  // violaria isso 4 vezes — e pior, com o pipeline já em andamento. Fail-soft
  // invariável, igual ao Passo 0 de `/diaria-edicao`: qualquer falha de sync
  // vira warning e a edição segue.
  // -------------------------------------------------------------------
  const syncScript = resolve(repoRootAbs, "scripts/sync-code.ts");
  if (existsSync(syncScript)) {
    try {
      runTsx(syncScript, [], { cwd: repoRootAbs, stdout: "ignore" });
    } catch (e) {
      console.warn(`[${nowIso()}] sync-code falhou (fail-soft, edição segue): ${(e as Error).message}`);
      log(
        repoRootAbs,
        dataDir,
        aammdd,
        `WARN  edition=${aammdd} sync-code falhou: ${(e as Error).message}`,
        "warn",
        "scheduled-edicao: sync-code falhou (fail-soft, edição segue)",
        `{"edition":"${aammdd}"}`,
      );
    }
  }

  // -------------------------------------------------------------------
  // UM SPAWN POR STAGE — laço compartilhado em `lib/edition-stage-runner.ts`
  // (#5738 criou, #5744 extraiu para o caminho interativo reusar).
  // try/catch em volta (achado P3 do review da PR #5753): `assertNoPublishStage`
  // lança, e hoje isso é inalcançável pelos dois callers — mas se um dia for
  // alcançado, uma exceção crua aqui pularia todo o `log()` estruturado abaixo.
  // O operador veria um stack trace no journal do systemd e nenhuma linha
  // `FAIL edition=... stage=...` no schedule log, que é justamente onde ele
  // procura.
  let runResult: ReturnType<typeof runEditionStages>;
  try {
    runResult = runEditionStages({
      aammdd,
      editionDir,
      repoRootAbs,
      resolveClaudeBin: resolveClaudeBinFn,
      env: claudeCliEnv(process.env),
      plan: STAGE_PLAN_IMPL,
      execFn,
      assertSentinelFn,
      onProgress: (m) => console.log(`[${nowIso()}] ${m}`),
    });
  } catch (e) {
    runResult = {
      outcomes: [],
      exitCode: 1,
      failedStage: null,
    };
    console.error(`[${nowIso()}] erro de configuração do plano de stages: ${(e as Error).message}`);
    runResult.outcomes.push({
      stage: -1,
      skill: "(plano)",
      status: "failed",
      exitCode: 1,
      durationMs: 0,
      failureTail: (e as Error).message,
    });
  }
  const exitCode = runResult.exitCode;
  const failedStage = runResult.failedStage;
  const tail = runResult.outcomes.find((o) => o.status === "failed")?.failureTail ?? "";

  const runEnd = nowIso();
  if (exitCode === 0) {
    log(
      repoRootAbs,
      dataDir,
      aammdd,
      `OK    edition=${aammdd} exit=0 end=${runEnd}`,
      "info",
      "scheduled-edicao: concluído",
      `{"edition":"${aammdd}","exit_code":0}`,
    );
  } else {
    // `stage=` no log: sem ele, uma falha no Stage 3 e uma no Stage 1 ficam
    // indistinguíveis na linha de schedule — e com 4 spawns em vez de 1, saber
    // ONDE parou é a diferença entre retomar e reprocessar tudo.
    log(
      repoRootAbs,
      dataDir,
      aammdd,
      `FAIL  edition=${aammdd} stage=${failedStage ?? "?"} exit=${exitCode} end=${runEnd} tail=${tail}`,
      "error",
      `scheduled-edicao: falha no stage ${failedStage ?? "?"} (exit ${exitCode})`,
      `{"edition":"${aammdd}","exit_code":${exitCode},"failed_stage":${failedStage ?? "null"}}`,
    );
  }

  return exitCode;
}

if (isMainModule(import.meta.url)) {
  const repoRootAbs = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  process.exit(main(repoRootAbs));
}
