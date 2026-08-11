#!/usr/bin/env node
/**
 * clarice-envio-run.ts (#5026)
 *
 * Orquestrador DETERMINÍSTICO da task diária `Diaria-Clarice-Envio` (19:00
 * BRT) — planeja e agenda a onda Clarice do dia SEGUINTE (06:00 BRT = 09:00
 * UTC). Molde direto: `scripts/clarice-novos-run.ts` (#4941) — mesma razão
 * de existir: `.claude/skills/diaria-clarice-envio/SKILL.md` tinha o LLM
 * como *glue* entre 8 passos (extrair campo do JSON de um passo, decidir
 * ramo condicional, injetar no próximo comando), incompatível com uma task
 * agendada sem editor presente (regra #573). A skill manual passa a
 * DELEGAR pra este script (ver #5027), não reimplementar o fluxo.
 *
 * O que MUDA em relação ao fluxo manual documentado em SKILL.md:
 *   - Ciclo e data NUNCA são digitados — resolvidos deterministicamente
 *     (ver `resolveEnvioCycleForToday`/`clarice-envio-cycle.ts`).
 *   - O freio de volume é o motor NOVO (`clarice-envio-risk.ts` +
 *     `scripts/lib/clarice-envio-policy.ts`, #5025) — NUNCA o semáforo
 *     antigo do dashboard, que inclui abertura.
 *   - O teste A/B/C decide sozinho pra `continuar`/`travar`
 *     (`recommendAbcAction`, já determinístico); `iniciar` (abrir teste
 *     novo, exige 3 assuntos que só o editor escreve) ABORTA — decisão do
 *     editor 260811.
 *   - Assunto(s) são HERDADOS da onda anterior do mesmo ciclo
 *     (`resolveInheritedSubjects`), nunca digitados.
 *   - `--send-test`/`review-test-email` são REMOVIDOS do caminho — decisão
 *     do editor 260811 (o HTML é o mesmo da edição inteira do ciclo, já
 *     revisado na Etapa 4 do `/diaria-mensal`; era o último LLM no caminho
 *     de um envio irreversível, e já produziu 2 blockers falsos).
 *   - `close-poll.ts` fica FORA do caminho — decisão do editor 260811. O
 *     guard `checkEiaGuard` (dentro de `clarice-schedule-group.ts --schedule`)
 *     já verifica a EXISTÊNCIA do marker; populá-lo é responsabilidade do
 *     `/diaria-mensal`, 1× por ciclo, não desta rodada diária.
 *   - Trava de concorrência (`scripts/lib/clarice-envio-lock.ts`) — decisão
 *     do editor: skill manual e task não podem montar a mesma onda ao mesmo
 *     tempo (`sent-or-queued.json` não tem lock próprio, #4765).
 *   - Guard de onda perdida (`detectMissedWaveToday`) — cobre o buraco do
 *     #4975 (nenhum guard detectava "onda esperada não disparou"): se a onda
 *     de HOJE deveria ter saído e o status não é "sent", a rodada REPORTA e
 *     NÃO ESCALA volume até resolver (mas continua tentando planejar a de
 *     amanhã — não trava a rampa inteira por um incidente pontual).
 *
 * Kill switch: `data/clarice-envio-enabled.json` — default LIGADO quando
 * ausente (decisão do editor, "ligada desde o início" — ver
 * `scripts/lib/clarice-envio-enabled.ts` pro racional completo e o risco
 * aceito desse default INVERTIDO em relação ao `clarice-novos-enabled.ts`).
 *
 * Exit codes:
 *   0 — sucesso (agendado / rodada sem ação legítima — pausado, ciclo não
 *       pronto, fila insuficiente, sem volume, abc "iniciar")
 *   1 — erro duro (guard abortou, sub-script falhou, exceção inesperada,
 *       lock já detido por outra rodada)
 *   2 — agendamento INCERTO em pelo menos 1 célula (POST aceito, GET-verify
 *       não confirmou status terminal) — NÃO declarar sucesso; reconciliável
 *       na próxima rodada (idempotente por key/campanha).
 *
 * Uso: `npx tsx scripts/clarice-envio-run.ts` — SEM args (task agendada roda
 * sem flags; nenhum override de produção é injetado automaticamente).
 *
 * @see .claude/skills/diaria-clarice-envio/SKILL.md (fluxo manual — delega pra cá)
 * @see scripts/clarice-novos-run.ts (molde de orquestrador)
 * @see #5027 (entrada "Diaria-Clarice-Envio" em scripts/lib/scheduled-tasks.ts —
 *      pode ainda não ter mergeado; confira o arquivo antes de assumir que já existe)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";
import { detectExecMode } from "./lib/exec-mode.ts";
import { isClariceEnvioEnabled } from "./lib/clarice-envio-enabled.ts";
import { acquireEnvioLock, releaseEnvioLock, LockHeldError } from "./lib/clarice-envio-lock.ts";
import { computeExpectedEnvioCycle } from "./lib/clarice-envio-cycle.ts";
import {
  resolveLatestMonthlyCycleFromDisk,
  type ResolveLatestMonthlyCycleResult,
} from "./lib/mensal/monthly-paths.ts";
import { datePartsInTz, toAammdd, BRT_TIMEZONE, type DateParts } from "./lib/next-edition-date.ts";
import { registerReport } from "./studio-ui/studio-reports.ts";
import { waveKey, scheduledAtForDate, type WaveProposal, type WaveState } from "./lib/clarice-wave-plan.ts";
import { proposeNextVolume, brtDayKey, type NextVolumeDecision } from "./lib/clarice-envio-policy.ts";
import type { RiskSnapshot } from "./clarice-envio-risk.ts";
import type { InvocationSummary } from "./clarice-schedule-group.ts";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

// ---------------------------------------------------------------------------
// Spawn de sub-script — mesmo padrão de clarice-novos-run.ts.
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

export class EnvioAbort extends Error {
  readonly code = 1 as const;
  constructor(reason: string) {
    super(reason);
    this.name = "EnvioAbort";
  }
}

// ---------------------------------------------------------------------------
// Datas — hoje/amanhã em BRT.
// ---------------------------------------------------------------------------

function todayPartsBrt(now: Date): DateParts {
  return datePartsInTz(now, BRT_TIMEZONE);
}

function todayAammdd(now: Date): string {
  return toAammdd(todayPartsBrt(now));
}

/** Data de ENVIO da onda desta rodada — sempre hoje+1 em BRT, YYYY-MM-DD. Nunca inferida de outra forma (princípio invariável do CLAUDE.md, superado aqui só pra ESTA automação por decisão explícita do editor 260811). */
export function sendDateBrt(now: Date): string {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const p = datePartsInTz(tomorrow, BRT_TIMEZONE);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Deps injetáveis.
// ---------------------------------------------------------------------------

export interface EnvioRunDeps {
  rootDir: string;
  now: () => Date;
  exec: ExecFn;
  isEnabled: () => boolean;
  execMode: () => "local" | "cloud";
  resolveLatestCycle: () => ResolveLatestMonthlyCycleResult;
}

export function productionDeps(rootDir: string = ROOT): EnvioRunDeps {
  return {
    rootDir,
    now: () => new Date(),
    exec: realExec(rootDir),
    isEnabled: () => isClariceEnvioEnabled(rootDir),
    execMode: () => detectExecMode({ projectRoot: rootDir }),
    resolveLatestCycle: () => resolveLatestMonthlyCycleFromDisk(),
  };
}

// ---------------------------------------------------------------------------
// Relatório.
// ---------------------------------------------------------------------------

export interface EnvioRunResult {
  code: 0 | 1 | 2;
  reportId: string;
  reportMarkdown: string;
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

function writeAndRegisterReport(deps: EnvioRunDeps, reportId: string, title: string, markdown: string): void {
  const dir = resolve(deps.rootDir, "data", "clarice-subscribers", "envio-reports");
  mkdirSync(dir, { recursive: true });
  const relPath = `data/clarice-subscribers/envio-reports/${reportId}.md`;
  writeFileSync(resolve(deps.rootDir, relPath), markdown, "utf8");
  const result = registerReport(deps.rootDir, { kind: "clarice-envio", sessionId: reportId, title, htmlPath: relPath });
  if (!result.ok) {
    console.error(`[clarice-envio-run] aviso: registro do relatório falhou (fail-soft, #3714): ${result.error}`);
  }
}

// ---------------------------------------------------------------------------
// Passo runner.
// ---------------------------------------------------------------------------

function step<T = unknown>(
  deps: EnvioRunDeps,
  report: ReportBuilder,
  label: string,
  scriptRelPath: string,
  args: string[],
  okCodes: number[] = [0],
): { result: StepResult; json: T | undefined } {
  report.note(`▶ ${label}`);
  const result = deps.exec(scriptRelPath, args);
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (!okCodes.includes(result.code)) {
    const detail = result.stderr.trim().split("\n").slice(-6).join(" | ") || "(sem stderr)";
    throw new EnvioAbort(`❌ ${label} falhou (exit ${result.code}): ${detail}`);
  }
  return { result, json: parseStepJson<T>(result.stdout) };
}

// ---------------------------------------------------------------------------
// Herança de assunto — decisão do editor 260811 (nunca digitado).
// ---------------------------------------------------------------------------

interface ParsedWaveKey {
  n: number;
  cell: "A" | "B" | "C" | null;
}

/** `waveKey()` de clarice-wave-plan.ts é `d{n}-{3 letras}{dd}(-{cell})?` — parse inverso pra extrair `n`/célula sem reimplementar a geração. */
function parseWave(key: string): ParsedWaveKey | null {
  const m = /^d(\d+)-[a-z]{3}\d{2}(?:-([ABC]))?$/.exec(key);
  if (!m) return null;
  return { n: Number(m[1]), cell: (m[2] as "A" | "B" | "C" | undefined) ?? null };
}

// União discriminada por `mode` (achado do type-design-analyzer no review da
// PR): a versão anterior tinha `single`/`byCell` como opcionais INDEPENDENTES
// dentro do mesmo `ok:true` — permitia estados impossíveis (`{ok:true}` vazio,
// os dois presentes ao mesmo tempo) e obrigava o call site a usar `!` (non-null
// assertion) reconstruindo a correlação certa/errada a partir de `abcAction`
// em vez de deixar o PRÓPRIO tipo garantir isso. Com `mode`, o call site troca
// os dois `!` por um `switch`/ternário exaustivo sobre `inherited.mode`.
export type InheritedSubjects =
  | { ok: true; mode: "single"; subject: string }
  | { ok: true; mode: "byCell"; subjects: Record<"A" | "B" | "C", string> }
  | { ok: false; reason: string };

/**
 * Herda o(s) assunto(s) da onda MAIS RECENTE do mesmo ciclo — nunca digitado
 * (achado do review da #5025: SKILL.md afirmava que `renderWaveProposal`
 * mostra "todo valor que vira escrita na Brevo", mas o assunto nunca
 * aparecia ali; aqui ele tem fonte determinística única).
 *
 * `travar` — pega o assunto da onda SEM célula (key sem sufixo -A/-B/-C) de
 * maior `n`. Se não houver NENHUMA onda sem célula ainda (ver `winner`
 * abaixo), cai pro assunto da CÉLULA VENCEDORA. `continuar` — pega, POR
 * CÉLULA, a onda com aquela célula de maior `n`; se QUALQUER célula não
 * tiver precedente, falha (não inventa).
 *
 * `winner` — achado HIGH do code-reviewer no review da PR: sem este
 * fallback, a automação TRAVA PRA SEMPRE no exato momento em que um teste
 * A/B/C conclui. A 1ª vez que `recommendAbcAction` devolve `"travar"`,
 * `state.waves` só tem entradas `-A/-B/-C` (o não-célula que este ramo
 * procura só existe DEPOIS de uma rodada `travar` bem-sucedida) — sem
 * `--locked-subject` sendo repassado pra `clarice-plan-wave.ts` (não é,
 * de propósito, pra não travar o teste artificialmente), o dia seguinte
 * recalcularia o MESMO `travar` e falharia da MESMA forma outra vez: um
 * deadlock de bootstrap, não um erro de 1 dia. `winner` (`proposal.abc.
 * winner`) é um precedente REAL e testado — a célula que já provou ser a
 * vencedora — então usar o assunto dela pra "destravar" o teste é
 * consistente com a decisão #4657 (o cálculo já é determinístico; só a
 * ESCRITA de um assunto NOVO exige o editor).
 */
export function resolveInheritedSubjects(
  waves: ReadonlyArray<Pick<WaveState, "key" | "subject">>,
  abcAction: "continuar" | "travar",
  winner: "A" | "B" | "C" | null = null,
): InheritedSubjects {
  if (abcAction === "travar") {
    let best: { n: number; subject: string } | null = null;
    for (const w of waves) {
      const parsed = parseWave(w.key);
      if (!parsed || parsed.cell !== null || !w.subject) continue;
      if (!best || parsed.n > best.n) best = { n: parsed.n, subject: w.subject };
    }
    if (best) return { ok: true, mode: "single", subject: best.subject };

    if (winner) {
      let bestCell: { n: number; subject: string } | null = null;
      for (const w of waves) {
        const parsed = parseWave(w.key);
        if (!parsed || parsed.cell !== winner || !w.subject) continue;
        if (!bestCell || parsed.n > bestCell.n) bestCell = { n: parsed.n, subject: w.subject };
      }
      if (bestCell) return { ok: true, mode: "single", subject: bestCell.subject };
    }

    return {
      ok: false,
      reason:
        `travar: nenhuma onda anterior SEM célula, nem da célula vencedora ` +
        `(${winner ?? "desconhecida"}), encontrada neste ciclo pra herdar assunto.`,
    };
  }

  const bestByCell: Record<"A" | "B" | "C", { n: number; subject: string } | null> = { A: null, B: null, C: null };
  for (const w of waves) {
    const parsed = parseWave(w.key);
    if (!parsed || !parsed.cell || !w.subject) continue;
    const cur = bestByCell[parsed.cell];
    if (!cur || parsed.n > cur.n) bestByCell[parsed.cell] = { n: parsed.n, subject: w.subject };
  }
  const missing = (["A", "B", "C"] as const).filter((c) => !bestByCell[c]);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `continuar: sem assunto herdável pra célula(s) ${missing.join(", ")} neste ciclo — 1ª onda de um teste A/B/C precisa do editor (abc.action="iniciar", fora do escopo desta automação).`,
    };
  }
  return {
    ok: true,
    mode: "byCell",
    subjects: { A: bestByCell.A!.subject, B: bestByCell.B!.subject, C: bestByCell.C!.subject },
  };
}

