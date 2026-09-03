#!/usr/bin/env node
/**
 * clarice-envio-engajados-run.ts (#6945)
 *
 * Orquestrador diário do grupo NOMEADO `engajados` (retenção — quem já
 * recebeu e está engajado, `send_eligible=1 AND sends_count>0 AND
 * priority_points>0`, ordenado por `priority_points DESC`) — estende ao
 * `engajados` a mesma orquestração automática que `Diaria-Clarice-Envio`
 * (`clarice-envio-run.ts`) já dá ao `ramp-warm`. A SELEÇÃO em si (quem
 * entra, exclusão de quem já recebeu neste MÊS de envio — `excludeSentSince`)
 * já está implementada em `clarice-build-segment.ts --group engajados`; esta
 * rodada só fecha o GATILHO que faltava (achado da investigação: nenhuma task
 * automatizada chamava esse grupo — o último envio foi manual, 06/08/2026).
 *
 * **#7234 corrige o "e correta" que esta docstring afirmava.** A janela do mês
 * derivava do CICLO (`cycleSendMonthStartIso`), e o ciclo é resolvido pela data
 * de EXECUÇÃO enquanto o envio sai no dia SEGUINTE — então a rodada de 31/ago
 * montava o envio de 1º/set com o cutoff de agosto, e o 1º envio do mês (o
 * único que deveria devolver a fila ao topo do score) saía raspando o fim da
 * fila do mês anterior. Este orquestrador agora passa `--send-date` e o cutoff
 * vira o mês-calendário do ENVIO (`sendMonthStartIso`, clarice-paths.ts).
 *
 * DELIBERADAMENTE MAIS SIMPLES que `clarice-envio-run.ts` (o irmão do
 * `ramp-warm`, #5025-#6288 e adjacentes): sem freio de risco de ISP
 * replicado (já hardcoded "ok" no motor do ramp-warm, #6793/#6888 — ver
 * `clarice-envio-engajados-policy.ts`), sem teste A/B/C de assunto próprio
 * (reusa o assunto JÁ TRAVADO do dia via `clarice-abc-state.json` — mesmo
 * conteúdo/edição do dia, só audiência diferente; se o teste A/B/C ainda
 * estiver em curso — `abcAction !== "travar"` —, esta rodada PULA o dia com
 * motivo claro em vez de inventar semântica de célula pra um grupo que
 * nunca teve células), sem estado `novos-state.json`/frescor. Reusa direto
 * de `clarice-envio-run.ts` (módulo irmão, mesmo diretório) os pedaços que
 * são infraestrutura pura, sem nada específico do ramp-warm:
 * `parseStepJson`/`realExec`/`sendDateBrt` — ver imports abaixo.
 *
 * LOCK COMPARTILHADO COM O ramp-warm, de propósito: `acquireEnvioLock`
 * chaveia por CICLO (`{cycle}/.envio-run.lock`), não por grupo — as duas
 * automações escrevem no MESMO `sent-or-queued.json` cycle-wide (#4765,
 * corrida de leitura-modificação-escrita já causou 52/1.963 contatos
 * escaparem do dedup) e devem nunca rodar concorrentes sobre o mesmo ciclo,
 * seja qual grupo for. `LockHeldError` aqui é um caminho de saída SEGURO
 * (a rodada de amanhã reconcilia), nunca uma falha genuína — mesmo
 * tratamento do exit 4 do ramp-warm (ver `scripts/lib/scheduled-tasks.ts`).
 *
 * Kill switch (`clarice-envio-engajados-enabled.ts`) nasce DESLIGADO — ao
 * contrário do `clarice-envio-enabled.ts` do ramp-warm (que nasceu ligado
 * porque substituía trabalho manual já diário) — esta automação é NOVA e
 * dispara e-mail real pra até `ENGAJADOS_MAX_DAILY_VOLUME` contatos/dia sem
 * gate humano no caminho normal; o editor liga explicitamente depois de
 * revisar.
 *
 * Uso:
 *   npx tsx scripts/clarice-envio-engajados-run.ts               # rodada normal
 *   npx tsx scripts/clarice-envio-engajados-run.ts --dry-run      # calcula tudo, NÃO cria lista/campanha
 *
 * Env: `BREVO_CLARICE_API_KEY` obrigatória fora de `--dry-run`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { detectExecMode } from "./lib/exec-mode.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { readClariceAbcState, lockedSubjectFromState, type ClariceAbcStateRead } from "./lib/clarice-abc-state.ts";
import { acquireEnvioLock, releaseEnvioLock, LockHeldError } from "./lib/clarice-envio-lock.ts";
import { computeExpectedEnvioCycle } from "./lib/clarice-envio-cycle.ts";
import { resolveLatestMonthlyCycleFromDisk, type ResolveLatestMonthlyCycleResult } from "./lib/mensal/monthly-paths.ts";
import { datePartsInTz, toAammdd, BRT_TIMEZONE } from "./lib/next-edition-date.ts";
import { registerReport } from "./studio-ui/studio-reports.ts";
import { scheduledAtForDate } from "./lib/clarice-wave-plan.ts";
import { isClariceEngajadosEnabled } from "./lib/clarice-envio-engajados-enabled.ts";
import { readEngajadosState, writeEngajadosState } from "./lib/clarice-envio-engajados-state.ts";
import { proposeEngajadosVolume } from "./lib/clarice-envio-engajados-policy.ts";
import {
  parseStepJson,
  realExec,
  sendDateBrt,
  type ExecFn,
  type StepResult,
} from "./clarice-envio-run.ts";
import type { InvocationSummary } from "./clarice-schedule-group.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

loadProjectEnv();

export class EnvioEngajadosAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvioEngajadosAbort";
  }
}

class ReportBuilder {
  private lines: string[] = [];
  constructor(readonly title: string) {
    this.lines.push(`# ${title}`, "");
  }
  note(line: string): void {
    this.lines.push(`- ${line}`);
    console.error(line);
  }
  section(heading: string): void {
    this.lines.push("", `## ${heading}`, "");
  }
  build(): string {
    return this.lines.join("\n") + "\n";
  }
}

function writeAndRegisterReport(rootDir: string, reportId: string, title: string, markdown: string): void {
  const dir = resolve(rootDir, "data", "clarice-subscribers", "envio-reports");
  mkdirSync(dir, { recursive: true });
  const relPath = `data/clarice-subscribers/envio-reports/${reportId}.md`;
  writeFileSync(resolve(rootDir, relPath), markdown, "utf8");
  // Mesmo `kind` ("clarice-envio") do ramp-warm e do guard — convenção já
  // documentada em studio-reports.ts: relatórios da mesma FAMÍLIA de
  // automação compartilham `kind`, `sessionId` distingue (ver #5026 lá).
  const result = registerReport(rootDir, { kind: "clarice-envio", sessionId: reportId, title, htmlPath: relPath });
  if (!result.ok) {
    console.error(`[clarice-envio-engajados-run] aviso: registro do relatório falhou (fail-soft, #3714): ${result.error}`);
  }
}

function step<T = unknown>(
  exec: ExecFn,
  report: ReportBuilder,
  label: string,
  scriptRelPath: string,
  args: string[],
  okCodes: number[] = [0],
): { result: StepResult; json: T | undefined } {
  report.note(`▶ ${label}`);
  const result = exec(scriptRelPath, args);
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (!okCodes.includes(result.code)) {
    const detail = result.stderr.trim().split("\n").slice(-6).join(" | ") || "(sem stderr)";
    throw new EnvioEngajadosAbort(`❌ ${label} falhou (exit ${result.code}): ${detail}`);
  }
  return { result, json: parseStepJson<T>(result.stdout) };
}

function todayAammdd(now: Date): string {
  return toAammdd(datePartsInTz(now, BRT_TIMEZONE));
}

export interface EngajadosRunDeps {
  rootDir: string;
  now: () => Date;
  exec: ExecFn;
  isEnabled: () => boolean;
  execMode: () => "local" | "cloud";
  resolveLatestCycle: () => ResolveLatestMonthlyCycleResult;
  readAbcState: () => ClariceAbcStateRead;
}

export function productionDeps(rootDir: string = ROOT): EngajadosRunDeps {
  return {
    rootDir,
    now: () => new Date(),
    exec: realExec(rootDir),
    isEnabled: () => isClariceEngajadosEnabled(rootDir),
    execMode: () => detectExecMode({ projectRoot: rootDir }),
    resolveLatestCycle: () => resolveLatestMonthlyCycleFromDisk(),
    readAbcState: () => readClariceAbcState(rootDir),
  };
}

export interface EngajadosRunOptions {
  dryRun?: boolean;
}

export interface EngajadosRunResult {
  /** 0 sucesso/pausa legítima · 1 erro estrutural · 4 lock já detido (mesmo código do ramp-warm — nunca falha genuína). */
  code: 0 | 1 | 4;
  reportId: string;
  reportMarkdown: string;
}

