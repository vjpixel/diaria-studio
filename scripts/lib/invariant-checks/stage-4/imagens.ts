/**
 * Invariantes do Stage 4 — imagens públicas, conteúdo das imagens, crop review e upload do card 4x5 (#14057).
 *
 * Família extraída de `../stage-4.ts` (divisão sem mudança de lógica). O
 * registro `STAGE_4_RULES` e o reexport público continuam em `../stage-4.ts`:
 * importe sempre de lá.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantViolation } from "../types.ts";
import { isCropReviewEntryStale, isSilencedCropWarn } from "../../crop-review-entry.ts"; // #13997
// #10346: ciclo de import com run-image-crop-reviewer.ts (que importa isCropReviewEntryStale daqui) é
// seguro — os dois lados só usam o outro dentro de funções, nunca no topo do módulo.
import { planEstiloRegenerationForEdition } from "../../../run-image-crop-reviewer.ts";
import { readEstiloFalsePositiveMd5s, isEstiloFalsePositive } from "../../estilo-false-positives.ts"; // #10328
import { extractDestaqueUrls, extractPromptUrl } from "../../../match-prompts-to-destaques.ts";
import { urlsMatch } from "../../url-utils.ts";
import { readDestaqueCount } from "../stage-3.ts";
import { hero2x1KeyFor, isDestaqueImagePresent } from "../../shared/public-image-keys.ts"; // #7399, extraído em #7596
import { type PublicImagesJson } from "./_shared.ts";

/**
 * `06-public-images.json` deve ter, pra cada destaque d1/d2/d3, uma URL
 * pública utilizável por LinkedIn/Facebook. Sem isso, publish-linkedin envia
 * image_url=null e Make rejeita (DLQ incident 260508).
 * #2147: URLs sociais são KV Worker (não Drive uc?id).
 * #7399: a chave base 1x1 (`d1`/`d2`/`d3`) deixou de ser uploadada — a
 * presença é satisfeita por `d{N}_4x5` OU pelo hero 2:1 (`hero2x1KeyFor`).
 * #7596: regra compartilhada com `assertCacheCompleteness` (upload-images-
 * public.ts) via `isDestaqueImagePresent` (lib/shared/public-image-keys.ts).
 *
 * #2133/#2141: também valida d2_2x1/d3_2x1/cover (hero 2:1 consumidos pelo email
 * body via substitute-image-urls). Ausentes aqui = email sai com placeholders crus.
 * Cross-mode blind spot: social mode preenche d2/d3 mas não d2_2x1/d3_2x1; se
 * newsletter mode falhou silenciosamente, esse check pega antes do publish.
 *
 * Shape real (escrito por scripts/upload-images-public.ts):
 *   { images: { d1_4x5: { url, file_id, filename, mime_type }, cover: {...}, ... } }
 */
