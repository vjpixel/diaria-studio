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
 * `extractInstagramCandidates` (parser específico — só destaques, nunca
 * seções), `toRankedCandidate` (o tipo de entrada difere —
 * `InstagramRawCandidate` tem `destaqueNumber`; `WeeklyRawCandidate` do
 * LinkedIn tem `kind`/`section`), e `dedupeCandidatesByUrl` (o LinkedIn
 * prioriza `kind:"destaque"` sobre `"section"`; aqui só existe destaque).
 *
 * **Por que o pool de candidatos é só DESTAQUE (D1/D2/D3), nunca
 * RADAR/USE MELHOR** (diferente do LinkedIn, que inclui as 4 seções): o
 * post semanal do Instagram é um CARROSSEL de imagens — 1 card 4:5 por
 * item selecionado, com o TÍTULO do destaque já EMBUTIDO na imagem
 * (`gen-social-card-4x5.ts`, ver `scripts/upload-images-public.ts`). Só
 * D1/D2/D3 têm esse card gerado (`imageSpecsFor` no upload script);
 * RADAR/USE MELHOR nunca tiveram imagem própria. Se um item de RADAR/USE
 * MELHOR vencesse o ranking, não haveria card correto pra mostrar — usar o
 * card do D1 da mesma edição como substituto mostraria o TÍTULO ERRADO
 * (do D1, não da matéria selecionada) embutido na imagem, o que é pior que
 * excluir o candidato.
 *
 * **Isto é uma LIMITAÇÃO TÉCNICA ATUAL, não uma decisão de escopo aceita
 * pelo editor** (correção #4511 — a versão anterior desta docstring dizia
 * "registrado como scoping decision", o que não reflete o que o editor de
 * fato decidiu): o comentário de resolução do editor na issue #4483 pediu
 * EXPLICITAMENTE que Radar/Use Melhor competissem no ranking. O editor
 * aceitou a restrição D1/D2/D3 por ora, mas pediu que isso ficasse
 * documentado como limitação PENDENTE, não como decisão concordada. Ver
 * #4513 (issue de follow-up: gerar card 4:5 pra Radar/Use Melhor, depois
 * remover esta restrição).
 */

import { parseDestaques } from "../extract-destaques.ts";
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

// ─── Extração de candidatos (só destaques — ver docstring do arquivo) ─────

export interface InstagramRawCandidate {
  /** AAMMDD da edição de origem. */
  editionDate: string;
  url: string;
  /** Título do destaque (literal — nunca reescrito na seleção/montagem). */
  title: string;
  body: string;
  why: string;
  /** 1, 2 ou 3 — usado pra resolver a imagem 4:5 (`d{n}_4x5`) da edição de origem. */
  destaqueNumber: 1 | 2 | 3;
  /** Categoria do destaque (`DESTAQUE N | categoria`) — usada na diversidade de desempate. */
  category: string;
}

/**
 * Pure: extrai os candidatos elegíveis (só DESTAQUE 1/2/3 com URL
 * não-vazia) do `02-reviewed.md` de UMA edição. Reusa `parseDestaques`
 * (mesmo parser do Stage 2/4/5 diários) — nada de parser novo (#172).
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
    });
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

/** Pure: dedup por URL normalizada — mantém a primeira ocorrência. */
export function dedupeCandidatesByUrl(candidates: InstagramRankedCandidate[]): InstagramRankedCandidate[] {
  const byUrl = new Map<string, InstagramRankedCandidate>();
  for (const c of candidates) {
    const key = normalizeUrl(c.url);
    if (!byUrl.has(key)) byUrl.set(key, c);
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
