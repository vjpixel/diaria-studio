/**
 * weekly-instagram-select.ts (#4483)
 *
 * Seleção por clique das matérias do post semanal do Instagram — sucessora
 * de `selectWeeklyD1` (`select-weekly-d1.ts`, #4101), que a issue #4483
 * SUPERSEDE: "os 5 D1, sem ranking por clique" vira "os 5 mais clicados da
 * semana, de qualquer posição elegível na edição".
 *
 * Metodologia idêntica em espírito à da newsletter semanal do LinkedIn
 * (#4456, `scripts/lib/weekly-linkedin-select.ts`):
 *   1. Ranqueia por TAXA de clique verificado (cliques únicos ÷ aberturas
 *      únicas da edição de origem), não clique bruto.
 *   2. Exclui links comerciais/afiliados/propriedade própria ANTES de
 *      ranquear.
 *   3. Desempate por RUÍDO: diferença de taxa menor que "o valor de 1
 *      clique" (1/aberturas) não desempata por número — cai no critério
 *      editorial (ângulo Brasil > implicação profissional > diversidade de
 *      categoria).
 *
 * O núcleo de ranking/blocklist (itens 1-3 acima) vive em
 * `weekly-social-click-rank.ts` (#4511 fleet review IMPORTANTE), reusado
 * também por `weekly-linkedin-select.ts`. Até o #4511, essas funções viviam
 * duplicadas byte-a-byte nos 2 lados — justificativa original: no momento em
 * que este arquivo foi escrito havia PRs concorrentes abertos tocando
 * `weekly-linkedin-select.ts` (#4507, #4501, #4495), e importar de lá
 * acoplaria este PR ao estado de merge daqueles. Com esses PRs já mergeados
 * a duplicação deixou de ter justificativa. O que continua SEPARADO por
 * diferença real de escopo (não movido pro módulo compartilhado):
 * `extractInstagramCandidates` (parser específico — extrai `destaqueNumber`,
 * que o LinkedIn não precisa; o LinkedIn extrai TODAS as seções secundárias
 * — LANÇAMENTOS/VÍDEOS inclusos —, aqui só RADAR compete, #4513/#5319),
 * `toRankedCandidate` (o tipo de entrada ainda difere — `InstagramRawCandidate`
 * tem `destaqueNumber` opcional; `WeeklyRawCandidate` do LinkedIn não tem esse
 * campo), e `resolveWeeklyImageUrls`/geração sob demanda (exclusivo do
 * Instagram — o LinkedIn não usa cards de imagem por item).
 *
 * **Pool de candidatos inclui RADAR desde o #4513** (além de DESTAQUE
 * D1/D2/D3) — reusa o MESMO padrão de extração que
 * `weekly-linkedin-parse.ts::extractWeeklyCandidates` já usa pro canal
 * irmão do LinkedIn: `parseDestaques` pros destaques + `parseSections` pra
 * seção secundária (só RADAR aqui — LANÇAMENTOS/VÍDEOS ficam de fora, mesmo
 * escopo pedido pelo editor na issue #4483/#4513). **USE MELHOR também
 * chegou a competir entre o #4513 (260803) e o #5319 (260814)** — removido
 * por decisão do editor: o post semanal é sobre a notícia mais clicada da
 * semana, não sobre tutorial/ferramenta. Regra permanente — não reabrir sem
 * nova decisão explícita do editor.
 *
 * Até o #4513, o pool era restrito a D1/D2/D3 por uma razão técnica real: o
 * post semanal do Instagram é um CARROSSEL de imagens — 1 card 4:5 por item
 * selecionado, com o TÍTULO já EMBUTIDO na imagem
 * (`gen-social-card-4x5.ts`) — e só D1/D2/D3 tinham esse card PRÉ-gerado no
 * Stage 3 diário (`imageSpecsFor` em `upload-images-public.ts`). RADAR nunca
 * teve card próprio, e usar o card do D1 como substituto mostraria o TÍTULO
 * ERRADO embutido na imagem — pior que excluir o candidato.
 *
 * **Decisão do editor (briefing 260803, #4513): gerar o card 4:5 SOB
 * DEMANDA** — só quando um item de RADAR de fato vence o ranking semanal,
 * nunca preventivamente pra todo item de toda edição diária (mais caro,
 * geraria imagem que a maioria nunca usa). A geração sob demanda vive em
 * `weekly-instagram-ondemand-card.ts`, invocada por
 * `publish-weekly-social.ts::resolveWeeklyImageUrls` quando o item
 * selecionado não tem `destaqueNumber` (== veio de seção, não de destaque).
 * Stage 3 da diária (`image-generate.ts`) permanece intocado — a geração
 * sob demanda roda no fluxo SEMANAL, reusando a MESMA pipeline de
 * compositing (`generateCard`) e upload (`uploadImageToWorkerKV`) que
 * D1/D2/D3 já usam.
 */