export function checkPublicImagesPopulated(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "06-public-images.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "public-images-exists",
        message:
          `06-public-images.json ausente — upload-images-public.ts não rodou. ` +
          `Stage 4 LinkedIn vai falhar com image_url=null (DLQ incident #999).`,
        source_issue: "#999",
        severity: "error",
        file: path,
      },
    ];
  }
  let data: PublicImagesJson;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as PublicImagesJson;
  } catch (e) {
    return [
      {
        rule: "public-images-parseable",
        message: `06-public-images.json não parseável: ${(e as Error).message}`,
        source_issue: "#999",
        severity: "error",
        file: path,
      },
    ];
  }
  const violations: InvariantViolation[] = [];
  const images = data.images ?? {};

  // #2352: d3 required only when destaque_count == 3.
  const destaqueCount = readDestaqueCount(editionDir);
  const socialDestaques = destaqueCount === 2 ? ["d1", "d2"] : ["d1", "d2", "d3"];

  // Social image presence for LinkedIn/Facebook (DLQ incident #999).
  // #7399: a chave base 1x1 (`d1`/`d2`/`d3`) deixou de ser uploadada —
  // "presença de imagem pro destaque" agora é satisfeita por QUALQUER um dos
  // dois: o card 4:5 (`d{N}_4x5`) OU o hero 2:1 (`hero2x1KeyFor`). #7596:
  // `isDestaqueImagePresent` é a MESMA função usada por assertCacheCompleteness
  // em upload-images-public.ts (lib/shared/public-image-keys.ts) — checar só
  // a chave base 1x1 (removida) sempre falhava depois do #7399, mesmo com
  // o pipeline saudável.
  for (const d of socialDestaques) {
    const heroKey = hero2x1KeyFor(d);
    if (!isDestaqueImagePresent(images, d)) {
      violations.push({
        rule: "public-images-populated",
        message: `06-public-images.json: nem images.${d}_4x5.url nem images.${heroKey}.url estão presentes (destaque ${d})`,
        source_issue: "#999",
        severity: "error",
        file: path,
      });
      continue;
    }
    for (const key of [`${d}_4x5`, heroKey]) {
      const url = images[key]?.url;
      if (typeof url === "string" && url.trim().length > 0 && !/^https?:\/\//.test(url)) {
        violations.push({
          rule: "public-images-url-shape",
          message: `06-public-images.json: images.${key}.url="${url.slice(0, 50)}" não é URL válida`,
          source_issue: "#999",
          severity: "error",
          file: path,
        });
      }
    }
  }

  // Newsletter hero 2x1 keys — required for email body substitution (#2133/#2141).
  // Absent → substitute-image-urls.ts writes literal {{IMG:04-d{N}-2x1.jpg}} and
  // exits 2. Warning (not error) so social-only runs are not blocked.
  // #2352: d3_2x1 only required when destaque_count == 3.
  const newsletterHeroKeys = destaqueCount === 2 ? ["cover", "d2_2x1"] : ["cover", "d2_2x1", "d3_2x1"];
  for (const key of newsletterHeroKeys) {
    const slot = images[key];
    const url = slot?.url;
    if (!url || typeof url !== "string" || url.trim().length === 0) {
      violations.push({
        rule: "public-images-newsletter-hero",
        message:
          `06-public-images.json: images.${key}.url ausente ou vazio — ` +
          `email body usa {{IMG:}} pra esta chave; ausente causa placeholder cru no HTML.`,
        source_issue: "#2133",
        severity: "warning",
        file: path,
      });
    }
  }

  return violations;
}

/**
 * #1730 (follow-up do #1710): content-check da imagem de destaque vs highlight
 * atual. O #1710 trocou o upstream de staleness das imagens de `02-reviewed.md`
 * → `_internal/02-d{N}-prompt.md` (correto pro mtime), mas isso narrow-ou um
 * gap: se o editor **troca o artigo do D{N}** editando headline+URL direto no
 * `02-reviewed.md` (sem rodar reorder-destaques.ts nem regenerar a imagem), o
 * prompt fica descrevendo a cena antiga, o mtime do prompt não muda → nenhum
 * flag, e a imagem publicada é de outra história.
 *
 * Esta é a versão content-aware (análoga ao social-hash-fresh #1413 que cobre
 * o 03-social.md): pra cada D{N}, compara o `destaque_url:` do frontmatter do
 * prompt (#606) com a URL principal do D{N} atual no `02-reviewed.md`. Se
 * divergem, a imagem foi gerada pra outro artigo.
 *
 * Single-sided: o prompt já carrega `destaque_url` (escrito no Stage 2/3), então
 * não precisa write-side novo. Warning, não error — gap narrowed (só dispara em
 * article-swap manual via edição crua). Edições de wording da MESMA URL são
 * corretamente ignoradas; troca de URL (mesmo da mesma história) gera warning
 * benigno — editor confirma e segue.
 */
export interface ImageContentMismatch {
  slot: "d1" | "d2" | "d3";
  promptUrl: string;
  reviewedUrl: string;
}

/**
 * Pure: compara URLs dos prompts (por slot) com as URLs em ordem do reviewed.
 * `reviewedUrls[0]` = D1, `[1]` = D2, `[2]` = D3. Slot sem URL no reviewed é
 * ignorado (outros checks cobrem reviewed incompleto).
 *
 * Distinção de 3 estados no `promptUrls[slot]` (review #1832):
 *   - `string`    → prompt existe e tem `destaque_url` → compara.
 *   - `null`      → prompt **existe mas sem** `destaque_url` → `missingFrontmatter`.
 *   - `undefined` → prompt file **não existe** → fora de escopo (all-images-exist
 *     cobre); NÃO reportar como frontmatter ausente (era a conflação do #1832).
 *
 * Comparação via `urlsMatch` (canonicalize compartilhado, #523/#626): host
 * case-insensitive + strip de tracking params + trailing slash, mas **path
 * case-sensitive** (RFC 3986) — dois slugs que diferem só no case do path são
 * artigos diferentes e disparam mismatch corretamente.
 *
 * `haveFrontmatter` = quantos slots têm `destaque_url` — o caller usa pra
 * decidir se a edição é de formato atual (≥1) e só então avisar sobre os
 * faltantes (edição legada pré-#606 não spamma warning).
 */
