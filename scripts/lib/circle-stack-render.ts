/**
 * circle-stack-render.ts (#10904)
 *
 * Monta (em Markdown) o post da edição semanal da diar.ia.br para o espaço "Radar de
 * Notícias Stack" (Circle da Stack) a partir da seleção por interesse dos
 * alunos (`circle-stack-select.ts`, gravada em
 * `data/weekly/{cycle}/_internal/circle-stack-selection.json`).
 *
 * Estrutura: abertura · Destaques da semana (título com link da fonte, corpo e
 * "Por que isso importa:" iguais aos da edição diária) · Lançamentos · Use melhor · Radar ·
 * Outros destaques da semana (só o que não apareceu acima) · última linha ("Assine a diar.ia.br. Chega de segunda a
 * sexta...", link e fecho na mesma linha).
 *
 * `stackNote` (opcional, por item): texto escrito para o público da Stack
 * (o ângulo de quem constrói). Nos itens de lista, SUBSTITUI a descrição
 * (`body`). Nos destaques é ignorado: título, corpo e "Por que isso importa"
 * saem iguais aos da diária (pedido do editor, 23/10/2026 — poupa revisão).
 * Nunca é gerado aqui — vem preenchido na seleção.
 *
 * Regras herdadas da newsletter (context/editorial-rules.md):
 *   - "Por que isso importa:" em parágrafo próprio.
 *   - Nunca seta (→/←) em link ou CTA (#9721).
 *   - Título do item entra literal, exceto colchetes (viram parênteses) e barra
 *     invertida (escapada), para não quebrar o rótulo do link.
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

/** Cauda da última linha, logo depois de "[Assine a diar.ia.br](url). " — não é parágrafo solto. */
export const DEFAULT_CIRCLE_STACK_CLOSING =
  "Chega de segunda a sexta, de graça, no seu e-mail.";

/** Rótulo do link de assinatura; abre a última linha: "[Assine a diar.ia.br](url). {closing}". */
const CTA_FIM_LABEL = "Assine a diar.ia.br";

export interface CircleStackItem {
  editionDate: string;
  url: string;
  title: string;
  /** Título como veio da edição (#11005), para auditoria quando `title` foi traduzido. */
  titleOriginal?: string;
  /**
   * O editor confirmou o `title` como está mesmo sem sinal de português (nome
   * de produto, #11161). Sem isso, o `--publish` recusa título sem acento nem
   * palavra funcional do português ("Codex Launch Notes").
   */
  titleReviewed?: boolean;
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

/** Pure: título do post — "Semana de DD/MM" (segunda da semana de conteúdo; pedido do editor 23/10/2026). */
export function circleStackTitle(contentWindow: string[]): string {
  if (contentWindow.length === 0) throw new Error("contentWindow vazio");
  return `Semana de ${ddmm(contentWindow[0])}`;
}

/** Pure: rótulo de link sem colchetes (quebrariam a sintaxe `[rótulo](url)`). */
function mdLabel(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim();
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

  const blocks: string[] = [];

  blocks.push(...paragraphs(opts.opening?.trim() || DEFAULT_CIRCLE_STACK_OPENING));

  blocks.push(`## Destaques da semana`);
  for (const h of sel.destaques) {
    // Título com link para a fonte, como na newsletter; sem "Leia na fonte"/"Na edição de" (pedido do editor, 23/10/2026).
    blocks.push(`### ${link(h.url, h.title)}`);
    blocks.push(...paragraphs(h.body));
    // #11068 (decisão do editor, 26/10/2026): aqui o `why` vai cru de propósito.
    // Ele aparece ROTULADO ("Por que isso importa:"), e o padrão de resumo da
    // #11062 (weekly-summary-writer) só vale onde o texto aparece sem rótulo,
    // como a legenda da retro semanal (format-weekly-social.ts).
    if (h.why.trim()) blocks.push(`**Por que isso importa:**`, ...paragraphs(h.why));
  }

  blocks.push(...listSection("Lançamentos", sel.lancamentos));
  blocks.push(...listSection("Use melhor", sel.useMelhor));
  blocks.push(...listSection("Radar", sel.radar));

  // "Outros destaques da semana" (pedido do editor, 23/10/2026): só os destaques das edições
  // que NÃO apareceram acima (comparação por título normalizado). Data sem título restante some.
  const norm = (t: string) => String(t).replace(/\s+/g, " ").trim().toLowerCase();
  const shown = new Set([...sel.destaques, ...sel.lancamentos, ...sel.useMelhor, ...sel.radar].map((it) => norm(it.title)));
  const others = sel.weeklyEditions
    .map((e) => ({ e, titles: e.destaques.map((t) => String(t).replace(/\s+/g, " ").trim()).filter((t) => t && !shown.has(norm(t))) }))
    .filter((x) => x.titles.length > 0);
  if (others.length > 0) {
    blocks.push(`## Outros destaques da semana`);
    for (const { e, titles } of others) {
      // Sem negrito em volta: o conversor do webhook da Stack não reconhece link dentro de **…**
      // e publica o Markdown cru (achado ao vivo, post de 23/10/2026).
      blocks.push(link(buildCircleStackUrl(e.url, sel.cycle, "edicao"), ddmm(e.editionDate)));
      blocks.push(titles.map((t) => `- ${t}`).join("\n"));
    }
  }


  // Última linha do post: link de assinatura + ÚLTIMO parágrafo do fecho (pedido do editor, 23/10/2026).
  // Parágrafos anteriores do fecho (só com --closing-file de várias linhas) vêm antes, para o CTA
  // continuar sendo a última linha. `paragraphs()` nunca devolve vazio aqui (o default cobre fecho vazio).
  const subscribeHref = opts.subscribeUrl?.trim() || buildCircleStackUrl(CIRCLE_STACK_SUBSCRIBE_BASE_URL, sel.cycle, "cta-fim");
  const closingParas = paragraphs(opts.closing?.trim() || DEFAULT_CIRCLE_STACK_CLOSING);
  const closingLast = closingParas.pop() as string;
  blocks.push(...closingParas, `${link(subscribeHref, CTA_FIM_LABEL)}. ${closingLast}`);

  return { title: circleStackTitle(sel.contentWindow), markdown: blocks.join("\n\n") };
}