import { parseDestaques } from "../extract-destaques.ts";
import { parseSections } from "./newsletter-parse.ts";
import {
  isCommercialOrOwnLink,
  hasSuspiciousCommercialLanguage,
  withinClickNoise,
  hasBrazilAngle,
  hasProfessionalImplication,
  editorialTiebreakScore,
  byRateDescThenTitle,
} from "./weekly-social-click-rank.ts";

export { isCommercialOrOwnLink, hasSuspiciousCommercialLanguage, withinClickNoise, hasBrazilAngle, hasProfessionalImplication, editorialTiebreakScore };

// ─── Extração de candidatos (destaques + RADAR — #4513, USE MELHOR excluído #5319) ────────

/** "destaque" = D1/D2/D3 com card 4:5 pré-gerado no Stage 3 diário. "section" = RADAR, card 4:5 gerado SOB DEMANDA (#4513). */
export type InstagramCandidateKind = "destaque" | "section";

export interface InstagramRawCandidate {
  /** AAMMDD da edição de origem. */
  editionDate: string;
  url: string;
  /** Título do destaque/item (literal — nunca reescrito na seleção/montagem). */
  title: string;
  /** Corpo do destaque OU descrição de 1 linha (item de seção). */
  body: string;
  /** "Por que isso importa" — só destaques têm; "" para itens de seção. */
  why: string;
  /** 1, 2 ou 3 quando `kind === "destaque"` — usado pra resolver a imagem 4:5 (`d{n}_4x5`) PRÉ-gerada da edição de origem. `undefined` quando `kind === "section"` (card gerado sob demanda, ver `weekly-instagram-ondemand-card.ts`). */
  destaqueNumber?: 1 | 2 | 3;
  /** Categoria do destaque (`DESTAQUE N | categoria`) OU nome da seção (RADAR) — usada na diversidade de desempate e no card gerado sob demanda. */
  category: string;
  kind: InstagramCandidateKind;
  /** Nome da seção normalizado — só presente quando `kind === "section"`. USE MELHOR nunca aparece aqui (excluído em `normalizeInstagramSectionName`, decisão do editor #5319 260814 — o carrossel é sobre notícia clicada, não tutorial/ferramenta). */
  section?: "radar";
}

function normalizeInstagramSectionName(name: string): "radar" | null {
  const n = name.toUpperCase();
  if (n === "RADAR") return "radar";
  // USE MELHOR excluído por decisão do editor (#5319, 260814) — o carrossel
  // é sobre notícia clicada, não tutorial/ferramenta; LANÇAMENTOS/VÍDEOS/etc
  // continuam fora de escopo pela mesma razão original do #4513.
  return null;
}

/**
 * Pure: extrai os candidatos elegíveis do `02-reviewed.md` de UMA edição —
 * DESTAQUE 1/2/3 (via `parseDestaques`, mesmo parser do Stage 2/4/5 diários)
 * + itens de RADAR/USE MELHOR (via `parseSections`, mesmo parser reusado
 * por `weekly-linkedin-parse.ts::extractWeeklyCandidates` pro canal irmão
 * do LinkedIn) — nada de parser novo (#172). Itens sem URL são descartados.
 */
export function extractInstagramCandidates(md: string, editionDate: string): InstagramRawCandidate[] {
  const out: InstagramRawCandidate[] = [];
  for (const d of parseDestaques(md)) {
    if (!d.url) continue;
    out.push({
      editionDate,
      url: d.url,
      title: d.title,
      body: d.body,
      why: d.why,
      destaqueNumber: d.n,
      category: d.category,
      kind: "destaque",
    });
  }
  for (const section of parseSections(md)) {
    const norm = normalizeInstagramSectionName(section.name);
    if (!norm) continue;
    for (const item of section.items) {
      if (!item.url) continue;
      out.push({
        editionDate,
        url: item.url,
        title: item.title,
        body: item.description,
        why: "",
        category: section.name,
        kind: "section",
        section: norm,
      });
    }
  }
  return out;
}

