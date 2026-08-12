/**
 * clarice-hour-test.ts (#5140)
 *
 * Estado DURÁVEL do teste de HORÁRIO da onda `ramp-warm` da Clarice News.
 * Mesmo papel que `clarice-abc-state.ts` cumpre pro teste de ASSUNTO, e
 * deliberadamente um ARQUIVO SEPARADO — ver "por que não reusar o A/B/C".
 *
 * ===========================================================================
 * O QUE O TESTE MEDE
 * ===========================================================================
 * A onda sai historicamente às 06:00 BRT, horário herdado e nunca testado. A
 * análise da #5140 aponta que ele é ruim pros dois objetivos de conversão do
 * e-mail (assinar a Diária, usar o cupom da Clarice), porque a decisão não
 * acontece na leitura — mediana do clique 7,6h, p75 37,9h — e, quando
 * acontece, cai em horário comercial. Um envio às 06:00 põe a janela de ação
 * imediata em 06h–10h, o trecho mais morto da curva de compra.
 *
 * A evidência disponível é OBSERVACIONAL e enviesada (os envios fora das
 * 06:00 foram escolhidos a dedo, nunca sorteados), então o desfecho é um
 * teste de verdade: 2 células estratificadas, MESMO assunto, diferindo só no
 * `--schedule-at`.
 *
 * ===========================================================================
 * POR QUE NÃO REUSAR A MÁQUINA DO A/B/C
 * ===========================================================================
 * Seria mais barato, e está errado por dois motivos independentes:
 *
 *   1. `parseAbcAudienceCampaign` (dashboard) casa `([ABC])\b`. Células
 *      nomeadas `A`/`B` apareceriam no painel como um teste de ASSUNTO em
 *      curso — o painel passaria a afirmar algo falso sobre o que está sendo
 *      testado.
 *   2. `clarice-abc-state.json` está `encerrado` desde 11/08/2026 (#5055).
 *      Reabri-lo devolve a ressalva de poder baixo do #4559, e
 *      `clarice-envio-run.ts` ZERA o passo adaptativo de volume quando há
 *      ressalva — o laço auto-alimentado "base pequena → poder baixo → passo
 *      zerado → base nunca cresce" documentado em
 *      docs/clarice-envio-daily-setup.md. Um teste de horário que, de efeito
 *      colateral, congela o volume da rampa mediria a coisa errada com a
 *      base errada.
 *
 * Daí o sufixo próprio (`H06`/`H10`, `hourCellLabel` em clarice-wave-plan.ts)
 * e este arquivo de estado separado.
 *
 * ===========================================================================
 * AS TRÊS LEITURAS POSSÍVEIS
 * ===========================================================================
 *   | estado do arquivo                        | status     | avisa |
 *   |------------------------------------------|------------|-------|
 *   | ausente                                  | `inativo`  | não   |
 *   | presente e válido                        | o valor    | não   |
 *   | presente e ilegível/inválido             | `inativo`  | SIM   |
 *
 * O fail-soft aponta pra `inativo` — o lado que NÃO divide a onda. Um estado
 * corrompido não pode virar "divida a base em células que eu não sei
 * interpretar": o custo de não rodar o teste hoje é um dia a menos de
 * amostra; o de dividir errado é uma onda real mal formada.
 *
 * Uso (CLI):
 *   npx tsx scripts/lib/clarice-hour-test.ts                       # imprime o estado
 *   npx tsx scripts/lib/clarice-hour-test.ts --start --hours 6,10  # inicia
 *   npx tsx scripts/lib/clarice-hour-test.ts --close --winner 10 \
 *     --rationale "..."                                            # encerra
 *
 * @see scripts/lib/clarice-abc-state.ts (mesmo padrão, teste de assunto)
 * @see #5140
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getArg, hasFlag, isMainModule } from "./cli-args.ts";

/** Duas células é o desenho da #5140; o teto existe pra que um `--hours` com
 *  typo (ex: "6,10,14,18,22") não fatie a onda em pedaços pequenos demais pra
 *  qualquer leitura — a base diária é de ~4k, e 2 braços já pedem ~4 dias pra
 *  detectar +1pp. */
export const MAX_HOUR_CELLS = 3;

export type ClariceHourTestState =
  | { status: "inativo" }
  | {
      status: "ativo";
      /** Horas BRT dos braços, ordenadas e sem repetição. */
      hoursBrt: number[];
      startedAt: string;
      startedBy: string;
      rationale?: string;
    }
  | {
      status: "encerrado";
      /** Hora BRT vencedora, ou `null` pra encerramento sem veredito (mesma
       *  semântica do `winner: null` do A/B/C — encerrar é ato editorial, não
       *  precisa de significância). */
      winnerBrt: number | null;
      hoursBrt: number[];
      decidedAt: string;
      decidedBy: string;
      rationale?: string;
    };

export type ClariceHourTestStateRead = ClariceHourTestState & {
  /** `true` quando o arquivo existia mas não pôde ser usado — quem chama
   *  deve AVISAR (não silenciar), mesmo o estado caindo em `inativo`. */
  degraded?: boolean;
  degradedReason?: string;
};

export function clariceHourTestStatePath(rootDir: string): string {
  return resolve(rootDir, "data", "clarice-hour-test.json");
}

/** Normaliza/valida a lista de horas. Lança em entrada inválida — este valor
 *  vira `scheduledAt` de campanha real (ver `scheduledAtForDate`). */
