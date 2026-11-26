/**
 * Invariantes do Stage 4 — Use Melhor (isca, sentinel, tempo, carrossel, post) (#14057).
 *
 * Família extraída de `../stage-4.ts` (divisão sem mudança de lógica). O
 * registro `STAGE_4_RULES` e o reexport público continuam em `../stage-4.ts`:
 * importe sempre de lá.
 */

import { existsSync, readFileSync } from "node:fs";
import { parseUseMelhorItems, readTempoArtifact, estimateMinutes } from "../../use-melhor-tempo-refresh.ts"; // #10765
import { resolve, basename } from "node:path";
import type { InvariantViolation } from "../types.ts";
import { extractSection, extractDestaqueBlock } from "../../extract-section.ts"; // #6064, #12094
import {
  normalizeUseMelhorUrl,
  USE_MELHOR_POST_ID,
  checkUseMelhorItemInFinal,
  loadUseMelhorPostConfigState,
  readApprovedForUseMelhor,
  readUseMelhorPostState,
  resolveUseMelhorCoverTitle,
  useMelhorPostStatePath,
  useMelhorUmFormat,
  type UseMelhorPostConfigState,
} from "../../use-melhor-post.ts"; // #9568
import { findOverflowingUseMelhorSlides, lintUseMelhorPostShape } from "../../use-melhor-carousel.ts"; // #9568, #9789/#9791, #10246
import { readUseMelhorCarouselStamp, staleUseMelhorImageKeys } from "../../use-melhor-slide-files.ts"; // #9795
import { lintUseMelhorIsca } from "../../use-melhor-isca.ts"; // #11667
import { gatherUseMelhorStatusInput } from "../../use-melhor-status.ts"; // #10879
import { type CarouselCtaOverride } from "../../instagram-test-override.ts"; // #8681
import { checkUseMelhorTempo } from "../../lint-checks/use-melhor-tempo.ts";
import { isNonEditorialHost } from "../../ctr-utils.ts"; // #8993
import { detectSponsoredMarkers } from "../../lint-checks/sponsored-source-markers.ts"; // #10169
import { loadCachedBody } from "../../url-body-cache.ts"; // #10169
import { ROOT } from "./_shared.ts";

/**
 * #11667: WARN-only — o 4º post (`## um`, item USE MELHOR) é a isca da
 * edição: mostra parte dos itens, nunca diz quantos faltam, nunca promete a
 * lista inteira e fecha com a chamada DATADA ("na edição de DD/MM"; no texto
 * corrido, no fim do 3º parágrafo, com uma única frase antes). Regras em
 * `context/editorial-rules.md` §"USE MELHOR no social"; lógica pura em
 * `scripts/lib/use-melhor-isca.ts`. Também avisa quando o item vem marcado
 * como possível publieditorial (#10169): só vira isca se o editor confirmar
 * no gate que não é anúncio. Inerte com o 4º post desligado ou sem item.
 */
export function checkUseMelhorIsca(
  editionDir: string,
  /** Injetável pra teste; default = `platform.config.json` do repo. */
  useMelhorConfig?: UseMelhorPostConfigState,
): InvariantViolation[] {
  const config = useMelhorConfig ?? loadUseMelhorPostConfigState(ROOT);
  if (!config.enabled) return [];
  const state = readUseMelhorPostState(editionDir);
  if (!state?.item) return [];
  const socialPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialPath)) return [];
  const section = extractSection(readFileSync(socialPath, "utf8"), "Social");
  const umText = section ? extractDestaqueBlock(section, USE_MELHOR_POST_ID) : null;
  const out: InvariantViolation[] = [];
  if (umText && umText.trim()) {
    const problems = lintUseMelhorIsca(umText.trim(), {
      format: useMelhorUmFormat(state.item),
      editionId: basename(editionDir),
    });
    if (problems.length > 0) {
      out.push({
        rule: "use-melhor-um-isca",
        message:
          `'## ${USE_MELHOR_POST_ID}' (4º post, USE MELHOR) fora do padrão de isca da edição (#11667): ` +
          problems.join("; ") +
          `. Ajustar em 03-social.md (edição cirúrgica, #495); o 4º post é fail-soft, não bloqueia a edição.`,
        source_issue: "#11667",
        severity: "warning",
        file: socialPath,
      });
    }
  }
  const url = state.item.url;
  if (url) {
    let host: string | null = null;
    try {
      host = new URL(url).hostname;
    } catch {
      host = null;
    }
    if (host && !isNonEditorialHost(host)) {
      const bodiesDir = resolve(editionDir, "_internal", "_forensic", "link-verify-bodies");
      const markers = detectSponsoredMarkers(url, loadCachedBody(bodiesDir, url));
      if (markers.length > 0) {
        out.push({
          rule: "use-melhor-um-isca",
          message:
            `item do 4º post (USE MELHOR) com marcador de publieditorial (${markers.join(", ")}) em ${url} — ` +
            `só pode ser a isca principal do dia se o editor confirmar no gate que NÃO é anúncio; ` +
            `senão, trocar o item do 4º post (#11667, #10169).`,
          source_issue: "#11667",
          severity: "warning",
          file: useMelhorPostStatePath(editionDir),
        });
      }
    }
  }
  return out;
}

