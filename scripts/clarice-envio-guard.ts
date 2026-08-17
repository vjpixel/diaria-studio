#!/usr/bin/env node
/**
 * clarice-envio-guard.ts (#5026)
 *
 * Task `Diaria-Clarice-Envio-Guard` (05:00 BRT) — segunda metade do par com
 * `clarice-envio-run.ts` (19:00 BRT). A onda de HOJE foi planejada e
 * AGENDADA ontem às 19:00, com o risco medido NAQUELE momento (a Brevo
 * congela destinatários no agendamento, não no envio — memória do projeto
 * `brevo-recipients-snapshot`). Entre 19:00 e 06:00 chegam ~11h de
 * bounce/unsub/spam da onda ANTERIOR (a que efetivamente saiu ontem de
 * manhã) — este guard relê o risco com esse dado fresco, na última janela
 * antes do disparo das 06:00, e é a mitigação natural do fato de que o
 * snapshot de destinatários ficou congelado 11h atrás.
 *
 * **ESCOPO DELIBERADAMENTE REDUZIDO** em relação à decisão original do
 * editor ("cancela e recria menor pro mesmo horário"): esta primeira versão
 * só CANCELA (`status: "suspended"`) quando o freio fresco é STOP — não
 * tenta recriar uma onda podada. Recriar exigiria segmentar + importar de
 * novo (escritas Brevo NOVAS) dentro de um caminho de código com ZERO horas
 * de produção, de madrugada, sem ninguém olhando — risco desproporcional ao
 * ganho de "não perder o dia", já que o dia seguinte reconcilia sozinho
 * (`baseVolume` nunca reseta pra zero por um dia sem envio, só não escala —
 * ver `NextVolumeInput.baseVolume`). Cancelar puro é a metade seguramente
 * implementável agora; "recria menor" fica registrado como follow-up.
 *
 * `brake` "hold"/"ok" fresco: nada a fazer — só reporta (confirma que a
 * onda segue segura pro disparo das 06:00). O relatório desta rodada é
 * sempre gravado, inclusive no caminho "nada a fazer" — silêncio total
 * numa automação que decide cancelar campanha real seria pior que um
 * relatório vazio.
 *
 * Kill switch: MESMO `data/clarice-envio-enabled.json` do run das 19:00 —
 * pausar a automação pausa o par inteiro (ver `clarice-envio-enabled.ts`).
 * Lock: MESMO recurso por ciclo de `clarice-envio-run.ts`
 * (`clarice-envio-lock.ts`) — impede o guard rodar por cima de uma rodada
 * de planejamento ainda em curso (ou vice-versa).
 *
 * **#5220 — pré-requisitos (`clarice-plan-wave`/`clarice-envio-risk`) NÃO
 * abortam mais na 1ª falha.** Gap achado ao vivo: um 503/rate-limit do
 * dashboard na janela 05:00–06:00 fazia o guard abortar ANTES de reavaliar
 * o freio, e a onda já agendada disparava às 06:00 sem checagem nenhuma —
 * o guard existia mas não fazia nada. Agora: (1) retry com backoff, orçamento
 * MENOR que o par das 19:00 (`GUARD_TRANSIENT_RETRY_BUDGET` — pior caso
 * ~20min, cabe com folga na janela de 1h); (2) se o retry esgotar (ou a
 * falha for estrutural), `handlePrereqFailure` decide por FALLBACK, lendo o
 * ÚLTIMO freio conhecido (gravado por `clarice-envio-run.ts` em
 * `data/clarice-subscribers/envio-reports/envio-{aammdd}-brake.json`, NUNCA
 * reconsultando a Brevo — é justamente a fonte que já falhou): freio da
 * noite era "ok" => deixa a onda seguir + ALARMA; qualquer outra coisa
 * (`hold`/`stop`/ausente/ilegível) => suspende por precaução (fail-closed).
 * Decisão do editor, 13/08/2026.
 *
 * Uso: `npx tsx scripts/clarice-envio-guard.ts` — SEM args.
 *
 * Exit codes: 0 — sucesso (nada a fazer / cancelado e CONFIRMADO com sucesso
 * / pausado / fallback deixou a onda seguir); 1 — erro duro (guard abortou,
 * lock detido, exceção inesperada, ou fallback sem onda pendente localmente
 * pra agir); 2 — CANCELAMENTO INCOMPLETO — pelo menos 1 onda pendente NÃO
 * foi confirmada suspensa (falha da API Brevo, ou `campaignId` desconhecido
 * por ausência/corrupção do registro local), no caminho normal OU no de
 * fallback. **Achado CRITICAL do silent-failure-hunter no review da PR**: a
 * versão anterior retornava `0` mesmo quando NENHUMA onda fosse de fato
 * cancelada — o único sinal externo (exit code) mentia "sucesso" exatamente
 * no cenário mais perigoso (freio disse STOP, e a onda dispara mesmo assim
 * às 06:00, sem que ninguém seja alertado porque a task "rodou com
 * sucesso"). `2` nunca é confundido com `0` por quem monitora só o exit
 * code. **Exit code sozinho NÃO distingue caminho normal de fallback** — o
 * `reportId` faz isso (sufixo `-prereq-fallback-*`), e é o que
 * `Diaria-Clarice-Envio-Guard-Alarm` (#5220, ~06:15 BRT) usa pra decidir se
 * alarma.
 *
 * @see scripts/clarice-envio-run.ts (a metade das 19:00, mesmo padrão de orquestração)
 * @see scripts/clarice-reapply-scheduled-html.ts (setCampaignStatus, reusado aqui)
 * @see scripts/lib/clarice-envio-last-brake.ts (sidecar do último freio conhecido)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { detectExecMode } from "./lib/exec-mode.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { isClariceEnvioEnabled } from "./lib/clarice-envio-enabled.ts";
import { acquireEnvioLock, releaseEnvioLock, LockHeldError } from "./lib/clarice-envio-lock.ts";
import { computeExpectedEnvioCycle } from "./lib/clarice-envio-cycle.ts";
import { clariceSegmentsDir } from "./lib/clarice-paths.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { setCampaignStatus } from "./clarice-reapply-scheduled-html.ts";
import type { CampaignEntry } from "./clarice-schedule-group.ts";
import { brtDayKey } from "./lib/clarice-envio-policy.ts";
import { datePartsInTz, toAammdd, BRT_TIMEZONE } from "./lib/next-edition-date.ts";
import { registerReport } from "./studio-ui/studio-reports.ts";
import {
  realExec,
  parseStepJson,
  type ExecFn,
  type StepResult,
} from "./clarice-envio-run.ts";
import { stepWithTransientRetry as sharedStepWithTransientRetry } from "./lib/transient-step-retry.ts";
import { readLastBrakeSnapshot } from "./lib/clarice-envio-last-brake.ts";
import type { WaveProposal } from "./lib/clarice-wave-plan.ts";
import type { RiskSnapshot } from "./clarice-envio-risk.ts";
import { readClariceEnvioOverrideState, applyEnvioOverride } from "./lib/clarice-envio-override.ts";

loadProjectEnv();
// `new URL("..", import.meta.url).pathname` quebra no Windows (dobra a drive
// letter, ex: "C:\C:\Users\...") — ver nota em scripts/brevo-diaria-run.ts e
// test/root-path-windows.test.ts.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Deps injetáveis.
// ---------------------------------------------------------------------------

export interface EnvioGuardDeps {
  rootDir: string;
  now: () => Date;
  exec: ExecFn;
  isEnabled: () => boolean;
  execMode: () => "local" | "cloud";
  /** #5220 — seam de sleep pro retry com backoff dos pré-requisitos (mesmo
   * padrão de `EnvioRunDeps.sleep` em `clarice-envio-run.ts`). Sem o seam,
   * os testes de retry esperariam de verdade (minutos). */
  sleep: (ms: number) => Promise<void>;
  /** `status` estreitado ao literal usado (achado do type-design-analyzer no
   * review da PR) — este guard só CANCELA (nunca reagenda, ver docstring do
   * arquivo), então um typo tipo `"supsended"` vira erro de compilação em vez
   * de falha silenciosa em produção às 05:00, sem ninguém olhando.
   * Contravariante: a função real (`setCampaignStatus`, `status: string`)
   * continua atribuível aqui sem wrapper. */
  setCampaignStatus: (apiKey: string, campaignId: number, status: "suspended") => Promise<unknown>;
}

