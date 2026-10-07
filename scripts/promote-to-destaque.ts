#!/usr/bin/env tsx
/**
 * promote-to-destaque.ts (#8757)
 *
 * Promove um item do pool (RADAR / USE MELHOR / LANÇAMENTOS / vídeo — qualquer
 * bucket de `01-approved.json` fora de `highlights[]`) a destaque numa edição
 * de 2 destaques, INSERINDO na posição pedida e deslocando os existentes
 * (ex: `--position 1` → D1 antigo vira D2, D2 antigo vira D3).
 *
 * Por que existe: `reorder-destaques.ts` só aceita permutação dos destaques
 * JÁ existentes. Na edição 260924 a promoção de um item do RADAR a D1 foi
 * feita à mão — rodízio de `04-d{N}-*` no OneDrive (sumiram 7 arquivos,
 * mesma causa já documentada em #8058/#8679), `01-approved*.json` esquecido
 * (`upload-images-public` nunca subiu o `d3_2x1`) e `02-d{N}-prompt.md`
 * trocado de slot.
 *
 * Mecanismo: a inserção É uma permutação de [1,2,3] em que o slot 3 — que
 * numa edição de 2 destaques não existe — gira para a posição nova
 * (`--position 1` ⇒ newOrder [3,1,2]). Todo o movimento de arquivo reusa os
 * helpers já verificados de `reorder-destaques.ts` (`stageAndWriteVerified`,
 * #5564 — staging local, nunca nome temporário dentro do `data/`), e como o
 * `d3` antigo não existe, o slot novo simplesmente fica vazio.
 *
 * O que ESTE script faz (mecânico):
 *   1. `04-d{N}-*` e `_internal/02-d{N}-{prompt.md,sd-prompt.json,draft.md}`
 *      deslocados;
 *   2. `01-approved.json` + `01-approved-capped.json`: item removido do
 *      bucket de origem e inserido em `highlights[]` na posição, ranks
 *      renumerados 1..3;
 *   3. `02-reviewed.md` (#9755, mesma limpeza que o swap ganhou no #9601):
 *      headers `**DESTAQUE N |` renumerados (N≥posição → N+1), placeholder do
 *      destaque novo inserido na posição, item promovido tirado da seção de
 *      pool de origem (senão a URL fica 2×), título provisório inserido no
 *      TÍTULO/SUBTÍTULO (marcador `swap-destaque-titulo-pending.json` →
 *      `swap-destaque.ts --finalize-titulo`) e contagem da intro re-sincronizada;
 *   4. `03-social.md`: seções `## d{N}` renumeradas;
 *   5. `_internal/intentional-error.json` (`location`), carimbos de social/
 *      carrossel, `fact-check-sources/`, `04-crop-review.json`,
 *      `06-public-images.json` (chaves das posições deslocadas invalidadas).
 *
 * O que NÃO faz (exige LLM, geração de imagem ou decisão editorial — sai
 * como `next_steps` no JSON):
 *   - escrever o texto do bloco `**DESTAQUE {posição}**` (substituindo o
 *     placeholder) em `02-reviewed.md` (`writer-destaque`) e o `## d{posição}`
 *     em `03-social.md`;
 *   - escrever `_internal/02-d{posição}-prompt.md` e gerar a imagem
 *     (`image-generate.ts --destaque d{posição}`), cards, carrossel e upload.
 *
 * Edição já com 3 destaques: recusa (exit 2). Pela regra do #3369, promover
 * com 3 destaques é SUBSTITUIR um existente, não inserir — outra operação.
 *
 * Uso:
 *   npx tsx scripts/promote-to-destaque.ts --edition-dir data/editions/2609/260924 \
 *     --url https://exemplo.com/artigo --position 1 [--dry-run]
 */