// ─── Cache local de cliques do Beehiiv ─────────────────────────────────────
//
// Mesma fonte que a newsletter semanal do LinkedIn usa
// (`data/beehiiv-cache/posts/*.json`, populado por `scripts/beehiiv-sync.ts`
// + enriquecido via MCP `list_post_clicks`) — ver docstring de
// `weekly-linkedin-clicks.ts` pra por que este módulo não chama a MCP
// direto (só roda de subagent/top-level, nunca de script TS standalone) e
// por que o gate de 7 dias de `identifyPostsNeedingClicks` não se aplica
// (a janela de conteúdo desta skill tem 2-6 dias de idade).

export interface CachedClickRow {
  url: string;
  base_url?: string;
  email?: { unique_verified_clicks?: number; verified_clicks?: number };
  web?: { total_unique_clicked?: number };
}

export interface BeehiivCachePost {
  id: string;
  title?: string;
  status?: string;
  publish_date?: number | null; // epoch seconds
  stats?: {
    email?: { clicks?: number; unique_opens?: number };
    clicks?: CachedClickRow[];
  };
}

export interface InstagramPostNeedingClicks {
  id: string;
  title: string;
  email_clicks: number;
}

/** Pure: `epoch seconds` → `AAMMDD` local. */
export function aammddFromEpochSeconds(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Pure: mapa `AAMMDD → post` pros posts cacheados cujo `publish_date` cai
 * numa das datas de `windowDates` e `status === "confirmed"`.
 */
export function matchPostsToWindow(
  posts: BeehiivCachePost[],
  windowDates: string[],
): Map<string, BeehiivCachePost> {
  const windowSet = new Set(windowDates);
  const out = new Map<string, BeehiivCachePost>();
  for (const post of posts) {
    if (post.status !== "confirmed" || !post.publish_date) continue;
    const date = aammddFromEpochSeconds(post.publish_date);
    if (!windowSet.has(date)) continue;
    const existing = out.get(date);
    if (!existing || (existing.publish_date ?? 0) < post.publish_date) out.set(date, post);
  }
  return out;
}

/** Pure: posts da janela que ainda precisam de enriquecimento de clicks via MCP. */
export function identifyInstagramPostsNeedingClicks(
  windowPosts: Map<string, BeehiivCachePost>,
): InstagramPostNeedingClicks[] {
  const out: InstagramPostNeedingClicks[] = [];
  for (const post of windowPosts.values()) {
    const emailClicks = post.stats?.email?.clicks ?? 0;
    const hasClicks = (post.stats?.clicks?.length ?? 0) > 0;
    if (emailClicks > 0 && !hasClicks) {
      out.push({ id: post.id, title: post.title ?? "", email_clicks: emailClicks });
    }
  }
  return out;
}

/** Pure: normaliza URL pra matching (host lowercase, sem query/hash/barra final). */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hostname = u.hostname.toLowerCase();
    u.search = "";
    u.hash = "";
    return u.toString().replace(/[.,]+$/, "").replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/[.,]+$/, "").replace(/\/$/, "");
  }
}

export interface CandidateClickCount {
  /** `email.unique_verified_clicks` somado entre variantes da mesma URL base. */
  uniqueVerifiedClicks: number;
  /**
   * `web.total_unique_clicked` somado — clique por link ao ler o e-mail no
   * NAVEGADOR (preview web do e-mail), campo por-LINK do `list_post_clicks`.
   * NÃO é "webview"/pageview do post (métrica por-POST, separada, que a
   * issue #4483 explicitamente pede pra excluir por crescer com o tempo e
   * penalizar edições antigas — nunca aparece nesta função, que só lê
   * `stats.clicks[].web`).
   */
  webUniqueClicks: number;
}