export async function runEnvioEngajados(
  deps: EngajadosRunDeps,
  opts: EngajadosRunOptions = {},
): Promise<EngajadosRunResult> {
  const now = deps.now();
  const aammdd = todayAammdd(now);
  const report = new ReportBuilder(`diar.ia.br Clarice envio engajados ${aammdd}`);
  let lockPath: string | null = null;

  if (!deps.isEnabled()) {
    report.note(
      "⏸️  automação PAUSADA (data/clarice-engajados-enabled.json = {enabled:false}) — nenhuma chamada Brevo feita. " +
        "Rode `npx tsx scripts/lib/clarice-envio-engajados-enabled.ts --set enabled` pra religar.",
    );
    const reportId = `envio-engajados-${aammdd}-paused`;
    writeAndRegisterReport(deps.rootDir, reportId, `diar.ia.br Clarice envio engajados ${aammdd} — pausado`, report.build());
    return { code: 0, reportId, reportMarkdown: report.build() };
  }

  try {
    report.section("Passo 0 — Preflight");
    if (deps.execMode() !== "local") {
      throw new EnvioEngajadosAbort("❌ exec-mode != local — esta rotina precisa do junction data/ (Brevo real). Não roda em sessão cloud.");
    }
    if (!opts.dryRun && !process.env.BREVO_CLARICE_API_KEY) {
      throw new EnvioEngajadosAbort("❌ BREVO_CLARICE_API_KEY não definida.");
    }

    // --- Ciclo: mesmo guard do ramp-warm — nunca distribuir ciclo velho. ---
    const expectedCycle = computeExpectedEnvioCycle(now);
    const readiness = deps.resolveLatestCycle();
    if (!readiness.cycle || readiness.cycle !== expectedCycle) {
      report.note(
        `ciclo esperado pelo calendário: ${expectedCycle}. Ciclo PRONTO mais recente encontrado: ${readiness.cycle ?? "nenhum"}.` +
          " Divergem — pulando esta rodada (mesma decisão do editor 260811 aplicada ao ramp-warm: nunca distribuir ciclo antigo).",
      );
      const reportId = `envio-engajados-${aammdd}-sem-ciclo-elegivel`;
      writeAndRegisterReport(
        deps.rootDir,
        reportId,
        `diar.ia.br Clarice envio engajados ${aammdd} — ciclo ${expectedCycle} ainda não pronto`,
        report.build(),
      );
      return { code: 0, reportId, reportMarkdown: report.build() };
    }
    const cycle = readiness.cycle;
    report.note(`ciclo: ${cycle} (calendário e conteúdo pronto batem).`);

    // --- Assunto: reusa o assunto do dia JÁ TRAVADO (mesma edição, audiência diferente). ---
    const abcState = deps.readAbcState();
    const lockedSubject = lockedSubjectFromState(abcState);
    if (!lockedSubject) {
      report.note(
        "assunto do dia ainda não está TRAVADO (teste A/B/C do ramp-warm em curso) — esta automação " +
          "reusa o assunto já decidido pro ciclo/dia, nunca inventa um por conta própria. Pulando hoje; " +
          "a rodada de amanhã tenta de novo (nenhum volume é perdido — a escalada continua do último " +
          "volume confirmado).",
      );
      const reportId = `envio-engajados-${aammdd}-sem-assunto-travado`;
      writeAndRegisterReport(
        deps.rootDir,
        reportId,
        `diar.ia.br Clarice envio engajados ${aammdd} — assunto ainda não travado`,
        report.build(),
      );
      return { code: 0, reportId, reportMarkdown: report.build() };
    }
    report.note(`assunto (herdado do dia): "${lockedSubject}".`);

    lockPath = acquireEnvioLock(deps.rootDir, cycle, "clarice-envio-engajados-run", now);

    const state = readEngajadosState(resolve(deps.rootDir, "data", "clarice-subscribers"));
    const volume = proposeEngajadosVolume(state?.lastVolume ?? null);
    report.note(
      `volume proposto: ${volume} (base ${state?.lastVolume ?? "bootstrap"} × 1,10, teto absoluto de segurança aplicado — ` +
        "ver clarice-envio-engajados-policy.ts). Corte real por fila disponível é feito por --budget na escrita abaixo.",
    );

    if (opts.dryRun) {
      report.note("ℹ️  --dry-run: parando aqui — nenhuma lista/campanha criada, nada agendado.");
      const reportId = `envio-engajados-${aammdd}-dry-run`;
      writeAndRegisterReport(deps.rootDir, reportId, `diar.ia.br Clarice envio engajados ${aammdd} — dry-run`, report.build());
      return { code: 0, reportId, reportMarkdown: report.build() };
    }

    const key = `engajados-${aammdd}`;

    // #7234 — resolvido ANTES do Passo 1 (era só no Passo 2) porque o
    // `clarice-build-segment.ts` precisa dele pra derivar o cutoff "já recebeu
    // neste mês" da data em que a onda SAI. É neste grupo que o defeito morde:
    // `engajados` é ordenado por score e a virada do mês é o que devolve a fila
    // ao topo — montar em 31/ago com o cutoff de agosto faz o 1º envio de
    // setembro sair raspando o fim da fila do mês anterior.
    const sendDate = sendDateBrt(now);

    report.section("Passo 1 — Selecionar + importar pro Brevo");
    const buildSegmentStep = step<{ selected?: number; budget?: number }>(
      deps.exec,
      report,
      "clarice-build-segment",
      "scripts/clarice-build-segment.ts",
      ["--group", "engajados", "--cycle", cycle, "--budget", String(volume), "--send-date", sendDate],
    );
    const segmentSelected = buildSegmentStep.json?.selected;
    if (typeof segmentSelected === "number") {
      report.note(`selecionados: ${segmentSelected} (proposto ${volume}) — fila real determina o número final, sem erro se for menor.`);
    }

    const label = `Engajados ${cycle} (${key})`;
    step(deps.exec, report, "clarice-import-waves --group engajados --execute", "scripts/clarice-import-waves.ts", [
      "--cycle",
      cycle,
      "--group",
      "engajados",
      "--key",
      key,
      "--label",
      label,
      // #5922-like: retry no mesmo dia reusa a lista já criada em vez de
      // abortar no pré-flight de duplicata (mesma robustez que `novos` já
      // tem, ver clarice-novos-run.ts Passo 4).
      "--reuse-existing",
      "--execute",
    ]);

    report.section("Passo 2 — Criar + agendar a campanha");
    // Mesma data/horário do envio do ramp-warm — reforço da MESMA edição
    // pro público de retenção, não um envio em horário próprio.
    // (`sendDate` resolvido lá no Passo 1, ver #7234.)
    const scheduleAt = scheduledAtForDate(sendDate);
    report.note(`data de envio: ${sendDate} (06:00 BRT / 09:00 UTC amanhã) — mesmo horário canônico do ramp-warm.`);

    step<InvocationSummary>(deps.exec, report, "clarice-schedule-group --create", "scripts/clarice-schedule-group.ts", [
      "--cycle",
      cycle,
      "--group",
      "engajados",
      "--key",
      key,
      "--subject",
      lockedSubject,
      "--schedule-at",
      scheduleAt,
      "--create",
    ]);

    const scheduleResult = deps.exec("scripts/clarice-schedule-group.ts", [
      "--cycle",
      cycle,
      "--group",
      "engajados",
      "--key",
      key,
      "--schedule",
    ]);
    if (scheduleResult.stderr.trim()) console.error(scheduleResult.stderr.trim());
    if (scheduleResult.code !== 0) {
      throw new EnvioEngajadosAbort(
        `❌ clarice-schedule-group --schedule ("${key}") falhou (exit ${scheduleResult.code}): ` +
          `${scheduleResult.stderr.trim().split("\n").slice(-6).join(" | ") || "(sem stderr)"}`,
      );
    }
    report.note(`✅ campanha "${key}" agendada pra ${scheduleAt}.`);

    // Só avança o estado de escalada DEPOIS do agendamento confirmado —
    // mesma disciplina de "confirmada" documentada em
    // clarice-envio-engajados-state.ts.
    writeEngajadosState(
      { lastVolume: volume, lastSentAtIso: now.toISOString(), lastCycle: cycle },
      resolve(deps.rootDir, "data", "clarice-subscribers"),
    );

    const reportId = `envio-engajados-${aammdd}`;
    writeAndRegisterReport(deps.rootDir, reportId, `diar.ia.br Clarice envio engajados ${aammdd}`, report.build());
    return { code: 0, reportId, reportMarkdown: report.build() };
  } catch (e) {
    if (e instanceof LockHeldError) {
      report.note(`🔒 ${e.message}`);
      const reportId = `envio-engajados-${aammdd}-lock-held`;
      writeAndRegisterReport(
        deps.rootDir,
        reportId,
        `diar.ia.br Clarice envio engajados ${aammdd} — rodada concorrente em curso`,
        report.build(),
      );
      // exit 4 — mesmo código do ramp-warm pra "lock detido" (nunca falha genuína, ver scheduled-tasks.ts).
      return { code: 4, reportId, reportMarkdown: report.build() };
    }
    const abort = e as EnvioEngajadosAbort;
    report.note(abort.message ?? String(e));
    const reportId = `envio-engajados-${aammdd}-abort`;
    writeAndRegisterReport(deps.rootDir, reportId, `diar.ia.br Clarice envio engajados ${aammdd} — abortado`, report.build());
    return { code: 1, reportId, reportMarkdown: report.build() };
  } finally {
    if (lockPath) releaseEnvioLock(lockPath);
  }
}

if (isMainModule(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  const dryRun = parsed.flags.has("dry-run");
  const deps = productionDeps(ROOT);
  runEnvioEngajados(deps, { dryRun })
    .then((r) => {
      process.exitCode = r.code;
    })
    .catch((e) => {
      console.error(String((e as Error)?.stack || e));
      process.exitCode = 1;
    });
}
