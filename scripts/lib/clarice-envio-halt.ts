/**
 * clarice-envio-halt.ts (#10096)
 *
 * Parada DURÁVEL da rampa Clarice por fila insuficiente.
 *
 * A regra do editor (260811) é "fila insuficiente → PARAR, nunca enviar
 * volume menor que o proposto sem avisar". Até o #10096 a parada valia por
 * UMA rodada: a seguinte recalculava a base a partir do último dia com envio
 * e mandava um volume muito menor, sem aviso — exatamente o que a regra
 * proíbe (ciclo 2609-10: 40.180 → parou → 31 → 101).
 *
 * Agora, quando `clarice-envio-run.ts` para por fila insuficiente, grava
 * `data/clarice-envio-halt.json`. Enquanto o arquivo existir, toda rodada
 * agendada sai em "parada pendente" (relatório `-fila-insuficiente-pendente`,
 * sem tocar Brevo/MV) até o editor decidir explicitamente:
 *
 *   npx tsx scripts/lib/clarice-envio-halt.ts                       # mostra o estado
 *   npx tsx scripts/lib/clarice-envio-halt.ts --clear --reason "..." # retoma a automação
 *   npx tsx scripts/lib/clarice-envio-halt.ts --accept-base --reason "..." # aceita base baixa da rampa (#10114)
 *
 * `--volume N` no caminho manual (`/diaria-clarice-envio`) também passa —
 * é número confirmado pelo editor — mas NÃO limpa a parada: a próxima rodada
 * AGENDADA continua pendente até o `--clear`. O envio manual é uma decisão
 * pontual; retomar a automação diária é outra.
 *
 * Distinto do kill switch (`clarice-envio-enabled.ts`): o kill switch é a
 * intenção do editor ("rampa ligada/pausada"); a parada é um FATO que a
 * automação encontrou e que espera resposta. Arquivos separados pra um nunca
 * apagar o outro.
 *
 * Leitura fail-SAFE: arquivo presente mas ilegível conta como PARADA ATIVA
 * (`halted: true`, `invalid: true`) — sinal de problema numa trava de envio
 * real nunca vira "pode enviar".
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule, parseArgs } from "./cli-args.ts";
import { getMachineId } from "./machine-id.ts";
import { logEvent } from "./run-log.ts";

export interface ClariceEnvioHalt {
  /** Motivo estruturado. Hoje só `fila-insuficiente`. */
  kind: "fila-insuficiente";
  /** ISO — quando a rodada parou. */
  since: string;
  /** `envio-{aammdd}` da rodada que parou. */
  reportId: string;
  cycle: string;
  queueAvailable: number;
  desiredVolume: number;
  baseVolume: number;
}

export type ClariceEnvioHaltRead =
  | { halted: false }
  | { halted: true; invalid: false; halt: ClariceEnvioHalt }
  | { halted: true; invalid: true; error: string };

export function clariceEnvioHaltPath(rootDir: string): string {
  return resolve(rootDir, "data", "clarice-envio-halt.json");
}

function isHalt(v: unknown): v is ClariceEnvioHalt {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.kind === "fila-insuficiente" &&
    typeof o.since === "string" &&
    typeof o.reportId === "string" &&
    typeof o.cycle === "string" &&
    typeof o.queueAvailable === "number" &&
    typeof o.desiredVolume === "number" &&
    typeof o.baseVolume === "number"
  );
}

export function readClariceEnvioHalt(rootDir: string): ClariceEnvioHaltRead {
  const p = clariceEnvioHaltPath(rootDir);
  if (!existsSync(p)) return { halted: false };
  try {
    const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!isHalt(raw)) return { halted: true, invalid: true, error: "shape inesperado" };
    return { halted: true, invalid: false, halt: raw };
  } catch (e) {
    return { halted: true, invalid: true, error: (e as Error).message };
  }
}

/** Grava a parada. Propaga erro de escrita — perder a parada em silêncio
 * reabriria o #10096. */
export function writeClariceEnvioHalt(rootDir: string, halt: ClariceEnvioHalt): void {
  const p = clariceEnvioHaltPath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(halt, null, 2) + "\n", "utf8");
}