export function normalizeHours(hours: readonly number[]): number[] {
  const uniq = [...new Set(hours)];
  if (uniq.length < 2) {
    throw new Error(`teste de horário exige >= 2 horas distintas — recebido: [${hours.join(", ")}]`);
  }
  if (uniq.length > MAX_HOUR_CELLS) {
    throw new Error(
      `teste de horário aceita no máximo ${MAX_HOUR_CELLS} braços — recebido ${uniq.length} ([${uniq.join(", ")}]). ` +
        "Mais braços que isso deixam cada célula pequena demais pra qualquer leitura na base atual.",
    );
  }
  for (const h of uniq) {
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      throw new Error(`hora BRT inválida: ${h} — esperado inteiro entre 0 e 23.`);
    }
  }
  return uniq.sort((a, b) => a - b);
}

function isValidState(v: unknown): v is ClariceHourTestState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.status === "inativo") return true;
  if (o.status === "ativo") {
    return Array.isArray(o.hoursBrt) && typeof o.startedAt === "string" && o.hoursBrt.length >= 2;
  }
  if (o.status === "encerrado") {
    return (
      Array.isArray(o.hoursBrt) &&
      typeof o.decidedAt === "string" &&
      (o.winnerBrt === null || typeof o.winnerBrt === "number")
    );
  }
  return false;
}

export function readClariceHourTestState(rootDir: string): ClariceHourTestStateRead {
  const p = clariceHourTestStatePath(rootDir);
  if (!existsSync(p)) return { status: "inativo" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf-8"));
  } catch (e) {
    return {
      status: "inativo",
      degraded: true,
      degradedReason: `JSON ilegível em ${p}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!isValidState(parsed)) {
    return {
      status: "inativo",
      degraded: true,
      degradedReason: `conteúdo inválido em ${p} — tratado como teste inativo (fail-soft).`,
    };
  }
  // Revalida as horas mesmo num estado estruturalmente válido: `hoursBrt`
  // veio de disco e vira `scheduledAt` de campanha.
  if (parsed.status !== "inativo") {
    try {
      normalizeHours(parsed.hoursBrt);
    } catch (e) {
      return {
        status: "inativo",
        degraded: true,
        degradedReason: `horas inválidas em ${p}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  return parsed;
}

function write(rootDir: string, state: ClariceHourTestState): ClariceHourTestState {
  writeFileSync(clariceHourTestStatePath(rootDir), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  return state;
}

export interface StartHourTestOptions {
  hoursBrt: readonly number[];
  startedBy?: string;
  rationale?: string;
  now?: () => Date;
}

export function startClariceHourTest(rootDir: string, opts: StartHourTestOptions): ClariceHourTestState {
  const hoursBrt = normalizeHours(opts.hoursBrt);
  const now = (opts.now ?? (() => new Date()))();
  return write(rootDir, {
    status: "ativo",
    hoursBrt,
    startedAt: now.toISOString(),
    startedBy: opts.startedBy ?? "editor",
    ...(opts.rationale ? { rationale: opts.rationale } : {}),
  });
}

export interface CloseHourTestOptions {
  winnerBrt: number | null;
  decidedBy?: string;
  rationale?: string;
  now?: () => Date;
}

export function closeClariceHourTest(rootDir: string, opts: CloseHourTestOptions): ClariceHourTestState {
  const current = readClariceHourTestState(rootDir);
  if (current.status === "inativo") {
    throw new Error("não há teste de horário ativo pra encerrar (estado atual: inativo).");
  }
  if (opts.winnerBrt !== null && !current.hoursBrt.includes(opts.winnerBrt)) {
    throw new Error(
      `vencedor ${opts.winnerBrt}h não é um dos braços do teste ([${current.hoursBrt.join(", ")}]) — ` +
        "encerrar apontando pra hora que não foi testada registraria uma conclusão que o dado não sustenta.",
    );
  }
  const now = (opts.now ?? (() => new Date()))();
  return write(rootDir, {
    status: "encerrado",
    winnerBrt: opts.winnerBrt,
    hoursBrt: current.hoursBrt,
    decidedAt: now.toISOString(),
    decidedBy: opts.decidedBy ?? "editor",
    ...(opts.rationale ? { rationale: opts.rationale } : {}),
  });
}

export function describeHourTestState(state: ClariceHourTestStateRead): string {
  if (state.status === "inativo") {
    return state.degraded ? `inativo (DEGRADADO: ${state.degradedReason})` : "inativo";
  }
  if (state.status === "ativo") {
    return `ativo — braços ${state.hoursBrt.map((h) => `${String(h).padStart(2, "0")}:00`).join(" × ")} BRT (desde ${state.startedAt})`;
  }
  const w = state.winnerBrt === null ? "sem vencedor" : `vencedor ${String(state.winnerBrt).padStart(2, "0")}:00 BRT`;
  return `encerrado — ${w} (em ${state.decidedAt})`;
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const rootDir = process.cwd();
  try {
    if (hasFlag(argv, "start")) {
      const raw = getArg(argv, "hours");
      if (!raw) throw new Error("--start exige --hours (ex: --hours 6,10)");
      const hours = raw.split(",").map((s) => Number(s.trim()));
      const st = startClariceHourTest(rootDir, {
        hoursBrt: hours,
        rationale: getArg(argv, "rationale") || undefined,
      });
      console.log(describeHourTestState(st));
    } else if (hasFlag(argv, "close")) {
      const raw = getArg(argv, "winner");
      const st = closeClariceHourTest(rootDir, {
        // `--winner` ausente ou "none" = encerramento SEM veredito, o mesmo
        // caminho que o A/B/C usou em 11/08 (p 0,2715, decisão editorial).
        winnerBrt: raw === "" || raw === "none" ? null : Number(raw),
        rationale: getArg(argv, "rationale") || undefined,
      });
      console.log(describeHourTestState(st));
    } else {
      console.log(describeHourTestState(readClariceHourTestState(rootDir)));
    }
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
