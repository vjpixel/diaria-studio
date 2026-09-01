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
 *     editor 260811. **#5055:** quando o editor ENCERROU o teste
 *     (`data/clarice-abc-state.json`), esse cálculo nem corre — o estado
 *     gravado força `travar` e o teste NUNCA reabre por recálculo.
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
 *   - Guard de onda JÁ EXISTENTE pra `sendDate` (`detectExistingWaveForSendDate`,
 *     #5058) — o oposto do guard acima: se JÁ existe onda pra AMANHÃ (retry
 *     manual + task agendada, ou 2 disparos concorrentes), a rodada PARA
 *     (code 0) em vez de montar uma 2ª onda — o dedup por contato não evita
 *     que o VOLUME do dia dobre.
 *   - Retry com backoff pra falha TRANSITÓRIA de `clarice-plan-wave.ts`
 *     (`stepWithTransientRetry`, #5058) — 429/503 do dashboard (rate limit da
 *     Brevo) não é erro de lógica; a rodada espera (honrando `retryAfterSecs`
 *     quando a Brevo informou) e repete até 3× antes de desistir, em vez de
 *     abortar na 1ª falha (achado ao vivo 260811: a onda de 12/08 só existiu
 *     porque um humano montou à mão).
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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { detectExecMode } from "./lib/exec-mode.ts";
import { isClariceEnvioEnabled } from "./lib/clarice-envio-enabled.ts";
import {
  readClariceAbcState,
  lockedSubjectFromState,
  describeAbcState,
  type ClariceAbcStateRead,
} from "./lib/clarice-abc-state.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { acquireEnvioLock, releaseEnvioLock, LockHeldError } from "./lib/clarice-envio-lock.ts";
import { computeExpectedEnvioCycle } from "./lib/clarice-envio-cycle.ts";
import {
  resolveLatestMonthlyCycleFromDisk,
  type ResolveLatestMonthlyCycleResult,
} from "./lib/mensal/monthly-paths.ts";
import { datePartsInTz, toAammdd, BRT_TIMEZONE, type DateParts } from "./lib/next-edition-date.ts";
import { registerReport } from "./studio-ui/studio-reports.ts";
import {
  brtHourToUtcHourSameDay,
  hourCellLabel,
  scheduledAtForDate,
  waveDateFragment,
  waveKey,
  type WaveCell,
  type WaveProposal,
  type WaveState,
} from "./lib/clarice-wave-plan.ts";
import { readClariceHourTestState } from "./lib/clarice-hour-test.ts";
import { stepWithTransientRetry as sharedStepWithTransientRetry } from "./lib/transient-step-retry.ts";
import { writeLastBrakeSnapshot } from "./lib/clarice-envio-last-brake.ts";
import { proposeNextVolume, brtDayKey, type NextVolumeDecision } from "./lib/clarice-envio-policy.ts";
import type { RiskSnapshot } from "./clarice-envio-risk.ts";
import type { InvocationSummary } from "./clarice-schedule-group.ts";

// #5048 — mesmo achado do #4983 (script irmão clarice-novos-run.ts): este é o
// processo ORQUESTRADOR, invocado sob systemd --user (task Diaria-Clarice-Envio,
// 19:00 BRT), que não herda o `.env` do shell interativo. O preflight do Passo 0
// (abaixo) lê `process.env.BREVO_CLARICE_API_KEY` diretamente — sem esta chamada
// em module scope, ANTES de qualquer outro código, a 1ª execução real sob
// systemd falha com "BREVO_CLARICE_API_KEY não definida" mesmo com a key
// presente em `.env` (achado ao vivo 260811 22:00 UTC — a onda de amanhã não
// foi planejada). Ver test/clarice-envio-run.test.ts para o teste que trava
// essa ORDEM (não só o comportamento final), mesmo padrão do #4983.
loadProjectEnv();

// `new URL("..", import.meta.url).pathname` quebra no Windows (dobra a drive
// letter, ex: "C:\C:\Users\...") — ver nota em scripts/brevo-diaria-run.ts e
// test/root-path-windows.test.ts.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  /** #5055 — estado durável do teste A/B/C. Injetado (e não lido de
   * `rootDir` no meio da rodada) pelo mesmo motivo de `isEnabled`: sem o
   * seam, os testes de integração desta função leriam o `data/` REAL da
   * máquina e o assunto travado em produção vazaria pras asserções. */
  readAbcState: () => ClariceAbcStateRead;
  /** #5058 — sleep injetável (mesmo padrão de `_sleep` em brevo-client.ts).
   * Usado só pelo retry de falha TRANSITÓRIA de `clarice-plan-wave` — sem o
   * seam, os testes de retry esperariam de verdade (minutos). */
  sleep: (ms: number) => Promise<void>;
}

/**
 * #5985 — gate de volume no caminho MANUAL. Ambas as flags são opcionais e
 * só mexem em algo quando presentes — sem elas o comportamento é
 * BYTE-IDÊNTICO ao da task agendada `Diaria-Clarice-Envio` (nenhuma flag é
 * injetada automaticamente nesse caminho, ver docstring de topo).
 */
export interface EnvioRunOptions {
  /** `--plan-only` — para logo após calcular `probe.volume` (Passo 4),
   * ANTES do MV sob demanda (que gasta crédito real). Imprime a proposta,
   * libera o lock, não escreve nada, não agenda. */
  planOnly?: boolean;
  /** `--volume N` — substitui o volume que a política teria escolhido
   * sozinha (`probe.volume`) pelo número confirmado/ajustado pelo editor.
   * Os guards de fila/crédito/freio continuam rodando sobre N — nunca são
   * afrouxados; se N pedir mais do que algum teto permite, a rodada ABORTA
   * explicando qual teto foi violado, em vez de cortar em silêncio pra
   * caber (diferente da assimetria de crédito do Passo 5/#5042, que só
   * vale quando NINGUÉM confirmou um número explicitamente). */
  volume?: number;
}

/** #5985 — proposta calculada por `--plan-only`, devolvida em `EnvioRunResult.plan`
 * e impressa como JSON pelo entrypoint CLI. Reúne todo o contexto que torna
 * o volume proposto auditável ANTES de qualquer chamada que gaste crédito
 * (ver docstring de `EnvioRunOptions.planOnly`). */
