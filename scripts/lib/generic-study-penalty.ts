/**
 * generic-study-penalty.ts (#9462, decisão do editor de 05/10/2026)
 *
 * Classificador determinístico do formato que o editor mais tira do destaque
 * no gate 4: ESTUDO/ESTATÍSTICA ou CASE CORPORATIVO genérico SEM fato novo
 * concreto (lançamento, incidente, decisão, número inédito com consequência).
 *
 * Calibrado contra as decisões REAIS do editor (02-reviewed.md × top-3 do
 * 01-categorized.json, casadas por URL), não contra rótulo de agente — lição
 * da #8412. O ângulo Brasil NÃO é sinal: nenhuma regra olha país, domínio
 * .br, `brazil_p` ou menção a "Brasil" (decisão do editor: penalizar o
 * formato, não o Brasil).
 *
 * Forma da regra (só o TÍTULO — é onde o veículo declara o ângulo; o resumo
 * de imprensa quase sempre tem um "anunciou"/"lançou" genérico ou um número
 * que não é o fato da manchete, então vetaria quase tudo e não entra):
 *   generic = (ESTUDO no título | ESTATÍSTICA no título | CASE no título)
 *             E nenhum VETO de fato novo no título
 *             E nenhum VETO de ângulo de serviço ao leitor no título
 *             E bucket ≠ lancamento (link oficial = fato novo por definição)
 *
 * Puro: não lê disco. A aplicação (reordenar o top-3) mora em
 * `demoteGenericStudyHighlights` abaixo; o CLI em
 * `scripts/demote-generic-study-highlights.ts`.
 */

import { decodeHtmlEntities } from "./clean-summary.ts";
import { hasNegativeImpactTag, type HighlightLike } from "./negative-impact-promotion.ts";

export interface GenericStudyInput {
  title: string;
  bucket?: string;
}

export interface GenericStudyVerdict {
  generic: boolean;
  /** Sinais positivos (formato) que casaram. */
  signals: string[];
  /** Vetos (fato novo / serviço) que casaram — se houver, generic=false. */
  vetoes: string[];
}

