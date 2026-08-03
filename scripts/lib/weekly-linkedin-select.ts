/**
 * weekly-linkedin-select.ts (#4456)
 *
 * Seleção por clique das matérias da newsletter semanal do LinkedIn —
 * núcleo puro/testável (sem rede, sem disco), reunindo as 3 correções do
 * comentário 260802 (2º) do #4456:
 *
 *   1. Ranqueia por TAXA de clique verificado (cliques únicos ÷ aberturas
 *      únicas), não clique bruto — evita comparar edição de fim de mês
 *      (lista maior) com edição de início de mês.
 *   2. Exclui links comerciais/afiliados/propriedade própria ANTES de
 *      ranquear (`weekly-linkedin-filter.ts`) — sem isso, Divulgação e
 *      propriedade própria (que clicam bem por natureza) contaminam o topo.
 *   3. Desempate por RUÍDO: quando a diferença de taxa entre 2 candidatos é
 *      menor que "o valor de 1 clique" (1/aberturas, em pontos percentuais),
 *      não desempata por número — cai no critério editorial (ângulo Brasil >
 *      implicação profissional > diversidade de categoria).
 */

import { classifyOrigin } from "../build-link-ctr.ts";
import { isCommercialOrOwnLink } from "./weekly-linkedin-filter.ts";
import { normalizeUrl } from "./weekly-linkedin-clicks.ts";
import type { WeeklyRawCandidate } from "./weekly-linkedin-parse.ts";