import { existsSync, readFileSync } from "node:fs";
import {
  annotateRenamesNotReverted,
  writeFilesVerified,
  type VerifiedWrite,
} from "./lib/write-files-verified.ts"; // #9188, #9320
import { resolve } from "node:path";
import { parseArgsWithTrueDefault, isMainModule } from "./lib/cli-args.ts";
import {
  renameDestaqueImages,
  renameDestaquePrompts,
  reorderSocialMd,
  updateIntentionalErrorLocationJson,
  reindexCarouselSourceHashes,
  reorderFactCheckSources,
  reorderCropReviewJson,
  invalidatePublicImagesForReorder,
} from "./reorder-destaques.ts";
import {
  loadIntentionalErrorJson,
  writeIntentionalErrorJson,
  intentionalErrorJsonPath,
} from "./lib/intentional-errors.ts";
import { planHumanizerReseal } from "./lib/humanizer-social-seal.ts"; // #9679
import {
  removePoolItemFromMd,
  syncIntroCountInMd,
  renderDestaquePlaceholder,
} from "./swap-destaque.ts"; // #9755
import {
  locateTituloSubtituloLines,
  parsePendingTitulos,
  sanitizeTituloSegment,
  serializePendingTitulos,
  toProvisionalTitulo,
  tituloPendingPath,
  upsertPendingTitulo,
  type PendingTitulo,
} from "./lib/titulo-provisional.ts"; // #9755
import { useMelhorPostReselectStep } from "./lib/use-melhor-post.ts"; // #9755

/** Pure: newOrder que insere o slot vazio (3) na `position` (1..3). */
export function insertionOrder(position: number): number[] {
  if (![1, 2, 3].includes(position)) throw new Error(`--position precisa ser 1, 2 ou 3 (recebido: ${position})`);
  const existing = [1, 2];
  return [...existing.slice(0, position - 1), 3, ...existing.slice(position - 1)];
}

type ApprovedJson = { highlights?: unknown[]; [bucket: string]: unknown };

function sameUrl(a: unknown, url: string): boolean {
  return typeof a === "string" && a.trim() === url.trim();
}

/**
 * Pure: remove o item com `url` de qualquer bucket fora de `highlights` e o
 * insere em `highlights` na `position`, renumerando `rank`. Retorna o bucket
 * de origem, ou `null` se a URL não estiver em nenhum bucket (nada muda).
 * Lança se a URL já for destaque ou se `highlights` não tiver 2 itens.
 */
export function promoteInApprovedJson(
  json: ApprovedJson,
  url: string,
  position: number,
): { sourceBucket: string } | null {
  const h = json.highlights;
  if (!Array.isArray(h)) throw new Error("01-approved: `highlights` ausente");
  if (h.some((x) => sameUrl((x as { url?: unknown })?.url, url))) {
    throw new Error(`a URL já é destaque: ${url}`);
  }
  if (h.length !== 2) {
    throw new Error(
      `a edição tem ${h.length} destaque(s); promover com inserção só vale para 2 → 3. ` +
        `Com 3 destaques, promover é SUBSTITUIR um existente (#3369) — outra operação.`,
    );
  }
  for (const [bucket, items] of Object.entries(json)) {
    if (bucket === "highlights" || !Array.isArray(items)) continue;
    const idx = items.findIndex((it) => sameUrl((it as { url?: unknown })?.url, url));
    if (idx < 0) continue;
    const [article] = items.splice(idx, 1) as Record<string, unknown>[];
    const highlight = {
      rank: position,
      score: article.score ?? null,
      bucket: typeof article.category === "string" ? article.category : bucket,
      url: article.url,
      article,
    };
    h.splice(position - 1, 0, highlight);
    h.forEach((x, i) => {
      if (x && typeof x === "object") (x as { rank?: number }).rank = i + 1;
    });
    return { sourceBucket: bucket };
  }
  return null;
}

/** Pure: renumera headers `**DESTAQUE N |` com N ≥ position para N+1. */
export function shiftDestaqueHeadersInMd(md: string, position: number): string {
  return md.replace(/^\*\*DESTAQUE\s+(\d+)(\s*\|)/gm, (full, n: string, rest: string) => {
    const num = parseInt(n, 10);
    return num >= position ? `**DESTAQUE ${num + 1}${rest}` : full;
  });
}

/**
 * #9755: insere o bloco placeholder do destaque novo na `position`, DEPOIS de
 * `shiftDestaqueHeadersInMd` (os existentes já renumerados). Posição com
 * vizinho seguinte → entra antes do header `**DESTAQUE {position+1} |`;
 * posição final → depois do último bloco DESTAQUE, antes do `---` que abre a
 * próxima seção (uma caixa de divulgação na lacuna fica antes do novo,
 * mesma fronteira do `blockRe` do swap, #9254). Sem âncora → md intacto,
 * `inserted: false`. @pure
 */