/** Limpa a parada (decisão do editor). Devolve `false` se não havia parada. */
export function clearClariceEnvioHalt(
  rootDir: string,
  reason: string,
  opts: { now?: () => Date; machine?: string; logRunEvent?: boolean } = {},
): boolean {
  const p = clariceEnvioHaltPath(rootDir);
  if (!existsSync(p)) return false;
  const before = readClariceEnvioHalt(rootDir);
  rmSync(p, { force: true });
  if (opts.logRunEvent !== false) {
    logEvent(
      {
        edition: null,
        stage: null,
        agent: "clarice-envio-halt",
        level: "info",
        message: `parada da rampa Clarice limpa pelo editor (motivo: ${reason})`,
        details: {
          clearedAt: (opts.now ?? (() => new Date()))().toISOString(),
          machine: opts.machine ?? (getMachineId() || null),
          sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
          reason,
          halt: before.halted && !before.invalid ? before.halt : null,
        },
      },
      rootDir,
    );
  }
  return true;
}

/**
 * #10118 — idade máxima (em dias) de uma parada por fila insuficiente antes de
 * a rodada agendada deixar de ser "pausa legítima" e virar ALARME. Dentro do
 * limite, a parada é a regra 260811 funcionando (espera decisão do editor);
 * além dele, ninguém decidiu e o único sinal seria um relatório que alguém
 * precisa abrir. 3 dias = um fim de semana inteiro sem leitura mais 1 dia de
 * folga, curto o bastante pra não deixar a rampa morta por uma semana.
 */
export const CLARICE_ENVIO_HALT_MAX_AGE_DAYS = 3;

/** Sufixo do `reportId` de uma rodada que encontrou a parada VENCIDA (#10118).
 * Fica de FORA de `OK_SUFFIXES` (`clarice-envio-alarm.ts`) de propósito: é o
 * que faz a task de alarme disparar. */
export const HALT_STALE_REPORT_SUFFIX = "-fila-insuficiente-vencida";

export type ClariceEnvioHaltStaleness = { stale: false } | { stale: true; reasons: string[] };

/**
 * #10118 — a parada passou do ponto de "pausa legítima"? Vencida quando
 * (a) passou de `maxAgeDays` desde `since`, (b) o ciclo esperado pelo
 * calendário difere do `cycle` gravado (a fila do ciclo novo é outra — a
 * parada provavelmente nem se aplica mais), ou (c) `since` é ilegível
 * (fail-toward-alarming: não dá pra provar que ainda está dentro do limite).
 * Puro. `currentCycle` null (calendário indisponível) só desliga o critério (b).
 */
export function evaluateHaltStaleness(
  halt: ClariceEnvioHalt,
  now: Date,
  currentCycle: string | null,
  maxAgeDays: number = CLARICE_ENVIO_HALT_MAX_AGE_DAYS,
): ClariceEnvioHaltStaleness {
  const reasons: string[] = [];
  const sinceMs = Date.parse(halt.since);
  if (Number.isNaN(sinceMs)) {
    reasons.push(`data da parada ilegível (since=${JSON.stringify(halt.since)})`);
  } else {
    const ageDays = (now.getTime() - sinceMs) / 86_400_000;
    if (ageDays > maxAgeDays) {
      reasons.push(`parada há mais de ${maxAgeDays} dias (desde ${halt.since})`);
    }
  }
  if (currentCycle && currentCycle !== halt.cycle) {
    reasons.push(`ciclo mudou desde a parada (${halt.cycle} → ${currentCycle})`);
  }
  return reasons.length > 0 ? { stale: true, reasons } : { stale: false };
}

/**
 * #10121 — staleness a partir da LEITURA (não só da parada legível). Arquivo
 * ilegível conta como parada ativa (lado seguro, #10096) e, como não dá pra
 * saber desde quando nem de qual ciclo, é VENCIDA de imediato: sem isso a
 * rodada sairia `-fila-insuficiente-pendente` (OK pro alarme) todo dia e a
 * rampa ficaria parada indefinidamente sem ninguém ser avisado. Puro.
 */
export function evaluateHaltReadStaleness(
  read: Exclude<ClariceEnvioHaltRead, { halted: false }>,
  now: Date,
  currentCycle: string | null,
  maxAgeDays: number = CLARICE_ENVIO_HALT_MAX_AGE_DAYS,
): ClariceEnvioHaltStaleness {
  if (read.invalid) return { stale: true, reasons: [`arquivo de parada ilegível (${read.error})`] };
  return evaluateHaltStaleness(read.halt, now, currentCycle, maxAgeDays);
}

