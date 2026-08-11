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
 * Uso: `npx tsx scripts/clarice-envio-guard.ts` — SEM args.
 *
 * Exit codes: 0 — sucesso (nada a fazer / cancelado com sucesso / pausado);
 * 1 — erro duro (guard abortou, lock detido, exceção inesperada).
 *
 * @see scripts/clarice-envio-run.ts (a metade das 19:00, mesmo padrão de orquestração)
 * @see scripts/clarice-reapply-scheduled-html.ts (setCampaignStatus, reusado aqui)
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import type { WaveProposal } from "./lib/clarice-wave-plan.ts";
import type { RiskSnapshot } from "./clarice-envio-risk.ts";

loadProjectEnv();
const ROOT = resolve(new URL("..", import.meta.url).pathname);

// ---------------------------------------------------------------------------
// Deps injetáveis.
// ---------------------------------------------------------------------------

export interface EnvioGuardDeps {
  rootDir: string;
  now: () => Date;
  exec: ExecFn;
  isEnabled: () => boolean;
  execMode: () => "local" | "cloud";
  setCampaignStatus: (apiKey: string, campaignId: number, status: string) => Promise<unknown>;
}

export function productionGuardDeps(rootDir: string = ROOT): EnvioGuardDeps {
  return {
    rootDir,
    now: () => new Date(),
    exec: realExec(rootDir),
    isEnabled: () => isClariceEnvioEnabled(rootDir),
    execMode: () => detectExecMode({ projectRoot: rootDir }),
    setCampaignStatus,
  };
}

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
  } catch {
    // dir pode não existir ainda numa 1ª rodada — writeFileAtomic não cria
    // diretório; fallback simples via mkdirSync+retry evitado aqui de
    // propósito (mesma disciplina fail-soft do registro abaixo: o pior
    // resultado é o relatório não persistir, nunca a rodada travar por isso).
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

function readCampaignEntries(rootDir: string, cycle: string): CampaignEntry[] {
  const p = resolve(clariceSegmentsDir(cycle, resolve(rootDir, "data", "clarice-subscribers")), "group-campaigns.json");
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8")) as CampaignEntry[];
  } catch {
    return [];
  }
}

function writeCampaignEntries(rootDir: string, cycle: string, entries: CampaignEntry[]): void {
  const p = resolve(clariceSegmentsDir(cycle, resolve(rootDir, "data", "clarice-subscribers")), "group-campaigns.json");
  writeFileAtomic(p, JSON.stringify(entries, null, 2));
}

// ---------------------------------------------------------------------------
// Orquestração principal.
// ---------------------------------------------------------------------------

export interface EnvioGuardResult {
  code: 0 | 1;
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

    const cycle = computeExpectedEnvioCycle(now);
    lockPath = acquireEnvioLock(deps.rootDir, cycle, `envio-guard-${aammdd}`, now);
    report.note(`lock adquirido: ${lockPath}`);

    const targetDate = targetDateBrt(now);
    report.note(`ciclo: ${cycle}. data alvo (hoje, 06:00 BRT): ${targetDate}.`);

    const planResult = deps.exec("scripts/clarice-plan-wave.ts", ["--cycle", cycle, "--dates", targetDate, "--json"]);
    if (planResult.stderr.trim()) console.error(planResult.stderr.trim());
    if (![0, 2].includes(planResult.code)) {
      throw new EnvioGuardAbort(`❌ clarice-plan-wave falhou (exit ${planResult.code}): ${planResult.stderr.trim().split("\n").slice(-6).join(" | ")}`);
    }
    const proposal = parseStepJson<WaveProposal>(planResult.stdout);
    if (!proposal) throw new EnvioGuardAbort("❌ clarice-plan-wave não devolveu JSON parseável.");

    const pending = findPendingWavesToday(proposal.state.waves, now);
    if (pending.length === 0) {
      report.note("nenhuma onda pendente pra hoje (já enviada, cancelada antes, ou automação ainda não gerou uma) — nada a fazer.");
      const reportId = `envio-${aammdd}-guard-nada-a-fazer`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio guard ${aammdd} — nada a fazer`, report.build());
      return { code: 0, reportId, reportMarkdown: report.build() };
    }
    report.note(`${pending.length} onda(s) pendente(s) pra hoje: ${pending.map((p) => p.key).join(", ")}.`);

    const riskResult = deps.exec("scripts/clarice-envio-risk.ts", []);
    if (riskResult.stderr.trim()) console.error(riskResult.stderr.trim());
    if (riskResult.code !== 0) {
      throw new EnvioGuardAbort(`❌ clarice-envio-risk falhou (exit ${riskResult.code}): ${riskResult.stderr.trim().split("\n").slice(-6).join(" | ")}`);
    }
    const risk = parseStepJson<RiskSnapshot>(riskResult.stdout);
    if (!risk) throw new EnvioGuardAbort("❌ clarice-envio-risk não devolveu JSON parseável.");
    report.note(`freio fresco (05:00): ${risk.brake.level.toUpperCase()} — ${risk.brake.reasons.join(" ")}`);

    if (risk.brake.level !== "stop") {
      report.note("freio dentro do aceitável — onda(s) seguem pro disparo das 06:00 sem alteração.");
      const reportId = `envio-${aammdd}-guard-ok`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio guard ${aammdd} — onda confirmada`, report.build());
      return { code: 0, reportId, reportMarkdown: report.build() };
    }

    report.note("⚠️  freio em STOP com dado fresco — cancelando a(s) onda(s) pendente(s) pra hoje (escopo reduzido: cancela, não recria — ver docstring do arquivo).");
    const entries = readCampaignEntries(deps.rootDir, cycle);
    const apiKey = process.env.BREVO_CLARICE_API_KEY!;
    let anyCancelled = false;
    for (const p of pending) {
      const entry = entries.find((e) => e.key === p.key);
      if (!entry) {
        report.note(`⚠️  "${p.key}": pendente segundo clarice-plan-wave, mas sem entrada em group-campaigns.json — não foi possível cancelar (campaignId desconhecido). Cancelar manualmente pelo painel Brevo.`);
        continue;
      }
      try {
        await deps.setCampaignStatus(apiKey, entry.campaignId, "suspended");
        entry.status = "draft"; // reflete localmente que não é mais "scheduled" — evita que a próxima rodada a trate como comprometida
        anyCancelled = true;
        report.note(`✅ "${p.key}" (campaignId ${entry.campaignId}) suspensa.`);
      } catch (e) {
        report.note(`❌ "${p.key}" (campaignId ${entry.campaignId}): falha ao suspender — ${(e as Error).message}. Cancelar manualmente pelo painel Brevo.`);
      }
    }
    if (anyCancelled) writeCampaignEntries(deps.rootDir, cycle, entries);

    const reportId = `envio-${aammdd}-guard-cancelou`;
    writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio guard ${aammdd} — onda cancelada (freio STOP)`, report.build());
    return { code: 0, reportId, reportMarkdown: report.build() };
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