/**
 * #2464 finding 2: rejeita items de USE MELHOR contendo o sentinel
 * `[DESCRIÇÃO PENDENTE]` — injetado pelo stitch quando não há `summary`.
 *
 * O sentinel satisfaz o check de tempo (o stitch já appenda `(5 min)` a ele),
 * então sem este guard poderia chegar ao leitor se o editor não notar.
 *
 * `[DESCRIÇÃO PENDENTE]` é escrito EXCLUSIVAMENTE por `renderUseMelhorSection`
 * (stitch-newsletter.ts) — não aparece em nenhuma outra seção. Portanto a busca
 * simples por substring no documento é suficiente e precisa, sem precisar escopar
 * ao bloco USE MELHOR linha a linha.
 *
 * severity: "error" (gate-blocking) — o editor DEVE preencher a descrição antes
 * da publicação. Um link sem descrição não agrega valor editorial.
 */
export function checkUseMelhorSentinel(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  if (!md.includes("[DESCRIÇÃO PENDENTE]")) return [];

  // Contar ocorrências do sentinel para mensagem diagnóstica.
  const matches = md.match(/\[DESCRIÇÃO PENDENTE\]/g);
  const count = matches?.length ?? 1;

  return [
    {
      rule: "use-melhor-sentinel",
      message:
        `${count} item(ns) de USE MELHOR com descrição placeholder "[DESCRIÇÃO PENDENTE]" ` +
        `em ${path}. ` +
        `Fix: substituir "[DESCRIÇÃO PENDENTE]" pela descrição real de cada item antes de publicar ` +
        `(stitch injeta esse placeholder quando approved.json não tem "summary"; ` +
        `preencha o summary no JSON ou edite diretamente no 02-reviewed.md).`,
      source_issue: "#2464",
      severity: "error",
      file: path,
    },
  ];
}

/**
 * #2372/#2415/#2447: cada item de USE MELHOR precisa de estimativa de tempo na
 * descrição (`(15 min)` — formato canônico, ou `— 15 min` como atalho aceito).
 *
 * severity: "error" (gate-blocking, #2447 opção a) — `stitch-newsletter.ts` agora
 * injeta `(X min)` automaticamente (#2447 opção b), então o editor só chega aqui
 * sem tempo se editou a seção no Drive e removeu a estimativa.
 *
 * Roda no Stage 4 (PÓS-gate) onde o 02-reviewed.md já tem a estimativa injetada
 * pelo stitch. PRÉ-gate (Stage 2) o check permanece fora da STAGE_2_RULES porque
 * edições manuais do editor no Drive ou re-stitch podem alterar o conteúdo.
 */
export function checkUseMelhorTempoConsistent(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const md = readFileSync(path, "utf8");
  const result = checkUseMelhorTempo(md);
  if (result.ok) return [];
  const items = result.errors
    .map((e) => `item ${e.item} (linha ${e.titleLine}): "${e.excerpt}"`)
    .join("; ");
  return [
    {
      rule: "use-melhor-tempo",
      message:
        `${result.errors.length} item(ns) de USE MELHOR sem estimativa de tempo: ${items}. ` +
        `Fix: adicionar "(X min)" ao fim de cada descrição em ${path} ` +
        `(stitch injeta automaticamente — pode ter sido removido na edição manual).`,
      source_issue: "#2447",
      severity: "error",
      file: path,
    },
  ];
}