/**
 * #10123 — identidade ESTÁVEL de uma parada, pro fingerprint do alarme: a
 * mesma parada vencida produz o mesmo achado todo dia (uma issue por parada,
 * não uma por dia). Parada legível → `halt:{cycle}:{since}`; ilegível →
 * `halt:ilegivel`; ausente (limpa entre a rodada das 19:00 e o alarme) →
 * `halt:sem-arquivo`. Puro.
 */
export function haltAlarmFingerprint(read: ClariceEnvioHaltRead | null): string {
  if (!read || !read.halted) return "halt:sem-arquivo";
  if (read.invalid) return "halt:ilegivel";
  return `halt:${read.halt.cycle}:${read.halt.since}`;
}

/** Texto do relatório de uma rodada que encontrou a parada ativa. Puro. */
export function describeHaltForReport(read: Exclude<ClariceEnvioHaltRead, { halted: false }>, currentCycle: string | null): string {
  const clearCmd = 'npx tsx scripts/lib/clarice-envio-halt.ts --clear --reason "..."';
  if (read.invalid) {
    return (
      `🛑 parada da rampa ATIVA, mas data/clarice-envio-halt.json está ilegível (${read.error}) — tratando como parada (lado seguro). ` +
      `Confira o arquivo e, decidido retomar, rode \`${clearCmd}\`.`
    );
  }
  const h = read.halt;
  const cycleNote =
    currentCycle && currentCycle !== h.cycle
      ? ` O ciclo mudou desde a parada (${h.cycle} → ${currentCycle}) — a fila do ciclo novo provavelmente já comporta o volume; confira e libere.`
      : "";
  return (
    `🛑 rampa PARADA desde ${h.since} (${h.reportId}): fila insuficiente no ciclo ${h.cycle} ` +
    `(disponível ${h.queueAvailable}, desejado ${h.desiredVolume}, base ${h.baseVolume}). ` +
    `A parada da regra 260811 é durável (#10096): nenhuma rodada agendada envia até decisão explícita do editor.${cycleNote} ` +
    `Pra retomar: \`${clearCmd}\`; pra um envio pontual com volume confirmado: /diaria-clarice-envio com --volume N.`
  );
}

/** #10115 — sufixo do `reportId` de uma rodada que PAROU por fila insuficiente
 * mas não conseguiu gravar a parada durável. Fora de `OK_SUFFIXES`
 * (`clarice-envio-alarm.ts`): sem a parada, a próxima rodada pode recomeçar de
 * uma base residual — isso precisa chegar ao editor, não ficar numa nota. */
export const HALT_WRITE_FAILED_REPORT_SUFFIX = "-fila-insuficiente-halt-write-failed";

/** #10114 — sufixo do `reportId` de uma rodada agendada que parou porque o
 * volume-base colapsou (muito abaixo do pico recente da rampa,
 * `detectRampBaseCollapse`). Fora de `OK_SUFFIXES`: vira alarme. */
export const BASE_COLLAPSE_REPORT_SUFFIX = "-base-colapsada";

// ---------------------------------------------------------------------------
// #10114 — aceite explícito de uma base baixa. A condição de colapso é
// re-derivada do histórico da Brevo a cada rodada (durável por natureza); o
// aceite é o que o editor grava quando decide que a base baixa vale. Dias de
// rampa enviados ANTES do aceite deixam de contar pro pico.
// ---------------------------------------------------------------------------

export interface ClariceEnvioBaseAck {
  /** ISO — quando o editor aceitou a base atual. */
  acceptedAt: string;
  reason: string;
}

export function clariceEnvioBaseAckPath(rootDir: string): string {
  return resolve(rootDir, "data", "clarice-envio-base-ack.json");
}

/** Lê o aceite. Ausente OU ilegível → `null` (o guard de colapso continua
 * ativo — lado seguro: um arquivo corrompido nunca libera a rampa). */
export function readClariceEnvioBaseAck(rootDir: string): ClariceEnvioBaseAck | null {
  const p = clariceEnvioBaseAckPath(rootDir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown> | null;
    if (!raw || typeof raw.acceptedAt !== "string" || Number.isNaN(Date.parse(raw.acceptedAt))) return null;
    return { acceptedAt: raw.acceptedAt, reason: typeof raw.reason === "string" ? raw.reason : "" };
  } catch {
    return null;
  }
}

/** Grava o aceite (decisão do editor). Propaga erro de escrita. Também limpa
 * o estado durável de colapso (#10209): o editor decidiu sobre a base, o
 * alarme não deve seguir apontando o colapso até a próxima rodada agendada. */