export function findImageContentMismatches(
  promptUrls: { d1?: string | null; d2?: string | null; d3?: string | null },
  reviewedUrls: string[],
): {
  mismatches: ImageContentMismatch[];
  missingFrontmatter: Array<"d1" | "d2" | "d3">;
  haveFrontmatter: number;
} {
  const mismatches: ImageContentMismatch[] = [];
  const missingFrontmatter: Array<"d1" | "d2" | "d3"> = [];
  let haveFrontmatter = 0;
  const slots = ["d1", "d2", "d3"] as const;
  slots.forEach((slot, i) => {
    const reviewedUrl = reviewedUrls[i];
    if (reviewedUrl == null) return; // reviewed não tem esse slot — fora de escopo
    const promptUrl = promptUrls[slot];
    if (promptUrl === undefined) return; // prompt file ausente — all-images-exist cobre
    if (promptUrl === null) {
      missingFrontmatter.push(slot);
      return;
    }
    haveFrontmatter++;
    if (!urlsMatch(promptUrl, reviewedUrl)) {
      mismatches.push({ slot, promptUrl, reviewedUrl });
    }
  });
  return { mismatches, missingFrontmatter, haveFrontmatter };
}

export function checkImageContentFresh(editionDir: string): InvariantViolation[] {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(reviewedPath)) return [];
  const reviewedUrls = extractDestaqueUrls(readFileSync(reviewedPath, "utf8"));
  if (reviewedUrls.length === 0) return [];

  const internalDir = resolve(editionDir, "_internal");
  // undefined = file ausente; null = file existe sem frontmatter; string = url.
  const promptUrls: { d1?: string | null; d2?: string | null; d3?: string | null } = {};
  let anyPrompt = false;
  for (const slot of ["d1", "d2", "d3"] as const) {
    const p = resolve(internalDir, `02-${slot}-prompt.md`);
    if (existsSync(p)) {
      anyPrompt = true;
      promptUrls[slot] = extractPromptUrl(readFileSync(p, "utf8"));
    }
  }
  // Nenhum prompt = imagens ainda não geradas (Stage 3 não rodou) — nada a checar.
  if (!anyPrompt) return [];

  const { mismatches, missingFrontmatter, haveFrontmatter } =
    findImageContentMismatches(promptUrls, reviewedUrls);

  const violations: InvariantViolation[] = [];
  for (const m of mismatches) {
    violations.push({
      rule: "image-content-fresh",
      message:
        `Imagem do ${m.slot.toUpperCase()} foi gerada pra outro artigo: prompt ` +
        `destaque_url=${m.promptUrl} ≠ destaque atual ${m.reviewedUrl}. Editor trocou ` +
        `o artigo direto no 02-reviewed.md sem regenerar a imagem. Re-rodar Stage 3 ` +
        `(image-generate) pra esse destaque, ou rodar reorder-destaques.ts se foi reorder.`,
      source_issue: "#1730",
      severity: "warning",
      file: resolve(internalDir, `02-${m.slot}-prompt.md`),
    });
  }
  // Só avisa frontmatter-ausente em edição de formato atual (≥1 prompt JÁ tem
  // destaque_url) — assim os faltantes são anomalia real, não edição legada
  // pré-#606 (que spammaria warning não-acionável em todo reprocessamento).
  if (missingFrontmatter.length > 0 && haveFrontmatter > 0) {
    violations.push({
      rule: "image-content-fresh",
      message:
        `frontmatter destaque_url ausente em ${missingFrontmatter
          .map((s) => `02-${s}-prompt.md`)
          .join(", ")} (outros prompts da edição já têm) — content-check da imagem ` +
        `desabilitado pra esse(s) destaque(s). writer-destaque deveria ter escrito ` +
        `o frontmatter #606; adicionar manualmente ou regenerar Stage 2.`,
      source_issue: "#1730",
      severity: "warning",
      file: resolve(internalDir, `02-${missingFrontmatter[0]}-prompt.md`),
    });
  }
  return violations;
}