/**
 * #7668 item 3: observabilidade de cache miss do body do USE MELHOR.
 *
 * `stitch-newsletter.ts` escreve `_internal/use-melhor-tempo-source.json` com a
 * fonte real de cada estimativa injetada (`wordcount` | `youtube` |
 * `title-heuristic`). Este check lê esse artifact e sinaliza quando QUALQUER
 * item ainda cai no fallback de title-heuristic — sem piso percentual, de
 * propósito: é warning-only, e a contagem/percentual vai na mensagem pra quem
 * lê decidir. É o sintoma silencioso do bug: body não cacheado no Stage 1 →
 * estimativa de `(5 min)` em vez da real.
 *
 * severity: "warning" (não bloqueia o gate, #7668 — é um sinal de qualidade,
 * não uma reprovação do conteúdo). O editor cura o conteúdo; este check diz
 * se a curadoria está sendo feita com dados reais ou com o placeholder.
 *
 * Fail-soft: artifact ausente/inválido → sem violação (não é erro; é só ausência
 * de instrumentação, igual ao padrão dos outros checks que leem `_internal/*`).
 */
export function checkUseMelhorTempoTitleHeuristicShare(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "use-melhor-tempo-source.json");
  if (!existsSync(path)) return [];
  let entries: { source?: string; url?: string }[];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    entries = parsed;
  } catch {
    return [];
  }

  /**
   * #8992: `use-melhor-tempo-source.json` só é regravado quando `stitch-newsletter.ts`
   * roda de novo (Stage 2) — um "ajustar" que poda a seção USE MELHOR no gate do
   * Stage 4 (ex: 4→1 itens, achado ao vivo edição 260929) não regenera esse
   * artifact, então a contagem "N de M" fica com M = tamanho ANTES da poda,
   * relatando itens que nem aparecem mais em 02-reviewed.md. Filtrar `entries`
   * pelas URLs que ainda constam no documento atual corrige a contagem sem
   * exigir que o orchestrator dispare uma regeneração completa do stitch só
   * para atualizar esta instrumentação (warning-only, #7668).
   */
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  if (existsSync(reviewedPath)) {
    try {
      const reviewedMd = readFileSync(reviewedPath, "utf8");
      entries = entries.filter((e) => !e.url || reviewedMd.includes(e.url));
    } catch {
      // fail-soft — se não der pra ler 02-reviewed.md, segue com o snapshot cru
      // (mesma degradação de antes do #8992, melhor que travar o check).
    }
  }

  const total = entries.length;
  if (total === 0) return [];
  const heuristic = entries.filter((e) => e.source === "title-heuristic").length;
  if (heuristic === 0) return [];
  const pct = Math.round((heuristic / total) * 100);
  return [
    {
      rule: "use-melhor-tempo-title-heuristic-share",
      message:
        `${heuristic} de ${total} item(ns) de USE MELHOR (${pct}%) foram estimados por ` +
        `title-heuristic em vez de wordcount/youtube — bodies não cacheados no Stage 1 ` +
        `(browser fallback não persistiu o HTML, ou fetchBodyForCache não correu). ` +
        `Estimação real exige '_internal/_forensic/link-verify-bodies/<sha1>.html' para ` +
        `cada URL. Verifique ` +
        `scripts/verify-accessibility.ts (saveCachedBody no browser fallback) e ` +
        `scripts/stitch-newsletter.ts (prefetchUseMelhorBodies antes do render).`,
      source_issue: "#7668",
      severity: "warning",
      file: path,
    },
  ];
}

/**
 * #10765 itens 4 e 6: warning INDIVIDUAL por item USE MELHOR sem tempo medido —
 * (a) estimado por título (`title-heuristic` no artifact) ou (b) sem fonte de
 * medição nenhuma (item inserido/movido à mão no gate, ausente do artifact).
 * O agregado `use-melhor-tempo-title-heuristic-share` só dava contagem; aqui o
 * editor vê QUAIS títulos conferir. Warning-only, fail-soft (mesma disciplina
 * do #7668).
 */
