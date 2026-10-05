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
 * Desde o #9641, também identifica itens por URL (`extractNewsletterItems`)
 * pra separar **cortes** (fora da contagem enquanto a pipeline entrega >10
 * itens — decisão do editor de 01/10/2026 na #7972) de **inclusões**.
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

// ---------------------------------------------------------------------------
// Itens por URL (#9641): cortes × inclusões
// ---------------------------------------------------------------------------

/** Linha de item/título: `**[Título](https://…)**` (espaços de quebra no fim tolerados). */
const ITEM_LINE_RE = /^\*\*\[(.+)\]\((https?:\/\/[^\s)]+)\)\*\*$/;
const LINK_TARGET_RE = /\]\((https?:\/\/[^\s)]+)\)/g;

export interface NewsletterItem {
  url: string;
  title: string;
  /** Nome da seção (`sectionHeaderName`), ex.: `RADAR`, `DESTAQUE 1`. */
  section: string;
}

/** Seção do pool = nem intro, nem destaque, nem bloco da pipeline. */
export function isPoolSection(section: string): boolean {
  return (
    section !== "intro" &&
    !/^DESTAQUE \d+$/.test(section) &&
    !(PIPELINE_OWNED_SECTIONS as readonly string[]).includes(section)
  );
}

/**
 * Itens da newsletter — toda linha `**[Título](url)**` fora dos blocos da
 * pipeline (É IA?, ERRO INTENCIONAL, SORTEIO, PARA ENCERRAR). Nos destaques
 * é a linha de título; no pool, a linha do item. Pura.
 */
export function extractNewsletterItems(md: string): NewsletterItem[] {
  const items: NewsletterItem[] = [];
  let section = "intro";
  for (const raw of md.split("\n")) {
    const header = sectionHeaderName(raw);
    if (header) {
      section = header;
      continue;
    }
    if ((PIPELINE_OWNED_SECTIONS as readonly string[]).includes(section)) continue;
    const m = raw.trim().match(ITEM_LINE_RE);
    if (m) items.push({ url: m[2], title: m[1].trim(), section });
  }
  return items;
}

/** Nomes das seções (`sectionHeaderName`) presentes no texto. */
export function sectionNames(md: string): Set<string> {
  const names = new Set<string>();
  for (const line of md.split("\n")) {
    const h = sectionHeaderName(line);
    if (h) names.add(h);
  }
  return names;
}

/** Todo alvo de link markdown `](url)` do texto. */
export function linkTargets(md: string): Set<string> {
  return new Set([...md.matchAll(LINK_TARGET_RE)].map((m) => m[1]));
}

/**
 * Cortes (#9641): item de SEÇÃO DO POOL presente na saída da pipeline cuja
 * URL não aparece em lugar nenhum do final (nem como item de outra seção, nem
 * como link no corpo de um destaque). Item que muda de seção ou vira destaque
 * NÃO é corte — segue aparecendo no diff das duas seções. Destaque que sai
 * também não entra aqui (é troca de destaque, conta como modificação). Pura.
 */
export function findCutItems(baseline: string, final: string): NewsletterItem[] {
  const finalTargets = linkTargets(final);
  const seen = new Set<string>();
  return extractNewsletterItems(baseline).filter((it) => {
    if (!isPoolSection(it.section) || finalTargets.has(it.url) || seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });
}

/**
 * Inclusões (#9641): item do final cuja URL não estava entre os itens da
 * saída da pipeline (`pipelineUrls`). **Premissa registrada:** a URL é a
 * identidade do item, então trocar a URL da mesma história (fonte primária no
 * lugar da imprensa) conta como inclusão — é como o editor mediu à mão em
 * 01/10/2026 na #7972 ("parte das inclusões é troca de URL da mesma
 * história"). Pura.
 */
export function findIncludedItems(final: string, pipelineUrls: ReadonlySet<string>): NewsletterItem[] {
  const seen = new Set<string>();
  return extractNewsletterItems(final).filter((it) => {
    if (pipelineUrls.has(it.url) || seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });
}

function isBlockBoundary(line: string): boolean {
  const t = line.trim();
  return t === "" || t === "---" || sectionHeaderName(line) !== null || ITEM_LINE_RE.test(t);
}

/**
 * Tira do baseline o bloco de cada item cortado (linha do item + resumo até
 * a próxima linha em branco/item/cabeçalho/`---`; se o resumo vier depois de
 * uma linha em branco, sai também). Seção do pool que fica sem nenhum item
 * perde o cabeçalho — senão cortar uma seção inteira ainda apareceria como
 * `-1` —, a menos que a seção exista no final (`finalSections`: o editor
 * cortou tudo e incluiu outro item ali; o cabeçalho não é mudança). Só atua
 * em seções do pool. Pura.
 */
export function removeCutItemBlocks(
  md: string,
  cutUrls: ReadonlySet<string>,
  finalSections: ReadonlySet<string> = new Set(),
): string {
  if (cutUrls.size === 0) return md;
  const lines = md.split("\n");
  const out: string[] = [];
  const touchedSections = new Set<string>();
  let section = "intro";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const header = sectionHeaderName(line);
    if (header) section = header;
    const m = header ? null : line.trim().match(ITEM_LINE_RE);
    if (m && isPoolSection(section) && cutUrls.has(m[2])) {
      touchedSections.add(section);
      let j = i + 1;
      while (j < lines.length && !isBlockBoundary(lines[j])) j++;
      if (j === i + 1) {
        // Formato "título, linha em branco, resumo".
        let k = j;
        while (k < lines.length && lines[k].trim() === "") k++;
        if (k < lines.length && !isBlockBoundary(lines[k])) {
          j = k;
          while (j < lines.length && !isBlockBoundary(lines[j])) j++;
        }
      }
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  if (touchedSections.size === 0) return out.join("\n");

  // Cabeçalho de seção do pool que ficou vazia.
  const kept: string[] = [];
  for (let k = 0; k < out.length; k++) {
    const header = sectionHeaderName(out[k]);
    if (header && touchedSections.has(header) && !finalSections.has(header)) {
      let n = k + 1;
      while (n < out.length && out[n].trim() === "") n++;
      if (n >= out.length || out[n].trim() === "---" || sectionHeaderName(out[n]) !== null) continue;
    }
    kept.push(out[k]);
  }
  return kept.join("\n");
}