export function insertDestaquePlaceholderInMd(
  md: string,
  position: 1 | 2 | 3,
  title: string,
  url: string,
): { md: string; inserted: boolean } {
  const placeholder = renderDestaquePlaceholder(position, title, url);
  const next = new RegExp(`^\\*\\*DESTAQUE\\s+${position + 1}\\s*\\|`, "m").exec(md);
  if (next) {
    return { md: md.slice(0, next.index) + placeholder + "\n\n---\n\n" + md.slice(next.index), inserted: true };
  }
  if (position === 1) return { md, inserted: false };
  const prev = new RegExp(`^\\*\\*DESTAQUE\\s+${position - 1}\\s*\\|`, "m").exec(md);
  if (!prev) return { md, inserted: false };
  const rest = md.slice(prev.index);
  const end = /\n+---[ \t]*\n+(?=\*\*(?:DESTAQUE\s+\d|🚀|🔬|📰|📡|🛠️|VÍDEOS?|🎁|🙋|ERRO\s+INTENCIONAL|ASSINE))/u.exec(rest);
  if (end) {
    const at = prev.index + end.index;
    return { md: md.slice(0, at) + "\n\n---\n\n" + placeholder + md.slice(at), inserted: true };
  }
  const trimmed = md.replace(/\s+$/, "");
  return { md: trimmed + "\n\n---\n\n" + placeholder + "\n", inserted: true };
}

/**
 * #9755: re-deriva o bloco TÍTULO/SUBTÍTULO de uma edição de 2 destaques
 * inserindo o título `provisional` na `position` — os segmentos existentes
 * (inclusive se o editor os reescreveu) são preservados e só deslocados:
 * TÍTULO = D1, SUBTÍTULO = `D2 | D3`. Bloco ausente → `no_block`; bloco que
 * não tem exatamente 2 títulos (escrito à mão) → `unexpected_shape`, intacto.
 * @pure
 */
export function insertTitleInTituloSubtitulo(
  md: string,
  position: 1 | 2 | 3,
  provisional: string,
): { md: string; status: "updated" | "no_block" | "unexpected_shape" } {
  const lines = md.split("\n");
  const loc = locateTituloSubtituloLines(lines);
  if (!loc || loc.titleIdx < 0) return { md, status: "no_block" };
  if (loc.subtitleIdx < 0) return { md, status: "unexpected_shape" };
  const units = [
    lines[loc.titleIdx].trim(),
    ...lines[loc.subtitleIdx].split("|").map((x) => x.trim()),
  ].filter((x) => x.length > 0);
  if (units.length !== 2) return { md, status: "unexpected_shape" };
  units.splice(position - 1, 0, sanitizeTituloSegment(provisional));
  lines[loc.titleIdx] = units[0];
  lines[loc.subtitleIdx] = units.slice(1).join(" | ");
  return { md: lines.join("\n"), status: "updated" };
}

export interface PromoteMdUpdates {
  placeholder_inserted: boolean;
  pool_item_removed: boolean;
  section_removed: string | null;
  titulo_subtitulo: "updated" | "no_block" | "unexpected_shape";
  provisional_title: string;
  intro_count: { before: number | null; after: number | null; changed: boolean };
}

/**
 * #9755: tudo que o promote muda no texto de `02-reviewed.md`, na ordem:
 * (1) renumera headers; (2) placeholder do destaque novo; (3) tira o item
 * promovido do pool de origem (`removePoolItemFromMd` do swap); (4) título
 * provisório no TÍTULO/SUBTÍTULO; (5) contagem da intro. @pure
 */