export function checkUseMelhorTempoItemSemMedicao(editionDir: string): InvariantViolation[] {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(reviewedPath)) return [];
  let md: string;
  try {
    md = readFileSync(reviewedPath, "utf8");
  } catch {
    return [];
  }
  const items = parseUseMelhorItems(md);
  if (items.length === 0) return [];
  const entries = readTempoArtifact(editionDir);
  const out: InvariantViolation[] = [];
  const warn = (message: string) =>
    out.push({ rule: "use-melhor-tempo-item-sem-medicao", message, source_issue: "#10765", severity: "warning", file: reviewedPath });
  for (const it of items) {
    const e = entries.find((x) => x.url === it.url);
    const measured = estimateMinutes(e?.estimate);
    if (!e?.source) {
      warn(
        `USE MELHOR "${it.title}": sem fonte de medição do tempo (item inserido/movido à mão) — ` +
          `rode refresh-use-melhor-tempo.ts ou re-meça com move-pool-item.ts sem --tempo.`,
      );
    } else if (e.source === "title-heuristic") {
      warn(`USE MELHOR "${it.title}": tempo ESTIMADO POR TÍTULO (corpo não medido) — conferir o "(N min)" no gate.`);
    } else if (measured !== null && it.mdTempo !== measured) {
      warn(
        e.md_tempo === it.mdTempo
          ? `USE MELHOR "${it.title}": texto diz ${it.mdTempo ?? "?"} min, medido ${measured} min (${e.source}) — escolha manual preservada, confira.`
          : `USE MELHOR "${it.title}": o "(N min)" mudou desde a última medição (${measured} min, ${e.source}) — rode refresh-use-melhor-tempo.ts.`,
      );
    }
  }
  return out;
}

/**
 * (#9568) Mesma checagem de overflow, pro carrossel de N slides do 4º post
 * (`## um`). Inerte enquanto `publishing.social.use_melhor_time` não estiver
 * definido. Severity "warning", nunca "error": o 4º post é fail-soft por
 * decisão do editor — texto que não cabe faz o Stage 3 PULAR o carrossel
 * (`gen-carousel-cards.ts`), nunca bloqueia a edição.
 */
export function checkUseMelhorCarouselOverflow(
  editionDir: string,
  section: string,
  socialPath: string,
  useMelhorConfig?: UseMelhorPostConfigState,
  ctaOverride?: CarouselCtaOverride | null,
): InvariantViolation[] {
  const config = useMelhorConfig ?? loadUseMelhorPostConfigState(ROOT);
  if (!config.enabled) return [];
  const state = readUseMelhorPostState(editionDir);
  if (!state?.item) return [];
  const umText = extractDestaqueBlock(section, USE_MELHOR_POST_ID);
  if (!umText || !umText.trim()) return [];
  const violations: InvariantViolation[] = [];
  // Self-review #9572 (finding 6): os lints sociais só enumeram `## d{N}` — a
  // forma do `## um` é checada aqui (Stages 2 e 4), warning-only como o resto.
  // #9789/#9791: + lista numerada direto ao ponto, até 2 itens por card.
  // #10246: item sem `steps` (não é tutorial) aceita texto corrido de 3 parágrafos.
  const shape = lintUseMelhorPostShape(umText.trim(), useMelhorUmFormat(state.item));
  if (shape.length > 0) {
    violations.push({
      rule: "use-melhor-um-shape",
      message:
        `'## ${USE_MELHOR_POST_ID}' (4º post, USE MELHOR) fora do formato do §3c do social-writer: ` +
        shape.join("; ") +
        `. Reescrever em 03-social.md (o 4º post é fail-soft, #9568 — não bloqueia a edição).`,
      source_issue: "#9568",
      severity: "warning",
      file: socialPath,
    });
  }
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  const coverTitle = resolveUseMelhorCoverTitle(state.item, {
    reviewedMd: existsSync(reviewedPath) ? readFileSync(reviewedPath, "utf8") : null,
    approved: readApprovedForUseMelhor(editionDir),
  }); // #9600 — mesmo título que o Stage 3 renderiza
  const overflow = findOverflowingUseMelhorSlides(umText.trim(), coverTitle, ctaOverride);
  if (overflow.length === 0) return violations;
  violations.push(
    {
      rule: "carousel-text-overflow",
      message:
        `'## ${USE_MELHOR_POST_ID}' (4º post, USE MELHOR) tem ${overflow.length} slide(s) que não cabem no card: ` +
        overflow.map((o) => `${o.slot} (${o.chars} chars, ${o.excessPx}px além)`).join("; ") +
        `. Reescrever o parágrafo (ou encurtar o título da capa) e rodar ` +
        `"npx tsx scripts/gen-carousel-cards.ts --edition-dir ${editionDir}". Enquanto isso o ` +
        `carrossel do 4º post é PULADO (fail-soft, #9568) — não bloqueia a edição.`,
      source_issue: "#9568",
      severity: "warning",
      file: socialPath,
    },
  );
  return violations;
}

