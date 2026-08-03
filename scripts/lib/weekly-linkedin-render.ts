/**
 * weekly-linkedin-render.ts (#4456)
 *
 * Monta o artefato colável (`ln-{cycle}.html`) da newsletter semanal do
 * LinkedIn a partir da seleção já aprovada (`select-linkedin-weekly.ts`) +
 * texto novo já humanizado/corrigido (abertura, fecho, comentário do USE
 * MELHOR — a skill roda `humanizador` + Clarice ANTES de chamar este módulo;
 * ver `.claude/skills/diaria-linkedin-semanal/SKILL.md`).
 *
 * Regras do comentário 260802 (3º) do #4456, todas aplicadas aqui:
 *   - Título do destaque entra LITERAL — só a numeração ("1.", "2.", "3.")
 *     é adicionada. Nunca reescrito, nunca linkado (ver "Cai o link por
 *     destaque").
 *   - Bloco USE MELHOR é OBRIGATÓRIO só quando há comentário do editor —
 *     ausente/vazio → bloco inteiro omitido (nunca gerado por esta função).
 *   - Texto de link NUNCA termina em domínio nu (auto-linkagem do LinkedIn
 *     parte o link em dois e a parte clicável fica sem UTM) — usa sempre
 *     rótulo de ação.
 *   - UTM: `utm_source=linkedin&utm_medium=newsletter&utm_campaign=ln-{cycle}
 *     &utm_content=cta-abertura|lista|cta-usemelhor|cta-fim` (item-01/02/03
 *     SAÍRAM; `cta-abertura` ENTROU em 260803). São 3 CTAs de assinatura, um
 *     por terço da peça, cada um com `utm_content` próprio: sem isso não dá pra
 *     saber qual posição converte e a decisão de manter/cortar vira palpite.
 */

export const LINKEDIN_WEEKLY_UTM_SOURCE = "linkedin";
export const LINKEDIN_WEEKLY_UTM_MEDIUM = "newsletter";

/** Pure: `utm_campaign` da newsletter semanal do LinkedIn — `ln-{cycle}` (#4456). */
export function linkedinWeeklyCampaign(cycle: string): string {
  return `ln-${cycle}`;
}

export type LinkedinWeeklyUtmContent = "mencao-abertura" | "cta-abertura" | "lista" | "cta-usemelhor" | "cta-fim";

/** Pure: monta uma URL com o triplo UTM completo (+ `utm_content`) do contrato do #4456. */
export function buildLinkedinWeeklyUrl(baseUrl: string, cycle: string, content: LinkedinWeeklyUtmContent): string {
  const u = new URL(baseUrl);
  u.searchParams.set("utm_source", LINKEDIN_WEEKLY_UTM_SOURCE);
  u.searchParams.set("utm_medium", LINKEDIN_WEEKLY_UTM_MEDIUM);
  u.searchParams.set("utm_campaign", linkedinWeeklyCampaign(cycle));
  u.searchParams.set("utm_content", content);
  return u.toString();
}

/** Base da diar.ia.br pros 2 CTAs de assinatura (meio e fim) — mesma constante base de `edition-url.ts`. */
export const LINKEDIN_WEEKLY_SUBSCRIBE_BASE_URL = "https://diar.ia.br";

/** Pure: rótulo de ação nunca termina em domínio nu (achado operacional #4456 — auto-linkagem do LinkedIn). */
export function endsInBareDomainLabel(label: string): boolean {
  return /(^|\s)([a-z0-9-]+\.)+[a-z]{2,}\/?$/i.test(label.trim());
}