/** Pure: soma cliques (verified email + web) pra uma URL, casando por `base_url`/`url` normalizado. */
export function clickCountsForUrl(url: string, clicks: CachedClickRow[] | undefined): CandidateClickCount {
  const target = normalizeUrl(url);
  const zero: CandidateClickCount = { uniqueVerifiedClicks: 0, webUniqueClicks: 0 };
  if (!clicks || clicks.length === 0) return zero;

  const rowBase = (c: CachedClickRow) => normalizeUrl(c.base_url || c.url);

  const sum = (rows: CachedClickRow[]): CandidateClickCount =>
    rows.reduce(
      (acc, c) => ({
        uniqueVerifiedClicks: acc.uniqueVerifiedClicks + (c.email?.unique_verified_clicks ?? 0),
        webUniqueClicks: acc.webUniqueClicks + (c.web?.total_unique_clicked ?? 0),
      }),
      { ...zero },
    );

  const exact = clicks.filter((c) => rowBase(c) === target);
  if (exact.length > 0) return sum(exact);

  const normNoProto = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
  const targetFuzzy = normNoProto(target);
  const fuzzy = clicks.filter((c) => normNoProto(rowBase(c)) === targetFuzzy);
  if (fuzzy.length > 0) return sum(fuzzy);

  return zero;
}

/** Pure: `unique_opens` do e-mail do post — denominador da taxa (issue #4483: "aberturas é o denominador certo"). */
export function uniqueOpensOf(post: BeehiivCachePost | undefined): number {
  return post?.stats?.email?.unique_opens ?? 0;
}

// ─── Exclusão de links comerciais/próprios ─────────────────────────────────
//
// `isCommercialOrOwnLink`/`hasSuspiciousCommercialLanguage` importados de
// `weekly-social-click-rank.ts` — ver docstring do arquivo (#4511).

// ─── Ranking + seleção ──────────────────────────────────────────────────────

export interface InstagramRankedCandidate extends InstagramRawCandidate {
  uniqueVerifiedClicks: number;
  webUniqueClicks: number;
  /** Aberturas únicas do e-mail da edição de origem. */
  opens: number;
  /** `(uniqueVerifiedClicks + webUniqueClicks) / opens * 100`, ou 0 se `opens === 0`. */
  ratePct: number;
  /** `true` quando o candidato foi excluído por ser link comercial/afiliado/propriedade própria. */
  excluded: boolean;
  /**
   * `false` quando o post da edição de origem está AUSENTE do cache local
   * de cliques (gap de sync, status≠confirmed, ou publish_date ausente) —
   * `opens`/`ratePct` são 0 por FALTA DE DADO, não porque o post genuinamente
   * não teve abertura.
   */
  hasClickData: boolean;
}

/** Pure: monta o `InstagramRankedCandidate` a partir de um candidato bruto + dados de clique já resolvidos. */
export function toRankedCandidate(
  raw: InstagramRawCandidate,
  clicks: CandidateClickCount,
  opens: number,
  hasClickData: boolean = true,
): InstagramRankedCandidate {
  const total = clicks.uniqueVerifiedClicks + clicks.webUniqueClicks;
  const ratePct = opens > 0 ? (total / opens) * 100 : 0;
  return {
    ...raw,
    uniqueVerifiedClicks: clicks.uniqueVerifiedClicks,
    webUniqueClicks: clicks.webUniqueClicks,
    opens,
    ratePct,
    excluded: isCommercialOrOwnLink(raw.url),
    hasClickData,
  };
}

/**
 * Pure: dedup por URL normalizada — quando a mesma matéria aparece tanto
 * como DESTAQUE quanto em RADAR/USE MELHOR (raro, mas o parser não impede),
 * mantém `kind: "destaque"` (corpo completo + card 4:5 já pré-gerado) sobre
 * `"section"` (mesmo critério de `weekly-linkedin-select.ts::dedupeCandidatesByUrl`,
 * #4513). Fora esse caso, mantém a primeira ocorrência.
 */
export function dedupeCandidatesByUrl(candidates: InstagramRankedCandidate[]): InstagramRankedCandidate[] {
  const byUrl = new Map<string, InstagramRankedCandidate>();
  for (const c of candidates) {
    const key = normalizeUrl(c.url);
    const existing = byUrl.get(key);
    if (!existing || (existing.kind === "section" && c.kind === "destaque")) {
      byUrl.set(key, c);
    }
  }
  return [...byUrl.values()];
}

// `withinClickNoise`, `hasProfessionalImplication`, `hasBrazilAngle`,
// `editorialTiebreakScore`, `byRateDescThenTitle` importados de
// `weekly-social-click-rank.ts` — ver docstring do arquivo (#4511).

