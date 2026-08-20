/**
 * clarice-group-cells.ts (#4657, fecha de verdade o item 3 da #4449)
 *
 * Gera o manifest de uma onda do fluxo `--group` — com células A/B/C
 * (`buildGroupCells`) ou lista única quando o assunto está travado
 * (`buildSingleWave`). A chave nunca é digitada: vem de `waveKey()`.
 *
 * O buraco que isto fecha: `clarice-build-segment.ts` escreve um manifest de
 * UMA entrada, com `key` = nome do grupo (`ramp-warm`), que nunca termina em
 * `-A`/`-B`/`-C` nem casa `d{N}-`. Consequências, cada uma silenciosa:
 *   - `clarice-import-waves.ts` só usa `groupCellListNameFor` (o naming que o
 *     painel consegue parsear, #4447) quando a `key` tem sufixo de célula —
 *     pelo caminho scriptado nunca se chegava numa lista com célula. O ciclo
 *     2607-08 só conseguiu porque alguém escreveu `d1-sab01-manifest.json`
 *     com 3 entradas À MÃO. Era esse o "digitado à mão" da #4449, que
 *     sobreviveu ao #4471 (que ligou o gerador de NOME) porque quem se
 *     digitava era a CHAVE.
 *   - `computeNextWaveNumber` não avança em `ramp-warm`, então uma onda de
 *     vários dias com assunto travado sairia com 3 campanhas de nome
 *     idêntico (`grupo:ramp-warm`), colidindo entre si.
 *
 * A divisão em células usa `stratify` (mesma amostragem sistemática de
 * `clarice-split-cells.ts`), que preserva a proporção de tiers entre as
 * células — célula enviesada invalidaria o teste de assunto antes de começar.
 *
 * PURO: recebe as linhas já segmentadas e devolve os artefatos. Quem escreve
 * em disco é `scripts/clarice-split-group-cells.ts`.
 */

import { stratify } from "../clarice-build-edition-sends.ts";
import { hourCellLabel, waveKey } from "./clarice-wave-plan.ts";
import type { ClariceHourTestState } from "./clarice-hour-test.ts";

/** Uma entrada de manifest, no shape que `clarice-import-waves.ts` já lê. */
export interface CellManifestEntry {
  key: string;
  file: string;
  desc: string;
  count: number;
}

/**
 * Entrada de manifest JUNTO das linhas que ela descreve.
 *
 * Eram dois arrays paralelos (`manifest[]` + `cells[]`) que o chamador
 * percorria em lockstep (`manifest.forEach((e, i) => write(cells[i]))`). A
 * invariante "mesmo comprimento, mesmo índice" não era expressável no tipo e
 * valia só por disciplina dos dois construtores — um terceiro produtor, ou um
 * refactor que reordenasse um array e não o outro, type-checaria e escreveria
 * um CSV sob o nome errado, ou perderia linhas em silêncio (a classe do
 * #4577/#4602, onde um contato sumiu sem erro). Parear torna a dessincronia
 * impossível em vez de improvável — achado convergente do review de tipos e
 * do caçador de falhas silenciosas no PR #4660.
 */
export interface GroupCell<T> {
  entry: CellManifestEntry;
  rows: T[];
}

export interface GroupCellsArtifact<T> {
  /** Chave do DIA (`d6-qui06`) — é o `--group` a passar pro import. */
  groupKey: string;
  cells: GroupCell<T>[];
}

export const CELLS = ["A", "B", "C"] as const;

/** O manifest, na ordem — o que vai pro `{groupKey}-manifest.json`. */
export function manifestOf<T>(artifact: GroupCellsArtifact<T>): CellManifestEntry[] {
  return artifact.cells.map((c) => c.entry);
}

/**
 * Divide as linhas de uma onda em 3 células A/B/C.
 *
 * Tamanhos o mais iguais possível (resto distribuído entre as primeiras) —
 * nunca uma célula com o resto todo, que enviesaria a potência entre braços.
 *
 * `desc` sai como `celula X` (sem acento), a mesma grafia do ciclo 2607-08;
 * o parser aceita as duas. O que o painel de fato lê é o NOME DA LISTA,
 * gerado depois por `groupCellListNameFor` a partir da `key` daqui.
 */
export function buildGroupCells<T>(rows: T[], n: number, date: string): GroupCellsArtifact<T> {
  const total = rows.length;
  const base = Math.floor(total / CELLS.length);
  const rest = total % CELLS.length;
  const caps = CELLS.map((_, i) => base + (i < rest ? 1 : 0));
  const split = stratify(rows, caps);

  return {
    groupKey: waveKey(n, date),
    cells: CELLS.map((cell, i) => ({
      entry: {
        key: waveKey(n, date, cell),
        file: `${waveKey(n, date, cell)}.csv`,
        desc: `celula ${cell}`,
        count: split[i].length,
      },
      rows: split[i],
    })),
  };
}