// ---------------------------------------------------------------------------
// Guard de onda perdida (#4975) — a onda de HOJE deveria ter disparado?
// ---------------------------------------------------------------------------

export interface MissedWave {
  key: string;
  status: string;
  scheduledAt: string;
}

/**
 * `state.waves` reflete o CICLO INTEIRO (não filtrado por `--dates`) — uma
 * única chamada a `clarice-plan-wave.ts` já basta pra checar o passado E
 * planejar o futuro. Onda "perdida" = `scheduledAt` cai no dia-calendário
 * BRT de HOJE, esse instante já passou, e `status !== "sent"` — mesma
 * classe de sinal que o #4975 pedia e não existia (a d11-ter11 daquele
 * incidente acabou sendo cancelamento deliberado, não bug; mas o guard
 * continua fazendo falta pro PRÓXIMO caso que não seja).
 */
export function detectMissedWaveToday(
  waves: ReadonlyArray<Pick<WaveState, "key" | "status" | "scheduledAt">>,
  now: Date,
): MissedWave | null {
  const todayKey = brtDayKey(now.toISOString());
  for (const w of waves) {
    if (!w.scheduledAt) continue;
    const day = brtDayKey(w.scheduledAt);
    if (day !== todayKey) continue;
    const schedMs = Date.parse(w.scheduledAt);
    if (Number.isFinite(schedMs) && schedMs < now.getTime() && w.status !== "sent") {
      return { key: w.key, status: w.status, scheduledAt: w.scheduledAt };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orquestração principal.
// ---------------------------------------------------------------------------

export async function runEnvio(deps: EnvioRunDeps): Promise<EnvioRunResult> {
  const now = deps.now();
  const aammdd = todayAammdd(now);
  const report = new ReportBuilder(`diar.ia.br Clarice envio ${aammdd}`);
  let lockPath: string | null = null;

  // --- Kill switch — ANTES de qualquer chamada externa. ---
  if (!deps.isEnabled()) {
    report.note(
      "⏸️  automação PAUSADA (data/clarice-envio-enabled.json = {enabled:false}) — nenhuma chamada Brevo feita. " +
        "Rode `npx tsx scripts/lib/clarice-envio-enabled.ts --set enabled` pra religar.",
    );
    const reportId = `envio-${aammdd}-paused`;
    writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio ${aammdd} — pausado`, report.build());
    return { code: 0, reportId, reportMarkdown: report.build() };
  }

  try {
    report.section("Passo 0 — Preflight");
    if (deps.execMode() !== "local") {
      throw new EnvioAbort("❌ exec-mode != local — esta rotina precisa do junction data/ (Brevo/MV reais). Não roda em sessão cloud.");
    }
    if (!process.env.BREVO_CLARICE_API_KEY) {
      throw new EnvioAbort("❌ BREVO_CLARICE_API_KEY não definida.");
    }
    const hasMv = !!process.env.MILLION_VERIFIER_API_KEY;
    if (!hasMv) {
      report.note("⚠️  MILLION_VERIFIER_API_KEY ausente — MV sob demanda desabilitado nesta rodada (a onda usa só a fila já verificada).");
    }

    const stale = step(deps, report, "clarice-check-derived-stale", "scripts/clarice-check-derived-stale.ts", []);
    if (String(stale.result.stdout).trim() === "stale") {
      report.note("↻ store derivado stale — reingerindo (clarice-build-db.ts) antes de planejar.");
      step(deps, report, "clarice-build-db (pré-stale)", "scripts/clarice-build-db.ts", []);
    }

    // --- Ciclo: calendário vs pronto (nunca cair de volta pra um ciclo antigo em silêncio). ---
    const expectedCycle = computeExpectedEnvioCycle(now);
    const readiness = deps.resolveLatestCycle();
    if (!readiness.cycle || readiness.cycle !== expectedCycle) {
      report.note(
        `ciclo esperado pelo calendário: ${expectedCycle}. Ciclo PRONTO mais recente encontrado: ${readiness.cycle ?? "nenhum"}.` +
          (readiness.cycle
            ? " Divergem — a edição do ciclo esperado provavelmente ainda não passou pela revisão do /diaria-mensal (Etapa 4)."
            : " Nenhum ciclo com preview+gabarito É IA?+assunto pronto foi encontrado."),
      );
      report.note("decisão do editor (260811): PARAR na virada do ciclo, nunca continuar distribuindo o ciclo antigo indefinidamente.");
      const reportId = `envio-${aammdd}-sem-ciclo-elegivel`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio ${aammdd} — ciclo ${expectedCycle} ainda não pronto`, report.build());
      return { code: 0, reportId, reportMarkdown: report.build() };
    }
    const cycle = readiness.cycle;
    report.note(`ciclo: ${cycle} (calendário e conteúdo pronto batem).`);

    if (!existsSync(resolve(deps.rootDir, "data", "monthly", cycle, "_internal", ".step-4-done.json"))) {
      // Redundante com `readiness` na prática (hasPreviewWithUnsubscribe já
      // exige o HTML final, que só existe pós-Etapa-4) — mantido como
      // segunda checagem EXPLÍCITA porque é o marker literal que o Passo 0
      // do SKILL.md manual sempre checou, e falhar aqui por um jeito
      // diferente do esperado é preferível a confiar só na inferência.
      throw new EnvioAbort(`❌ data/monthly/${cycle}/_internal/.step-4-done.json ausente — Etapa 4 (revisão) do /diaria-mensal não concluída.`);
    }

    // --- Trava de concorrência — todo o resto da rodada roda com o lock preso. ---
    lockPath = acquireEnvioLock(deps.rootDir, cycle, `envio-run-${aammdd}`, now);
    report.note(`lock adquirido: ${lockPath}`);

    // --- Passo 1: planejamento (1 única chamada cobre passado + futuro). ---
    report.section("Passo 1 — Levantar o estado + propor a onda de amanhã");
    const sendDate = sendDateBrt(now);
    report.note(`data de envio desta rodada: ${sendDate} (06:00 BRT / 09:00 UTC amanhã).`);

    const planStep = step<WaveProposal>(
      deps,
      report,
      "clarice-plan-wave",
      "scripts/clarice-plan-wave.ts",
      ["--cycle", cycle, "--dates", sendDate, "--json"],
      [0, 2], // 2 = blockers presentes, ainda assim JSON válido — tratamos os blockers abaixo, não aqui.
    );
    let proposal = planStep.json;
    if (!proposal) throw new EnvioAbort("❌ clarice-plan-wave não devolveu JSON parseável.");

    if (proposal.staleNote) {
      report.note(`⚠️  dashboard serviu cache stale: ${proposal.staleNote} — decisões desta rodada podem estar levemente desatualizadas.`);
    }

    // --- Guard de onda perdida (#4975) ---
    const missed = detectMissedWaveToday(proposal.state.waves, now);
    if (missed) {
      report.note(
        `⚠️  ONDA PERDIDA: "${missed.key}" estava agendada pra ${missed.scheduledAt} mas status="${missed.status}" (esperado "sent"). ` +
          "Não escalando volume nesta rodada até isso ser investigado — planejamento de amanhã segue, sem crescer.",
      );
    }

    // --- Blockers estruturais que NÃO dependem do semáforo antigo (aquele foi substituído). ---
    if (proposal.committedLookupFailed) {
      throw new EnvioAbort("❌ consulta de campanhas comprometidas (queued/sent) na Brevo falhou — nunca planejar sobre fila superestimada.");
    }
    if (proposal.novosFreshness.status === "never-run") {
      throw new EnvioAbort("❌ /diaria-clarice-novos nunca rodou neste ciclo — cadastro novo perderia prioridade em silêncio.");
    }
    if (proposal.novosFreshness.status === "blocker") {
      throw new EnvioAbort(`❌ /diaria-clarice-novos rodou há mais de 48h (${proposal.novosFreshness.ageHours?.toFixed(1)}h) — rode-o antes.`);
    }
    if (proposal.novosFreshness.status === "warning") {
      report.note(`⚠️  /diaria-clarice-novos rodou há ${proposal.novosFreshness.ageHours?.toFixed(1)}h (entre 12h e 48h) — seguindo, mas registrado.`);
    }
    if (proposal.brevoCredits === null) {
      throw new EnvioAbort("❌ crédito Brevo não consultado (BREVO_CLARICE_API_KEY ausente ou falha) — nunca agendar sem validar antes.");
    }

    // --- Teste A/B/C — decide sozinha continuar/travar; iniciar exige o editor. ---
    report.section("Passo 2 — Teste A/B/C");
    report.note(`recomendação: ${proposal.abc.action} (métrica: ${proposal.abc.metric}). ${proposal.abc.rationale}`);
    if (proposal.abc.action === "iniciar") {
      report.note("abc.action=\"iniciar\" exige 3 assuntos novos que só o editor escreve — automação não decide sozinha (#4657/decisão 260811). Pausando.");
      const reportId = `envio-${aammdd}-abc-iniciar`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio ${aammdd} — teste A/B/C precisa do editor`, report.build());
      return { code: 0, reportId, reportMarkdown: report.build() };
    }
    const abcAction = proposal.abc.action; // "continuar" | "travar"
    let noEscalationReason: string | null = null;
    if (proposal.abc.caveats.length > 0) {
      noEscalationReason = `ressalvas no teste A/B/C: ${proposal.abc.caveats.join("; ")}`;
      report.note(`⚠️  ${noEscalationReason} — não escalando volume hoje (mantém a base), sem abortar.`);
    }

    // --- Assunto(s) herdado(s). ---
    const inherited = resolveInheritedSubjects(proposal.state.waves, abcAction, proposal.abc.winner);
    if (!inherited.ok) throw new EnvioAbort(`❌ ${inherited.reason}`);

    // --- Passo 3: risco de ISP (motor novo — abertura NUNCA freia, #5025). ---
    report.section("Passo 3 — Risco de ISP (freio + acelerador)");
    const riskStep = step<RiskSnapshot>(deps, report, "clarice-envio-risk", "scripts/clarice-envio-risk.ts", []);
    const risk = riskStep.json;
    if (!risk) throw new EnvioAbort("❌ clarice-envio-risk não devolveu JSON parseável.");
    report.note(`freio: ${risk.brake.level.toUpperCase()} — ${risk.brake.reasons.join(" ")}`);
    report.note(
      `tendência de abertura (60d, só observação, NUNCA freia): ${risk.openTrend.verdict} ` +
        `(${risk.openTrend.previous.toFixed(1)}% → ${risk.openTrend.current.toFixed(1)}%, ${risk.openTrend.sampleDays} dias de amostra).`,
    );
    if (risk.staleNote) report.note(`⚠️  ${risk.staleNote}`);

    const effectiveStep = missed || noEscalationReason ? 0 : risk.step;
    if (missed && risk.step > 0) report.note(`passo adaptativo calculado seria +${(risk.step * 100).toFixed(1)}%, zerado por onda perdida (ver acima).`);
    else if (noEscalationReason && risk.step > 0) report.note(`passo adaptativo calculado seria +${(risk.step * 100).toFixed(1)}%, zerado por ${noEscalationReason}.`);

    // --- Passo 4: fila de 1º envio — MV sob demanda se insuficiente, senão PARA (decisão do editor). ---
    report.section("Passo 4 — Fila de 1º envio");
    const probe = proposeNextVolume({
      baseVolume: proposal.volumes.baseVolume,
      step: effectiveStep,
      brake: risk.brake.level,
      queueAvailable: Number.MAX_SAFE_INTEGER,
      creditAvailable: null,
    });
    report.note(`volume desejado antes de considerar fila/crédito: ${probe.volume} (${probe.note})`);

    let queueAvailable = proposal.availableFirstSend;
    if (queueAvailable < probe.volume && proposal.mvOnDemandPlan.byCohort.length > 0) {
      if (!hasMv) {
        report.note(
          `⚠️  fila (${queueAvailable}) menor que o desejado (${probe.volume}) e há backlog MV disponível, mas MILLION_VERIFIER_API_KEY está ausente — não é possível verificar nesta rodada.`,
        );
      } else {
        report.note(`fila (${queueAvailable}) menor que o desejado (${probe.volume}) — rodando MV sob demanda (déficit: ${proposal.mvOnDemandPlan.deficit}, custo estimado US$${proposal.mvOnDemandPlan.estimatedCostUsd.toFixed(2)}).`);
        step(deps, report, "clarice-mv-ondemand", "scripts/clarice-mv-ondemand.ts", ["--cycle", cycle, "--dates", sendDate]);
        step(deps, report, "clarice-build-db (pós-MV)", "scripts/clarice-build-db.ts", []);
        const replan = step<WaveProposal>(
          deps,
          report,
          "clarice-plan-wave (pós-MV)",
          "scripts/clarice-plan-wave.ts",
          ["--cycle", cycle, "--dates", sendDate, "--json"],
          [0, 2],
        );
        if (replan.json) {
          queueAvailable = replan.json.availableFirstSend;
          proposal = replan.json;
          report.note(`fila após MV sob demanda: ${queueAvailable}.`);
          // Achado do code-reviewer no review da PR: os guards estruturais
          // do Passo 1 (crédito/committed-lookup/novosFreshness) só eram
          // checados na 1ª chamada — `proposal` é REASSIGNADO aqui pro
          // resultado da 2ª, e `creditAvailable:null` é fail-OPEN por
          // desenho (proposeNextVolume trata "não consultado" como "não
          // limita"). Sem revalidar, uma falha transitória de crédito
          // bem depois do MV+build-db (rate-limit da Brevo é documentado
          // como frequente neste projeto) viraria "sem limite" em vez de
          // abortar — o oposto do que o guard original garante.
          if (proposal.committedLookupFailed) {
            throw new EnvioAbort("❌ (pós-MV) consulta de campanhas comprometidas na Brevo falhou — nunca planejar sobre fila superestimada.");
          }
          if (proposal.novosFreshness.status === "never-run") {
            throw new EnvioAbort("❌ (pós-MV) /diaria-clarice-novos nunca rodou neste ciclo.");
          }
          if (proposal.novosFreshness.status === "blocker") {
            throw new EnvioAbort(`❌ (pós-MV) /diaria-clarice-novos rodou há mais de 48h (${proposal.novosFreshness.ageHours?.toFixed(1)}h).`);
          }
          if (proposal.brevoCredits === null) {
            throw new EnvioAbort("❌ (pós-MV) crédito Brevo não consultado — nunca agendar sem validar antes.");
          }
        } else {
          // Achado HIGH do silent-failure-hunter: a versão anterior não
          // fazia NADA aqui — seguia com a fila PRÉ-MV em silêncio, mesmo
          // já tendo gasto crédito real de MillionVerifier na verificação
          // que acabou de rodar. Reportar é o mínimo; nunca fingir que o
          // replan aconteceu quando o JSON veio vazio/malformado.
          report.note(
            "⚠️  replan pós-MV não devolveu JSON parseável — seguindo com a fila PRÉ-MV " +
              "(a verificação MillionVerifier já gastou crédito real nesta rodada e pode ter sido desperdiçada; o volume final abaixo NÃO reflete o resultado do MV).",
          );
        }
      }
    }

    if (queueAvailable < probe.volume) {
      report.note(
        `fila de 1º envio insuficiente mesmo após MV sob demanda (disponível: ${queueAvailable}, desejado: ${probe.volume}) — ` +
          "decisão do editor (260811): PARAR esta rodada (nunca trocar de público sozinha, nunca enviar volume menor que o proposto sem avisar antes).",
      );
      lockPath && releaseEnvioLock(lockPath);
      lockPath = null;
      const reportId = `envio-${aammdd}-fila-insuficiente`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio ${aammdd} — fila insuficiente`, report.build());
      return { code: 0, reportId, reportMarkdown: report.build() };
    }

    // --- Passo 5: volume final. ---
    const decision: NextVolumeDecision = proposeNextVolume({
      baseVolume: proposal.volumes.baseVolume,
      step: effectiveStep,
      brake: risk.brake.level,
      queueAvailable,
      creditAvailable: proposal.brevoCredits,
    });
    report.note(`volume final: ${decision.volume} (cappedBy: ${decision.cappedBy ?? "n/a"}) — ${decision.note}`);

    if (decision.volume <= 0) {
      report.note("volume final é 0 — nada a agendar nesta rodada.");
      lockPath && releaseEnvioLock(lockPath);
      lockPath = null;
      const reasonSlug = risk.brake.level === "stop" ? "freio-stop" : "sem-volume";
      const reportId = `envio-${aammdd}-${reasonSlug}`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio ${aammdd} — sem volume (${risk.brake.level})`, report.build());
      return { code: 0, reportId, reportMarkdown: report.build() };
    }

    // --- Passo 6: segmentar + dividir em células + importar. ---
    report.section("Passo 6 — Montar a onda");
    const n = proposal.startingWaveNumber;
    const waveKeyBase = waveKey(n, sendDate);
    report.note(`onda d${n} · ${sendDate} · chave base "${waveKeyBase}" · teste A/B/C: ${abcAction}.`);

    step(deps, report, "clarice-build-segment", "scripts/clarice-build-segment.ts", [
      "--group", "ramp-warm", "--cycle", cycle, "--budget", String(decision.volume),
    ]);

    const splitArgs = ["--cycle", cycle, "--wave", String(n), "--date", sendDate, "--from", "segments/ramp-warm.csv"];
    if (abcAction === "travar") splitArgs.push("--no-cells");
    step(deps, report, "clarice-split-group-cells", "scripts/clarice-split-group-cells.ts", splitArgs);

    const label = `${cycle} ${waveKeyBase}`;
    step(deps, report, "clarice-import-waves", "scripts/clarice-import-waves.ts", [
      "--cycle", cycle, "--group", waveKeyBase, "--label", label, "--execute",
    ]);

    // --- Passo 7: criar + agendar cada célula (ou a onda única). ---
    report.section("Passo 7 — Criar e agendar");
    const scheduledAt = scheduledAtForDate(sendDate);
    // Narrado por `inherited.mode` (não mais por `abcAction`) — achado do
    // type-design-analyzer: o tipo discriminado elimina os `!` non-null
    // assertions que existiam aqui antes.
    const cells: Array<{ key: string; cell: "A" | "B" | "C" | null; subject: string }> =
      inherited.mode === "single"
        ? [{ key: waveKeyBase, cell: null, subject: inherited.subject }]
        : (["A", "B", "C"] as const).map((c) => ({ key: `${waveKeyBase}-${c}`, cell: c, subject: inherited.subjects[c] }));

    let anyUncertain = false;
    let scheduledCount = 0;
    const summaries: InvocationSummary[] = [];
    try {
      for (const { key, cell, subject } of cells) {
        const keyArgs = cell ? ["--key", key] : [];
        step<InvocationSummary>(deps, report, `clarice-schedule-group --create (${key})`, "scripts/clarice-schedule-group.ts", [
          "--cycle", cycle, "--group", waveKeyBase, ...keyArgs, "--subject", subject, "--schedule-at", scheduledAt, "--create",
        ]);

        const scheduleResult = deps.exec("scripts/clarice-schedule-group.ts", [
          "--cycle", cycle, "--group", waveKeyBase, ...keyArgs, "--schedule",
        ]);
        if (scheduleResult.stderr.trim()) console.error(scheduleResult.stderr.trim());
        const scheduleJson = parseStepJson<InvocationSummary>(scheduleResult.stdout);
        if (scheduleResult.code === 2) {
          anyUncertain = true;
          report.note(`⚠️  "${key}": agendamento INCERTO — POST aceito mas GET-verify não confirmou (status="${scheduleJson?.status ?? "?"}"). Reconciliável amanhã.`);
        } else if (scheduleResult.code !== 0) {
          throw new EnvioAbort(`❌ clarice-schedule-group --schedule ("${key}") falhou (exit ${scheduleResult.code}): ${scheduleResult.stderr.trim().split("\n").slice(-6).join(" | ")}`);
        } else {
          report.note(`✅ "${key}" agendada pra ${scheduledAt} (status="${scheduleJson?.status ?? "?"}").`);
        }
        if (scheduleJson) summaries.push(scheduleJson);
        scheduledCount++;
      }
    } catch (cellError) {
      // Achado MEDIUM do code-reviewer: com >1 célula (continuar), uma
      // falha na célula B depois da A já ter sido criada+agendada com
      // sucesso deixava a onda num estado MISTO (A é campanha real na
      // Brevo, vai disparar amanhã) sem NENHUM sinal disso no relatório —
      // "abortado" parecia "nada foi escrito", quando na verdade ~1/3 do
      // volume já estava. Torna isso explícito antes de propagar o erro
      // pro catch externo (que ainda reporta "abortado" — code 1 continua
      // certo, só o CONTEÚDO do relatório passa a não esconder o estado
      // parcial).
      if (scheduledCount > 0) {
        const done = cells.slice(0, scheduledCount).map((c) => c.key);
        const pendingCells = cells.slice(scheduledCount).map((c) => c.key);
        report.note(
          `⚠️  ONDA PARCIALMENTE MONTADA: ${scheduledCount} de ${cells.length} célula(s) já confirmada(s) ANTES ` +
            `deste erro — ${done.join(", ")} já são campanhas REAIS na Brevo e vão disparar amanhã às 06:00 do ` +
            `jeito que estão. NÃO reiniciar do zero na próxima rodada — as células restantes (${pendingCells.join(", ")}) ` +
            "precisam ser reconciliadas manualmente ou na próxima invocação (clarice-import-waves/clarice-schedule-group são idempotentes por key).",
        );
      }
      throw cellError;
    }

    const reportId = `envio-${aammdd}`;
    writeAndRegisterReport(
      deps,
      reportId,
      `diar.ia.br Clarice envio ${aammdd} — ${decision.volume} e-mail(s), ${cells.length} célula(s)`,
      report.build(),
    );
    return { code: anyUncertain ? 2 : 0, reportId, reportMarkdown: report.build() };
  } catch (e) {
    if (e instanceof LockHeldError) {
      report.note(e.message);
      const reportId = `envio-${aammdd}-lock-held`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio ${aammdd} — rodada concorrente em curso`, report.build());
      return { code: 1, reportId, reportMarkdown: report.build() };
    }
    const abort = e instanceof EnvioAbort ? e : new EnvioAbort(`❌ erro inesperado: ${(e as Error).message}`);
    report.note(abort.message);
    const reportId = `envio-${aammdd}-abort`;
    writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio ${aammdd} — abortado`, report.build());
    return { code: abort.code, reportId, reportMarkdown: report.build() };
  } finally {
    if (lockPath) releaseEnvioLock(lockPath);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const deps = productionDeps(ROOT);
  runEnvio(deps)
    .then((r) => {
      // process.exitCode (não process.exit()) — deixa o event loop drenar o
      // fetch fire-and-forget do e-mail de notificação (mesmo guard #4653
      // de clarice-novos-run.ts).
      process.exitCode = r.code;
    })
    .catch((e) => {
      console.error(String((e as Error)?.stack || e));
      process.exitCode = 1;
    });
}