export function writeClariceEnvioBaseAck(rootDir: string, reason: string, now: Date = new Date()): ClariceEnvioBaseAck {
  const ack: ClariceEnvioBaseAck = { acceptedAt: now.toISOString(), reason };
  const p = clariceEnvioBaseAckPath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ack, null, 2) + "\n", "utf8");
  clearClariceEnvioBaseCollapse(rootDir);
  return ack;
}

// ---------------------------------------------------------------------------
// #10209 item 3 — estado DURÁVEL do colapso de base. A condição é derivada do
// histórico da Brevo, que só a rodada das 19:00 consulta. Antes, o alarme
// (20:30) só via o colapso se o relatório do dia fosse `-base-colapsada`:
// dias `-paused`/`-abort`/sem relatório não geravam achado e 2 deles fechavam
// a issue com a base ainda colapsada (mesmo defeito que o #10125 corrigiu pra
// parada vencida). Agora a rodada que para por colapso grava este arquivo; a
// rodada que calcula a proposta SEM colapso (ou o `--accept-base`) o apaga; o
// alarme lê o arquivo toda execução.
// ---------------------------------------------------------------------------

export interface ClariceEnvioBaseCollapseState {
  /** ISO — quando a rodada detectou o colapso pela 1ª vez (preservado nas seguintes). */
  detectedAt: string;
  /** `envio-{aammdd}-base-colapsada` da rodada que gravou por último. */
  reportId: string;
  baseVolume: number;
  baseDay: string;
  peakVolume: number;
  peakDay: string;
  fraction: number;
}

export type ClariceEnvioBaseCollapseRead =
  | { collapsed: false }
  | { collapsed: true; invalid: false; state: ClariceEnvioBaseCollapseState }
  | { collapsed: true; invalid: true; error: string };

export function clariceEnvioBaseCollapsePath(rootDir: string): string {
  return resolve(rootDir, "data", "clarice-envio-base-collapse.json");
}

function isBaseCollapseState(v: unknown): v is ClariceEnvioBaseCollapseState {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.detectedAt === "string" &&
    typeof o.reportId === "string" &&
    typeof o.baseVolume === "number" &&
    typeof o.baseDay === "string" &&
    typeof o.peakVolume === "number" &&
    typeof o.peakDay === "string" &&
    typeof o.fraction === "number"
  );
}

/** Leitura fail-SAFE (mesmo racional da parada): arquivo presente mas
 * ilegível conta como colapso ativo — o alarme segue avisando. */
export function readClariceEnvioBaseCollapse(rootDir: string): ClariceEnvioBaseCollapseRead {
  const p = clariceEnvioBaseCollapsePath(rootDir);
  if (!existsSync(p)) return { collapsed: false };
  try {
    const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!isBaseCollapseState(raw)) return { collapsed: true, invalid: true, error: "shape inesperado" };
    return { collapsed: true, invalid: false, state: raw };
  } catch (e) {
    return { collapsed: true, invalid: true, error: (e as Error).message };
  }
}

/** Grava o colapso. `detectedAt` de um estado anterior legível é preservado
 * (identidade estável do achado). Propaga erro de escrita. */