/**
 * Variante SEM teste A/B/C — uma lista só para a onda do dia, usada quando a
 * recomendação do planejador é `travar` (assunto único).
 *
 * `rows.slice()` e não `rows`: `buildGroupCells` devolve arrays NOVOS (saídos
 * de `stratify`), então aliasar o array do chamador aqui deixaria os dois
 * construtores com contratos diferentes quanto a compartilhamento — o tipo de
 * assimetria que produz "funcionou no teste, corrompeu na 3ª invocação".
 *
 * ATENÇÃO ao nome da lista: `listNameFor` monta `Clarice {label} {key} —
 * {desc}` e NÃO embute o ciclo. Por isso `resolveListName`
 * (`clarice-import-waves.ts`) trata chave com formato de dia (`d{N}-`) como
 * caso próprio e usa o CICLO no lugar do label — senão `summarizeCycleSends`,
 * que filtra por `listName.includes(cycle)`, jogaria a campanha em
 * `unscopedCount` sempre que o operador esquecesse de digitar o ciclo no
 * `--label`. Nada forçava isso antes (#4660).
 */
/**
 * #5140 — variante do teste de HORÁRIO: N células (hoje 2) com o MESMO
 * assunto, diferindo só no horário de agendamento. Reusa `stratify` pelo
 * mesmo motivo que `buildGroupCells`: célula enviesada por tier invalidaria o
 * teste antes de começar, e aqui isso seria pior que no A/B/C — o efeito
 * esperado do horário (+1 a +3pp de abertura) é da mesma ordem de grandeza da
 * diferença entre tiers, então um desbalanceio produziria um "vencedor" que
 * é só composição de audiência.
 *
 * O sufixo vem de `hourCellLabel` (`H06`, `H10`), NUNCA digitado — mesma
 * disciplina do #4449/#4471 pro A/B/C, e o que mantém a célula derivável do
 * nome da lista por `groupCellListNameFor`.
 *
 * `hoursBrt` já chega normalizado por `normalizeHours`
 * (`clarice-hour-test.ts`); a validação de faixa fica em `hourCellLabel`.
 */
export function buildHourCells<T>(
  rows: T[],
  n: number,
  date: string,
  hoursBrt: readonly number[],
): GroupCellsArtifact<T> {
  if (hoursBrt.length < 2) {
    throw new Error(`buildHourCells exige >= 2 horas — recebido [${hoursBrt.join(", ")}].`);
  }
  const total = rows.length;
  const base = Math.floor(total / hoursBrt.length);
  const rest = total % hoursBrt.length;
  const caps = hoursBrt.map((_, i) => base + (i < rest ? 1 : 0));
  const split = stratify(rows, caps);

  return {
    groupKey: waveKey(n, date),
    cells: hoursBrt.map((hour, i) => {
      const label = hourCellLabel(hour);
      return {
        entry: {
          key: waveKey(n, date, label),
          file: `${waveKey(n, date, label)}.csv`,
          desc: `hora ${String(hour).padStart(2, "0")}:00 BRT`,
          count: split[i].length,
        },
        rows: split[i],
      };
    }),
  };
}

export function buildSingleWave<T>(rows: T[], n: number, date: string): GroupCellsArtifact<T> {
  const groupKey = waveKey(n, date);
  return {
    groupKey,
    cells: [
      {
        entry: { key: groupKey, file: `${groupKey}.csv`, desc: "onda unica", count: rows.length },
        rows: rows.slice(),
      },
    ],
  };
}

/** Caminho do manifest que `clarice-import-waves --group {groupKey}` lê. */
export function cellManifestFileName(groupKey: string): string {
  return `${groupKey}-manifest.json`;
}

/**
 * #5140: união discriminada em vez do antigo `"single" | "cells"`. O teste de
 * horário traz um 3º caminho que CARREGA DADO (as horas), e um par
 * `(strategy, hours)` solto no chamador é exatamente a assimetria que o
 * `CellsWithRows` deste arquivo já combate: nada no tipo impediria
 * `"single"` com horas preenchidas, ou `"hours"` sem elas.
 */
export type CellStrategy =
  | { kind: "single" }
  | { kind: "cells" }
  | { kind: "hours"; hoursBrt: number[] };

