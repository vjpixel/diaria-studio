/**
 * circle-stack-render.ts (#10904)
 *
 * Monta o post da edição semanal da diar.ia.br para o espaço "Radar de
 * Notícias Stack" (Circle da Stack) a partir da seleção por interesse dos
 * alunos (`circle-stack-select.ts`, gravada em
 * `data/weekly/{cycle}/_internal/circle-stack-selection.json`).
 *
 * Estrutura: abertura · Destaques da semana (título, corpo, "Por que isso
 * importa:", links) · Lançamentos e ferramentas · Use melhor · Radar ·
 * Edições da semana · fecho + CTA.
 *
 * `stackNote` (opcional, por item): texto escrito para o público da Stack
 * (o ângulo de quem constrói). Quando presente, substitui o "por que isso
 * importa" da edição diária no destaque, ou entra como 2ª linha nos itens
 * de lista. Nunca é gerado aqui — vem preenchido na seleção.
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
  html: string;
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`);
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function listSection(heading: string, items: CircleStackItem[]): string[] {
  if (items.length === 0) return [];
  const lis = items.map((it) => {
    const desc = it.stackNote?.trim() || it.body.trim();
    return `<li>${link(it.url, it.title)}${desc ? `<br>${escapeHtml(desc)}` : ""}</li>`;
  });
  return [`<h2>${escapeHtml(heading)}</h2>`, `<ul>\n${lis.join("\n")}\n</ul>`];
}

/** Pure: monta título + HTML do post. */
export function renderCircleStackPost(sel: CircleStackSelection, opts: CircleStackRenderOptions = {}): CircleStackRendered {
  if (sel.destaques.length === 0) throw new Error(`Seleção ${sel.cycle} sem destaques — nada a publicar`);

  const editionUrlByDate = new Map(sel.weeklyEditions.map((e) => [e.editionDate, e.url]));
  const out: string[] = [];

  out.push(...paragraphs(opts.opening?.trim() || DEFAULT_CIRCLE_STACK_OPENING));

  out.push(`<h2>Destaques da semana</h2>`);
  for (const h of sel.destaques) {
    out.push(`<h3>${escapeHtml(h.title)}</h3>`);
    out.push(...paragraphs(h.body));
    const why = h.stackNote?.trim() || h.why.trim();
    if (why) out.push(`<p><strong>Por que isso importa:</strong></p>`, ...paragraphs(why));
    const editionUrl = editionUrlByDate.get(h.editionDate);
    const links = [link(h.url, "Leia na fonte")];
    if (editionUrl) {
      links.push(link(buildCircleStackUrl(editionUrl, sel.cycle, "edicao"), `Na edição de ${ddmm(h.editionDate)}`));
    }
    out.push(`<p>${links.join(" | ")}</p>`);
  }

  out.push(...listSection("Lançamentos e ferramentas", sel.lancamentos));
  out.push(...listSection("Use melhor", sel.useMelhor));
  out.push(...listSection("Radar", sel.radar));

  if (sel.weeklyEditions.length > 0) {
    out.push(`<h2>Edições da semana</h2>`);
    const items = sel.weeklyEditions.map(
      (e) =>
        `<li>${link(buildCircleStackUrl(e.url, sel.cycle, "edicao"), ddmm(e.editionDate))}: ${escapeHtml(e.destaques.join(" · "))}</li>`,
    );
    out.push(`<ul>\n${items.join("\n")}\n</ul>`);
  }

  out.push(...paragraphs(opts.closing?.trim() || DEFAULT_CIRCLE_STACK_CLOSING));
  const subscribeHref = opts.subscribeUrl?.trim() || buildCircleStackUrl(CIRCLE_STACK_SUBSCRIBE_BASE_URL, sel.cycle, "cta-fim");
  out.push(`<p>${link(subscribeHref, CTA_FIM_LABEL)}</p>`);

  return { title: circleStackTitle(sel.contentWindow), html: out.join("\n") };
}