function norm(s: string): string {
  return decodeHtmlEntities(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

// Fronteira de palavra Unicode-aware (o \b do JS é ASCII-only: quebra em "á").
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
function rx(body: string): RegExp {
  return new RegExp(`${B}(?:${body})${E}`, "iu");
}

// --- Sinais de FORMATO (título) -------------------------------------------

/** Estudo/pesquisa/levantamento citado como a notícia. */
const STUDY_TITLE = rx(
  "estudos?|pesquisas?|levantamentos?|relat[óo]rios?|sondagem|censo|" +
    "surveys?|study|studies|report\\s+(?:finds|found|shows|reveals)|" +
    "(?:os|segundo|de acordo com)\\s+dados|dados\\s+(?:mostram|revelam|apontam|indicam)",
);

/**
 * Estatística como manchete: "17,8% do mundo", "70% dos médicos", "x em cada
 * y". O percentual precisa vir de uma POPULAÇÃO (pessoas, empresas, mundo…):
 * "perde 17% do valor de mercado", "reduz preço em 80%" é número de um fato
 * concreto, não estatística de adoção (review da PR #9667).
 */
const POPULATION =
  "(?:empresas|profissionais|pessoas|trabalhadores|m[ée]dicos|executivos|usu[áa]rios|companhias|consumidores|" +
  "jovens|alunos|estudantes|brasileiros|americanos|europeus|adultos|funcion[áa]rios|l[íi]deres|ceos|gestores|" +
  "startups|organiza[çc][õo]es|desenvolvedores|programadores|internautas|entrevistados|respondentes|professores|" +
  "fam[íi]lias|popula[çc][ãa]o|mundo|pa[íi]s|planeta|mercado de trabalho|for[çc]a de trabalho|" +
  // fatia do TRABALHO feita por IA ("80% do código", "31% da jornada")
  "jornada|vendas|c[óo]digo|trabalho|tarefas|atendimentos|code|work|tasks|" +
  "people|companies|workers|employees|users|adults|developers|businesses|firms|respondents)";
const STAT_TITLE = new RegExp(
  `${B}\\d+(?:[.,]\\d+)?\\s?%\\s+(?:d[oa]s?|de)\\s+(?:\\p{L}+\\s+)?${POPULATION}${E}|` +
    `${B}\\d+(?:[.,]\\d+)?\\s?%\\s+(?:of|of all)\\s+(?:\\p{L}+\\s+)?${POPULATION}${E}|` +
    `${B}(?:quase|mais de|menos de|metade|maioria|um terço|dois terços)\\s+(?:d[oa]s?\\s+)?(?:\\d+(?:[.,]\\d+)?\\s?%\\s+)?(?:d[oa]s\\s+)?${POPULATION}${E}|` +
    `${B}\\d+\\s+em\\s+cada\\s+\\d+${E}`,
  "iu",
);

/**
 * Case corporativo: empresa usuária adotando IA como a notícia
 * ("Grupo Sabin reduz…", "McDonald's adota IA…", "Como as PMEs… estão
 * acelerando…", "…o uso da IA nas empresas").
 */
const CASE_TITLE = rx(
  // "adota" só vira case quando o objeto é IA/agentes/automação genérica:
  // "Apple adota Gemini na Siri" e "Meta adota marca d'água…" são decisão de
  // produto de uma empresa de IA, não empresa usuária adotando IA.
  "(?:adota|adotam|adotou)\\s+(?:a\\s+|o\\s+|uso\\s+d[ae]\\s+)?(?:ia|intelig[êe]ncia artificial|agentes?|automa[çc][ãa]o|ferramentas?\\s+de\\s+ia|ai)|" +
    "reduz|reduzem|reduziu|economiza|economizam|" +
    "como\\s+(?:as|os)\\s+(?:pmes|empresas|bancos|varejistas|startups|companhias|hospitais)|" +
    "nas\\s+empresas|nos\\s+neg[óo]cios|" +
    "j[áa]\\s+(?:devolve|decide|decidem|usa|usam|substitui|transforma)",
);

// --- VETOS: fato novo concreto (título) ------------------------------------

/** Lançamento/anúncio. */
const VETO_LAUNCH = rx(
  "lan[çc]a|lan[çc]ou|lan[çc]am|lan[çc]amento|launch(?:es|ed)?|introduc(?:es|ing)|" +
    "anuncia|anunciou|announc(?:es|ed)|apresenta|apresentou|estreia|estreou|libera|liberou|" +
    "chega(?!\\s+a\\s+\\d)|chegou|unveil(?:s|ed)?|releas(?:es|ed)|rolls? out|novo modelo|nova vers[ãa]o",
);

/** Incidente: dano concreto, ataque, falha, processo. */
const VETO_INCIDENT = rx(
  "golpes?|fraudes?|ataques?|hack(?:s|ed|ers?)?|hacke(?:ia|ar)|invad\\p{L}*|invas[ãa]o|vaz\\p{L}*|" +
    "falh(?:a|as|ou)|bug|deepfakes?|crimes?|criminos\\p{L}*|cybercrim\\p{L}*|cibercrim\\p{L}*|processo|processa\\p{L}*|multa\\p{L}*|" +
    "demit\\p{L}*|demiss\\p{L}*|layoffs?|mort\\p{L}*|morre\\p{L}*|vazamento|breach|lawsuit|sued?",
);

/**
 * Decisão: governo, regulação, justiça, transação, cancelamento. Nome de
 * país/bloco como LUGAR (EUA, Brasil…) NÃO entra — seria tratar o ângulo
 * geográfico como sinal. Instituição como ATOR entra, simétrica: órgão
 * brasileiro (STF, ANPD…) e estrangeiro (FTC, Casa Branca, Comissão
 * Europeia…) absolvem igual (review da PR #9667: só os BR protegiam).
 */
const VETO_DECISION = rx(
  "aprova\\p{L}*|lei|leis|regra|regras|regula\\p{L}*|proib\\p{L}*|pro[íi]be|ban(?:e|iu|s|ned)?|" +
    "decis[ãa]o|cancela\\p{L}*|suspende\\p{L}*|" +
    // instituições — genérico
    "governos?|government|tribuna(?:l|is)|justi[çc]a|courts?|ju[íi]z(?:a|es)?|judge|" +
    "regulador\\p{L}*|regulator\\p{L}*|ag[êe]ncias?\\s+regulador\\p{L}*|parlamentos?|parliament|" +
    "congresso|congress|senado|senate|minist[ée]rios?|ministry|ministro|prefeitura|" +
    // instituições — nomeadas (BR e estrangeiras, mesmo peso)
    "stf|stj|tse|tcu|anpd|anatel|cade|ftc|fcc|doj|casa\\s+branca|white\\s+house|" +
    "comiss[ãa]o\\s+europeia|european\\s+commission|parlamento\\s+europeu|european\\s+parliament|" +
    "acordo|adquire|aquisi[çc][ãa]o|compra|ipo|rodada|investe|investimento|bilh(?:ão|ões)|" +
    "acquir\\p{L}*|deal|ruling",
);

/**
 * Siglas de instituição que colidem com palavra comum em minúscula ("sec",
 * "eu" = pronome): só casam em MAIÚSCULA (SEC, UE, EU como ator regulatório).
 * OCDE/OECD fica de fora: aparece como régua de comparação ("maior do que
 * em países da OCDE"), não como quem decide.
 */
const VETO_DECISION_ACRONYM = new RegExp(`${B}(?:SEC|UE|EU|ONU|UN)${E}`, "u");

/**
 * Fato de produto concreto: preço, limite/cota, recurso novo chegando a
 * usuários ("ChatGPT ganha…", "Google leva… a mais 40 países"), valor de
 * mercado. Review da PR #9667: sem isso "reduz preço" e "adota" de empresa
 * de IA saíam como case corporativo.
 */
const VETO_PRODUCT = rx(
  // preço/limite como FATO (mudou, é da API/plano) — "McDonald's adota IA
  // para calcular preço de seus lanches" segue case, o preço ali é do cliente.
  "(?:reduz\\p{L}*|corta\\p{L}*|baixa\\p{L}*|aumenta\\p{L}*|sobe|dobra\\p{L}*|muda\\p{L}*|cuts?|raises?|slash\\p{L}*|lowers?)\\s+" +
    "(?:(?:o|os|a|as|seus?|suas?|its|the)\\s+)?(?:pre[çc]os?|prices?|pricing|limites?|cotas?|quotas?|rate\\s+limits?)|" +
    "(?:pre[çc]os?|prices?|pricing|limites?|cotas?|quotas?)\\s+(?:(?:d[aeo]s?|of|for)\\s+(?:the\\s+)?)?(?:api|planos?|plans?|assinaturas?|uso|usage|tokens?)|" +
    "ganha|ganham|ganhou|leva|levam|levou|expande|expandem|expandiu|integra|integram|integrou|" +
    "valor\\s+de\\s+mercado|market\\s+(?:cap|value)|a[çc][õo]es|shares",
);

/**
 * "Pesquisa" como NOME DE PRODUTO (Pesquisa Google, Pesquisa com IA,
 * pesquisa profunda / deep research) não é estudo: removido do título antes
 * de testar o sinal de estudo.
 */
const PRODUCT_SEARCH = new RegExp(
  `${B}(?:pesquisa\\s+(?:google|com\\s+ia|profunda|avan[çc]ada)|deep\\s+research|google\\s+search|ai\\s+mode|modo\\s+ia)${E}`,
  "giu",
);

/** Ângulo de serviço ao leitor ("veja como", "quem sabe usar…", "você"). */
const VETO_SERVICE = rx(
  "veja\\s+(?:como|quais|o que)|saiba\\s+como|como\\s+se\\s+proteger|quem\\s+sabe\\s+usar|voc[êe]",
);

/**
 * Consequência concreta para pessoas ("número inédito com consequência", nas
 * palavras do editor): emprego, renda, salário, vagas.
 */
const VETO_CONSEQUENCE = rx(
  "empregos?|empregabilidade|desemprego|renda|sal[áa]rios?|vagas|contrata\\p{L}*|jobs|wages|unemployment",
);

/** Comportamento do próprio sistema de IA como achado (pesquisa de laboratório). */
const VETO_AI_BEHAVIOR = rx(
  "replic\\p{L}*|autorreplic\\p{L}*|self-replicat\\p{L}*|engan\\p{L}*|mente|mentiu|chantage\\p{L}*|" +
    "trapace\\p{L}*|cheat\\p{L}*|" +
    "sabot\\p{L}*|rogue|rebel\\p{L}*|deceiv\\p{L}*|deception|misalign\\p{L}*|desalinh\\p{L}*",
);

/**
 * Classifica um candidato pelo título (+ bucket). Determinístico e puro.
 * Vetos vencem sinais: qualquer marcador de fato novo no título absolve.
 */
export function classifyGenericStudy(input: GenericStudyInput): GenericStudyVerdict {
  const title = norm(input.title);
  const signals: string[] = [];
  const vetoes: string[] = [];
  if (!title) return { generic: false, signals, vetoes };

  if (STUDY_TITLE.test(title.replace(PRODUCT_SEARCH, " "))) signals.push("estudo");
  if (STAT_TITLE.test(title)) signals.push("estatistica");
  if (CASE_TITLE.test(title)) signals.push("case");

  if (input.bucket === "lancamento") vetoes.push("bucket:lancamento");
  if (VETO_LAUNCH.test(title)) vetoes.push("fato:lancamento");
  if (VETO_INCIDENT.test(title)) vetoes.push("fato:incidente");
  if (VETO_DECISION.test(title) || VETO_DECISION_ACRONYM.test(title)) vetoes.push("fato:decisao");
  if (VETO_PRODUCT.test(title)) vetoes.push("fato:produto");
  if (VETO_CONSEQUENCE.test(title)) vetoes.push("fato:consequencia");
  if (VETO_AI_BEHAVIOR.test(title)) vetoes.push("fato:comportamento-de-ia");
  if (VETO_SERVICE.test(title)) vetoes.push("servico-ao-leitor");

  return { generic: signals.length > 0 && vetoes.length === 0, signals, vetoes };
}

// ---------------------------------------------------------------------------
// Reordenação do top-3
// ---------------------------------------------------------------------------

export interface GenericStudyHighlight extends HighlightLike {
  rank?: number;
}

export interface GenericStudyDemotion {
  url: string;
  title: string;
  bucket?: string;
  from_rank: number;
  to_rank: number;
  signals: string[];
  /** Quem subiu para a vaga (título do novo top-3 que não estava antes). */
  replaced_by?: string;
}

export interface GenericStudyKept {
  url: string;
  title: string;
  rank: number;
  reason: string;
  signals: string[];
}

export interface GenericStudyDemotionResult<H extends GenericStudyHighlight> {
  highlights: H[];
  demoted: GenericStudyDemotion[];
  kept: GenericStudyKept[];
}

function urlOf(h: GenericStudyHighlight): string {
  const u = h.url ?? h.article?.url;
  return typeof u === "string" ? u : "";
}

function titleOf(h: GenericStudyHighlight): string {
  const t = (h.article as { title?: unknown } | undefined)?.title ?? (h as { title?: unknown }).title;
  return typeof t === "string" ? t : "";
}

export function classifyHighlight(h: GenericStudyHighlight): GenericStudyVerdict {
  return classifyGenericStudy({
    title: titleOf(h),
    bucket: typeof h.bucket === "string" ? h.bucket : undefined,
  });
}

/**
 * Tira do top-3 os candidatos genéricos — penalidade de SELEÇÃO, não de
 * existência: o item continua em `highlights` (rank 4+) e no bucket dele
 * (pool); o editor pode promovê-lo de volta. Ordem nova: os não-genéricos na
 * ordem original, depois os genéricos. Ranks renumerados.
 *
 * Invariantes:
 *  - #3916: se o top-3 original tinha destaque de impacto negativo e o novo
 *    não tem, o melhor negativo não-genérico sobe para a 3ª vaga; sem um, o
 *    genérico negativo fica (só aviso, `kept`).
 *  - Com menos de 3 não-genéricos, os genéricos completam o top-3 (`kept`) —
 *    a edição nunca fica com menos destaques por causa da penalidade.
 *  - Item com `same_fact_demoted` (#9100) nunca é promovido por este passo.
 *  - Domínio (≤2 URLs/domínio, #5735): só reordena itens que JÁ estão na
 *    edição (nenhuma URL entra nem sai), então a contagem não muda.
 *
 * Puro: não muta `highlights`.
 */
export function demoteGenericStudyHighlights<H extends GenericStudyHighlight>(
  highlights: H[],
  topN = 3,
): GenericStudyDemotionResult<H> {
  const ordered = [...highlights].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const verdicts = new Map<H, GenericStudyVerdict>();
  for (const h of ordered) {
    const v = classifyHighlight(h);
    if (v.generic) verdicts.set(h, v);
  }
  const topBefore = ordered.slice(0, topN);
  if (!topBefore.some((h) => verdicts.has(h))) {
    return { highlights: highlights.slice(), demoted: [], kept: [] };
  }

  // Item já rebaixado por MESMO FATO (#9100, passo anterior) nunca sobe de
  // volta ao top-3 por causa desta penalidade: vai para o fim, atrás dos
  // genéricos.
  const blocked = (h: H) => h.same_fact_demoted !== undefined && h.same_fact_demoted !== null;
  const clean = ordered.filter((h) => !verdicts.has(h) && !blocked(h));
  const generic = ordered.filter((h) => verdicts.has(h) && !blocked(h));
  const tail = ordered.filter((h) => blocked(h));
  let next = [...clean, ...generic, ...tail];
  const keptNeg = new Set<H>();

  if (topBefore.some(hasNegativeImpactTag) && !next.slice(0, topN).some(hasNegativeImpactTag)) {
    const cleanNeg = clean.find((h, i) => i >= topN && hasNegativeImpactTag(h));
    if (cleanNeg) {
      const rest = next.filter((h) => h !== cleanNeg);
      next = [...rest.slice(0, topN - 1), cleanNeg, ...rest.slice(topN - 1)];
    } else {
      const negGeneric = topBefore.find((h) => verdicts.has(h) && hasNegativeImpactTag(h));
      if (negGeneric) {
        const rest = next.filter((h) => h !== negGeneric);
        const at = Math.min(topBefore.indexOf(negGeneric), topN - 1);
        next = [...rest.slice(0, at), negGeneric, ...rest.slice(at)];
        keptNeg.add(negGeneric);
      }
    }
  }

  const newTop = next.slice(0, topN);
  const risers = newTop.filter((h) => !topBefore.includes(h));
  const newHighlights = next.map((h, i) => ({ ...h, rank: i + 1 }));
  const demoted: GenericStudyDemotion[] = [];
  const kept: GenericStudyKept[] = [];
  let riserIdx = 0;
  next.forEach((h, i) => {
    const v = verdicts.get(h);
    if (!v) return;
    const fromIdx = ordered.indexOf(h);
    if (fromIdx >= topN) return; // já estava fora do top-N
    if (i < topN) {
      kept.push({
        url: urlOf(h),
        title: titleOf(h),
        rank: i + 1,
        reason: keptNeg.has(h)
          ? "único destaque de impacto negativo sem substituto (#3916) — mantido, só aviso"
          : "candidatos não-genéricos insuficientes para completar o top-3 — mantido, só aviso",
        signals: v.signals,
      });
      return;
    }
    const riser = risers[riserIdx++];
    demoted.push({
      url: urlOf(h),
      title: titleOf(h),
      ...(typeof h.bucket === "string" ? { bucket: h.bucket } : {}),
      from_rank: fromIdx + 1,
      to_rank: i + 1,
      signals: v.signals,
      ...(riser ? { replaced_by: titleOf(riser) } : {}),
    });
    newHighlights[i] = { ...newHighlights[i], generic_study_demoted: { signals: v.signals } };
  });
  return { highlights: newHighlights as H[], demoted, kept };
}

/**
 * Linha de aviso (relatório do Stage 1 / gate 4) para um rebaixamento.
 * `applied=false` (flag desligada, modo sombra) descreve o que a regra FARIA.
 */
export function formatGenericStudyNote(d: GenericStudyDemotion, applied = true): string {
  const why = `sinais: ${d.signals.join(", ")}`;
  const riser = d.replaced_by ? `"${d.replaced_by}"` : "o próximo candidato";
  if (!applied) {
    return (
      `🔎 ESTUDO/CASE GENÉRICO (penalidade desligada) — "${d.title}" (D${d.from_rank}) seria rebaixado ` +
      `e ${riser} subiria (${why}).`
    );
  }
  return (
    `⬇️ ESTUDO/CASE GENÉRICO — "${d.title}" rebaixado de D${d.from_rank} (ficou no pool${d.bucket ? `, ${d.bucket}` : ""}; ` +
    `${why}); subiu ${riser}. Promova de volta se houver fato novo.`
  );
}