/**
 * Chamada do CTA do bloco Use Melhor (decisão do editor 260803, #4456): frase
 * de contexto + âncora, em vez de link solto. Este é o PRIMEIRO convite de
 * assinatura da edição (o bloco cai depois do 2º headline — ver docstring de
 * `renderLinkedinWeeklyHtml`), e um link sem frase não diz ao leitor o que ele
 * ganha assinando. A frase promete exatamente o que o bloco acima acabou de
 * entregar, então o convite é verificável pelo próprio conteúdo da peça.
 *
 * PLURAL de propósito ("tutoriais e dicas", nunca "um desses"): a seção Use
 * Melhor da edição diária leva de 1 a 3 itens (semana 26w31: 3, 3, 2, 1, 3),
 * então o singular subvende o que o assinante recebe de fato. Sem menção a
 * tempo de leitura (decisão do editor 260803): o que converte aqui é a cadência
 * diária, não a duração de cada item.
 *
 * A âncora é em 1ª pessoa e sem "grátis"/imperativo empilhados de propósito: o
 * aprendizado do CTA-01 (`docs/experiments/cta-ab-mensal-2606-07.md`) é que
 * âncora com verbo imperativo + "grátis" + seta concentra sinal promocional e
 * custa ENTREGA. O "de graça" continua existindo na peça, mas no fecho em prosa,
 * longe da âncora clicável.
 */
/**
 * Âncora do CTA que fecha a ABERTURA (decisão do editor 260803, #4456). Quem
 * abandona o artigo depois da 1ª manchete nunca alcança o CTA do Use Melhor
 * (que só entra depois da 2ª) nem o do fim, então existe um ponto de entrada
 * acima da dobra.
 *
 * Deliberadamente a MAIS sóbria das três: verbo no infinitivo, sem "grátis",
 * sem seta. É a forma do braço A do CTA-01 (`docs/experiments/cta-ab-mensal-2606-07.md`),
 * o único que sobreviveu ao teste sem degradar entrega. A densidade promocional
 * acima da dobra foi o gatilho identificado lá, então os CTAs com mais peso
 * ficam no meio (`cta-usemelhor`) e no fim (`cta-fim`) da peça.
 */
/**
 * Separador entre os destaques de uma mesma edição na lista "Edições da semana".
 * Precisa ser TEXTO (não estrutura HTML) porque o editor de artigo do LinkedIn
 * achata `<ul>` aninhada — ver comentário no laço de `weeklyEditions`.
 */
export const DESTAQUE_SEPARATOR = " · ";

const CTA_ABERTURA_LABEL = "Assinar a edição diária";
const CTA_USEMELHOR_LEAD = "Tutoriais e dicas como este saem em toda edição diária.";
const CTA_USEMELHOR_LABEL = "Quero receber a edição diária →";
const CTA_FIM_LABEL = "Assine grátis, é rapidinho →";

export interface WeeklyLinkedinHeadlineInput {
  /** Título literal (copiado do bloco de origem — nunca reescrito). */
  title: string;
  /** Corpo literal (parágrafos separados por linha em branco dupla). */
  body: string;
  /** "Por que isso importa" literal — "" se ausente (candidato de seção, não destaque). */
  why: string;
}

export interface WeeklyLinkedinUseMelhorInput {
  title: string;
  url: string;
  description: string;
  /** Comentário do editor — OBRIGATÓRIO pra o bloco renderizar. Vazio/whitespace = bloco omitido. */
  editorComment: string;
}

export interface WeeklyLinkedinEditionItem {
  editionDate: string;
  /** URL pública da edição (derivada do D1 via `deriveEditionUrl`). */
  url: string;
  /**
   * Títulos dos até-3 destaques da edição, na ordem (D1 primeiro). Decisão
   * do editor 260802 (#4456, registrada em comentário na issue) resolve o
   * achado #4489 finding 8b — "Edições da semana" (nome também decidido
   * nessa sessão, era "Resto da semana") lista as edições da janela com D1
   * parseável — até 5, pode ser menos em semana curta (feriado) ou com
   * algum D1 ilegível — com link + seus destaques, não só as que perderam
   * a disputa de manchete.
   */
  destaques: string[];
}