export function writeClariceEnvioBaseCollapse(
  rootDir: string,
  state: ClariceEnvioBaseCollapseState,
): ClariceEnvioBaseCollapseState {
  const prev = readClariceEnvioBaseCollapse(rootDir);
  const next: ClariceEnvioBaseCollapseState =
    prev.collapsed && !prev.invalid ? { ...state, detectedAt: prev.state.detectedAt } : state;
  const p = clariceEnvioBaseCollapsePath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

/** Apaga o estado de colapso. Devolve `false` se não havia. */
export function clearClariceEnvioBaseCollapse(rootDir: string): boolean {
  const p = clariceEnvioBaseCollapsePath(rootDir);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

/**
 * #10209 item 2 — menor `--volume N` que tira a rampa do colapso: a onda de N
 * vira o novo dN, e só não recolapsa se `N >= minFraction × pico`. Abaixo
 * disso, `--volume N` envia e a rodada agendada seguinte para de novo — o
 * caminho certo para retomar com base menor é `--accept-base`. Puro.
 */
export function minVolumeToClearCollapse(peakVolume: number, minFraction: number): number {
  return Math.max(1, Math.ceil(peakVolume * minFraction));
}

/** Texto de orientação do colapso (relatório, issue, e-mail). Puro. */
export function describeBaseCollapseActions(peakVolume: number | null, minFraction: number): string[] {
  const minN = peakVolume !== null && peakVolume > 0 ? minVolumeToClearCollapse(peakVolume, minFraction) : null;
  return [
    'aceitar a base baixa e retomar a automação: `npx tsx scripts/lib/clarice-envio-halt.ts --accept-base --reason "..."`',
    minN !== null
      ? `envio pontual com volume confirmado: \`/diaria-clarice-envio --volume N\` — só resolve com N ≥ ${minN} ` +
        `(${Math.round(minFraction * 100)}% do pico ${peakVolume}); abaixo disso a onda vira a nova base e a próxima rodada agendada recolapsa`
      : `envio pontual com volume confirmado: \`/diaria-clarice-envio --volume N\` — abaixo de ${Math.round(minFraction * 100)}% do pico a onda vira a nova base e a próxima rodada agendada recolapsa`,
  ];
}

// ---------------------------------------------------------------------------
// #10209 item 1 — registro dos dias em que a rodada agendou volume REDUZIDO
// por crédito Brevo (`cappedBy: "credit"`, #5042). É redução deliberada, não
// resíduo de onda parcial: sem este registro, a rodada seguinte comparava o
// dia cortado com o pico anterior e parava por "base colapsada".
// ---------------------------------------------------------------------------

export interface ClariceEnvioCreditCap {
  /** YYYY-MM-DD (BRT) — dia em que a onda cortada sai. */
  day: string;
  /** Volume agendado depois do corte. */
  volume: number;
  recordedAt: string;
}

/** Quantos registros manter — bem acima da janela de pico (7 dias de rampa). */
export const CLARICE_ENVIO_CREDIT_CAPS_KEEP = 30;

export function clariceEnvioCreditCapsPath(rootDir: string): string {
  return resolve(rootDir, "data", "clarice-envio-credit-caps.json");
}

/** Ausente OU ilegível → `[]`: sem registro, o guard de colapso fica MAIS
 * estrito (lado seguro — no pior caso para e chama o editor). */
export function readClariceEnvioCreditCaps(rootDir: string): ClariceEnvioCreditCap[] {
  const p = clariceEnvioCreditCapsPath(rootDir);
  if (!existsSync(p)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is ClariceEnvioCreditCap =>
        !!e &&
        typeof e === "object" &&
        typeof (e as ClariceEnvioCreditCap).day === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test((e as ClariceEnvioCreditCap).day) &&
        typeof (e as ClariceEnvioCreditCap).volume === "number" &&
        typeof (e as ClariceEnvioCreditCap).recordedAt === "string",
    );
  } catch {
    return [];
  }
}

/** Registra (ou substitui, mesmo `day`) um corte por crédito. Propaga erro de escrita. */
export function recordClariceEnvioCreditCap(
  rootDir: string,
  cap: { day: string; volume: number },
  now: Date = new Date(),
): ClariceEnvioCreditCap[] {
  const entries = readClariceEnvioCreditCaps(rootDir).filter((e) => e.day !== cap.day);
  entries.push({ day: cap.day, volume: cap.volume, recordedAt: now.toISOString() });
  entries.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const kept = entries.slice(-CLARICE_ENVIO_CREDIT_CAPS_KEEP);
  const p = clariceEnvioCreditCapsPath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(kept, null, 2) + "\n", "utf8");
  return kept;
}

// CLI guard: só executa como main module, importável sem efeito colateral.
if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  if (flags.has("accept-base") || "accept-base" in values) {
    const reason = (values.reason ?? "").trim();
    if (!reason) {
      console.error('[clarice-envio-halt] --accept-base exige --reason "..." (decisão do editor que aceita a base baixa da rampa, #10114).');
      process.exitCode = 2;
    } else {
      console.log(JSON.stringify(writeClariceEnvioBaseAck(root, reason)));
    }
  } else if (flags.has("clear") || "clear" in values) {
    const reason = (values.reason ?? "").trim();
    if (!reason) {
      console.error('[clarice-envio-halt] --clear exige --reason "..." (decisão do editor que libera a rampa).');
      process.exitCode = 2;
    } else {
      console.log(clearClariceEnvioHalt(root, reason) ? "cleared" : "no-halt");
    }
  } else {
    const read = readClariceEnvioHalt(root);
    console.log(read.halted ? JSON.stringify(read, null, 2) : "no-halt");
  }
}