export interface EnvioPlanProposal {
  cycle: string;
  sendDate: string;
  /** Volume que a política proposeria, SEM considerar fila/crédito (mesmo
   * `probe.volume` do Passo 4 — a proposta "de política pura"). */
  volume: number;
  baseVolume: number;
  step: number;
  note: string;
  brake: { level: RiskSnapshot["brake"]["level"]; reasons: string[] };
  overrideApplied: boolean;
  /** Fila de 1º envio ANTES de qualquer MV sob demanda (plan-only nunca roda MV). */
  queueAvailable: number;
  brevoCredits: number | null;
  mvOnDemand: { deficit: number; estimatedCostUsd: number; backlogAvailable: boolean };
  abcAction: "continuar" | "travar";
  subjects: InheritedSubjects;
}

export function productionDeps(rootDir: string = ROOT): EnvioRunDeps {
  return {
    rootDir,
    now: () => new Date(),
    exec: realExec(rootDir),
    isEnabled: () => isClariceEnvioEnabled(rootDir),
    execMode: () => detectExecMode({ projectRoot: rootDir }),
    resolveLatestCycle: () => resolveLatestMonthlyCycleFromDisk(),
    readAbcState: () => readClariceAbcState(rootDir),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };
}

// ---------------------------------------------------------------------------
// Relatório.
// ---------------------------------------------------------------------------