export interface WeeklyLinkedinRenderInput {
  cycle: string;
  /** 1-3 manchetes, na ordem de seleção. */
  headlines: WeeklyLinkedinHeadlineInput[];
  useMelhor?: WeeklyLinkedinUseMelhorInput;
  /** Edições da semana com D1 parseável (até 5) — link + destaques de cada uma ("Edições da semana", #4456). */
  weeklyEditions: WeeklyLinkedinEditionItem[];
  /** Abertura — prosa nova, já humanizada/corrigida pela skill (Skill("humanizador") + Clarice). */
  opening: string;
  /** Fecho antes do CTA final — prosa nova, já humanizada/corrigida. */
  closing: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paragraphsHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("\n");
}

/** Wordmark da marca, como aparece em prosa. Base de `linkifyWordmark`. */
export const WORDMARK = "diar.ia.br";

/** Palavras que a âncora do wordmark estende além do domínio (ver `linkifyWordmark`). */
const WORDMARK_TRAILING_WORDS = 3;

/**
 * Pure: transforma a PRIMEIRA menção em prosa a `diar.ia.br` num link com UTM.
 *
 * Por que existe: o editor de artigo do LinkedIn auto-linka toda menção ao
 * domínio mesmo fora de link intencional, e o link que ELE cria aponta pra home
 * CRUA, sem UTM. É o primeiro clique possível da peça e estava saindo inteiro
 * da medição. Pré-linkado, o clique passa a ser atribuível.
 *
 * Por que a âncora ESTENDE além do domínio (testado ao vivo 260803, editor do
 * LinkedIn, as duas formas):
 *
 *   texto "diar.ia.br"                    -> href REESCRITO pra http://diar.ia.br, UTM perdida
 *   texto "diar.ia.br, newsletter de IA"  -> href preservado, UTM intacta
 *
 * É o mesmo fenômeno que `endsInBareDomainLabel` já guarda pros outros rótulos:
 * o auto-linkificador só sequestra a âncora quando ela TERMINA no domínio. Daí
 * estender por algumas palavras resolver.
 *
 * Degrada em silêncio seguro: se mesmo estendida a âncora terminar em domínio
 * (ex: o wordmark é a última coisa do parágrafo), NÃO linka — melhor perder a
 * atribuição do que emitir um link que se anuncia rastreado e não é. Opera
 * sobre a saída de `paragraphsHtml` (já escapada), nunca sobre prosa crua.
 */
export function linkifyWordmark(paragraphsHtmlOut: string, cycle: string): string {
  const idx = paragraphsHtmlOut.indexOf(WORDMARK);
  if (idx < 0) return paragraphsHtmlOut;
  const after = paragraphsHtmlOut.slice(idx + WORDMARK.length);
  // estende por até N palavras, parando em qualquer tag (não atravessa parágrafo)
  const tail = after.match(new RegExp(`^(?:[^<\\s]*\\s+){0,${WORDMARK_TRAILING_WORDS}}[^<\\s]*`))?.[0] ?? "";
  const label = (WORDMARK + tail).replace(/\s+$/, "");
  if (endsInBareDomainLabel(label)) return paragraphsHtmlOut;
  const url = buildLinkedinWeeklyUrl(LINKEDIN_WEEKLY_SUBSCRIBE_BASE_URL, cycle, "mencao-abertura");
  return (
    paragraphsHtmlOut.slice(0, idx) +
    `<a href="${escapeHtml(url)}">${label}</a>` +
    paragraphsHtmlOut.slice(idx + label.length)
  );
}

/** Pure: título numerado — única transformação permitida sobre o título literal (#4456). */
export function numberedTitle(n: number, title: string): string {
  return `${n}. ${title}`;
}

/** Pure: `AAMMDD` → "Edição de DD/MM" — rótulo de link pra "Edições da semana", nunca termina em domínio nu. */
export function editionLabel(aammdd: string): string {
  const dd = aammdd.slice(4, 6);
  const mm = aammdd.slice(2, 4);
  return `Edição de ${dd}/${mm}`;
}

