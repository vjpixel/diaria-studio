/**
 * manual-edit-diff.ts (#9356, #9357)
 *
 * Funções PURAS pra comparar "o que a pipeline entregou" com "o que saiu",
 * descontando as mutações que a própria pipeline faz depois do baseline —
 * do contrário o diff nunca zera e a métrica "edição sem modificação
 * manual" (#9357, definição de feito da épica #7972) fica inverificável.
 *
 * Dois usos:
 * - `edition-manual-edits.ts` (#9357): diff por seção, com contagem de
 *   linhas adicionadas/removidas, pra decidir `zero_manual_edits`;
 * - `derive-editor-requests.ts backfill-stage4` (#9356): reconstrói um
 *   baseline aproximado pras edições cujo snapshot foi gravado tarde.
 *
 * ## Mutações da pipeline descontadas (e por quê)
 *
 * | Mutação | Onde acontece | Desconto |
 * |---|---|---|
 * | Bloco `TÍTULO`/`SUBTÍTULO` no topo | `insert-titulo-subtitulo.ts` (Stage 2) | removido dos dois lados — deriva dos títulos, que são comparados à parte |
 * | Linha de cobertura ("Nesta edição, a IA analisou…") | `sync-coverage-line.ts` (Stage 2/4) | número vira placeholder — muda sozinho quando um item é cortado; o corte em si aparece na seção |
 * | Blocos É IA?, ERRO INTENCIONAL, SORTEIO, PARA ENCERRAR | Stage 3 (É IA?), render do erro/rodapé | conteúdo vira placeholder — é preenchimento de template, não texto editorial revisável |
 * | URL própria (`{edition_url}`) | `resolve-edition-url.ts` (Stage 5) | normalizada pro placeholder (mesmo desconto do #7974) |
 * | Correção do fact-check (`fact-check-autofix.json`, status `applied`) | `apply-factcheck-autofix.ts` (Stage 4) | aplicada ao baseline antes de comparar |
 * | Erro intencional plantado (`wrong_value`) | `plant-intentional-error.ts` / editor no gate | aplicado ao baseline quando o final o contém |
 * | 3 títulos → 1 | `title-picker` (Stage 2) | baseline reconstruído fica com o título que o title-picker escolheu |
 *
 * **Premissa registrada:** o bloco ERRO INTENCIONAL conta como pipeline
 * mesmo quando o editor o preenche no gate interativo do Stage 2 — é
 * insumo de design do concurso ("ache o erro"), não correção de texto da
 * pipeline. Se o editor quiser que conte, basta tirar `ERRO INTENCIONAL` de
 * `PIPELINE_OWNED_SECTIONS`.
 */

import { BEEHIIV_BASE_URL } from "./edition-url.ts";

/** Seções cujo conteúdo é preenchimento de template/pipeline, não texto revisável. */
export const PIPELINE_OWNED_SECTIONS = ["É IA?", "ERRO INTENCIONAL", "SORTEIO", "PARA ENCERRAR"] as const;

const PIPELINE_BLOCK_PLACEHOLDER = "{bloco da pipeline}";
const COVERAGE_RE = /^(Nesta edição, a IA analisou )\d.*$/;

const SELF_URL_RE = new RegExp(`${BEEHIIV_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s)]*`, "g");

/** Troca toda URL do próprio site pelo placeholder `{edition_url}`. */
export function normalizeSelfUrls(content: string): string {
  return content.replace(SELF_URL_RE, "{edition_url}");
}

/**
 * Nome "nu" de uma linha de cabeçalho em negrito (`**🛠️ USE MELHOR**` →
 * `USE MELHOR`), ou `null` se a linha não é um cabeçalho de seção. Aceita
 * cabeçalho sem negrito só pra `É IA?` (o stitch o grava assim).
 */
export function sectionHeaderName(line: string): string | null {
  const trimmed = line.trim();
  const bold = trimmed.match(/^\*\*(.+)\*\*$/);
  const inner = bold ? bold[1] : trimmed === "É IA?" ? trimmed : null;
  if (inner === null || inner.startsWith("[")) return null;
  // Remove emoji/símbolos no começo (com seletores de variação, ZWJ e tons de pele).
  const name = inner.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (/^DESTAQUE \d+/.test(name)) return name.match(/^DESTAQUE \d+/)![0];
  if (name !== name.toUpperCase() || name.length < 3) return null;
  return name;
}