/**
 * #3951: revisor de crop de imagem (`image-crop-reviewer`, Stage 3) sinaliza
 * quando o corte perdeu o sentido da imagem original. Desde o #12226 só o
 * card 4:5 avisa (o 1:1 não chega ao leitor, ver `isSilencedCropWarn`).
 * Warning-only — mesmo padrão do has-negative-impact-highlight
 * (#3916/#3918): nunca bloqueia o gate, só avisa. Se o arquivo não existe
 * (revisor não rodou nesta edição — ex: retomada de checkpoint pré-#3951),
 * não é violação — o revisor é assistido, não obrigatório.
 *
 * #9598: entrada cujo `image_md5` (carimbado por `run-image-crop-reviewer.ts`
 * no persist) não bate mais com o md5 atual de `04-{destaque}-{ratio}.jpg` é
 * de uma versão ANTERIOR da imagem (regerada, trocada por swap/promote) — o
 * aviso antigo é descartado e vira uma nota "desatualizado, re-rodar o
 * revisor" em vez de citar uma imagem que não existe mais. O md5 viaja com a
 * entrada no `reorder-destaques.ts` (o conteúdo da imagem também viaja), então
 * reorder não invalida nada. Entrada sem `image_md5`/`ratio` (persistida antes
 * do #9598) segue o comportamento antigo — sem como saber de qual imagem era.
 */

interface CropReviewFileEntry {
  destaque?: string;
  ratio?: string;
  status?: string;
  categoria?: string;
  motivo?: string;
  sugestao?: string;
  image_md5?: string;
  image_variant?: string;
}

function readCropReviewEntries(editionDir: string): { path: string; results: CropReviewFileEntry[] } | null {
  const path = resolve(editionDir, "_internal", "04-crop-review.json");
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { results?: CropReviewFileEntry[] };
    return { path, results: Array.isArray(data.results) ? data.results : [] };
  } catch {
    return null;
  }
}

/**
 * Achado de Noite Estrelada (#8989) ainda válido para a imagem atual (#9598) e
 * não marcado como falso positivo pelo editor (#10328).
 */
function isCurrentStarryNight(editionDir: string, r: CropReviewFileEntry, falsePositives: Set<string>): boolean {
  return (
    !!r &&
    r.status === "warn" &&
    r.categoria === "estilo" &&
    !isEstiloFalsePositive(r, falsePositives) &&
    !isCropReviewEntryStale(editionDir, r)
  );
}

export function checkCropReviewWarnings(editionDir: string): InvariantViolation[] {
  const read = readCropReviewEntries(editionDir);
  if (!read) return [];
  const { path } = read;
  const results = read.results.filter((r) => r && !isSilencedCropWarn(r)); // #12226
  // #10312: Noite Estrelada ATUAL sai daqui e vira erro em
  // `image-starry-night-detected` (checkStarryNightDetected abaixo). A
  // entrada desatualizada continua aqui, como nota "re-rodar o revisor".
  // #10328: falso positivo marcado pelo editor some também daqui (não vira warning).
  // #10333: só enquanto a entrada fala da arte atual — desatualizada, o falso
  // positivo vale para a arte antiga e a nota "re-rodar o revisor" volta.
  const falsePositives = readEstiloFalsePositiveMd5s(editionDir);
  const warns = results.filter(
    (r) =>
      r &&
      r.status === "warn" &&
      !isCurrentStarryNight(editionDir, r, falsePositives) &&
      !(isEstiloFalsePositive(r, falsePositives) && !isCropReviewEntryStale(editionDir, r)),
  );
  const stale = warns.filter((r) => isCropReviewEntryStale(editionDir, r));
  const staleKeys = [...new Set(stale.map((r) => `${(r.destaque ?? "?").toUpperCase()} (${r.ratio})`))];
  const staleNotices: InvariantViolation[] = staleKeys.map((key) => ({
    rule: "image-crop-warn",
    message:
      `Destaque ${key}: aviso do revisor de crop descartado — a imagem mudou depois da revisão ` +
      `(regerada ou trocada). Re-rodar image-crop-reviewer pra revisar a imagem atual (#9598).`,
    source_issue: "#9598",
    severity: "warning" as const,
    file: path,
  }));
  const current: InvariantViolation[] = warns
    .filter((r) => !stale.includes(r))
    .map((r) => ({
      rule: "image-crop-warn",
      message:
        `Destaque ${(r.destaque ?? "?").toUpperCase()}: ${r.motivo ?? "crop pode ter perdido o sentido da imagem original"}` +
        (r.sugestao ? ` — sugestão: ${r.sugestao}` : ""),
      source_issue: "#3951",
      severity: "warning" as const,
      file: path,
    }));
  return [...current, ...staleNotices];
}