export interface WeeklyLinkedinRenderResult {
  html: string;
  warnings: string[];
  /** `false` quando `useMelhor` foi passado mas o bloco foi OMITIDO por falta de comentário do editor. */
  useMelhorRendered: boolean;
}

/**
 * Monta o HTML colável. Pure — nenhuma chamada de rede/disco. `input.opening`/
 * `input.closing`/`useMelhor.editorComment` já devem estar humanizados/
 * corrigidos (responsabilidade da skill, não deste módulo).
 *
 * Ordem de montagem (opening → headline 1 → headline 2 → Use Melhor →
 * headline 3 → Edições da semana → closing) restaura o template original da
 * issue #4456 — decisão do editor (#4489): o CTA de assinatura que fecha o
 * bloco Use Melhor é o primeiro convite da edição, e cair no meio (depois de
 * 2 dos 3 headlines) alcança o leitor engajado que não necessariamente lê a
 * edição inteira — quem abandona antes do 3º headline nunca veria o CTA se o
 * bloco viesse só depois de todos os headlines.
 */
export function renderLinkedinWeeklyHtml(input: WeeklyLinkedinRenderInput): WeeklyLinkedinRenderResult {
  const warnings: string[] = [];
  const parts: string[] = [];

  // #4489 finding 3: opening/closing são SEMPRE obrigatórios (diferente do
  // comentário do Use Melhor, que é legitimamente opcional) — `resolveTextArg`
  // (render-linkedin-weekly.ts) retorna "" em silêncio quando a flag foi
  // omitida ou o arquivo é ilegível/vazio; sem este warning o parágrafo
  // simplesmente desaparece do artefato final sem nenhum sinal.
  if (!input.opening.trim()) {
    warnings.push("Abertura ausente/vazia — parágrafo de abertura omitido (opening é obrigatório, não opcional como o comentário do Use Melhor).");
  }
  // Abertura e fecho quebram em parágrafos por linha em branco dupla, igual ao
  // corpo das manchetes (decisão do editor 260803). Antes iam num <p> único, o
  // que empilhava 5-6 frases num bloco só e afundava a leitura no LinkedIn.
  if (input.opening.trim()) {
    parts.push(linkifyWordmark(paragraphsHtml(input.opening), input.cycle));
    const ctaAberturaUrl = buildLinkedinWeeklyUrl(LINKEDIN_WEEKLY_SUBSCRIBE_BASE_URL, input.cycle, "cta-abertura");
    parts.push(`<p><a href="${escapeHtml(ctaAberturaUrl)}">${escapeHtml(CTA_ABERTURA_LABEL)}</a></p>`);
  }

  function pushHeadline(h: WeeklyLinkedinHeadlineInput, n: number): void {
    parts.push(`<h2>${escapeHtml(numberedTitle(n, h.title))}</h2>`);
    parts.push(paragraphsHtml(h.body));
    if (h.why.trim()) {
      parts.push(`<p><strong>Por que isso importa:</strong> ${escapeHtml(h.why.trim())}</p>`);
    }
    parts.push("<hr/>");
  }

  // Caso normal (3 headlines): USE MELHOR entra depois do 2º. Semana
  // reduzida (#4489): com 2 headlines, ambos entram antes (mesma regra —
  // "depois do 2º disponível"); com 1, entra logo depois dele (equivalente a
  // "no fim", já que não sobra headline 3); com 0, entra logo após a abertura.
  const useMelhorSplitIndex = Math.min(2, input.headlines.length);
  input.headlines.slice(0, useMelhorSplitIndex).forEach((h, i) => pushHeadline(h, i + 1));

  let useMelhorRendered = false;
  const hasComment = !!input.useMelhor?.editorComment?.trim();
  if (input.useMelhor && !hasComment) {
    warnings.push('USE MELHOR: comentário do editor ausente — bloco inteiro omitido (regra do #4456, nunca gerado automaticamente).');
  }
  if (input.useMelhor && hasComment) {
    const um = input.useMelhor;
    if (endsInBareDomainLabel(um.title)) {
      warnings.push(`USE MELHOR: título "${um.title}" termina em domínio nu — risco de auto-linkagem partir o link no paste do LinkedIn.`);
    }
    parts.push(`<h3>🛠️ Use melhor</h3>`);
    parts.push(`<p><a href="${escapeHtml(um.url)}">${escapeHtml(um.title)}</a></p>`);
    if (um.description.trim()) parts.push(`<p>${escapeHtml(um.description.trim())}</p>`);
    parts.push(`<p><em>${escapeHtml(um.editorComment.trim())}</em></p>`);
    const ctaUseMelhorUrl = buildLinkedinWeeklyUrl(LINKEDIN_WEEKLY_SUBSCRIBE_BASE_URL, input.cycle, "cta-usemelhor");
    parts.push(`<p>${escapeHtml(CTA_USEMELHOR_LEAD)}</p>`);
    parts.push(`<p><a href="${escapeHtml(ctaUseMelhorUrl)}">${escapeHtml(CTA_USEMELHOR_LABEL)}</a></p>`);
    parts.push("<hr/>");
    useMelhorRendered = true;
  }

  input.headlines.slice(useMelhorSplitIndex).forEach((h, i) => pushHeadline(h, useMelhorSplitIndex + i + 1));

  if (input.weeklyEditions.length > 0) {
    parts.push(`<h3>Edições da semana</h3>`);
    parts.push("<ul>");
    for (const item of input.weeklyEditions) {
      // #4489 finding 2 (mesmo guard do bloco Use Melhor — endsInBareDomainLabel
      // sobre um.title, acima): destaque em texto puro (não linkado) ainda
      // arrisca auto-linkagem do LinkedIn se terminar em domínio nu —
      // warn-only, título é literal.
      for (const destaque of item.destaques) {
        if (endsInBareDomainLabel(destaque)) {
          warnings.push(
            `Edições da semana: destaque "${destaque}" (${item.editionDate}) termina em domínio nu — risco de auto-linkagem partir o link no paste do LinkedIn.`,
          );
        }
      }
      const listUrl = buildLinkedinWeeklyUrl(item.url, input.cycle, "lista");
      // Lista PLANA com separador visível, nunca <ul> aninhada (achado ao vivo
      // 260803, colando a edição #1): o editor de artigo do LinkedIn não suporta
      // aninhamento e ACHATA o <ul> interno, colando os 3 destaques num bloco
      // corrido sem separador nenhum ("...Claude Opus 5 EUA fiscalizam GPT-5.6..."),
      // onde não dá pra ver onde um título acaba e o outro começa. O separador
      // sobrevive ao achatamento porque é texto, não estrutura.
      const destaques = item.destaques.map(escapeHtml).join(DESTAQUE_SEPARATOR);
      const suffix = destaques ? `: ${destaques}` : "";
      parts.push(`<li><a href="${escapeHtml(listUrl)}">${escapeHtml(editionLabel(item.editionDate))}</a>${suffix}</li>`);
    }
    parts.push("</ul>");
    parts.push("<hr/>");
  }

  if (!input.closing.trim()) {
    warnings.push("Fecho ausente/vazio — parágrafo de fecho omitido (closing é obrigatório, não opcional como o comentário do Use Melhor).");
  }
  if (input.closing.trim()) {
    parts.push(paragraphsHtml(input.closing));
  }
  const ctaFimUrl = buildLinkedinWeeklyUrl(LINKEDIN_WEEKLY_SUBSCRIBE_BASE_URL, input.cycle, "cta-fim");
  parts.push(`<p><a href="${escapeHtml(ctaFimUrl)}">${escapeHtml(CTA_FIM_LABEL)}</a></p>`);

  return { html: parts.join("\n"), warnings, useMelhorRendered };
}