/**
 * Normaliza `02-reviewed.md` pra comparação (ver tabela no topo). Pura e
 * idempotente.
 */
export function normalizeNewsletterForComparison(md: string): string {
  let lines = md.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd());

  // Bloco TÍTULO/SUBTÍTULO (insert-titulo-subtitulo.ts) — só se for o topo do arquivo.
  const firstContent = lines.findIndex((l) => l.trim() !== "");
  if (firstContent >= 0 && lines[firstContent].trim() === "TÍTULO") {
    const sep = lines.findIndex((l, i) => i > firstContent && l.trim() === "---");
    if (sep >= 0) lines = lines.slice(sep + 1);
  }

  const out: string[] = [];
  let inPipelineBlock = false;
  for (const line of lines) {
    if (inPipelineBlock) {
      if (line.trim() === "---") {
        inPipelineBlock = false;
        out.push(line);
      }
      continue;
    }
    const header = sectionHeaderName(line);
    if (header && (PIPELINE_OWNED_SECTIONS as readonly string[]).includes(header)) {
      out.push(`**${header}**`, "", PIPELINE_BLOCK_PLACEHOLDER, "");
      inPipelineBlock = true;
      continue;
    }
    out.push(line.replace(COVERAGE_RE, "$1{cobertura}"));
  }

  return normalizeSelfUrls(out.join("\n"))
    .replace(/\n{3,}/g, "\n\n")
    .trim() + "\n";
}

/** Título (texto do link) da 1ª linha `**[...](...)**` de cada DESTAQUE N. */
export function extractDestaqueTitles(md: string): Map<number, string> {
  const titles = new Map<number, string>();
  let current: number | null = null;
  for (const line of md.split("\n")) {
    const header = sectionHeaderName(line);
    if (header) {
      const m = header.match(/^DESTAQUE (\d+)$/);
      current = m ? Number(m[1]) : null;
      continue;
    }
    if (current === null || titles.has(current)) continue;
    const t = line.trim().match(/^\*\*\[(.+?)\]\(/);
    if (t) titles.set(current, t[1].trim());
  }
  return titles;
}

/** Nº de linhas de título (`**[...](...)**`) no bloco logo após cada cabeçalho DESTAQUE N. */
export function countTitleOptions(md: string): Map<number, number> {
  const counts = new Map<number, number>();
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = sectionHeaderName(lines[i])?.match(/^DESTAQUE (\d+)$/);
    if (!m) continue;
    let n = 0;
    for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || /^\*\*\[.+?\]\(/.test(lines[j].trim())); j++) {
      if (lines[j].trim() !== "") n++;
    }
    counts.set(Number(m[1]), n);
  }
  return counts;
}

export interface TitlePick {
  destaque: number;
  chosen: string;
}

/**
 * No baseline com 3 opções de título por destaque, mantém só a escolhida pelo
 * `title-picker` (ou a 1ª, se não há pick pra aquele destaque). Opções = as
 * linhas `**[...](...)**` contíguas (separadas só por linha em branco) logo
 * depois do cabeçalho.
 */
