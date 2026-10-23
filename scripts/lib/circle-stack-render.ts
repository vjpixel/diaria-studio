/**
 * circle-stack-render.ts (#10904)
 *
 * Monta (em Markdown) o post da edição semanal da diar.ia.br para o espaço "Radar de
 * Notícias Stack" (Circle da Stack) a partir da seleção por interesse dos
 * alunos (`circle-stack-select.ts`, gravada em
 * `data/weekly/{cycle}/_internal/circle-stack-selection.json`).
 *
 * Estrutura: abertura · Destaques da semana (título, corpo, "Por que isso
 * importa:", links) · Lançamentos e ferramentas · Use melhor · Radar ·
 * Edições da semana · fecho + CTA.
 *
 * `stackNote` (opcional, por item): texto escrito para o público da Stack
 * (o ângulo de quem constrói). Quando presente, SUBSTITUI o "por que isso
 * importa" da edição diária no destaque, e SUBSTITUI a descrição (`body`)
 * nos itens de lista. Nunca é gerado aqui — vem preenchido na seleção.
 *
 * Regras herdadas da newsletter (context/editorial-rules.md):
 *   - "Por que isso importa:" em parágrafo próprio.
 *   - Nunca seta (→/←) em link ou CTA (#9721).
 *   - Título do item entra literal.
 *
 * UTM do canal: `utm_source=stack&utm_medium=circle&
 * utm_campaign=stack-{cycle}&utm_content=edicao|cta-fim` — só nos links
 * para a diar.ia.br. Link de fonte sai sem UTM, como na newsletter.
 */

export const CIRCLE_STACK_UTM_SOURCE = "stack";
export const CIRCLE_STACK_UTM_MEDIUM = "circle";
export const CIRCLE_STACK_SUBSCRIBE_BASE_URL = "https://diar.ia.br";

export type CircleStackUtmContent = "edicao" | "cta-fim";

export const DEFAULT_CIRCLE_STACK_OPENING =
  "A edição semanal da diar.ia.br para quem constrói com IA: o que saiu na semana sobre ferramentas, agentes, automação e produto.";

export const DEFAULT_CIRCLE_STACK_CLOSING =
  "A diar.ia.br sai de segunda a sexta, de graça, no seu e-mail.";

const CTA_FIM_LABEL = "Assinar a diar.ia.br";

export interface CircleStackItem {
  editionDate: string;
  url: string;
  title: string;
  body: string;
  why: string;
  stackNote?: string;
  /**
   * Posição do destaque na edição de origem (1..3). Quando presente, o link
   * "Na edição de DD/MM" vai direto ao destaque (`/p/{slug}#dN`, #11003) em
   * vez do topo da página. Ausente (seleção antiga, item de seção) = topo.
   */
  destaqueN?: number;
}

export interface CircleStackEdition {
  editionDate: string;
  url: string;
  destaques: string[];
}

/** Shape de `circle-stack-selection.json` que o render consome. */
export interface CircleStackSelection {
  cycle: string;
  contentWindow: string[];
  destaques: CircleStackItem[];
  lancamentos: CircleStackItem[];
  useMelhor: CircleStackItem[];
  radar: CircleStackItem[];
  weeklyEditions: CircleStackEdition[];
}

export interface CircleStackRenderOptions {
  opening?: string;
  closing?: string;
  /** Link de assinatura alternativo (ex: link rastreado da própria Stack). Sem UTM adicionada se informado. */
  subscribeUrl?: string;
}

export interface CircleStackRendered {
  title: string;
  /** Corpo em Markdown — o webhook da Stack remove HTML. */
  markdown: string;
}

export function circleStackCampaign(cycle: string): string {
  return `stack-${cycle}`;
}

/** Pure: adiciona o triplo UTM do canal + `utm_content`. */
export function buildCircleStackUrl(baseUrl: string, cycle: string, content: CircleStackUtmContent): string {
  const u = new URL(baseUrl);
  u.searchParams.set("utm_source", CIRCLE_STACK_UTM_SOURCE);
  u.searchParams.set("utm_medium", CIRCLE_STACK_UTM_MEDIUM);
  u.searchParams.set("utm_campaign", circleStackCampaign(cycle));
  u.searchParams.set("utm_content", content);
  return u.toString();
}

/**
 * Pure: aponta a URL da edição para o destaque N (`#dN`, âncora gravada por
 * `site-destaque-anchors.ts`, #11003). Fora de 1..3 devolve a URL intacta —
 * âncora inexistente só deixaria o leitor no topo, mas não há por que gravar
 * um fragmento que a página não tem.
 */
