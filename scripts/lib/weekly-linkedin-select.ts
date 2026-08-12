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
 *      CTOR sozinho não decide — e, desde #5109, a decisão de QUAL(IS)
 *      candidato(s) da banda entram deixou de ser automática por critério
 *      editorial quando a banda excede as vagas restantes: vira escolha
 *      manual do editor no gate (ver `selectHeadlines`/`applyPendingPicks`
 *      abaixo).
 *
 * #4511 fleet review IMPORTANTE: o núcleo de ranking/desempate
 * (`withinClickNoise`, `hasBrazilAngle`, `hasProfessionalImplication`,
 * `editorialTiebreakScore`, `byRateDescThenTitle`) vive em
 * `weekly-social-click-rank.ts`, compartilhado com `weekly-instagram-select.ts`
 * (#4483) — não é mais duplicado byte-a-byte aqui. Reexportados abaixo pra
 * não quebrar os importadores existentes (`test/weekly-linkedin-select.test.ts`,
 * `select-linkedin-weekly.ts`).
 */

import { isCommercialOrOwnLink } from "./weekly-linkedin-filter.ts";
import { normalizeUrl } from "./weekly-linkedin-clicks.ts";
import type { WeeklyRawCandidate } from "./weekly-linkedin-parse.ts";
import {
  withinClickNoise,
  hasBrazilAngle,
  hasProfessionalImplication,
  editorialTiebreakScore,
  byRateDescThenTitle,
} from "./weekly-social-click-rank.ts";

export { withinClickNoise, hasBrazilAngle, hasProfessionalImplication, editorialTiebreakScore };

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
 * mais completa como PONTO DE PARTIDA, seja pro corpo levantado literal
 * de uma manchete que ficar com `textOrigin: "literal"`, seja como
 * material extra pra quem for escrever o resumo próprio, #5108).
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
 * Pure: dado o número de edições encontradas na janela (0-5), quantas
 * manchetes selecionar. "Semana com menos de 3 edições (feriado): reduz o
 * número de itens em vez de puxar da semana anterior" — nunca mais que 3,
 * nunca mais que o nº de edições disponíveis.
 */
export function computeHeadlineCap(editionsFound: number): number {
  return Math.max(0, Math.min(3, editionsFound));
}

export interface WeeklySelectionResult {
  /** Candidatos selecionados como manchete, em ordem de seleção (1ª = D1 do LinkedIn, etc). Pode ficar mais curto que `maxHeadlines` quando `pendingGroup !== null` — as vagas restantes aguardam escolha manual do editor. */
  selected: WeeklyRankedCandidate[];
  /**
   * #5109 (decisão do editor): CTOR puro decide FORA da banda de ruído.
   * DENTRO da banda (`withinClickNoise`), quando o grupo empatado é MAIOR
   * que as vagas restantes, a escolha de quais entram deixou de ser
   * automática (`editorialTiebreakScore` não resolve mais o empate aqui) —
   * este é o grupo inteiro que precisa de escolha manual do editor no gate
   * (Passo 3 da skill). `null` quando a seleção terminou sem ambiguidade
   * pendente (ou porque não houve empate largo o bastante, ou porque
   * `eligible` se esgotou antes de qualquer banda estourar as vagas).
   */
  pendingGroup: WeeklyRankedCandidate[] | null;
  /** Quantas vagas de `maxHeadlines` ainda faltam preencher a partir de `pendingGroup` — 0 quando `pendingGroup` é `null`. */
  pendingSlots: number;
  /**
   * TODOS os candidatos elegíveis PRA MANCHETE (não-excluídos,
   * não-use_melhor — #4492), ranqueados — auditoria. Nome distinto do pool
   * COMPLETO (todas as seções, incluindo use_melhor) usado por
   * `selectUseMelhor` em `select-linkedin-weekly.ts` — os dois eram chamados
   * `ranked` até o #4507, risco real de troca acidental (compilaria limpo,
   * `selectUseMelhor` sempre retornaria `undefined` em silêncio).
   */
  headlineEligible: WeeklyRankedCandidate[];
  /** Candidatos excluídos (comercial/afiliado/própria) — auditoria. */
  excluded: WeeklyRankedCandidate[];
  warnings: string[];
}

/**
 * Seleciona as manchetes da semana por CTOR puro (taxa de clique
 * verificado), com deferência ao editor quando o empate dentro do ruído de
 * 1 clique (`withinClickNoise`) excede as vagas restantes. Pure.
 *
 * #5109 (decisão do editor, comentário na própria issue): antes desta
 * mudança, um empate dentro da banda de ruído era resolvido AUTOMATICAMENTE
 * por `editorialTiebreakScore` (ângulo Brasil > implicação profissional >
 * diversidade de categoria) — achado ao vivo do ciclo `26w32`: a banda
 * engoliu 6 candidatos e o CTOR virou critério terciário, produzindo 3×
 * RADAR seguidos enquanto um candidato de 1,69% (🔒 SEGURANÇA, categoria
 * nova) perdia nas 3 rodadas pra candidatos de 1,14-1,29%. A partir daqui:
 * CTOR decide sozinho toda vez que NÃO há ambiguidade (banda de 1 candidato,
 * ou banda que cabe inteira nas vagas restantes); só quando a banda é MAIOR
 * que as vagas restantes a decisão fica pendente (`pendingGroup`) — o
 * caller (`select-linkedin-weekly.ts`) escreve o grupo no output pro gate
 * (Passo 3 da skill) apresentar ao editor, que escolhe manualmente. Uma
 * banda que cabe inteira nas vagas restantes (ex: 2 candidatos empatados,
 * 2 vagas) não tem escolha real a fazer — os dois entram, ordem entre eles é
 * arbitrária (`byRateDescThenTitle`) porque são estatisticamente
 * indistinguíveis. `editorialTiebreakScore` continua exportado e testado —
 * vira no máximo DICA calculada pelo caller pra exibição no gate, nunca
 * decisor automático (ver `select-linkedin-weekly.ts`).
 *
 * #4492: candidatos de `section === "use_melhor"` NUNCA competem por
 * manchete, mesmo quando têm a maior taxa de clique da semana — ficam
 * reservados exclusivamente pro bloco Use Melhor dedicado (`selectUseMelhor`,
 * que roda DEPOIS escolhendo só entre os `use_melhor` restantes).
 */
export function selectHeadlines(candidatesIn: WeeklyRankedCandidate[], maxHeadlines: number): WeeklySelectionResult {
  const deduped = dedupeCandidatesByUrl(candidatesIn);
  const excluded = deduped.filter((c) => c.excluded);
  const eligible = deduped.filter((c) => !c.excluded && c.section !== "use_melhor").sort(byRateDescThenTitle);

  const selected: WeeklyRankedCandidate[] = [];
  const warnings: string[] = [];
  let remaining = eligible;
  let pendingGroup: WeeklyRankedCandidate[] | null = null;

  while (selected.length < maxHeadlines && remaining.length > 0) {
    const top = remaining[0];
    const tiedGroup = remaining.filter((c) => withinClickNoise(c, top)).sort(byRateDescThenTitle);
    const slotsLeft = maxHeadlines - selected.length;

    // #4489 finding 1 (item 3): "empate" pode ser genuíno (todos os
    // candidatos têm dado de clique real e a taxa realmente coincide dentro
    // do ruído de 1 clique) ou um FALSO empate — 1+ candidato sem dado de
    // clique (post ausente do cache Beehiiv) caindo em ratePct=0 junto de
    // outro que também deu 0 por acaso/genuinamente. Preservado sob o novo
    // fluxo pendingGroup — o editor precisa saber ANTES de escolher.
    const missingData = tiedGroup.filter((c) => !c.hasClickData);

    if (tiedGroup.length > slotsLeft) {
      pendingGroup = tiedGroup;
      if (missingData.length > 0) {
        warnings.push(
          `${tiedGroup.length} candidatos com taxa próxima (${top.ratePct.toFixed(2)}%) disputam ${slotsLeft} vaga(s) restante(s), mas NÃO é empate genuíno — ` +
            `${missingData.length} deles sem dado de clique real (edição ${[...new Set(missingData.map((c) => c.editionDate))].join(", ")} ` +
            `ausente/não confirmada no cache Beehiiv) — escolha manual necessária no gate (Passo 3), CTOR não tem competição de verdade pra decidir aqui.`,
        );
      } else {
        warnings.push(
          `${tiedGroup.length} candidatos empatados (dentro do ruído de 1 clique, ${top.ratePct.toFixed(2)}%) disputam ${slotsLeft} vaga(s) restante(s) — ` +
            `escolha manual necessária no gate (Passo 3), CTOR não decide sozinho dentro da banda de ruído (#5109).`,
        );
      }
      break;
    }

    if (tiedGroup.length > 1) {
      warnings.push(
        `${tiedGroup.length} candidatos empatados (dentro do ruído de 1 clique, ${top.ratePct.toFixed(2)}%) cabem todos nas vagas restantes — incluídos sem necessidade de desempate.`,
      );
    }
    selected.push(...tiedGroup);
    const tiedGroupSet = new Set(tiedGroup);
    remaining = remaining.filter((c) => !tiedGroupSet.has(c));
  }

  if (maxHeadlines < 3) {
    warnings.push(`Semana com ${maxHeadlines} edição(ões) disponível(is) — reduzindo pra ${maxHeadlines} manchete(s) em vez de 3.`);
  }
  // Shortfall REAL (candidatos elegíveis esgotados) é distinto de
  // pendingGroup (decisão pendente, não falta de candidato) — só emite este
  // warning quando a razão de `selected.length < maxHeadlines` não é uma
  // escolha aguardando o editor.
  if (pendingGroup === null && selected.length < maxHeadlines) {
    const useMelhorSkipped = deduped.filter((c) => !c.excluded && c.section === "use_melhor").length;
    const commercialSkipped = excluded.length;
    warnings.push(
      `Só ${selected.length}/${maxHeadlines} candidatos elegíveis encontrados ` +
        `(${commercialSkipped} excluído(s) por comercial/própria, ${useMelhorSkipped} reservado(s) pro bloco Use Melhor).`,
    );
  }

  return {
    selected,
    pendingGroup,
    pendingSlots: pendingGroup ? maxHeadlines - selected.length : 0,
    headlineEligible: eligible,
    excluded,
    warnings,
  };
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

export interface ApplyPendingPicksResult {
  /** `selected` final (candidatos já decididos + escolhas do editor, nesta ordem) — só populado quando `error === null`. */
  selected: WeeklyRankedCandidate[];
  /** `null` em sucesso; motivo legível quando as escolhas não resolvem o `pendingGroup` de forma exata. */
  error: string | null;
}

/**
 * Pure: resolve o `pendingGroup` de `selectHeadlines` com as escolhas
 * explícitas do editor (#5109, Passo 3 do gate) — `select-linkedin-weekly.ts`
 * chama isto quando `--picks` é passado. Exige exatidão: `pickedUrls` precisa
 * ter EXATAMENTE `pendingSlots` URLs, todas presentes em `pendingGroup`, sem
 * repetição — qualquer divergência é erro explícito (nunca completa/trunca
 * em silêncio). Ordem de `pickedUrls` é preservada no `selected` final (o
 * editor decide também a ordem de exibição das manchetes escolhidas).
 */
export function applyPendingPicks(
  previousSelected: WeeklyRankedCandidate[],
  pendingGroup: WeeklyRankedCandidate[],
  pendingSlots: number,
  pickedUrls: string[],
): ApplyPendingPicksResult {
  if (pickedUrls.length !== pendingSlots) {
    return {
      selected: [],
      error: `--picks precisa de exatamente ${pendingSlots} URL(s) (recebeu ${pickedUrls.length}) — o grupo empatado tem ${pendingGroup.length} candidato(s) disputando ${pendingSlots} vaga(s).`,
    };
  }

  const byNormalizedUrl = new Map(pendingGroup.map((c) => [normalizeUrl(c.url), c]));
  const seen = new Set<string>();
  const chosen: WeeklyRankedCandidate[] = [];
  for (const rawUrl of pickedUrls) {
    const key = normalizeUrl(rawUrl);
    if (seen.has(key)) {
      return { selected: [], error: `--picks contém URL repetida: "${rawUrl}"` };
    }
    seen.add(key);
    const match = byNormalizedUrl.get(key);
    if (!match) {
      return {
        selected: [],
        error: `--picks contém URL fora do grupo empatado: "${rawUrl}" — candidatos elegíveis: ${pendingGroup.map((c) => c.url).join(", ")}`,
      };
    }
    chosen.push(match);
  }

  return { selected: [...previousSelected, ...chosen], error: null };
}