/**
 * (#9795) `06-public-images.json` com chave de slide do 4º post
 * (`um_carousel_*`) cujo arquivo local não existe — sobra de um render com
 * mais slides (`## um` reescrito mais curto, edição 261007). O publish montaria
 * o carrossel com URL de slide que não faz mais parte dele, e o preview social
 * listava o slide fantasma. Não depende do config do 4º post: chave órfã é
 * lixo mesmo com a feature desligada. Warning (o 4º post é fail-soft, #9568);
 * `upload-images-public.ts` e `gen-carousel-cards.ts` já podam sozinhos —
 * isto acusa o estado quando nenhum dos dois rodou depois da sobra.
 */
export function checkUseMelhorPublicImageKeysHaveFiles(editionDir: string): InvariantViolation[] {
  const p = resolve(editionDir, "06-public-images.json");
  if (!existsSync(p)) return [];
  let images: Record<string, unknown>;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as { images?: Record<string, unknown> };
    if (!data?.images || typeof data.images !== "object") return [];
    images = data.images;
  } catch {
    return [];
  }
  const keep = readUseMelhorCarouselStamp(editionDir)?.slots ?? [];
  const stale = staleUseMelhorImageKeys(images, editionDir, keep);
  if (stale.length === 0) return [];
  return [
    {
      rule: "use-melhor-image-key-without-file",
      message:
        `06-public-images.json tem ${stale.length} chave(s) de slide do 4º post sem arquivo local: ` +
        `${stale.join(", ")} (sobra de um carrossel com mais slides). Re-rodar ` +
        `"npx tsx scripts/upload-images-public.ts --edition-dir ${editionDir}" — ele remove as chaves órfãs.`,
      source_issue: "#9795",
      severity: "warning",
      file: p,
    },
  ];
}

/**
 * (#10879) Carrossel do 4º post (`04-um-carousel-*`) defasado em relação ao
 * `## um` atual NO GATE. O pré-render do Stage 4 (`upload-images-public.ts
 * --mode social`) já regera o carrossel defasado sozinho (#10834); se ele
 * continua defasado aqui, a regeração falhou — caso típico: a máquina não tem
 * a fonte Georgia (servidor 300) — e o Stage 5 vai pular o 4º post no
 * LinkedIn/Instagram/Facebook. Antes deste check isso só aparecia como warning
 * no stderr do upload, sem nada no gate. Warning, nunca error: o 4º post é
 * fail-soft (#9568) e a edição não bloqueia por ele.
 */
export function checkUseMelhorCarouselStaleAtGate(
  editionDir: string,
  /** Injetável pra teste; default = `platform.config.json` do repo. */
  useMelhorConfig?: UseMelhorPostConfigState,
): InvariantViolation[] {
  const config = useMelhorConfig ?? loadUseMelhorPostConfigState(ROOT);
  if (!config.enabled) return [];
  let stale: boolean;
  try {
    stale = gatherUseMelhorStatusInput(editionDir, config).carouselStale === true;
  } catch {
    return []; // arquivo ilegível já é coberto pelos checks de estrutura
  }
  if (!stale) return [];
  return [
    {
      rule: "use-melhor-carousel-stale",
      message:
        `carrossel do 4º post (USE MELHOR) está DEFASADO em relação ao '## ${USE_MELHOR_POST_ID}' atual de 03-social.md ` +
        `e o pré-render não conseguiu regerar (causa mais comum: fonte Georgia ausente nesta máquina, #10879). ` +
        `Sem conserto, o Stage 5 PULA o 4º post no LinkedIn/Instagram/Facebook. Conserto: numa máquina com Georgia, ` +
        `"npx tsx scripts/gen-carousel-cards.ts --edition-dir ${editionDir}" + ` +
        `"npx tsx scripts/upload-images-public.ts --edition-dir ${editionDir} --mode social" ` +
        `(o motivo exato sai no stderr do upload).`,
      source_issue: "#10879",
      severity: "warning",
      file: resolve(editionDir, "03-social.md"),
    },
  ];
}