export function withDestaqueAnchor(url: string, destaqueN: number | undefined): string {
  if (destaqueN === undefined || !Number.isInteger(destaqueN) || destaqueN < 1 || destaqueN > 3) return url;
  const u = new URL(url);
  u.hash = `d${destaqueN}`;
  return u.toString();
}

/** Pure: `AAMMDD` → `DD/MM`. */
export function ddmm(aammdd: string): string {
  if (!/^\d{6}$/.test(aammdd)) throw new Error(`AAMMDD inválido: ${aammdd}`);
  return `${aammdd.slice(4, 6)}/${aammdd.slice(2, 4)}`;
}

/** Pure: título do post — "Radar de Notícias Stack — semana de DD/MM a DD/MM". */
export function circleStackTitle(contentWindow: string[]): string {
  if (contentWindow.length === 0) throw new Error("contentWindow vazio");
  return `Radar de Notícias Stack — semana de ${ddmm(contentWindow[0])} a ${ddmm(contentWindow[contentWindow.length - 1])}`;
}

/** Pure: rótulo de link sem colchetes (quebrariam a sintaxe `[rótulo](url)`). */
function mdLabel(s: string): string {
  return s.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim();
}

/** Pure: URL segura dentro de `( )` do Markdown. */
function mdUrl(u: string): string {
  return u.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
}

function link(href: string, label: string): string {
  return `[${mdLabel(label)}](${mdUrl(href)})`;
}

/** Pure: parágrafos separados por linha em branco (o webhook da Stack trata linha em branco como parágrafo). */
function paragraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function listSection(heading: string, items: CircleStackItem[]): string[] {
  if (items.length === 0) return [];
  const lines = items.map((it) => {
    const desc = (it.stackNote?.trim() || it.body.trim()).replace(/\s*\n+\s*/g, " ");
    return `- ${link(it.url, it.title)}${desc ? `: ${desc}` : ""}`;
  });
  return [`## ${heading}`, lines.join("\n")];
}

/** Pure: monta título + corpo em Markdown do post (formato aceito pelo webhook da Stack). */
export function renderCircleStackPost(sel: CircleStackSelection, opts: CircleStackRenderOptions = {}): CircleStackRendered {
  if (sel.destaques.length === 0) throw new Error(`Seleção ${sel.cycle} sem destaques — nada a publicar`);

  const editionUrlByDate = new Map(sel.weeklyEditions.map((e) => [e.editionDate, e.url]));
  const blocks: string[] = [];

  blocks.push(...paragraphs(opts.opening?.trim() || DEFAULT_CIRCLE_STACK_OPENING));

  blocks.push(`## Destaques da semana`);
  for (const h of sel.destaques) {
    blocks.push(`### ${h.title.replace(/\s+/g, " ").trim()}`);
    blocks.push(...paragraphs(h.body));
    const why = h.stackNote?.trim() || h.why.trim();
    if (why) blocks.push(`**Por que isso importa:**`, ...paragraphs(why));
    const editionUrl = editionUrlByDate.get(h.editionDate);
    const links = [link(h.url, "Leia na fonte")];
    if (editionUrl) {
      const editionHref = withDestaqueAnchor(buildCircleStackUrl(editionUrl, sel.cycle, "edicao"), h.destaqueN); // #11003
      links.push(link(editionHref, `Na edição de ${ddmm(h.editionDate)}`));
    }
    blocks.push(links.join(" | "));
  }

  blocks.push(...listSection("Lançamentos e ferramentas", sel.lancamentos));
  blocks.push(...listSection("Use melhor", sel.useMelhor));
  blocks.push(...listSection("Radar", sel.radar));

  if (sel.weeklyEditions.length > 0) {
    blocks.push(`## Edições da semana`);
    blocks.push(
      sel.weeklyEditions
        .map((e) => `- ${link(buildCircleStackUrl(e.url, sel.cycle, "edicao"), ddmm(e.editionDate))}: ${e.destaques.join(" · ")}`)
        .join("\n"),
    );
  }

  blocks.push(...paragraphs(opts.closing?.trim() || DEFAULT_CIRCLE_STACK_CLOSING));
  const subscribeHref = opts.subscribeUrl?.trim() || buildCircleStackUrl(CIRCLE_STACK_SUBSCRIBE_BASE_URL, sel.cycle, "cta-fim");
  blocks.push(link(subscribeHref, CTA_FIM_LABEL));

  return { title: circleStackTitle(sel.contentWindow), markdown: blocks.join("\n\n") };
}