export function applyPromoteToReviewedMd(
  md: string,
  position: 1 | 2 | 3,
  promotedTitle: string,
  promotedUrl: string,
): { md: string; updates: PromoteMdUpdates } {
  const provisional = toProvisionalTitulo(promotedTitle);
  const shifted = shiftDestaqueHeadersInMd(md, position);
  const ph = insertDestaquePlaceholderInMd(shifted, position, provisional, promotedUrl);
  const pool = removePoolItemFromMd(ph.md, promotedUrl);
  const titulo = insertTitleInTituloSubtitulo(pool.md, position, provisional);
  const intro = syncIntroCountInMd(titulo.md);
  return {
    md: intro.md,
    updates: {
      placeholder_inserted: ph.inserted,
      pool_item_removed: pool.removed,
      section_removed: pool.section_removed,
      titulo_subtitulo: titulo.status,
      provisional_title: provisional,
      intro_count: { before: intro.before, after: intro.after, changed: intro.changed },
    },
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function jsonContent(data: unknown): string {
  return JSON.stringify(data, null, 2) + "\n";
}

/** #9188: escrita verificada (OneDrive) de um JSON avulso. */
function writeJson(path: string, data: unknown): void {
  writeFilesVerified([{ path, content: jsonContent(data) }], "promote-to-destaque");
}

export interface PromoteResult {
  position: number;
  new_order: number[];
  source_bucket: string;
  dry_run: boolean;
  rewritten: string[];
  renamed: Array<{ from: string; to: string }>;
  warnings: string[];
  next_steps: string[];
  /** #9755: o que mudou no texto de 02-reviewed.md (`null` = md ausente). */
  md_updates: PromoteMdUpdates | null;
}

export function promoteToDestaque(
  editionDir: string,
  url: string,
  position: number,
  dryRun = false,
): PromoteResult {
  const internalDir = resolve(editionDir, "_internal");
  const newOrder = insertionOrder(position);
  const rewritten: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const warnings: string[] = [];

  // 0. Valida e prepara os JSONs ANTES de mexer em qualquer arquivo — URL
  //    ausente ou edição com 3 destaques abortam sem efeito colateral.
  const approvedPaths = ["01-approved.json", "01-approved-capped.json"]
    .map((f) => resolve(internalDir, f))
    .filter((p) => existsSync(p));
  if (approvedPaths.length === 0) throw new Error(`nenhum 01-approved*.json em ${internalDir}`);
  const updated: Array<{ path: string; data: ApprovedJson }> = [];
  let sourceBucket: string | null = null;
  let promotedTitle: string | null = null;
  for (const p of approvedPaths) {
    const data = readJson(p) as ApprovedJson;
    const r = promoteInApprovedJson(data, url, position);
    if (!r) {
      throw new Error(`URL não encontrada em nenhum bucket de ${p}: ${url}`);
    }
    sourceBucket = sourceBucket ?? r.sourceBucket;
    if (promotedTitle === null) {
      const art = (data.highlights![position - 1] as { article?: { title?: unknown } }).article;
      promotedTitle = typeof art?.title === "string" && art.title.trim() ? art.title.trim() : url;
    }
    updated.push({ path: p, data });
  }
  const pos = position as 1 | 2 | 3; // validado por insertionOrder()

  // 1. Arquivos binários/prompt primeiro (única etapa capaz de abortar no
  //    meio — mesmo sequenciamento de reorder-destaques.ts, #5087).
  renamed.push(...renameDestaqueImages(editionDir, newOrder, dryRun));
  renamed.push(...renameDestaquePrompts(internalDir, newOrder, dryRun));

  // 2. JSONs canônicos. #9188: 01-approved*.json + 02-reviewed.md +
  //    03-social.md vão num LOTE verificado (writeFilesVerified) — nunca
  //    meio-gravado (ex: JSON com o destaque novo e o md ainda renumerado
  //    pela ordem antiga). Gravado antes do carimbo do social, que relê o disco.
  const pendingWrites: VerifiedWrite[] = [];
  for (const { path, data } of updated) {
    pendingWrites.push({ path, content: jsonContent(data) });
  }

  // 3. 02-reviewed.md (#9755): renumera, placeholder do destaque novo, tira o
  //    item do pool, título provisório no TÍTULO/SUBTÍTULO e contagem da intro.
  //    O TEXTO do bloco novo continua sendo do writer-destaque.
  const mdPath = resolve(editionDir, "02-reviewed.md");
  let mdUpdates: PromoteMdUpdates | null = null;
  if (existsSync(mdPath)) {
    const md = readFileSync(mdPath, "utf8");
    const applied = applyPromoteToReviewedMd(md, pos, promotedTitle!, url);
    mdUpdates = applied.updates;
    if (applied.md !== md) pendingWrites.push({ path: mdPath, content: applied.md });
    if (!applied.updates.placeholder_inserted) {
      warnings.push(`02-reviewed.md: âncora do DESTAQUE ${position} não encontrada — placeholder NÃO inserido; escrever o bloco à mão.`);
    }
    if (!applied.updates.pool_item_removed) {
      warnings.push(`02-reviewed.md: o item promovido não foi achado em nenhuma seção de pool — conferir se a URL ficou duplicada.`);
    }
    if (applied.updates.titulo_subtitulo === "updated") {
      // Mesmo marcador do swap: o invariante titulo-subtitulo-not-provisional
      // barra o gate até `swap-destaque.ts --finalize-titulo`.
      const markerPath = tituloPendingPath(editionDir);
      let existing: PendingTitulo[] = [];
      if (existsSync(markerPath)) {
        try {
          existing = parsePendingTitulos(readFileSync(markerPath, "utf8"));
        } catch (e) {
          warnings.push(`marcador ${markerPath} ilegível (${(e as Error).message}) — sobrescrito.`);
        }
      }
      // Entradas pendentes de posições deslocadas acompanham a renumeração.
      const shiftedEntries = existing.map((e) =>
        e.position >= pos ? { ...e, position: (e.position + 1) as 1 | 2 | 3 } : e,
      ).filter((e) => e.position <= 3);
      pendingWrites.push({
        path: markerPath,
        content: serializePendingTitulos(
          upsertPendingTitulo(shiftedEntries, { position: pos, provisional_title: applied.updates.provisional_title }),
        ),
      });
    } else if (applied.updates.titulo_subtitulo === "unexpected_shape") {
      warnings.push(`02-reviewed.md: bloco TÍTULO/SUBTÍTULO fora do formato de 2 destaques (escrito à mão?) — não alterado; incluir o D${position} à mão.`);
    }
  }

  // 3b. 03-social.md — conteúdo computado aqui, gravado no mesmo lote.
  const socialPath = resolve(editionDir, "03-social.md");
  let socialShift: { before: string; after: string } | null = null;
  if (existsSync(socialPath)) {
    const md = readFileSync(socialPath, "utf8");
    const shifted = reorderSocialMd(md, newOrder);
    if (shifted !== md) {
      pendingWrites.push({ path: socialPath, content: shifted });
      socialShift = { before: md, after: shifted };
    }
  }

  if (!dryRun) {
    try {
      writeFilesVerified(pendingWrites, "promote-to-destaque");
    } catch (err) {
      throw annotateRenamesNotReverted(err, renamed); // #9320
    }
  }
  for (const w of pendingWrites) rewritten.push(w.path);

  // 4. intentional-error.json
  const iePath = intentionalErrorJsonPath(editionDir);
  const ie = loadIntentionalErrorJson(iePath);
  if (ie) {
    const { record, changed } = updateIntentionalErrorLocationJson(ie, newOrder);
    if (changed) {
      if (!dryRun) writeIntentionalErrorJson(iePath, record);
      rewritten.push(iePath);
    }
  }

  // 5. Carimbo do carrossel. O hash SOCIAL (.social-source-hash.json) NÃO é
  //    recarimbado aqui (#9321, espelho do #9149/#9169): o 01-approved.json já
  //    tem o item promovido, mas 03-social.md ainda não tem a seção ## d{pos}
  //    dele — recarimbar agora silenciaria o social-hash-fresh do Stage 4.
  //    O recarimbo é um next_step, só depois do splice social.
  const carousel = reindexCarouselSourceHashes(editionDir, newOrder, dryRun);
  if (carousel) rewritten.push(carousel.path);

  // 5b. Selo do humanizador (#9679): a renumeração dos headers não muda texto.
  //     Re-selar aqui (só se o selo batia antes) faz o check pós-splice apontar
  //     SÓ a seção nova (`main_d{pos}`) em vez de todas as permutadas.
  let humanizerStaleBefore = false;
  if (socialShift) {
    const plan = planHumanizerReseal(
      editionDir,
      socialShift.before,
      socialShift.after,
      `promote-to-destaque --position ${position} (#9679, #9796): headers ## d{N} renumerados e seções reordenadas, texto intacto`,
    );
    if (plan.status === "reseal") {
      if (!dryRun) writeFilesVerified([{ path: plan.path, content: plan.content }], "promote-to-destaque");
      rewritten.push(plan.path);
    } else if (plan.status === "stale_before") {
      humanizerStaleBefore = true;
    }
  }

  // 6. fact-check-sources (secundário: falha vira warning, igual ao reorder).
  try {
    const fc = reorderFactCheckSources(internalDir, newOrder, dryRun);
    rewritten.push(...fc.modified);
    renamed.push(...fc.renamed);
  } catch (e) {
    warnings.push(`fact-check-sources/ pode ter ficado parcialmente deslocado: ${(e as Error).message}`);
  }

  // 7. 04-crop-review.json + 06-public-images.json (fail-soft em JSON ruim).
  const cropPath = resolve(internalDir, "04-crop-review.json");
  const publicPath = resolve(editionDir, "06-public-images.json");
  for (const [path, apply] of [
    [cropPath, (d: unknown) => reorderCropReviewJson(d, newOrder)],
    [publicPath, (d: unknown) => invalidatePublicImagesForReorder(d, newOrder)],
  ] as const) {
    if (!existsSync(path)) continue;
    let data: unknown;
    try {
      data = readJson(path);
    } catch (e) {
      warnings.push(`${path} ilegível (${(e as Error).message}), pulando.`);
      continue;
    }
    const r = apply(data);
    if (r.changed) {
      if (!dryRun) writeJson(path, r.data);
      rewritten.push(path);
    }
  }
  if (rewritten.includes(publicPath)) {
    warnings.push("06-public-images.json: chaves das posições deslocadas removidas — rodar upload-images-public.ts de novo.");
  }

  const d = `d${position}`;
  const nextSteps = [
    // #9102: sem isto o writer-destaque escreve sem texto-fonte e o fact-checker lê manifest defasado.
    `Re-baixar a fonte do destaque novo e invalidar o manifest do fact-check: npx tsx scripts/refresh-destaque-sources.ts --edition-dir ${editionDir}/ — rodar UMA vez; passar o path da entrada de sources com destaque === ${position} como source_text_path ao writer-destaque.`,
    `Escrever o bloco **DESTAQUE ${position}** em 02-reviewed.md (writer-destaque) a partir do item promovido, substituindo o placeholder [RASCUNHO PENDENTE].`,
    `Depois de integrar o texto do writer-destaque: trocar no TÍTULO/SUBTÍTULO o título provisório pelo final — npx tsx scripts/swap-destaque.ts --finalize-titulo --edition-dir ${editionDir} (até lá o invariante titulo-subtitulo-not-provisional do Stage 4 barra o gate, #9755)`,
    `Escrever a seção ## ${d} em 03-social.md (# Social e # Curto).`,
    `Humanizar a seção nova ## ${d} e gravar o selo: npx tsx scripts/check-humanizer-social.ts --write --bypass-reason "seção ${d} nova (promote)" --edition-dir ${editionDir}` +
      (humanizerStaleBefore
        ? ` — ATENÇÃO: o 03-social.md já divergia do selo ANTES do promote, então as outras seções editadas depois da humanização também precisam passar pelo humanizador.`
        : ` (as demais seções já estão seladas, #9679).`),
    `Só DEPOIS do splice social: recarimbar o hash social — npx tsx scripts/refresh-social-hash.ts --edition-dir ${editionDir} (até lá o social-hash-fresh do Stage 4 acusa de propósito, #9321)`,
    `Escrever _internal/02-${d}-prompt.md e gerar a imagem: npx tsx scripts/image-generate.ts --editorial ${editionDir}/_internal/02-${d}-prompt.md --out-dir ${editionDir}/ --destaque ${d}`,
    `Regerar cards/carrossel e subir as imagens: gen-carousel-cards.ts + upload-images-public.ts.`,
    `Rodar check-invariants.ts --stage 4.`,
  ];
  // #9755: o item promovido era o do 4º post social → re-selecionar.
  const umStep = useMelhorPostReselectStep(editionDir, url);
  if (umStep) nextSteps.push(umStep);

  return {
    position,
    new_order: newOrder,
    source_bucket: sourceBucket!,
    dry_run: dryRun,
    rewritten,
    renamed,
    warnings,
    next_steps: nextSteps,
    md_updates: mdUpdates,
  };
}

function main(): void {
  const args = parseArgsWithTrueDefault(process.argv.slice(2));
  const editionDir = args["edition-dir"];
  const url = args.url;
  const position = parseInt(args.position ?? "", 10);
  if (!editionDir || !url || !Number.isFinite(position)) {
    console.error("Uso: promote-to-destaque.ts --edition-dir <dir> --url <url do item> --position <1|2|3> [--dry-run]");
    process.exit(2);
  }
  try {
    const result = promoteToDestaque(resolve(editionDir), url, position, args["dry-run"] === "true");
    for (const w of result.warnings) console.error(`⚠️  ${w}`);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`promote-to-destaque: ${(e as Error).message}`);
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