/**
 * #10312: o revisor de imagem (`image-crop-reviewer`, Stage 3) acusou padrão
 * de Noite Estrelada (`categoria: "estilo"`, #8989) na imagem ATUAL do
 * destaque. Até aqui isso era só `image-crop-warn` (warning) e a imagem
 * chegava ao gate pronta pra publicar — achado ao vivo na edição 261016 (D2,
 * redemoinho azul/amarelo na tela do celular). A regra é invariável (CLAUDE.md:
 * "Prompt de imagem: ... SEM Noite Estrelada"), então aqui é ERRO.
 *
 * O Stage 3 já regenera sozinho (`run-image-crop-reviewer.ts
 * --estilo-regen-plan`, teto `MAX_ESTILO_AUTO_REGEN`); este invariante só
 * dispara quando a regeneração automática esgotou ou não rodou. Imagem
 * regerada depois da revisão (md5 diverge, #9598) não conta — vira a nota de
 * desatualizado de `image-crop-warn`.
 *
 * Não é o caso do #7401 (reverter escolha editorial pra satisfazer lint): o
 * conserto é regenerar a imagem, nunca mexer no texto do editor. Falso
 * positivo do revisor: `run-image-crop-reviewer.ts --mark-false-positive dN`,
 * gravado fora do veredito e chaveado pelo md5 da imagem (#10328) — o
 * `status: "ok"` manual no veredito ainda é respeitado, mas o próximo persist
 * do revisor o apaga.
 */
export function checkStarryNightDetected(editionDir: string): InvariantViolation[] {
  const read = readCropReviewEntries(editionDir);
  if (!read) return [];
  const { path, results } = read;
  const falsePositives = readEstiloFalsePositiveMd5s(editionDir);
  const hits = results.filter((r) => isCurrentStarryNight(editionDir, r, falsePositives));
  // O plano de regeneração sempre grava este arquivo; ausente = o orchestrator
  // pulou o passo do Stage 3 (o loop vive só no playbook).
  const regenRan = existsSync(resolve(editionDir, "_internal", "04-estilo-regen.json"));
  // #10346: o arquivo existir não prova que o plano rodou para a imagem ATUAL —
  // depois de um swap/promote no Stage 4 a contagem zera (#10327) e o plano
  // devolveria `regenerate: [dN]`. Recalcula o plano (sem gravar) e só diz
  // "esgotou" para quem ele de fato declara esgotado. Estado ilegível → `null`,
  // tratado como "não sei": sugere o plano primeiro, que é inofensivo.
  let pendingRegen: Set<string> | null = null;
  if (regenRan) {
    try {
      const plan = planEstiloRegenerationForEdition(editionDir);
      pendingRegen = plan ? new Set<string>(plan.regenerate) : null;
    } catch {
      pendingRegen = null;
    }
  }
  const causeFor = (d: string): { cause: string; suggestPlan: boolean } => {
    if (!regenRan) {
      return {
        cause:
          "a regeneração automática do Stage 3 NÃO rodou (_internal/04-estilo-regen.json ausente — passo --estilo-regen-plan pulado)",
        suggestPlan: true,
      };
    }
    if (pendingRegen === null) {
      return {
        cause: "não deu para ler o estado do plano de regeneração (_internal/04-estilo-regen.json/04-crop-review.json)",
        suggestPlan: true,
      };
    }
    if (pendingRegen.has(d)) {
      return {
        cause:
          "a regeneração automática ainda não rodou para a imagem ATUAL (ex.: destaque trocado no Stage 4 — o plano devolve regenerate para ele)",
        suggestPlan: true,
      };
    }
    return { cause: "a regeneração automática do Stage 3 esgotou", suggestPlan: false };
  };
  // #10328: com o plano esgotado, `--estilo-regen-plan` devolve `regenerate: []`
  // e não faz nada — sugerir só quando ele ainda regeneraria.
  const manual = (d: string) =>
    `reescrever _internal/02-${d}-prompt.md e rodar image-generate.ts --force + --ratio 4x5 --force + gen-social-card-4x5.ts`;
  const byDestaque = new Map<string, CropReviewFileEntry[]>();
  for (const r of hits) {
    const key = r.destaque ?? "?";
    byDestaque.set(key, [...(byDestaque.get(key) ?? []), r]);
  }
  return [...byDestaque.entries()].map(([destaque, entries]) => {
    const ratios = entries.map((e) => e.ratio ?? "?").join(", ");
    const motivo = entries.find((e) => e.motivo)?.motivo ?? "padrão de espiral/redemoinho estilo Noite Estrelada";
    const { cause, suggestPlan } = causeFor(destaque);
    return {
      rule: "image-starry-night-detected",
      message:
        `Destaque ${destaque.toUpperCase()} (${ratios}): imagem gerada com Noite Estrelada — ${motivo}; ${cause}. ` +
        `Viola regra invariável — em rodada sem gates a edição para aqui. Regenerar: ` +
        (suggestPlan
          ? `\`npx tsx scripts/run-image-crop-reviewer.ts --edition-dir <dir>/ --estilo-regen-plan\` + os comandos de \`commands.${destaque}\` (ou ${manual(destaque)})`
          : manual(destaque)) +
        `, depois re-rodar o revisor. Falso positivo: \`npx tsx scripts/run-image-crop-reviewer.ts --edition-dir <dir>/ --mark-false-positive ${destaque}\` ` +
        `(vale enquanto a imagem for a mesma e sobrevive a novas revisões; trocar a entrada para status "ok" é perdido no próximo persist do revisor, #10328).`,
      source_issue: "#10312",
      severity: "error" as const,
      file: path,
    };
  });
}