/** #13927: URLs explícitas permitem detectar troca sem inferir o assunto do texto. */
export function checkUseMelhorSocialSource(
  editionDir: string,
  config = loadUseMelhorPostConfigState(ROOT),
): InvariantViolation[] {
  if (!config.enabled) return [];
  const state = readUseMelhorPostState(editionDir);
  const file = resolve(editionDir, "03-social.md");
  if (!state?.item || !existsSync(file)) return [];
  const section = extractSection(readFileSync(file, "utf8"), "Social");
  const block = section ? extractDestaqueBlock(section, "um") : null;
  if (!block) return [];
  const urls = block.match(/https?:\/\/[^\s<>)\]]+/g) ?? [];
  if (!urls.length || urls.some(url => normalizeUseMelhorUrl(url) === normalizeUseMelhorUrl(state.item!.url))) return [];
  return [{ rule: "use-melhor-social-source", source_issue: "#13927", severity: "warning", file,
    message: `## um cita outra fonte: esperado ${state.item.url}. Rode swap-use-melhor-post.ts --edition-dir ${editionDir} --url <item do USE MELHOR> e reescreva # Social ## um e # Curto ## um.` }];
}

/**
 * (#9592) O 4º post (USE MELHOR) só sai se o item ESCOLHIDO — o de
 * `_internal/use-melhor-post.json`, pro qual o `## um` foi escrito — seguir
 * renderizado no USE MELHOR do `02-reviewed.md` final. Edição 261005: os 5
 * canais pularam o 4º post no Stage 5 sem que nada no gate deixasse claro que
 * ele não ia sair. Este check acusa ANTES do gate quando o item saiu da edição
 * (editor tirou/trocou no painel), com o comando que realinha. Desde #12898,
 * bloqueia o gate: um warning permitia perder o post nos cinco canais.
 * Item de score maior na edição final NÃO é violação — a escolha gravada vale.
 */
export function checkUseMelhorPostItemRendered(
  editionDir: string,
  /** Injetável pra teste; default = `platform.config.json` do repo. */
  useMelhorConfig?: UseMelhorPostConfigState,
): InvariantViolation[] {
  const config = useMelhorConfig ?? loadUseMelhorPostConfigState(ROOT);
  if (!config.enabled) return [];
  const state = readUseMelhorPostState(editionDir);
  if (!state?.item) return []; // ausência já aparece no resumo do gate ({use_melhor_post_block})
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(reviewedPath)) return [];
  const final = checkUseMelhorItemInFinal(state.item, readFileSync(reviewedPath, "utf8"));
  const pendingPath = resolve(editionDir, "_internal/use-melhor-refresh-pending.json");
  const pending = existsSync(pendingPath);
  if (final.ok && !pending) return [];
  return [
    {
      rule: "use-melhor-post-item-rendered",
      message:
        `4º post (USE MELHOR) bloqueia o gate: ${final.ok ? "re-seleção com reescrita pendente do ## um" : final.reason}. Para manter o 4º post: ` +
        `"npx tsx scripts/select-use-melhor-post.ts --edition-dir ${editionDir} --reviewed" e re-rodar ` +
        `social-writer/social-curto só pro '## ${USE_MELHOR_POST_ID}' (ou gravar à mão em ` +
        `_internal/use-melhor-post.json o item que ficou na edição, junto com o texto de '## ${USE_MELHOR_POST_ID}'). ` +
        `Refazer humanização, carrossel e preview; só após concluir, limpar a pendência com ` +
        `"npx tsx scripts/refresh-use-melhor-post.ts --edition-dir ${editionDir} --done".`,
      source_issue: "#12898",
      severity: "error",
      file: useMelhorPostStatePath(editionDir),
    },
  ];
}
