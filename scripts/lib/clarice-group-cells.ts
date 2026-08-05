/**
 * clarice-group-cells.ts (#4657, fecha de verdade o item 3 da #4449)
 *
 * Gera o manifest de CÉLULAS A/B/C de uma onda do fluxo `--group` — a peça
 * que faltava pra o naming ser determinístico ponta a ponta.
 *
 * O buraco que isto fecha: `clarice-build-segment.ts` escreve um manifest de
 * UMA entrada, com `key` = nome do grupo (`ramp-warm`), que nunca termina em
 * `-A`/`-B`/`-C`. `clarice-import-waves.ts --group X` lê `{X}-manifest.json`
 * e só usa `groupCellListNameFor` (o naming que o painel consegue parsear)
 * quando a `key` da entrada tem esse sufixo. Ou seja: pelo caminho scriptado
 * NUNCA se chegava numa lista com célula — o ciclo 2607-08 só conseguiu
 * porque alguém escreveu `d1-sab01-manifest.json` com 3 entradas À MÃO
 * (`d1-sab01-A/B/C`). Era esse o "digitado à mão" da #4449, e ele
 * sobrevivia mesmo depois do #4471 ter ligado o gerador de NOME, porque
 * quem digitava era a CHAVE.
 *
 * Aqui a chave vem de `waveKey()` e a divisão de `stratify` (mesma
 * amostragem sistemática de `clarice-split-cells.ts`, que preserva a
 * proporção de tiers entre as células — célula enviesada invalidaria o
 * teste de assunto antes de ele começar).
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

export interface GroupCellsArtifact<T> {
  /** Chave do DIA (`d6-qui06`) — é o `--group` a passar pro import. */
  groupKey: string;
  manifest: CellManifestEntry[];
  /** Linhas de cada célula, na ordem A/B/C. */
  cells: T[][];
}

export const CELLS = ["A", "B", "C"] as const;

/**
 * Divide as linhas de uma onda em 3 células e monta o manifest.
 *
 * As 3 células recebem tamanhos o mais iguais possível (resto distribuído
 * entre as primeiras) — nunca uma célula com o resto todo, que enviesaria a
 * potência do teste entre braços.
 *
 * `desc` sai como `celula X` (sem acento), a mesma grafia que o ciclo
 * 2607-08 usou e que o parser aceita nas duas formas. O que importa pro
 * parser é o NOME DA LISTA, gerado depois por `groupCellListNameFor` a
 * partir da `key` daqui.
 */
export function buildGroupCells<T>(rows: T[], n: number, date: string): GroupCellsArtifact<T> {
  const groupKey = waveKey(n, date);
  const total = rows.length;
  const base = Math.floor(total / CELLS.length);
  const rest = total % CELLS.length;
  const caps = CELLS.map((_, i) => base + (i < rest ? 1 : 0));
  const cells = stratify(rows, caps);

  const manifest: CellManifestEntry[] = CELLS.map((cell, i) => ({
    key: waveKey(n, date, cell),
    file: `${waveKey(n, date, cell)}.csv`,
    desc: `celula ${cell}`,
    count: cells[i].length,
  }));

  return { groupKey, manifest, cells };
}

/**
 * Variante SEM teste A/B/C — uma lista só para a onda do dia, usada quando a
 * recomendação é `travar` (assunto único).
 *
 * Existe pelo mesmo motivo de `buildGroupCells`: `clarice-build-segment.ts`
 * escreve manifest com `key` = nome do grupo (`ramp-warm`), que não carrega o
 * dia. Com assunto travado e vários dias na onda, as 3 campanhas sairiam
 * todas como `grupo:ramp-warm` — mesmo nome, colidindo entre si — e
 * `computeNextWaveNumber` nunca avançaria a numeração, porque `ramp-warm`
 * não casa `d{N}-`. A chave do dia vem de `waveKey()`, gerada.
 *
 * `desc` entra no nome da lista via `listNameFor` (`Clarice {label} {key} —
 * {desc}`); o `--label` do import é quem carrega o ciclo mensal, que é o que
 * `summarizeCycleSends` usa pra atribuir a campanha ao ciclo.
 */
export function buildSingleWave<T>(rows: T[], n: number, date: string): GroupCellsArtifact<T> {
  const groupKey = waveKey(n, date);
  return {
    groupKey,
    manifest: [{ key: groupKey, file: `${groupKey}.csv`, desc: "onda unica", count: rows.length }],
    cells: [rows],
  };
}

/** Nome do arquivo de manifest que `clarice-import-waves --group {groupKey}` lê. */
export function cellManifestFileName(groupKey: string): string {
  return `${groupKey}-manifest.json`;
}
