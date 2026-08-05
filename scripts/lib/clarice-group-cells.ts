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
import { waveKey } from "./clarice-wave-plan.ts";

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

export type CellStrategy = "single" | "cells";

/**
 * Decide entre onda única e teste A/B/C a partir do argv. PURA e exportada de
 * propósito: é a única lógica com consequência de produção no CLI (define se
 * saem 1 ou 3 listas na Brevo pra um envio real) e, sem extrair, ficava sem
 * teste nenhum — achado do analisador de testes no PR #4660 (risco 9/10).
 */
export function resolveCellStrategy(argv: string[]): CellStrategy {
  return argv.includes("--no-cells") ? "single" : "cells";
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
export const SPLIT_GROUP_CELLS_FLAGS = new Set(["no-cells", "dry-run"]);

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