export interface EnvioRunResult {
  // #5826: 4 = lock de concorrência já estava travado (abort SEGURO, sem
  // tocar Brevo — nunca uma falha genuína). Distinto de 1 (EnvioAbort real)
  // de propósito: `Diaria-Clarice-Envio` (scheduled-tasks.ts) marca 4 em
  // `successExitCodes` pra `systemctl --user list-units --state=failed`
  // parar de acusar essa rodada como falha. 3 já está em uso por
  // `Diaria-Clarice-Novos`/`-Tarde` (disparo incerto, outro script) — 4 evita
  // colisão semântica mesmo não havendo colisão de fato (exit code é escopado
  // por task/unit systemd, nunca comparado entre scripts diferentes).
  code: 0 | 1 | 2 | 4;
  reportId: string;
  reportMarkdown: string;
  /** #5985 — presente só quando a rodada foi `--plan-only`. Sem escrita,
   * sem relatório registrado (`reportId`/`reportMarkdown` ficam vazios
   * nesse caso) — é o próprio JSON que o caminho manual apresenta. */
  plan?: EnvioPlanProposal;
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
// #5058 — retry com backoff pra falha TRANSITÓRIA de `clarice-plan-wave.ts`
// (429/503 do dashboard — exit code 3, ver TransientDashboardError nesse
// script). Achado ao vivo 260811: a task das 19:00 morreu na 1ª falha de
// rate limit (`retryAfterSecs: 258`, ~4min) sem nenhum mecanismo de retry —
// a onda do dia seguinte só existiu porque um humano montou à mão. 3
// tentativas totais (mesma convenção de `MAX_ATTEMPTS` em brevo-client.ts),
// honrando `retryAfterSecs` quando a Brevo informou; sem ele, um fallback
// conservador. Capped pra nunca pendurar a rodada indefinidamente numa
// leitura de header maliciosa/absurda.
// ---------------------------------------------------------------------------

const TRANSIENT_RETRY_MAX_ATTEMPTS = 3;
const TRANSIENT_RETRY_FALLBACK_MS = 60_000; // 1min — quando retryAfterSecs não veio
// 35min — cobre os 2 valores REAIS já observados (258s em 260811, e
// `retryAfterSecs: 1916` ≈32min no achado ao vivo de 05/08 documentado em
// .claude/skills/diaria-clarice-envio/SKILL.md) com folga, sem pendurar a
// rodada indefinidamente numa leitura de header absurda. A task roda às
// 19:00 com horas de sobra antes do envio das 06:00 — esperar até ~1h no
// pior caso (2 esperas de 35min pras 3 tentativas) não compete com nenhum
// prazo real.
const TRANSIENT_RETRY_CAP_MS = 35 * 60_000;

/**
 * Variante de `step()` que reconhece o exit code 3 (falha TRANSITÓRIA,
 * ver docstring acima) e retenta com backoff em vez de abortar a rodada na
 * 1ª falha. Qualquer outro código fora de `okCodes` continua abortando
 * imediatamente — mesma disciplina de `step()`, só o ramo 3 é novo.
 *
 * #5220 — molde extraído pra `lib/transient-step-retry.ts` pra reuso pelo
 * guard das 05:00 (`clarice-envio-guard.ts`), que precisa do MESMO
 * mecanismo com um orçamento de espera MENOR. Este wrapper preserva o
 * orçamento ORIGINAL (3 tentativas, fallback 1min, cap 35min) — nenhuma
 * mudança de orçamento aqui.
 *
 * #6288 — o motor compartilhado (`lib/transient-step-retry.ts`) passou a
 * desistir na hora quando `retryAfterSecs` excede o `capMs`, em vez de
 * dormir o teto e retentar sabendo que vai falhar de novo — mudança de
 * COMPORTAMENTO real, que este wrapper herda automaticamente por delegar
 * pro motor (ver ali pro racional completo).
 */
async function stepWithTransientRetry<T = unknown>(
  deps: EnvioRunDeps,
  report: ReportBuilder,
  label: string,
  scriptRelPath: string,
  args: string[],
  okCodes: number[] = [0],
): Promise<{ result: StepResult; json: T | undefined }> {
  return sharedStepWithTransientRetry<T>({
    exec: deps.exec,
    sleep: deps.sleep,
    note: (line) => report.note(line),
    parseJson: parseStepJson,
    label,
    scriptRelPath,
    args,
    okCodes,
    budget: {
      maxAttempts: TRANSIENT_RETRY_MAX_ATTEMPTS,
      fallbackMs: TRANSIENT_RETRY_FALLBACK_MS,
      capMs: TRANSIENT_RETRY_CAP_MS,
    },
    makeAbort: (message) => new EnvioAbort(message),
  });
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
 * `lockedSubject` (#5055) — quando o editor ENCERROU o teste
 * (`data/clarice-abc-state.json`), o assunto travado ali tem precedência
 * sobre qualquer herança: ele é a decisão explícita, e herdar seria
 * reconstruir por inferência algo que já está escrito. É também a única
 * escrita legítima de um assunto "digitado" no fluxo — feita 1× pelo editor,
 * num comando dedicado, não a cada rodada.
 *
 * `winner` — achado HIGH do code-reviewer no review da PR: sem este
 * fallback, a automação TRAVA PRA SEMPRE no exato momento em que um teste
 * A/B/C conclui POR CÁLCULO (sem estado gravado). A 1ª vez que
 * `recommendAbcAction` devolve `"travar"`, `state.waves` só tem entradas
 * `-A/-B/-C` (o não-célula que este ramo procura só existe DEPOIS de uma
 * rodada `travar` bem-sucedida), e o dia seguinte recalcularia o MESMO
 * `travar` e falharia da MESMA forma outra vez: um deadlock de bootstrap,
 * não um erro de 1 dia. `winner` (`proposal.abc.winner`) é um precedente
 * REAL e testado — a célula que já provou ser a vencedora — então usar o
 * assunto dela pra "destravar" o teste é consistente com a decisão #4657 (o
 * cálculo já é determinístico; só a ESCRITA de um assunto NOVO exige o
 * editor). Continua valendo pro caminho calculado; o `lockedSubject` acima
 * simplesmente torna o deadlock impossível quando há estado gravado.
 */
export interface InheritedSubjectsInput {
  waves: ReadonlyArray<Pick<WaveState, "key" | "subject">>;
  abcAction: "continuar" | "travar";
  /** Célula vencedora calculada, quando houver. Ver `winner` na docstring. */
  winner?: "A" | "B" | "C" | null;
  /** Assunto travado no estado durável (#5055). Ver acima. */
  lockedSubject?: string | null;
}

// Objeto de opções e não 4 posicionais (achado MEDIUM do type-design-analyzer
// no review da PR #5057): `winner` e `lockedSubject` são ambos
// nulláveis-e-parecidos, e `f(waves, "travar", "B", "Assunto...")` obrigava a
// consultar a assinatura pra saber qual é qual. É também a convenção local —
// `proposeNextVolume({...})` neste mesmo arquivo e `recommendAbcAction(t, {...})`
// no módulo vizinho já usam opções nomeadas.
export function resolveInheritedSubjects(input: InheritedSubjectsInput): InheritedSubjects {
  const { waves, abcAction, winner = null, lockedSubject = null } = input;

  if (abcAction === "travar") {
    if (lockedSubject) return { ok: true, mode: "single", subject: lockedSubject };

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
// Guard de onda JÁ EXISTENTE pra `sendDate` (#5058, nota relacionada) — o
// oposto de `detectMissedWaveToday`: aquele cobre HOJE (onda que deveria ter
// saído e não saiu); este cobre AMANHÃ (a data que ESTA rodada está prestes
// a planejar), pra nunca montar uma 2ª onda pro mesmo dia.
// ---------------------------------------------------------------------------

export interface ExistingWaveForSendDate {
  key: string;
  status: string;
  /** `null` pra onda em DRAFT (#5064) — casada só pelo fragmento de data da `key`. */
  scheduledAt: string | null;
}

/**
 * `clarice-envio-run.ts` não verificava se já existia onda agendada pra
 * `sendDate` antes de planejar a próxima — `detectMissedWaveToday` só olha o
 * dia de HOJE. Rodar o orquestrador 2× na mesma janela (retry manual + task
 * agendada, ou 2 disparos concorrentes do systemd) montaria uma SEGUNDA onda
 * pra mesma manhã: o dedup por contato (`sent-or-queued.json` + guard de
 * campanha comprometida) impede que alguém receba 2 e-mails, mas o VOLUME do
 * dia dobraria, porque `baseVolumeFromLastSendDay` deriva do último dia
 * ENVIADO e não enxerga a onda já enfileirada (ainda não propagada ao store
 * local) — um dia de 3.948 viraria ~8,5k, muito além do teto de +25%/dia do
 * motor do #5025.
 *
 * `status === "suspended"` é excluído — é o estado CANCELADO explícito
 * (freio STOP via `clarice-envio-guard.ts`), não uma onda viva competindo
 * pelo mesmo dia; qualquer outro status que `state.waves` de fato carrega
 * (`queued`, `sent`, `in_process`, ...) conta como "já existe" — melhor
 * parar e exigir reconciliação manual do que arriscar dobrar o volume.
 *
 * **Onda em DRAFT (#5064, fecha o limite conhecido do #5058).**
 * `/api/campaigns?includeScheduled=1` só devolve `sent`+`queued` (nunca
 * `draft` — ver `buildCampaignsResponse` no Worker), então uma onda
 * PARCIALMENTE montada onde só o `--create` rodou (campanha ainda "draft",
 * `--schedule` não chegou a rodar — ver "ONDA PARCIALMENTE MONTADA" no Passo
 * 7 abaixo) nunca tem `scheduledAt` (a Brevo só grava isso quando
 * `--schedule` faz o PUT) — ficaria invisível pro match por data acima.
 * `clarice-plan-wave.ts` fecha esse buraco buscando campanhas `draft` DIRETO
 * na Brevo (`fetchDraftCampaigns`, sem depender do dashboard) e fundindo com
 * sent/queued antes de `summarizeCycleSends`; aqui, uma onda sem
 * `scheduledAt` cai no fallback: casa pelo FRAGMENTO DE DATA embutido na
 * própria `key` (`d{N}-{dia}{DD}`, ver `waveDateFragment`) — a mesma parte
 * que `waveKey` grava na criação, independente de a campanha já ter sido
 * agendada. Restrito a `status === "draft"` de propósito (nunca um
 * fallback geral pra "sem scheduledAt") — `sent`/`queued` sempre têm
 * `scheduledAt` (ou `sentDate`, que `summarizeCycleSends` usa no lugar), só
 * uma campanha genuinamente nunca agendada nem enviada chega aqui sem data.
 */
export function detectExistingWaveForSendDate(
  waves: ReadonlyArray<Pick<WaveState, "key" | "status" | "scheduledAt">>,
  sendDate: string,
): ExistingWaveForSendDate[] {
  const matches: ExistingWaveForSendDate[] = [];
  const fragment = waveDateFragment(sendDate);
  const fragmentRe = new RegExp(`-${fragment}($|-)`);
  for (const w of waves) {
    if (w.status === "suspended") continue;
    if (w.scheduledAt) {
      if (brtDayKey(w.scheduledAt) === sendDate) {
        matches.push({ key: w.key, status: w.status, scheduledAt: w.scheduledAt });
      }
      continue;
    }
    // #5064 — sem scheduledAt: só cai no fallback por fragmento de data se
    // for genuinamente DRAFT (ver docstring acima pro porquê da restrição).
    if (w.status === "draft" && fragmentRe.test(w.key)) {
      matches.push({ key: w.key, status: w.status, scheduledAt: null });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Orquestração principal.
// ---------------------------------------------------------------------------

/**
 * #6133 — `opts.volume` chega cru da CLI e pode ser string VAZIA (flag
 * `--volume ""` ou env interpolada vazia). Passar `String("")` adiante como
 * `--target-volume` derruba `clarice-plan-wave` no receptor (valida inteiro
 * positivo) → o guard cai no fallback por precaução → tentativa de
 * cancelamento indevido das ondas (#6124). Normaliza AQUI, no emissor:
 * vazio/NaN/≤0/não-inteiro → `undefined` (não propaga o flag); inteiro
 * positivo válido → number.
 */
export function normalizeTargetVolume(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? raw : undefined;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "") return undefined;
    const n = Number(t);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

export async function runEnvio(deps: EnvioRunDeps, opts: EnvioRunOptions = {}): Promise<EnvioRunResult> {
  const requestedVolume = normalizeTargetVolume((opts as { volume?: unknown }).volume);
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

    // #5058 — retry com backoff em vez de `step()`: `clarice-plan-wave.ts`
    // sinaliza exit code 3 quando o dashboard falha por rate limit (429/503)
    // transitório, e esta variante espera + repete em vez de abortar a
    // rodada na 1ª falha (ver TRANSIENT_RETRY_* acima).
    // #6075 — `--target-volume` (quando `--volume N` foi passado) garante
    // que `mvOnDemandPlan` já saia dimensionado contra o volume que o editor
    // pediu, não só contra o que a política proporia sozinha — inclusive no
    // `--plan-only` (JSON que a skill mostra ANTES de rodar MV de verdade).
    const planWaveArgs = ["--cycle", cycle, "--dates", sendDate, "--json"];
    if (requestedVolume !== undefined) planWaveArgs.push("--target-volume", String(requestedVolume));
    const planStep = await stepWithTransientRetry<WaveProposal>(
      deps,
      report,
      "clarice-plan-wave",
      "scripts/clarice-plan-wave.ts",
      planWaveArgs,
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

    // --- Guard de onda JÁ EXISTENTE pra `sendDate` (#5058; drafts #5064) ---
    // `detectMissedWaveToday` só cobre HOJE (onda que deveria ter saído e não
    // saiu); este é o caso oposto — uma onda que JÁ existe (criada/agendada/
    // enviada) pra AMANHÃ, a data que esta MESMA rodada está prestes a
    // planejar. Sem isto, rodar o orquestrador 2× na mesma janela (retry
    // manual + task agendada, ou 2 disparos concorrentes) monta uma SEGUNDA
    // onda pro mesmo dia — o dedup por contato (`sent-or-queued.json`) evita
    // duplicidade de ENVIO, mas o VOLUME do dia dobraria, porque
    // `baseVolumeFromLastSendDay` deriva do último dia ENVIADO e não enxerga
    // a onda já enfileirada (ainda não propagada ao store local).
    const existingForSendDate = detectExistingWaveForSendDate(proposal.state.waves, sendDate);
    if (existingForSendDate.length > 0) {
      const anyDraft = existingForSendDate.some((w) => w.status === "draft");
      report.note(
        `⚠️  ONDA JÁ EXISTE pra ${sendDate}: ` +
          existingForSendDate.map((w) => `"${w.key}" (status="${w.status}")`).join(", ") +
          " — não vou montar uma 2ª onda pro mesmo dia (rodada concorrente/retry já cobriu esta data). Nada a fazer nesta rodada." +
          (anyDraft
            ? " (#5064: ao menos 1 onda em DRAFT — provável --create sem --schedule de uma rodada anterior; reconcilie manualmente: rode --schedule pra essa key ou cancele o draft antes da próxima janela.)"
            : ""),
      );

      // #5698 — o freio é lido e o snapshot gravado MESMO neste short-circuit
      // (ex: onda montada à mão pelo editor durante o dia). Sem isto,
      // `envio-{aammdd}-brake.json` nunca existe pra esta janela, e o
      // fallback do guard das 05:00 (`handlePrereqFailure`) trata "snapshot
      // ausente" como se fosse "freio NÃO-OK" — suspendendo a onda por
      // precaução mesmo quando o editor tinha um override válido em vigor
      // (override só rebaixa stop→hold, nunca produz "ok" — ver
      // `clarice-envio-override.ts`). Falha aqui NUNCA vira abort — este
      // ramo já é um caminho de sucesso (exit 0), e não gravar o snapshot é
      // preferível a transformar um "nada a fazer" em erro duro.
      const riskResult = deps.exec("scripts/clarice-envio-risk.ts", []);
      if (riskResult.stderr.trim()) console.error(riskResult.stderr.trim());
      const riskJson = riskResult.code === 0 ? parseStepJson<RiskSnapshot>(riskResult.stdout) : undefined;
      if (riskJson) {
        writeLastBrakeSnapshot(deps.rootDir, aammdd, riskJson.brake, now.toISOString());
        report.note(
          `freio lido mesmo com onda já existente (snapshot gravado): ${riskJson.brake.level.toUpperCase()} — ${riskJson.brake.reasons.join(" ")}`,
        );
      } else {
        report.note(
          `⚠️  clarice-envio-risk falhou/sem JSON parseável neste ramo (exit ${riskResult.code}) — snapshot de freio NÃO gravado; o guard das 05:00 tratará como AUSENTE se precisar do fallback.`,
        );
      }

      lockPath && releaseEnvioLock(lockPath);
      lockPath = null;
      const reportId = `envio-${aammdd}-onda-ja-existe`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio ${aammdd} — onda já existe pra ${sendDate}`, report.build());
      return { code: 0, reportId, reportMarkdown: report.build() };
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
    // #5055: o estado durável é lido AQUI só pra relatar e pra alimentar
    // `resolveInheritedSubjects`. Quem já o aplicou na RECOMENDAÇÃO foi o
    // `clarice-plan-wave.ts` acima (que lê o mesmo arquivo) — não há duas
    // fontes de verdade, há um arquivo e dois leitores.
    const abcState = deps.readAbcState();
    if (abcState.invalidReason) report.note(`⚠️  estado do teste A/B/C ilegível (${abcState.invalidReason}) — tratando como ABERTO.`);
    report.note(describeAbcState(abcState));
    if (abcState.rationale) report.note(`motivo registrado pelo editor: ${abcState.rationale}`);
    report.note(`recomendação: ${proposal.abc.action} (métrica: ${proposal.abc.metric}). ${proposal.abc.rationale}`);
    // #5055 — divergência entre os DOIS leitores do mesmo arquivo é BUG, não
    // estado normal, e o guard é BIDIRECIONAL de propósito (achado do review
    // da PR #5057).
    //
    // Há duas leituras separadas no tempo: `clarice-plan-wave.ts` lê cedo, no
    // início do seu `main()`, e assa a decisão no JSON que devolve; este
    // processo lê de novo alguns segundos depois (acima). Os DOIS resolvem a
    // raiz por `import.meta.url` e o spawn fixa `cwd: rootDir`, então a raiz
    // nunca diverge — o que PODE divergir é o CONTEÚDO, se o editor rodar
    // `--close`/`--reopen` exatamente na janela entre as duas leituras.
    //
    // Checar só "encerrado ⇒ travar" cobria uma direção. A outra é pior de
    // enxergar: um `--reopen` que cai no meio da rodada deixa o proposal com
    // `travar` (da leitura velha) e o estado com `aberto` (da nova); sem
    // `lockedSubject`, `resolveInheritedSubjects` cairia na busca de
    // precedente e reusaria em silêncio o assunto que o editor ACABOU de
    // destravar. Por isso comparamos a INTENÇÃO dos dois lados.
    //
    // `metric === "nenhuma"` com `action === "travar"` identifica exatamente o
    // ramo `lockedSubject` de `recommendAbcAction` — um `travar` CALCULADO
    // sempre declara `metric: "clique"`, e `iniciar` nunca é `travar`.
    const planWaveUsedLock = proposal.abc.action === "travar" && proposal.abc.metric === "nenhuma";
    const stateSaysClosed = abcState.status === "encerrado";
    if (planWaveUsedLock !== stateSaysClosed) {
      throw new EnvioAbort(
        stateSaysClosed
          ? `❌ estado gravado diz teste A/B/C ENCERRADO (assunto "${abcState.subject}"), mas clarice-plan-wave ` +
              `devolveu abc.action="${proposal.abc.action}" (métrica "${proposal.abc.metric}") — não aplicou a trava. ` +
              `Não vou mandar 3 assuntos depois de o teste ter sido encerrado. Verifique ` +
              `data/clarice-abc-state.json e rode de novo (#5055).`
          : `❌ clarice-plan-wave travou o assunto, mas o estado lido agora diz teste A/B/C ABERTO — o arquivo ` +
              `mudou no meio da rodada (--close/--reopen concorrente) ou ficou ilegível. Não vou reusar por ` +
              `inferência um assunto que pode ter acabado de ser destravado. Rode de novo (#5055).`,
      );
    }

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
    const inherited = resolveInheritedSubjects({
      waves: proposal.state.waves,
      abcAction,
      winner: proposal.abc.winner,
      lockedSubject: lockedSubjectFromState(abcState),
    });
    if (!inherited.ok) throw new EnvioAbort(`❌ ${inherited.reason}`);

    // --- Passo 3: risco de ISP (motor novo — abertura NUNCA freia, #5025). ---
    report.section("Passo 3 — Risco de ISP (freio + acelerador)");
    const riskStep = step<RiskSnapshot>(deps, report, "clarice-envio-risk", "scripts/clarice-envio-risk.ts", []);
    const risk = riskStep.json;
    if (!risk) throw new EnvioAbort("❌ clarice-envio-risk não devolveu JSON parseável.");
    report.note(`freio: ${risk.brake.level.toUpperCase()} — ${risk.brake.reasons.join(" ")}`);
    // #5399 achado 2: "spam (Postmaster): sem leitura confiável" vinha
    // embutido em `brake.reasons` acima, na MESMA posição visual de uma
    // leitura normal — o operador podia decidir volume sem perceber que o
    // sinal PRIMÁRIO de spam está cego (o freio já é fail-safe por desenho,
    // mas essa é justamente a leitura que o humano deveria enxergar
    // destacada). Linha própria, com `⚠️` — mesmo padrão de destaque já usado
    // pra `staleNote` logo abaixo.
    if (risk.spamSignal.source === "indeterminate") {
      report.note(
        "⚠️  sinal de spam do Postmaster está SEM LEITURA CONFIÁVEL (indeterminate) — o freio assume 70% de utilização às cegas nesta rodada. Ver task 'Diaria-Postmaster-Spam-Sync'.",
      );
    }
    // #5220 — sidecar JSON pro guard das 05:00 (clarice-envio-guard.ts) usar
    // como FALLBACK se os próprios pré-requisitos dele (esta mesma dupla de
    // scripts, chamados de novo de manhã com dado mais fresco) falharem
    // mesmo após retry. Gravado incondicionalmente aqui (qualquer nível de
    // freio, não só STOP) — é a ÚLTIMA leitura conhecida, não uma decisão.
    writeLastBrakeSnapshot(deps.rootDir, aammdd, risk.brake, now.toISOString());
    report.note(
      `tendência de abertura (60d, só observação, NUNCA freia): ${risk.openTrend.verdict} ` +
        `(${risk.openTrend.previous.toFixed(1)}% → ${risk.openTrend.current.toFixed(1)}%, ${risk.openTrend.sampleDays} dias de amostra).`,
    );
    if (risk.staleNote) report.note(`⚠️  ${risk.staleNote}`);

    const effectiveStep = missed || noEscalationReason ? 0 : risk.step;
    if (missed && risk.step > 0) report.note(`passo adaptativo calculado seria +${(risk.step * 100).toFixed(1)}%, zerado por onda perdida (ver acima).`);
    else if (noEscalationReason && risk.step > 0) report.note(`passo adaptativo calculado seria +${(risk.step * 100).toFixed(1)}%, zerado por ${noEscalationReason}.`);

    // --- Passo 4: fila de 1º envio — MV sob demanda se insuficiente, senão PARA (decisão do editor). ---
    //
    // Assimetria DELIBERADA entre este passo e o Passo 5 (#5042, achado do
    // review consolidado 260811b): fila insuficiente PARA a rodada com aviso
    // (abaixo); crédito Brevo insuficiente (Passo 5, `cappedBy === "credit"`)
    // SEGUE agendando o volume reduzido, só registrando uma nota no
    // relatório pós-fato. As duas situações são "não dá pra mandar o volume
    // calculado", mas não são o mesmo problema:
    //   - Fila insuficiente significa TROCAR DE PÚBLICO — o público elegível
    //     hoje (assinantes-ativos + fila de leads/ex-assinantes já
    //     verificada) não tem gente suficiente pro volume proposto. Completar
    //     exigiria puxar contatos de outra categoria/cohort — decisão de
    //     público que a automação não toma sozinha (ver "decisão do editor"
    //     acima).
    //   - Crédito raso é só um CORTE DE VOLUME dentro do MESMO público já
    //     elegível — a Brevo aceita menos envios este ciclo, mas quem seria
    //     enviado continua sendo exatamente o recorte que já passou pelos
    //     guards de elegibilidade (fila, freio, passo adaptativo). Não há
    //     decisão de público pra tomar aqui, só um teto numérico mais baixo
    //     — por isso a rodada segue em vez de parar.
    // Se esse racional deixar de valer (ex.: crédito baixo virar sinal de
    // parar por outro motivo de negócio), reabrir #5042 com o editor antes
    // de mudar o comportamento — nunca alinhar os dois caminhos em silêncio.
    report.section("Passo 4 — Fila de 1º envio");
    const probe = proposeNextVolume({
      baseVolume: proposal.volumes.baseVolume,
      step: effectiveStep,
      brake: risk.brake.level,
      queueAvailable: Number.MAX_SAFE_INTEGER,
      creditAvailable: null,
    });
    report.note(`volume desejado antes de considerar fila/crédito: ${probe.volume} (${probe.note})`);

    // --- #5985: `--plan-only` PARA aqui — antes do MV sob demanda (que gasta
    // crédito real). Libera o lock, não escreve nada, não agenda. O JSON
    // devolvido em `plan` é a proposta que o caminho manual apresenta ao
    // editor via AskUserQuestion (ver SKILL.md); a task agendada nunca passa
    // `--plan-only`, então este ramo é inalcançável fora do caminho manual. ---
    if (opts.planOnly) {
      report.note("--plan-only: proposta calculada, nenhuma escrita feita, lock liberado antes de retornar.");
      lockPath && releaseEnvioLock(lockPath);
      lockPath = null;
      const plan: EnvioPlanProposal = {
        cycle,
        sendDate,
        volume: probe.volume,
        baseVolume: proposal.volumes.baseVolume,
        step: effectiveStep,
        note: probe.note,
        brake: { level: risk.brake.level, reasons: [...risk.brake.reasons] },
        overrideApplied: risk.overrideApplied,
        queueAvailable: proposal.availableFirstSend,
        brevoCredits: proposal.brevoCredits,
        mvOnDemand: {
          deficit: proposal.mvOnDemandPlan.deficit,
          estimatedCostUsd: proposal.mvOnDemandPlan.estimatedCostUsd,
          backlogAvailable: proposal.mvOnDemandPlan.byCohort.length > 0,
        },
        abcAction,
        subjects: inherited,
      };
      return { code: 0, reportId: "", reportMarkdown: "", plan };
    }

    // --- #5985: `--volume N` substitui o volume que a POLÍTICA teria
    // escolhido sozinha (`probe.volume`) pelo confirmado/ajustado pelo
    // editor. Usado a partir daqui em vez de `probe.volume` em todo o
    // restante do fluxo (checagem de fila, MV sob demanda, decisão final) —
    // os guards continuam os MESMOS, só o "desejado" de entrada muda.
    const desiredVolume = requestedVolume ?? probe.volume;
    if (requestedVolume !== undefined) {
      report.note(
        `--volume ${requestedVolume}: substituindo o volume que a política teria escolhido (${probe.volume}) — guards de fila/crédito/freio seguem valendo, sem afrouxar.`,
      );
    }

    let queueAvailable = proposal.availableFirstSend;
    if (queueAvailable < desiredVolume && proposal.mvOnDemandPlan.byCohort.length > 0) {
      if (!hasMv) {
        report.note(
          `⚠️  fila (${queueAvailable}) menor que o desejado (${desiredVolume}) e há backlog MV disponível, mas MILLION_VERIFIER_API_KEY está ausente — não é possível verificar nesta rodada.`,
        );
      } else {
        report.note(`fila (${queueAvailable}) menor que o desejado (${desiredVolume}) — rodando MV sob demanda (déficit: ${proposal.mvOnDemandPlan.deficit}, custo estimado US$${proposal.mvOnDemandPlan.estimatedCostUsd.toFixed(2)}).`);
        // #6075 — mesmo `--target-volume` do Passo 1: sem ele,
        // `clarice-mv-ondemand.ts` recomputa `planWave()` do zero contra o
        // volume da política, não contra `desiredVolume`.
        const mvOndemandArgs = ["--cycle", cycle, "--dates", sendDate];
        if (requestedVolume !== undefined) mvOndemandArgs.push("--target-volume", String(requestedVolume));
        step(deps, report, "clarice-mv-ondemand", "scripts/clarice-mv-ondemand.ts", mvOndemandArgs);
        step(deps, report, "clarice-build-db (pós-MV)", "scripts/clarice-build-db.ts", []);
        // #5058 — mesma retry com backoff da 1ª chamada (Passo 1) acima.
        const replan = await stepWithTransientRetry<WaveProposal>(
          deps,
          report,
          "clarice-plan-wave (pós-MV)",
          "scripts/clarice-plan-wave.ts",
          planWaveArgs,
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

    if (queueAvailable < desiredVolume) {
      const filaMsg = `fila de 1º envio insuficiente mesmo após MV sob demanda (disponível: ${queueAvailable}, desejado: ${desiredVolume})`;
      // #5985 — `--volume N` explícito: fila insuficiente é um teto
      // violado, não um "nada a fazer" — o editor confirmou um número e
      // precisa saber POR QUE não dá pra entregá-lo, nunca um corte
      // silencioso. Sem a flag, mantém o comportamento ORIGINAL (código 0,
      // "PARAR esta rodada") — a task agendada nunca passa `--volume`.
      if (requestedVolume !== undefined) {
        throw new EnvioAbort(`❌ --volume ${requestedVolume}: ${filaMsg} — teto violado: fila. Nunca trocar de público sozinha, nunca enviar menos do que o editor confirmou sem abortar antes.`);
      }
      report.note(
        `${filaMsg} — ` +
          "decisão do editor (260811): PARAR esta rodada (nunca trocar de público sozinha, nunca enviar volume menor que o proposto sem avisar antes).",
      );
      lockPath && releaseEnvioLock(lockPath);
      lockPath = null;
      const reportId = `envio-${aammdd}-fila-insuficiente`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice envio ${aammdd} — fila insuficiente`, report.build());
      return { code: 0, reportId, reportMarkdown: report.build() };
    }

    // --- Passo 5: volume final. Corte por crédito (`cappedBy: "credit"`)
    // SEGUE a rodada e agenda o volume reduzido — não é um esquecimento,
    // ver o racional da assimetria fila×crédito no comentário do Passo 4
    // acima (#5042). #5985: essa assimetria só vale quando NINGUÉM confirmou
    // um número explicitamente — com `--volume N`, qualquer corte (fila,
    // crédito OU freio) precisa ser dito ANTES de escrever, nunca em silêncio
    // pós-fato (ver o abort logo abaixo). ---
    const decision: NextVolumeDecision = proposeNextVolume({
      baseVolume: requestedVolume !== undefined ? requestedVolume : proposal.volumes.baseVolume,
      step: requestedVolume !== undefined ? 0 : effectiveStep,
      brake: risk.brake.level,
      queueAvailable,
      creditAvailable: proposal.brevoCredits,
    });
    report.note(`volume final: ${decision.volume} (cappedBy: ${decision.cappedBy ?? "n/a"}) — ${decision.note}`);

    // #5985 — `--volume N` acima do que fila/crédito/freio permitem: aborta
    // explicando qual teto foi violado, nunca corta em silêncio pra caber.
    // `decision.volume < requestedVolume` só acontece quando um teto REAL
    // reduziu o número (queue/credit/stop) — se o freio está em `hold`,
    // `decision.volume === requestedVolume` (cappedBy:"hold" é só rótulo do
    // ramo, não um corte de verdade) e nada aborta aqui.
    if (requestedVolume !== undefined && decision.volume < requestedVolume) {
      throw new EnvioAbort(
        `❌ --volume ${requestedVolume} acima do teto (${decision.cappedBy ?? "desconhecido"}): ${decision.note} — nunca corta em silêncio pra caber num número que o editor não confirmou.`,
      );
    }

    const volumeSource: "default_policy" | "editor_confirmed" | "editor_override" =
      requestedVolume === undefined
        ? "default_policy"
        : requestedVolume === probe.volume
          ? "editor_confirmed"
          : "editor_override";
    report.note(`origem do volume: ${volumeSource} (política teria escolhido ${probe.volume} sozinha).`);

    if (decision.volume <= 0) {
      report.note("volume final é 0 — nada a agendar nesta rodada.");
      lockPath && releaseEnvioLock(lockPath);
      lockPath = null;
      // #6793 item 2 (01/09/2026): risk.brake.level === "stop" nunca mais
      // acontece via decideBrake (freio removido) — este ramo fica vivo só
      // pra item 3 (clarice-envio-guard.ts, handlePrereqFailure) ou um
      // override manual futuro que reintroduza "stop"; "sem-volume" é o
      // caminho comum hoje (baseVolume ≤ 0).
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

    const buildSegmentStep = step<{ selected?: number; budget?: number }>(
      deps,
      report,
      "clarice-build-segment",
      "scripts/clarice-build-segment.ts",
      ["--group", "ramp-warm", "--cycle", cycle, "--budget", String(decision.volume)],
    );
    // #5395 — reconciliação: `--group ramp-warm` sem `--exact-budget` (não
    // suportado nesse modo) corta silenciosamente pra `ordered.slice(0,
    // budget)` — se a fila real (pós-guards) for menor que `decision.volume`,
    // `selected` sai menor que o pedido sem NENHUM sinal no relatório (a
    // causa raiz do achado ao vivo de 260816: onda 25% menor, relatório
    // 100% verde). `selected` ausente no JSON (parse falhou) não é tratado
    // como divergência — é ausência de dado, não confirmação de "bateu".
    const segmentSelected = buildSegmentStep.json?.selected;
    if (typeof segmentSelected === "number" && segmentSelected < decision.volume) {
      const deficit = decision.volume - segmentSelected;
      const pct = ((deficit / decision.volume) * 100).toFixed(1);
      report.note(
        `⚠️  RECONCILIAÇÃO: onda saiu ${segmentSelected} contra ${decision.volume} planejados ` +
          `(déficit ${deficit}, −${pct}%) — a fila real pós-guards (sent-or-queued.json/committed) ` +
          "era menor que o `availableFirstSend` calculado no planejamento. Investigar antes da próxima rodada " +
          "(órfãos de replan de lista, guard divergente, etc. — #5395).",
      );
    }

    // #5140 — teste de HORÁRIO. Só entra quando o de ASSUNTO está travado:
    // as duas dimensões dividem a MESMA onda, e rodar as duas juntas produz
    // 3×N células pequenas demais pra qualquer leitura, com os dois efeitos
    // confundidos. `abcAction === "travar"` é o sinal de que o A/B/C acabou
    // (hoje vindo do `clarice-abc-state.json` `encerrado`, #5055).
    const hourTest = readClariceHourTestState(deps.rootDir);
    if (hourTest.degraded) {
      report.note(`⚠️  estado do teste de horário ilegível — seguindo SEM teste de horário. ${hourTest.degradedReason}`);
    }
    const hourCells = hourTest.status === "ativo" && abcAction === "travar" ? hourTest.hoursBrt : null;
    if (hourTest.status === "ativo" && abcAction !== "travar") {
      report.note(
        "⚠️  teste de horário ATIVO mas o A/B/C de assunto não está travado — teste de horário PULADO nesta onda. " +
          "Duas dimensões na mesma onda confundem os efeitos e fragmentam a base; encerre o de assunto primeiro " +
          "(`npx tsx scripts/lib/clarice-abc-state.ts --close ...`).",
      );
    }

    const splitArgs = ["--cycle", cycle, "--wave", String(n), "--date", sendDate, "--from", "segments/ramp-warm.csv"];
    if (hourCells) {
      splitArgs.push("--hour-cells", hourCells.join(","));
      report.note(`teste de horário ATIVO — células ${hourCells.map((h) => `${String(h).padStart(2, "0")}:00`).join(" × ")} BRT (#5140).`);
    } else if (abcAction === "travar") {
      splitArgs.push("--no-cells");
    }
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
    //
    // `scheduleAt` é POR CÉLULA (#5140): no teste de horário é ELE que
    // carrega a variável independente do experimento. As 3 formas possíveis:
    //
    //   hourCells != null  → N células, MESMO assunto, horários distintos.
    //   mode "single"      → 1 onda, 1 horário (o canônico).
    //   senão              → A/B/C de assunto, 3 assuntos, MESMO horário.
    //
    // O assunto é o MESMO nas duas células — senão os braços divergiriam em
    // duas variáveis e o teste não mediria horário nenhum. Quando `hourCells`
    // é truthy o A/B/C está travado (guard no Passo 6) e
    // `resolveInheritedSubjects` devolve `mode: "single"`, então o ramo
    // `.subjects.A` é inalcançável hoje — está ali porque a correlação
    // "hourCells ⇒ single" vive no fluxo, não no tipo, e um `subjects[c]`
    // solto seria pior que um fallback explícito se alguém afrouxar o guard.
    const cells: Array<{ key: string; cell: WaveCell | null; subject: string; scheduleAt: string }> =
      hourCells
        ? hourCells.map((hourBrt) => {
            const label = hourCellLabel(hourBrt);
            return {
              key: `${waveKeyBase}-${label}`,
              cell: label,
              subject: inherited.mode === "single" ? inherited.subject : inherited.subjects.A,
              // `brtHourToUtcHourSameDay` e não `(h + 3) % 24`: o módulo
              // silenciosamente agendaria 22:00 BRT como 01:00 UTC do MESMO
              // `sendDate`, ou seja 24h antes do pretendido.
              scheduleAt: scheduledAtForDate(sendDate, brtHourToUtcHourSameDay(hourBrt)),
            };
          })
        : inherited.mode === "single"
          ? [{ key: waveKeyBase, cell: null, subject: inherited.subject, scheduleAt: scheduledAt }]
          : (["A", "B", "C"] as const).map((c) => ({
              key: `${waveKeyBase}-${c}`,
              cell: c,
              subject: inherited.subjects[c],
              scheduleAt: scheduledAt,
            }));

    let anyUncertain = false;
    let scheduledCount = 0;
    const summaries: InvocationSummary[] = [];
    try {
      for (const { key, cell, subject, scheduleAt } of cells) {
        const keyArgs = cell ? ["--key", key] : [];
        step<InvocationSummary>(deps, report, `clarice-schedule-group --create (${key})`, "scripts/clarice-schedule-group.ts", [
          "--cycle", cycle, "--group", waveKeyBase, ...keyArgs, "--subject", subject, "--schedule-at", scheduleAt, "--create",
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
          report.note(`✅ "${key}" agendada pra ${scheduleAt} (status="${scheduleJson?.status ?? "?"}").`);
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
        // `${key} (${scheduleAt})` em vez de um "às 06:00" fixo (#5140): com
        // horário por célula, uma frase que afirma a hora errada num aviso de
        // estado PARCIAL é pior que não dizer hora nenhuma — é justamente o
        // relatório que o editor lê pra decidir se cancela algo na Brevo.
        const done = cells.slice(0, scheduledCount).map((c) => `${c.key} (${c.scheduleAt})`);
        const pendingCells = cells.slice(scheduledCount).map((c) => c.key);
        report.note(
          `⚠️  ONDA PARCIALMENTE MONTADA: ${scheduledCount} de ${cells.length} célula(s) já confirmada(s) ANTES ` +
            `deste erro — ${done.join(", ")} já são campanhas REAIS na Brevo e vão disparar nos horários acima, do ` +
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
      // #5826: code 4, não 1 — abort SEGURO (lock já travado por outra
      // sessão, nunca tocou Brevo), não uma falha genuína. `code: 1` fazia o
      // `Diaria-Systemd-Failed-Units-Alarm` disparar como se fosse erro real.
      return { code: 4, reportId, reportMarkdown: report.build() };
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
  // #5985 — `--plan-only`/`--volume N` são o caminho MANUAL (ver
  // .claude/skills/diaria-clarice-envio/SKILL.md). A task agendada
  // `Diaria-Clarice-Envio` continua rodando SEM nenhuma flag — nenhum
  // override de produção é injetado automaticamente aqui.
  const parsed = parseArgs(process.argv.slice(2));
  const planOnly = parsed.flags.has("plan-only");
  const volumeArg = parsed.values["volume"];
  let volume: number | undefined;
  if (volumeArg !== undefined) {
    const n = Number(volumeArg);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      console.error(`❌ --volume precisa ser um inteiro positivo (recebido: "${volumeArg}").`);
      process.exitCode = 1;
    } else {
      volume = n;
    }
  }
  if (process.exitCode !== 1) {
    const deps = productionDeps(ROOT);
    runEnvio(deps, { planOnly, volume })
      .then((r) => {
        // `--plan-only` imprime a proposta em stdout (JSON) — é o que o
        // caminho manual lê pra apresentar via AskUserQuestion. Fora desse
        // caso, nada novo é impresso — mesmo comportamento de sempre.
        if (planOnly && r.plan) {
          console.log(JSON.stringify(r.plan, null, 2));
        }
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
}