export interface WeeklyRankedCandidate extends WeeklyRawCandidate {
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
   * de cliques do Beehiiv (gap de sync, status≠confirmed, ou publish_date
   * ausente — ver `matchPostsToWindow`) — nesse caso `opens`/`ratePct` são 0
   * por FALTA DE DADO, não porque o post genuinamente não teve abertura
   * (achado #4489 finding 1). `true` = o post foi encontrado no cache
   * (mesmo que `opens` acabe sendo 0 de verdade nele).
   */
  hasClickData: boolean;
}

/** Pure: monta o `WeeklyRankedCandidate` a partir de um candidato bruto + dados de clique já resolvidos. */
export function toRankedCandidate(
  raw: WeeklyRawCandidate,
  clicks: { uniqueVerifiedClicks: number; webUniqueClicks: number },
  opens: number,
  hasClickData: boolean = true,
): WeeklyRankedCandidate {
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
 * Pure: dedup por URL normalizada — quando a mesma matéria aparece em mais
 * de uma seção da edição (raro, mas o parser não impede), mantém só a
 * primeira ocorrência, priorizando `kind: "destaque"` sobre `"section"`
 * (o destaque tem corpo completo; um item de seção só tem 1 linha de
 * descrição — se os dois existirem pra mesma URL, o destaque é a versão
 * mais completa pra levantar literal).
 */
export function dedupeCandidatesByUrl(candidates: WeeklyRankedCandidate[]): WeeklyRankedCandidate[] {
  const byUrl = new Map<string, WeeklyRankedCandidate>();
  for (const c of candidates) {
    const key = normalizeUrl(c.url);
    const existing = byUrl.get(key);
    if (!existing || (existing.kind === "section" && c.kind === "destaque")) {
      byUrl.set(key, c);
    }
  }
  return [...byUrl.values()];
}

/**
 * Pure: `true` quando a diferença de taxa entre `a` e `b` é menor que "o
 * valor de 1 clique" — usa o MAIOR incremento-de-1-clique entre os dois
 * (o denominador menor produz o incremento maior; usar o maior dos dois é a
 * leitura generosa/conservadora — nunca subestima o ruído). `opens <= 0` em
 * qualquer lado desativa a banda de ruído (não há como calibrar o incremento
 * de 1 clique sem denominador) — comparação cai pra diferença estrita.
 */
export function withinClickNoise(a: WeeklyRankedCandidate, b: WeeklyRankedCandidate): boolean {
  if (a.opens <= 0 || b.opens <= 0) return a.ratePct === b.ratePct;
  const oneClickPct = Math.max(100 / a.opens, 100 / b.opens);
  return Math.abs(a.ratePct - b.ratePct) < oneClickPct;
}

const PROFESSIONAL_IMPLICATION_RE =
  /emprego|carreira|trabalh|profiss|mercado de trabalho|curr[ií]culo|vaga|contrata[çc][ãa]o|demiss/i;

/** Pure: heurística de "implicação profissional" — palavra-chave em título/categoria/corpo. */
export function hasProfessionalImplication(c: WeeklyRankedCandidate): boolean {
  return PROFESSIONAL_IMPLICATION_RE.test(`${c.title} ${c.category} ${c.body}`);
}

/** Pure: heurística de "ângulo Brasil" — reusa `classifyOrigin` (mesmo classificador do CTR table). */
export function hasBrazilAngle(c: WeeklyRankedCandidate): boolean {
  let domain = "";
  try {
    domain = new URL(c.url).hostname;
  } catch {
    // URL ilegível — domain fica vazio, classifyOrigin decide só pelo texto.
  }
  return classifyOrigin(`${c.title} ${c.body} ${c.why} ${c.category}`, domain) === "BR";
}

/**
 * Pure: score do critério editorial de desempate (#4456: "ângulo Brasil >
 * implicação profissional > diversidade de categoria"). Pesos em ordem
 * lexicográfica estrita (100 > 50 > 10 — nenhuma combinação dos critérios
 * mais fracos supera o mais forte).
 */
export function editorialTiebreakScore(c: WeeklyRankedCandidate, alreadySelectedCategories: Set<string>): number {
  let score = 0;
  if (hasBrazilAngle(c)) score += 100;
  if (hasProfessionalImplication(c)) score += 50;
  if (!alreadySelectedCategories.has(c.category.toUpperCase())) score += 10;
  return score;
}

function byRateDescThenTitle(a: WeeklyRankedCandidate, b: WeeklyRankedCandidate): number {
  return b.ratePct - a.ratePct || a.title.localeCompare(b.title);
}

/**
 * Pure: dado o número de edições encontradas na janela (0-5), quantas
 * manchetes selecionar. "Semana com menos de 3 edições (feriado): reduz o
 * número de itens em vez de puxar da semana anterior" — nunca mais que 3,
 * nunca mais que o nº de edições disponíveis.
 */
export function computeHeadlineCap(editionsFound: number): number {
  return Math.max(0, Math.min(3, editionsFound));
}

export interface WeeklySelectionResult {
  /** Candidatos selecionados como manchete, em ordem de seleção (1ª = D1 do LinkedIn, etc). */
  selected: WeeklyRankedCandidate[];
  /**
   * TODOS os candidatos elegíveis PRA MANCHETE (não-excluídos,
   * não-use_melhor — #4492), ranqueados — auditoria.
   */
  ranked: WeeklyRankedCandidate[];
  /** Candidatos excluídos (comercial/afiliado/própria) — auditoria. */
  excluded: WeeklyRankedCandidate[];
  warnings: string[];
}

/**
 * Seleciona as manchetes da semana por taxa de clique, com desempate
 * editorial dentro do ruído de 1 clique (ver `withinClickNoise`). Pure.
 *
 * #4492: candidatos de `section === "use_melhor"` NUNCA competem por
 * manchete, mesmo quando têm a maior taxa de clique da semana — ficam
 * reservados exclusivamente pro bloco Use Melhor dedicado (`selectUseMelhor`,
 * que roda DEPOIS escolhendo só entre os `use_melhor` restantes). Sem essa
 * exclusão, o melhor candidato Use Melhor virava manchete e o próprio bloco
 * Use Melhor caía pra um candidato mais fraco por exclusão — mesmo padrão do
 * filtro `excluded` (comercial/afiliado/própria) já aplicado abaixo. Trade-off
 * aceito (decisão da issue): em semanas com poucos candidatos não-use_melhor
 * de clique real, a manchete #3 pode cair pro desempate editorial — não é
 * regressão.
 */
export function selectHeadlines(candidatesIn: WeeklyRankedCandidate[], maxHeadlines: number): WeeklySelectionResult {
  const deduped = dedupeCandidatesByUrl(candidatesIn);
  const excluded = deduped.filter((c) => c.excluded);
  const eligible = deduped.filter((c) => !c.excluded && c.section !== "use_melhor").sort(byRateDescThenTitle);

  const selected: WeeklyRankedCandidate[] = [];
  const selectedCategories = new Set<string>();
  const warnings: string[] = [];
  let remaining = eligible;

  while (selected.length < maxHeadlines && remaining.length > 0) {
    const top = remaining[0];
    const tiedGroup = remaining.filter((c) => withinClickNoise(c, top));
    let winner: WeeklyRankedCandidate;
    if (tiedGroup.length > 1) {
      const scored = tiedGroup
        .map((c) => ({ c, score: editorialTiebreakScore(c, selectedCategories) }))
        .sort((x, y) => y.score - x.score || byRateDescThenTitle(x.c, y.c));
      winner = scored[0].c;
      // #4489 finding 1 (item 3): "empate" pode ser genuíno (todos os
      // candidatos têm dado de clique real e a taxa realmente coincide
      // dentro do ruído de 1 clique) ou um FALSO empate — 1+ candidato sem
      // dado de clique (post ausente do cache Beehiiv) caindo em ratePct=0
      // junto de outro que também deu 0 por acaso/genuinamente. As 2 causas
      // exigem texto de warning diferente — tratar como "empate" quando na
      // verdade é "sem dado" esconde do editor que a seleção não competiu
      // de verdade.
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

  if (maxHeadlines < 3) {
    warnings.push(`Semana com ${maxHeadlines} edição(ões) disponível(is) — reduzindo pra ${maxHeadlines} manchete(s) em vez de 3.`);
  }
  if (selected.length < maxHeadlines) {
    warnings.push(`Só ${selected.length}/${maxHeadlines} candidatos elegíveis encontrados (após exclusão comercial/própria).`);
  }

  return { selected, ranked: eligible, excluded, warnings };
}

/**
 * Seleciona a entrada do bloco USE MELHOR: o candidato de maior taxa cuja
 * seção de origem é `use_melhor`, EXCLUINDO URLs já escolhidas como
 * manchete (evita repetir a mesma matéria 2× na mesma edição do LinkedIn).
 * Pure. `undefined` se não houver candidato elegível.
 */
export function selectUseMelhor(
  candidatesIn: WeeklyRankedCandidate[],
  headlineUrls: Set<string>,
): WeeklyRankedCandidate | undefined {
  const deduped = dedupeCandidatesByUrl(candidatesIn);
  const pool = deduped
    .filter((c) => !c.excluded && c.section === "use_melhor" && !headlineUrls.has(normalizeUrl(c.url)))
    .sort(byRateDescThenTitle);
  return pool[0];
}