/**
 * #4090 item 4 (decisão do editor, 260727): se a edição gerou o card 4:5
 * (`04-d{N}-4x5.jpg` no disco — mandatório desde a decisão 260728, ver
 * `checkCard4x5Exists` em stage-3.ts) mas o upload (`06-public-images.json`)
 * não tem a entry `d{N}_4x5`, avisar no gate — silêncio aqui publica o post
 * no formato ERRADO (hero 2:1 sem título) sem ninguém perceber, porque o
 * Instagram cai na URL pública do hero quando falta `d{N}_4x5` (o arquivo
 * LOCAL do 4:5 não tem mais fallback pro 1:1 desde o #12226).
 *
 * Severity "warning", não "error": a issue original pede "avisar no gate",
 * não bloquear — `upload-images-public.ts` trata a entry `d{N}_4x5` como
 * `optional: true` (upload de card é adicional ao fluxo newsletter/social
 * que já funciona sem ele), e `checkCard4x5Exists` (Stage 3) já é a barreira
 * dura pra GERAÇÃO. Este check cobre o passo seguinte — UPLOAD — que pode
 * falhar independente da geração ter dado certo (rede, cache stale, etc).
 */
export function checkCard4x5UploadMismatch(editionDir: string): InvariantViolation[] {
  const imagesPath = resolve(editionDir, "06-public-images.json");
  const destaqueCount = readDestaqueCount(editionDir);
  const slots = destaqueCount === 2 ? (["d1", "d2"] as const) : (["d1", "d2", "d3"] as const);

  let images: PublicImagesJson["images"] = {};
  if (existsSync(imagesPath)) {
    try {
      images = (JSON.parse(readFileSync(imagesPath, "utf8")) as PublicImagesJson).images ?? {};
    } catch {
      images = {}; // JSON inválido já é coberto por public-images-parseable
    }
  }

  const violations: InvariantViolation[] = [];
  for (const d of slots) {
    const cardPath = resolve(editionDir, `04-${d}-4x5.jpg`);
    if (!existsSync(cardPath)) continue; // sem card gerado nesta edição — nada a cruzar
    const url = images?.[`${d}_4x5`]?.url;
    if (!url || typeof url !== "string" || url.trim().length === 0) {
      violations.push({
        rule: "card-4x5-upload-missing",
        message:
          `04-${d}-4x5.jpg existe no disco mas 06-public-images.json não tem ` +
          `images.${d}_4x5.url — upload-images-public.ts não subiu o card 4:5 (ou rodou ` +
          `antes do card existir). Publishers vão cair pro 1:1 EM SILÊNCIO (post sai sem ` +
          `título embutido). Fix: re-rodar "npx tsx scripts/upload-images-public.ts ` +
          `--edition-dir ${editionDir}" antes de publicar.`,
        source_issue: "#4090",
        severity: "warning",
        file: imagesPath,
      });
    }
  }
  return violations;
}
