/**
 * scripts/lib/pending-data-writes.ts (#12026, #12034)
 *
 * Parser da seção `## Escrita pendente em \`data/\` (#11780)` do corpo de uma
 * PR — o formato do item 35 de `context/overnight-dispatch-rules.md`: o
 * implementador não grava no `data/` real a partir do worktree e declara a
 * escrita no corpo, uma linha de lista por arquivo; quem mergeia aplica
 * depois do merge.
 *
 * Dois consumidores mecânicos, para a escrita não depender de memória:
 * - o trem de merge (#12026, `run-merge-train.ts`): o PR que mergeia é o
 *   PR-trem descartável e as PRs originais terminam FECHADAS, então o corpo
 *   da PR mergeada não traz a seção. O trem coleta as seções das originais,
 *   replica no corpo do PR-trem e imprime no fim do run.
 * - o `hermes/scripts/continuo-pr-review.sh` (#12034): depois de um merge
 *   confirmado, `register-pending-data-writes.ts` abre uma issue de alarme
 *   com as linhas pendentes.
 *
 * Só leitura de texto: nada aqui grava em `data/`. O formato da linha é
 * prosa ("chave de X para Y", ou o conteúdo inteiro de um arquivo novo), sem
 * gramática que permita aplicar a escrita sem julgamento — por isso o
 * consumidor registra e mostra, nunca aplica sozinho.
 */

/** Título da seção: `##`/`###`, "Escrita pendente em", `data/` com ou sem
 * crase, sufixo livre (o `(#11780)` do formato canônico é opcional aqui). */
const HEADING_RE = /^ {0,3}#{2,3}[ \t]+Escrita pendente em[ \t]+`?data\/`?/i;
/** Qualquer heading ATX — fecha a seção quando tem nível <= ao do título. */
const ANY_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM_RE = /^[ \t]*[-*+][ \t]+(.*\S)[ \t]*$/;
/** 1º code span que começa com `data/` — o caminho declarado na linha. */
const DATA_PATH_RE = /`(data\/[^`]+)`/;

export interface PendingDataWrite {
  /** Texto do item de lista, sem o marcador `- ` (como o coordenador o lê). */
  readonly line: string;
  /** Caminho `data/...` citado em crase na linha, ou `null` se não houver. */
  readonly path: string | null;
}

export interface PendingDataWritesSection {
  /** A seção existe no corpo (mesmo vazia). */
  readonly present: boolean;
  /** Itens de lista da seção, na ordem em que aparecem. */
  readonly writes: readonly PendingDataWrite[];
}

/**
 * Pura — extrai a seção `Escrita pendente em data/` do corpo de uma PR.
 *
 * - Título dentro de bloco de código cercado ou de comentário HTML não conta
 *   (é citação do formato, ex.: um corpo que reproduz o item 35).
 * - A seção vai até o próximo heading de nível <= ao do título, ou o fim.
 * - Só itens de lista contam; prosa solta na seção é ignorada. Item de lista
 *   dentro de cerca, na seção, também é ignorado.
 * - Mais de uma seção no corpo: os itens são concatenados.
 *
 * `present: false` quando não há título; `present: true, writes: []` quando
 * o título existe sem itens (o consumidor decide se isso é sinal).
 */
export function extractPendingDataWrites(body: string): PendingDataWritesSection {
  const lines = body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const writes: PendingDataWrite[] = [];
  let present = false;
  let sectionLevel: number | null = null;
  let fence: { ch: string; len: number } | null = null;

  for (const line of lines) {
    const fm = FENCE_RE.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len && line.trim() === fm[1]) fence = null;
      continue;
    }
    if (fm) {
      fence = { ch: fm[1][0], len: fm[1].length };
      continue;
    }

    if (HEADING_RE.test(line)) {
      present = true;
      sectionLevel = (ANY_HEADING_RE.exec(line) as RegExpExecArray)[1].length;
      continue;
    }
    const hm = ANY_HEADING_RE.exec(line);
    if (hm && sectionLevel !== null && hm[1].length <= sectionLevel) {
      sectionLevel = null;
      continue;
    }
    if (sectionLevel === null) continue;

    const item = LIST_ITEM_RE.exec(line);
    if (!item) continue;
    const text = item[1];
    const path = DATA_PATH_RE.exec(text);
    writes.push({ line: text, path: path ? path[1] : null });
  }

  return { present, writes };
}

/** Escrita pendente de uma PR específica (agregação do trem, alarme do contínuo). */
export interface PrPendingDataWrites {
  readonly pr: number;
  readonly writes: readonly PendingDataWrite[];
}

/** Título canônico da seção (item 35) — reusado ao replicar no PR-trem. */
export const PENDING_DATA_WRITES_HEADING = "## Escrita pendente em `data/` (#11780)";

/**
 * Pura — a seção agregada para o corpo de uma PR que junta outras (o PR-trem,
 * #12026): mesmo título do item 35, um sub-bloco por PR de origem. String
 * vazia quando nenhuma PR declarou escrita — o corpo fica como antes.
 */
export function buildAggregatedPendingDataWritesSection(perPr: readonly PrPendingDataWrites[]): string {
  const withWrites = perPr.filter((p) => p.writes.length > 0);
  if (withWrites.length === 0) return "";
  const blocks = withWrites.map((p) => [`- PR #${p.pr}:`, ...p.writes.map((w) => `  - ${w.line}`)].join("\n"));
  return (
    `${PENDING_DATA_WRITES_HEADING}\n\n` +
    "Agregado das PRs do lote (#12026). Aplicar cada linha no checkout principal depois do merge deste PR-trem.\n\n" +
    `${blocks.join("\n")}`
  );
}