/**
 * Decide entre onda única, teste A/B/C e teste de HORÁRIO a partir do argv.
 * PURA e exportada de propósito: é a única lógica com consequência de
 * produção no CLI (define quantas listas saem na Brevo pra um envio real) e,
 * sem extrair, ficava sem teste nenhum — achado do analisador de testes no PR
 * #4660 (risco 9/10).
 *
 * `--no-cells` + `--hour-cells` juntos ABORTA em vez de eleger um vencedor
 * silencioso: as duas flags exprimem intenções incompatíveis ("uma lista só"
 * × "duas listas por horário"), e adivinhar qual vale reintroduziria a classe
 * de bug do #4660 — fragmentar (ou não) a audiência de um envio real sem que
 * nada no log distinga isso do caminho pedido.
 */
export function resolveCellStrategy(argv: string[]): CellStrategy {
  const noCells = argv.includes("--no-cells");
  const raw = readFlagValue(argv, "hour-cells");

  if (raw !== null && noCells) {
    throw new Error(
      "--no-cells e --hour-cells são mutuamente exclusivos (uma lista só × uma lista por horário). " +
        "Passe só um dos dois.",
    );
  }
  if (raw !== null) {
    const hoursBrt = raw.split(",").map((s) => {
      const n = Number(s.trim());
      if (!Number.isInteger(n) || n < 0 || n > 23) {
        throw new Error(`--hour-cells: hora BRT inválida "${s.trim()}" — esperado inteiro entre 0 e 23.`);
      }
      return n;
    });
    const uniq = [...new Set(hoursBrt)].sort((a, b) => a - b);
    if (uniq.length < 2) {
      throw new Error(`--hour-cells exige >= 2 horas distintas — recebido "${raw}".`);
    }
    return { kind: "hours", hoursBrt: uniq };
  }
  return noCells ? { kind: "single" } : { kind: "cells" };
}

/**
 * #5827: `strategy.kind === "single"` (`--no-cells`, assunto travado)
 * fragmentaria SILENCIOSAMENTE a amostra do teste de HORÁRIO (#5140) se ele
 * estiver `ativo` — os dois testes (assunto e horário) são independentes, e
 * nada verificava isso antes de escrever uma onda real (achado ao vivo
 * 260820: onda `d24-sex21` saiu inteira às 06:00, zerando o braço das 10:00
 * de um teste rodando desde 16/08).
 *
 * PURA (recebe o estado já lido, não lê disco) pra ser testável sem fixture
 * de filesystem. Devolve a mensagem de erro (para abortar) quando o choque é
 * real, ou `null` quando é seguro seguir — `ignoreHourTest` é o escape hatch
 * explícito (`--ignore-hour-test`) pra quando "onda única mesmo com teste
 * ativo" é intencional.
 */
export function checkSingleStrategyAgainstHourTest(
  strategy: CellStrategy,
  hourTestState: ClariceHourTestState,
  ignoreHourTest: boolean,
): string | null {
  if (strategy.kind !== "single" || ignoreHourTest) return null;
  if (hourTestState.status !== "ativo") return null;
  const hours = hourTestState.hoursBrt.join(",");
  return (
    `--no-cells pedido, mas o teste de HORÁRIO (#5140) está ATIVO (braços ${hours} BRT desde ${hourTestState.startedAt}). ` +
    `Isso fragmentaria a amostra do dia em silêncio. Use --hour-cells ${hours} no lugar de --no-cells, ` +
    `ou passe --ignore-hour-test se "onda única mesmo assim" for intencional.`
  );
}

/** Lê `--nome valor` ou `--nome=valor` do argv. Devolve null se ausente. */
function readFlagValue(argv: string[], name: string): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1] ?? null;
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return null;
}

/**
 * Flags reconhecidas pelo `clarice-split-group-cells.ts`.
 *
 * Existe porque `hasFlag` faz match exato e o script não rejeitava argumento
 * desconhecido: um `--nocells`/`--no-cell` digitado errado devolvia `false` e
 * o script caía SILENCIOSAMENTE no caminho de 3 células — com assunto
 * travado, fragmentando a audiência em 3 listas pro mesmo assunto, sem nada
 * no log que distinguisse isso de um teste A/B/C legítimo (#4660).
 */
export const SPLIT_GROUP_CELLS_FLAGS = new Set(["no-cells", "dry-run", "ignore-hour-test"]);

/** Flags passadas que não são reconhecidas — provável typo. Pura. */
export function unknownFlags(argv: string[], known: Set<string> = SPLIT_GROUP_CELLS_FLAGS): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const name = a.slice(2).split("=")[0];
    // Flags com valor (`--cycle X`) são validadas pelos próprios getters; só
    // interessa aqui o que PARECE flag booleana e não é reconhecida.
    const hasValue = a.includes("=") || (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--"));
    if (hasValue) continue;
    if (!known.has(name)) out.push(a);
  }
  return out;
}