export function pruneTitleOptions(md: string, picks: readonly TitlePick[]): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i++;
    const header = sectionHeaderName(line);
    const m = header?.match(/^DESTAQUE (\d+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    // Coleta o bloco de opções: linhas de título e brancos, até o 1º parágrafo.
    const block: string[] = [];
    let j = i;
    while (j < lines.length && (lines[j].trim() === "" || /^\*\*\[.+?\]\(/.test(lines[j].trim()))) {
      block.push(lines[j]);
      j++;
    }
    const options = block.filter((l) => l.trim() !== "");
    if (options.length <= 1) continue;
    const pick = picks.find((p) => p.destaque === n);
    const chosen =
      (pick && options.find((l) => l.trim().match(/^\*\*\[(.+?)\]\(/)?.[1].trim() === pick.chosen.trim())) ??
      options[0];
    out.push("", chosen, "");
    i = j;
  }
  return out.join("\n");
}

export interface AutofixReplacement {
  text: string;
  suggested_fix: string;
  /** "newsletter" e/ou "social" — de onde o texto foi corrigido. */
  sources: readonly string[];
}

/** Aplica as correções `applied` do fact-check ao baseline (1ª ocorrência de cada). */
export function applyAutofixReplacements(
  content: string,
  replacements: readonly AutofixReplacement[],
  target: "newsletter" | "social",
): string {
  let out = content;
  for (const r of replacements) {
    if (!r.sources.includes(target) || !r.text || !out.includes(r.text)) continue;
    out = out.replace(r.text, r.suggested_fix);
  }
  return out;
}

/**
 * Se o final contém o erro plantado (`wrong_value`) e o baseline ainda não,
 * troca a 1ª ocorrência de `correct_value` no baseline. Sem os dois valores,
 * no-op.
 */
export function applyIntentionalError(
  baseline: string,
  final: string,
  err: { correct_value?: string | null; wrong_value?: string | null } | null | undefined,
): string {
  const correct = err?.correct_value?.trim();
  const wrong = err?.wrong_value?.trim();
  if (!correct || !wrong || correct.includes("PREENCHER") || wrong.includes("PREENCHER")) return baseline;
  if (!final.includes(wrong) || baseline.includes(wrong) || !baseline.includes(correct)) return baseline;
  return baseline.replace(correct, wrong);
}

/**
 * Reconstrói o `02-reviewed.md` do fim do Stage 2 a partir do último
 * arquivo da pipeline (`02-humanized.md`/`02-clarice-corrected.md`), para as
 * edições sem baseline confiável (#9356, backfill). Aproximação: o que a
 * pipeline fez entre esse arquivo e o fim do Stage 2 e não está nesta lista
 * (ex.: correção da Clarice via MCP gravada direto em `02-reviewed.md`)
 * aparece como diff — por isso o resultado é sempre rotulado
 * `baseline: "reconstructed"`.
 */
export function reconstructStage2Newsletter(input: {
  pipelineOutput: string;
  final: string;
  titlePicks: readonly TitlePick[];
  intentionalError?: { correct_value?: string | null; wrong_value?: string | null } | null;
}): string {
  const pruned = pruneTitleOptions(input.pipelineOutput, input.titlePicks);
  return applyIntentionalError(pruned, input.final, input.intentionalError);
}

export interface SectionChange {
  section: string;
  added: number;
  removed: number;
  /** Até 2 linhas de amostra de cada lado, cortadas em 120 chars. */
  sample_removed: string[];
  sample_added: string[];
}

function splitSections(md: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = "intro";
  sections.set(current, []);
  for (const line of md.split("\n")) {
    const header = sectionHeaderName(line);
    if (header) {
      current = header;
      if (!sections.has(current)) sections.set(current, []);
    }
    if (line.trim() === "" || line.trim() === "---") continue;
    sections.get(current)!.push(line.trim());
  }
  return sections;
}

/** Multiconjunto de `a` menos `b` (preserva ordem de `a`). */
function multisetMinus(a: readonly string[], b: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const c = counts.get(x) ?? 0;
    if (c > 0) counts.set(x, c - 1);
    else out.push(x);
  }
  return out;
}

/**
 * Diff por seção (linhas não-vazias, como multiconjunto — reordenar
 * parágrafos dentro da seção não conta; mover um item de seção conta nas
 * duas). Entrada já normalizada. Seções sem mudança não aparecem.
 */
export function diffBySection(baseline: string, final: string): SectionChange[] {
  const a = splitSections(baseline);
  const b = splitSections(final);
  const names = [...new Set([...a.keys(), ...b.keys()])];
  const changes: SectionChange[] = [];
  const cut = (s: string) => (s.length > 120 ? s.slice(0, 117) + "..." : s);
  for (const name of names) {
    const removed = multisetMinus(a.get(name) ?? [], b.get(name) ?? []);
    const added = multisetMinus(b.get(name) ?? [], a.get(name) ?? []);
    if (removed.length === 0 && added.length === 0) continue;
    changes.push({
      section: name,
      added: added.length,
      removed: removed.length,
      sample_removed: removed.slice(0, 2).map(cut),
      sample_added: added.slice(0, 2).map(cut),
    });
  }
  return changes;
}