export function productionGuardDeps(rootDir: string = ROOT): EnvioGuardDeps {
  return {
    rootDir,
    now: () => new Date(),
    exec: realExec(rootDir),
    isEnabled: () => isClariceEnvioEnabled(rootDir),
    execMode: () => detectExecMode({ projectRoot: rootDir }),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    setCampaignStatus,
  };
}

// ---------------------------------------------------------------------------
// #5220 — retry com backoff pros pré-requisitos (`clarice-plan-wave.ts`/
// `clarice-envio-risk.ts`), orçamento MENOR que o par das 19:00
// (`clarice-envio-run.ts`, ~11h de folga até o envio do dia SEGUINTE). O
// guard roda dentro da janela 05:00→06:00 do MESMO dia — pior caso (2
// esperas pras 3 tentativas, ambas no teto) precisa caber com folga franca
// antes do disparo. 3 tentativas, fallback 30s (sem retryAfterSecs), teto de
// 10min por espera => pior caso ~20min de espera total, bem dentro da janela
// de 1h.
// ---------------------------------------------------------------------------

const GUARD_TRANSIENT_RETRY_BUDGET = {
  maxAttempts: 3,
  fallbackMs: 30_000,
  capMs: 10 * 60_000,
};

export class EnvioGuardAbort extends Error {
  readonly code = 1 as const;
  constructor(reason: string) {
    super(reason);
    this.name = "EnvioGuardAbort";
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
  build(): string {
    return this.lines.join("\n") + "\n";
  }
}

function todayAammdd(now: Date): string {
  return toAammdd(datePartsInTz(now, BRT_TIMEZONE));
}

function targetDateBrt(now: Date): string {
  const p = datePartsInTz(now, BRT_TIMEZONE);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function writeAndRegisterReport(deps: EnvioGuardDeps, reportId: string, title: string, markdown: string): void {
  const dir = resolve(deps.rootDir, "data", "clarice-subscribers", "envio-reports");
  const relPath = `data/clarice-subscribers/envio-reports/${reportId}.md`;
  try {
    writeFileAtomic(resolve(deps.rootDir, relPath), markdown);
  } catch (e) {
    // dir pode não existir ainda numa 1ª rodada — writeFileAtomic não cria
    // diretório; fallback simples via mkdirSync+retry evitado aqui de
    // propósito (mesma disciplina fail-soft do registro abaixo: o pior
    // resultado é o relatório não persistir, nunca a rodada travar por isso).
    // Achado MEDIUM do silent-failure-hunter no review da PR: este catch
    // ficava mudo (nem console.error) — contradizia o próprio princípio
    // declarado no header do arquivo ("silêncio total... seria pior que um
    // relatório vazio"). `report.note()` já ecoou cada linha operacional em
    // stderr no momento em que foi adicionada, então o log da task não
    // perde o conteúdo — mas a falha de PERSISTIR o .md em si precisa
    // aparecer também.
    console.error(`[clarice-envio-guard] aviso: falha ao persistir o relatório em disco: ${(e as Error).message}`);
  }
  const result = registerReport(deps.rootDir, { kind: "clarice-envio", sessionId: reportId, title, htmlPath: relPath });
  if (!result.ok) console.error(`[clarice-envio-guard] aviso: registro do relatório falhou (fail-soft, #3714): ${result.error}`);
}

// ---------------------------------------------------------------------------
// Ondas pendentes de hoje (ainda não "sent").
// ---------------------------------------------------------------------------

export interface PendingWave {
  key: string;
  scheduledAt: string;
}

export function findPendingWavesToday(
  waves: ReadonlyArray<{ key: string; status: string; scheduledAt: string | null }>,
  now: Date,
): PendingWave[] {
  const todayKey = brtDayKey(now.toISOString());
  const pending: PendingWave[] = [];
  for (const w of waves) {
    if (!w.scheduledAt) continue;
    if (brtDayKey(w.scheduledAt) !== todayKey) continue;
    if (w.status === "sent") continue;
    pending.push({ key: w.key, scheduledAt: w.scheduledAt });
  }
  return pending;
}

/**
 * `onInvalid` — achado HIGH do silent-failure-hunter no review da PR: um
 * `group-campaigns.json` corrompido (escrita interrompida, conflito de sync
 * do OneDrive) produzia o MESMO `[]` que "esta onda nunca teve campanha
 * nenhuma registrada" — downstream, toda onda pendente caía no ramo
 * "campaignId desconhecido", e o operador não tinha como saber que o
 * problema era um arquivo local corrompido, não uma onda nunca registrada.
 * Ausência (arquivo nunca existiu) continua silenciosa — legítimo, é o
 * caso normal do 1º dia de um ciclo.
 */
function readCampaignEntries(rootDir: string, cycle: string, onInvalid: (msg: string) => void): CampaignEntry[] {
  const p = resolve(clariceSegmentsDir(cycle, resolve(rootDir, "data", "clarice-subscribers")), "group-campaigns.json");
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CampaignEntry[];
  } catch (e) {
    onInvalid(
      `⚠️  ${p} existe mas não deu pra ler/parsear (${(e as Error).message}) — tratando como SEM entradas, ` +
        `mas isso é um arquivo CORROMPIDO, não "onda nunca registrada". Investigar antes de confiar no ` +
        `"campaignId desconhecido" que vai aparecer abaixo pra cada onda pendente.`,
    );
    return [];
  }
}

function writeCampaignEntries(rootDir: string, cycle: string, entries: CampaignEntry[]): void {
  const p = resolve(clariceSegmentsDir(cycle, resolve(rootDir, "data", "clarice-subscribers")), "group-campaigns.json");
  writeFileAtomic(p, JSON.stringify(entries, null, 2));
}

/**
 * Deriva ondas pendentes de hoje DIRETO do registro local
 * (`group-campaigns.json`) — usado pelo caminho de FALLBACK (#5220), que
 * roda justamente quando `clarice-plan-wave.ts` (a fonte normal de
 * `proposal.state.waves`) falhou. `group-campaigns.json` é a MESMA fonte
 * que o cancelamento em si já usa pra achar o `campaignId` — derivar
 * "pendente" dela é consistente com "o que dá pra cancelar", que é
 * exatamente o que o fallback precisa saber.
 */
function findPendingWavesFromLocalEntries(entries: CampaignEntry[], now: Date): PendingWave[] {
  const asWaveLike = entries
    .filter((e) => e.status !== "sent")
    .map((e) => ({ key: e.key, status: e.status, scheduledAt: e.scheduledAt ?? null }));
  return findPendingWavesToday(asWaveLike, now);
}

/**
 * Cancela (`suspended`) cada onda pendente, rastreando CONFIRMAÇÃO por onda
 * — mesma disciplina do achado CRITICAL do silent-failure-hunter (ver
 * docstring do módulo, "Exit codes"). Extraído (#5220) pra ser reusado
 * tanto pelo caminho normal (freio fresco = STOP) quanto pelo caminho de
 * FALLBACK (pré-requisito falhou, freio anterior não-OK).
 */
async function cancelPendingWaves(
  deps: EnvioGuardDeps,
  report: ReportBuilder,
  cycle: string,
  pending: PendingWave[],
): Promise<{ allConfirmed: boolean }> {
  const entries = readCampaignEntries(deps.rootDir, cycle, (msg) => report.note(msg));
  const apiKey = process.env.BREVO_CLARICE_API_KEY!;
  let allConfirmed = true;
  let anySucceeded = false;
  for (const p of pending) {
    const entry = entries.find((e) => e.key === p.key);
    if (!entry) {
      report.note(`⚠️  "${p.key}": pendente, mas sem entrada em group-campaigns.json — não foi possível cancelar (campaignId desconhecido). Cancelar manualmente pelo painel Brevo.`);
      allConfirmed = false;
      continue;
    }
    try {
      await deps.setCampaignStatus(apiKey, entry.campaignId, "suspended");
      entry.status = "draft"; // reflete localmente que não é mais "scheduled" — evita que a próxima rodada a trate como comprometida
      anySucceeded = true;
      report.note(`✅ "${p.key}" (campaignId ${entry.campaignId}) suspensa.`);
    } catch (e) {
      report.note(`❌ "${p.key}" (campaignId ${entry.campaignId}): falha ao suspender — ${(e as Error).message}. Cancelar manualmente pelo painel Brevo.`);
      allConfirmed = false;
    }
  }
  if (anySucceeded) writeCampaignEntries(deps.rootDir, cycle, entries);
  return { allConfirmed };
}

/**
 * #5220 — caminho de FALLBACK: os pré-requisitos (`clarice-plan-wave.ts`/
 * `clarice-envio-risk.ts`) falharam mesmo após o retry transitório (ver
 * `GUARD_TRANSIENT_RETRY_BUDGET`). Decisão do editor (13/08/2026):
 *
 *   - Freio registrado pela rodada das 19:00 (lido de DISCO, nunca
 *     reconsultando a Brevo — é justamente a fonte que já falhou) era
 *     "ok" => deixa a onda seguir pro disparo das 06:00, mas ALARMA (o
 *     guard não conseguiu reavaliar com dado fresco, então "deixar passar"
 *     é uma aposta, não uma confirmação).
 *   - Qualquer outra coisa — "hold", "stop", ausente, ou ilegível — =>
 *     suspende por precaução (fail-closed).
 *
 * Ondas pendentes são derivadas do registro LOCAL (`group-campaigns.json`,
 * `findPendingWavesFromLocalEntries`), nunca de `proposal.state.waves` —
 * esse é justamente o dado que pode não existir aqui (se foi
 * `clarice-plan-wave.ts` que falhou).
 */
async function handlePrereqFailure(
  deps: EnvioGuardDeps,
  report: ReportBuilder,
  aammdd: string,
  cycle: string,
  now: Date,
  cause: Error,
): Promise<EnvioGuardResult> {
  report.note(`⚠️  pré-requisito(s) do guard (clarice-plan-wave/clarice-envio-risk) falharam mesmo após retry — ${cause.message}`);

  // #5220 — mesma matemática de `now - 24h` usada acima pra resolver o
  // ciclo: o dia-calendário BRT em que `clarice-envio-run.ts` RODOU (19:00
  // de ontem, relativo a este guard de hoje de manhã).
  const runAammdd = todayAammdd(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const lastBrake = readLastBrakeSnapshot(deps.rootDir, runAammdd, (msg) => report.note(msg));
  if (lastBrake) {
    report.note(`freio registrado pela rodada das 19:00 (${lastBrake.recordedAt}): ${lastBrake.brake.toUpperCase()} — ${lastBrake.reasons.join(" ")}`);
  } else {
    report.note("nenhum freio registrado pela rodada das 19:00 encontrado (ausente ou ilegível) — tratando como NÃO-OK (fail-closed).");
  }

  const entries = readCampaignEntries(deps.rootDir, cycle, (msg) => report.note(msg));
  const pending = findPendingWavesFromLocalEntries(entries, now);

  if (pending.length === 0) {
    report.note("nenhuma onda pendente encontrada no registro local (group-campaigns.json) pra hoje — nada pra suspender, mas os pré-requisitos falharam e isso merece atenção.");
    const reportId = `envio-${aammdd}-guard-prereq-falhou-sem-pendencia`;
    writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio guard ${aammdd} — ⚠️ pré-requisito falhou, sem onda pendente localmente`, report.build());
    return { code: 1, reportId, reportMarkdown: report.build() };
  }
  report.note(`${pending.length} onda(s) pendente(s) pra hoje (via registro local): ${pending.map((p) => p.key).join(", ")}.`);

  if (lastBrake?.brake === "ok") {
    report.note("fallback: freio da noite era OK — deixando a(s) onda(s) seguir(em) pro disparo das 06:00 SEM alteração (mas alarmando: o guard não conseguiu reavaliar com dado fresco).");
    const reportId = `envio-${aammdd}-guard-prereq-fallback-deixou-passar`;
    writeAndRegisterReport(
      deps,
      reportId,
      `diar.ia.br Clarice envio guard ${aammdd} — ⚠️ pré-requisito falhou, onda seguiu por fallback (freio da noite era OK)`,
      report.build(),
    );
    return { code: 0, reportId, reportMarkdown: report.build() };
  }

  report.note("fallback: freio da noite NÃO era OK (ou ausente/ilegível) — suspendendo por precaução (escopo reduzido: cancela, não recria — ver docstring do arquivo).");
  const { allConfirmed } = await cancelPendingWaves(deps, report, cycle, pending);
  const code = allConfirmed ? 0 : 2;
  const reportId = allConfirmed
    ? `envio-${aammdd}-guard-prereq-fallback-cancelou`
    : `envio-${aammdd}-guard-prereq-fallback-cancelamento-incompleto`;
  const title = allConfirmed
    ? `diar.ia.br Clarice envio guard ${aammdd} — ⚠️ pré-requisito falhou, onda suspensa por precaução (fallback)`
    : `diar.ia.br Clarice envio guard ${aammdd} — ⚠️⚠️ pré-requisito falhou E cancelamento de fallback INCOMPLETO, agir manualmente`;
  if (!allConfirmed) {
    report.note("⚠️  NEM TODA onda pendente foi confirmada suspensa no fallback — a campanha pode disparar às 06:00. Verificar o painel Brevo manualmente antes do disparo.");
  }
  writeAndRegisterReport(deps, reportId, title, report.build());
  return { code, reportId, reportMarkdown: report.build() };
}

// ---------------------------------------------------------------------------
// Orquestração principal.
// ---------------------------------------------------------------------------

export interface EnvioGuardResult {
  /** `2` = cancelamento INCOMPLETO (ver docstring do módulo) — nunca colapsado em `0`. */
  code: 0 | 1 | 2;
  reportId: string;
  reportMarkdown: string;
}

export async function runEnvioGuard(deps: EnvioGuardDeps): Promise<EnvioGuardResult> {
  const now = deps.now();
  const aammdd = todayAammdd(now);
  const report = new ReportBuilder(`diar.ia.br Clarice envio guard ${aammdd}`);
  let lockPath: string | null = null;

  if (!deps.isEnabled()) {
    report.note("⏸️  automação PAUSADA — nenhuma checagem/cancelamento feito (mesmo kill switch da rodada das 19:00).");
    const reportId = `envio-${aammdd}-guard-paused`;
    writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio guard ${aammdd} — pausado`, report.build());
    return { code: 0, reportId, reportMarkdown: report.build() };
  }

  try {
    if (deps.execMode() !== "local") throw new EnvioGuardAbort("❌ exec-mode != local — precisa do junction data/.");
    if (!process.env.BREVO_CLARICE_API_KEY) throw new EnvioGuardAbort("❌ BREVO_CLARICE_API_KEY não definida.");

    // Achado do code-reviewer no review da PR (confiança 88%): o ciclo NÃO
    // pode ser recomputado a partir do `now` do GUARD — `clarice-envio-run.ts`
    // fixou o ciclo ONTEM às 19:00 (mês de ONTEM) pra uma onda que dispara
    // HOJE; na virada de mês (ex: planejado 31/08, dispara 01/09),
    // `computeExpectedEnvioCycle(now)` aqui devolveria o ciclo de SETEMBRO,
    // enquanto a campanha pendente está registrada sob o ciclo de AGOSTO —
    // `findPendingWavesToday` não encontraria nada, e o guard reportaria
    // "nada a fazer" bem na noite de maior risco (1ª onda de um ciclo novo,
    // sem histórico). Subtrair 24h dá o dia-calendário BRT em que
    // `clarice-envio-run.ts` rodou (19:00 é sempre o MESMO dia-calendário
    // BRT que 05:00 do dia seguinte menos 24h, já que BRT não tem DST) —
    // sempre o ciclo correto, cruzando virada de mês ou não.
    const cycle = computeExpectedEnvioCycle(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    lockPath = acquireEnvioLock(deps.rootDir, cycle, `envio-guard-${aammdd}`, now);
    report.note(`lock adquirido: ${lockPath}`);

    const targetDate = targetDateBrt(now);
    report.note(`ciclo: ${cycle}. data alvo (hoje, 06:00 BRT): ${targetDate}.`);

    // #5220 — retry com backoff (orçamento MENOR que o par das 19:00, ver
    // `GUARD_TRANSIENT_RETRY_BUDGET`) em vez de abortar direto na 1ª falha
    // TRANSITÓRIA (Gap 1 da issue #5220: um 503/rate-limit na janela
    // 05:00–06:00 fazia o guard abortar SEM reavaliar o freio, e a onda já
    // agendada disparava às 06:00 sem checagem nenhuma). Se o retry esgotar
    // (ou a falha for estrutural, não-transitória), cai no FALLBACK
    // (`handlePrereqFailure`) em vez de simplesmente abortar.
    let proposal: WaveProposal | undefined;
    let pending: PendingWave[] = [];
    let prereqFailure: Error | null = null;

    try {
      const planStep = await sharedStepWithTransientRetry<WaveProposal>({
        exec: deps.exec,
        sleep: deps.sleep,
        note: (line) => report.note(line),
        parseJson: parseStepJson,
        label: "clarice-plan-wave",
        scriptRelPath: "scripts/clarice-plan-wave.ts",
        args: ["--cycle", cycle, "--dates", targetDate, "--json"],
        okCodes: [0, 2], // 2 = blockers presentes, ainda assim JSON válido.
        budget: GUARD_TRANSIENT_RETRY_BUDGET,
        makeAbort: (message) => new EnvioGuardAbort(message),
      });
      proposal = planStep.json;
      if (!proposal) throw new EnvioGuardAbort("❌ clarice-plan-wave não devolveu JSON parseável.");

      pending = findPendingWavesToday(proposal.state.waves, now);
      if (pending.length === 0) {
        report.note("nenhuma onda pendente pra hoje (já enviada, cancelada antes, ou automação ainda não gerou uma) — nada a fazer.");
        const reportId = `envio-${aammdd}-guard-nada-a-fazer`;
        writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio guard ${aammdd} — nada a fazer`, report.build());
        return { code: 0, reportId, reportMarkdown: report.build() };
      }
      report.note(`${pending.length} onda(s) pendente(s) pra hoje: ${pending.map((p) => p.key).join(", ")}.`);
    } catch (e) {
      prereqFailure = e as Error;
    }

    let risk: RiskSnapshot | undefined;
    if (!prereqFailure) {
      try {
        const riskStep = await sharedStepWithTransientRetry<RiskSnapshot>({
          exec: deps.exec,
          sleep: deps.sleep,
          note: (line) => report.note(line),
          parseJson: parseStepJson,
          label: "clarice-envio-risk",
          scriptRelPath: "scripts/clarice-envio-risk.ts",
          args: [],
          budget: GUARD_TRANSIENT_RETRY_BUDGET,
          makeAbort: (message) => new EnvioGuardAbort(message),
        });
        risk = riskStep.json;
        if (!risk) throw new EnvioGuardAbort("❌ clarice-envio-risk não devolveu JSON parseável.");
      } catch (e) {
        prereqFailure = e as Error;
      }
    }

    if (prereqFailure) {
      return await handlePrereqFailure(deps, report, aammdd, cycle, now, prereqFailure);
    }

    // #5515 — defesa em profundidade: `clarice-envio-risk.ts` já aplica o
    // override persistente internamente (`fetchRiskSnapshot`, ponto único
    // de cálculo), então em produção `risk!.brake` já chega rebaixado aqui.
    // Esta 2ª aplicação é IDEMPOTENTE (no-op quando o freio recebido já não
    // é mais "stop") e garante que o guard nunca cancela uma onda coberta
    // por um override ainda válido mesmo se, por qualquer motivo, o JSON
    // recebido do subprocess não tiver passado pelo rebaixamento (ex: um
    // caller de teste injetando `exec` com um STOP cru).
    const override = readClariceEnvioOverrideState(deps.rootDir, now, {
      onInvalid: (msg) => report.note(msg),
    });
    const { brake: effectiveBrake, overrideApplied } = applyEnvioOverride(risk!.brake, override);

    report.note(`freio fresco (05:00): ${effectiveBrake.level.toUpperCase()} — ${effectiveBrake.reasons.join(" ")}`);
    if (overrideApplied) {
      report.note("(guard) override do editor aplicado sobre o freio fresco recebido do subprocess — ver razão acima.");
    }

    if (effectiveBrake.level !== "stop") {
      report.note("freio dentro do aceitável — onda(s) seguem pro disparo das 06:00 sem alteração.");
      const reportId = `envio-${aammdd}-guard-ok`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio guard ${aammdd} — onda confirmada`, report.build());
      return { code: 0, reportId, reportMarkdown: report.build() };
    }

    report.note("⚠️  freio em STOP com dado fresco — cancelando a(s) onda(s) pendente(s) pra hoje (escopo reduzido: cancela, não recria — ver docstring do arquivo).");
    // Achado CRITICAL do silent-failure-hunter (ver docstring do módulo,
    // "Exit codes"): rastreia CONFIRMAÇÃO por onda, não só "tentei". `code`
    // só é 0 quando TODA onda pendente foi de fato suspensa — uma falha de
    // API ou um campaignId desconhecido em QUALQUER onda vira `code: 2`,
    // nunca colapsado no mesmo 0 do caminho feliz.
    const { allConfirmed } = await cancelPendingWaves(deps, report, cycle, pending);

    const code = allConfirmed ? 0 : 2;
    const reportId = allConfirmed ? `envio-${aammdd}-guard-cancelou` : `envio-${aammdd}-guard-cancelamento-incompleto`;
    const title = allConfirmed
      ? `diar.ia.br Clarice envio guard ${aammdd} — onda cancelada (freio STOP)`
      : `diar.ia.br Clarice envio guard ${aammdd} — ⚠️ CANCELAMENTO INCOMPLETO, agir manualmente`;
    if (!allConfirmed) {
      report.note("⚠️  NEM TODA onda pendente foi confirmada suspensa — a campanha pode disparar às 06:00 mesmo com o freio em STOP. Verificar o painel Brevo manualmente antes do disparo.");
    }
    writeAndRegisterReport(deps, reportId, title, report.build());
    return { code, reportId, reportMarkdown: report.build() };
  } catch (e) {
    if (e instanceof LockHeldError) {
      report.note(e.message);
      const reportId = `envio-${aammdd}-guard-lock-held`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio guard ${aammdd} — rodada concorrente em curso`, report.build());
      return { code: 1, reportId, reportMarkdown: report.build() };
    }
    const abort = e instanceof EnvioGuardAbort ? e : new EnvioGuardAbort(`❌ erro inesperado: ${(e as Error).message}`);
    report.note(abort.message);
    const reportId = `envio-${aammdd}-guard-abort`;
    writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio guard ${aammdd} — abortado`, report.build());
    return { code: abort.code, reportId, reportMarkdown: report.build() };
  } finally {
    if (lockPath) releaseEnvioLock(lockPath);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const deps = productionGuardDeps(ROOT);
  runEnvioGuard(deps)
    .then((r) => {
      process.exitCode = r.code;
    })
    .catch((e) => {
      console.error(String((e as Error)?.stack || e));
      process.exitCode = 1;
    });
}