export interface InstagramSelectionResult {
  /** Candidatos selecionados, em ordem de seleção (1ª posição do carrossel primeiro). */
  selected: InstagramRankedCandidate[];
  /** TODOS os candidatos elegíveis (não-excluídos), ranqueados — auditoria. */
  ranked: InstagramRankedCandidate[];
  /** Candidatos excluídos (comercial/afiliado/própria) — auditoria. */
  excluded: InstagramRankedCandidate[];
  warnings: string[];
}

/**
 * Seleciona os itens do post semanal do Instagram por taxa de clique, com
 * desempate editorial dentro do ruído de 1 clique. Pure.
 */
export function selectInstagramWeekly(candidatesIn: InstagramRankedCandidate[], maxItems: number): InstagramSelectionResult {
  const deduped = dedupeCandidatesByUrl(candidatesIn);
  const excluded = deduped.filter((c) => c.excluded);
  const eligible = deduped.filter((c) => !c.excluded).sort(byRateDescThenTitle);

  const selected: InstagramRankedCandidate[] = [];
  const selectedCategories = new Set<string>();
  const warnings: string[] = [];
  let remaining = eligible;

  while (selected.length < maxItems && remaining.length > 0) {
    const top = remaining[0];
    const tiedGroup = remaining.filter((c) => withinClickNoise(c, top));
    let winner: InstagramRankedCandidate;
    if (tiedGroup.length > 1) {
      const scored = tiedGroup
        .map((c) => ({ c, score: editorialTiebreakScore(c, selectedCategories) }))
        .sort((x, y) => y.score - x.score || byRateDescThenTitle(x.c, y.c));
      winner = scored[0].c;
      const missingData = tiedGroup.filter((c) => !c.hasClickData);
      if (missingData.length > 0) {
        warnings.push(
          `${tiedGroup.length} candidatos com a mesma taxa (${top.ratePct.toFixed(2)}%), mas NÃO é empate genuíno — ` +
            `${missingData.length} deles sem dado de clique real (edição ${[...new Set(missingData.map((c) => c.editionDate))].join(", ")} ` +
            `ausente/não confirmada no cache Beehiiv) — desempate editorial escolheu "${winner.title}" sem competição de clique de verdade.`,
        );
      } else {
        warnings.push(
          `Empate por clique entre ${tiedGroup.length} candidatos (dentro do ruído de 1 clique, ` +
            `${top.ratePct.toFixed(2)}%) — desempate editorial escolheu "${winner.title}"`,
        );
      }
    } else {
      winner = top;
    }
    selected.push(winner);
    selectedCategories.add(winner.category.toUpperCase());
    remaining = remaining.filter((c) => c !== winner);
  }

  if (selected.length < maxItems) {
    warnings.push(`Só ${selected.length}/${maxItems} candidatos elegíveis encontrados (após exclusão comercial/própria).`);
  }

  return { selected, ranked: eligible, excluded, warnings };
}

/**
 * Seleciona o carrossel "Principais Destaques" (#5330) — os D1 da semana,
 * um por edição, em ordem cronológica (segunda a sexta), SEM ranking por
 * clique. Reusa a mesma exclusão comercial/própria de `toRankedCandidate`
 * (`excluded`, calculado ali independente de qual seleção vai consumir o
 * candidato) — um D1 comercial/afiliado é descartado aqui do mesmo jeito que
 * seria em `selectInstagramWeekly`, só não compete por taxa de clique.
 *
 * Diferente de `selectInstagramWeekly`: não há desempate (1 D1 por edição,
 * nunca 2 do mesmo dia) nem `ranked` por taxa (a ordem É a ordem editorial
 * da semana). `warnings` sinaliza edição cuja D1 ficou de fora (comercial ou
 * ausente do pool de candidatos brutos).
 */
export function selectInstagramHighlights(candidatesIn: InstagramRankedCandidate[]): InstagramSelectionResult {
  const d1s = candidatesIn
    .filter((c) => c.kind === "destaque" && c.destaqueNumber === 1)
    .sort((a, b) => a.editionDate.localeCompare(b.editionDate));
  const excluded = d1s.filter((c) => c.excluded);
  const selected = d1s.filter((c) => !c.excluded);
  const warnings: string[] = [];
  for (const c of excluded) {
    warnings.push(`D1 de ${c.editionDate} ("${c.title}") excluído — link comercial/afiliado/próprio.`);
  }
  return { selected, ranked: selected, excluded, warnings };
}
