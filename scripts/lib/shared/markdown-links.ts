/**
 * markdown-links.ts (#4558 Parte A)
 *
 * Parser + renderer de um subset mínimo de markdown — só `[texto](url)` —
 * usado nas seções narrativas e nas respostas de FAQ dos hubs temáticos
 * (issue #4558: "hub temático é link interno de verdade" — cada afirmação
 * específica linka a edição de origem, não só a lista de fontes no rodapé).
 *
 * Extraído de `hub-page.ts` (onde nasceu, #4558 Parte A — PR #4627; #4635
 * só adicionou o guard de URL vazia e os comentários de fleet review, não
 * criou o parser) pra cá — `geo-faq.ts` também precisa desse parser (as
 * respostas de FAQ ganharam link inline em #4635) e `hub-page.ts` já importa
 * de `geo-faq.ts`; deixar o parser dentro de `hub-page.ts` criaria import
 * circular. Módulo sem NENHUMA dependência de I/O — seguro de importar em
 * qualquer bundle (Worker incluso).
 *
 * **Duplicata deliberada de `findMarkdownLinks`
 * (`scripts/lib/newsletter-render-html.ts`), não reuso por import.** Aquele
 * arquivo importa `readFileSync` de `node:fs` no topo e carrega uma cadeia
 * de dependência inteira específica de e-mail (word-joiner, estilo inline
 * pro Outlook) que não serve a uma página web comum. `geo-faq.ts` (que
 * importa este módulo) já é bundlado em RUNTIME no Worker `arquivo` (via
 * `render-archive.ts`) — puxar a cadeia de e-mail pra lá seria custo real.
 * Em `livros`/`cursos` o acoplamento só existiria em BUILD-TIME
 * (`build-livros-page.ts`/`build-cursos-page.ts` rodam em Node, emitem HTML
 * estático servido por `env.ASSETS` — o Worker deles nunca importa
 * `geo-faq.ts` em runtime, achado do fleet review da PR #4642), mas o
 * princípio geral (não acoplar um parser genérico a uma cadeia de e-mail)
 * vale de qualquer forma.
 *
 * O wordmark da marca (`applyBrandWordmark`, #4797) É reusado por import —
 * diferente do resto da cadeia de e-mail, ele foi extraído pra
 * `scripts/lib/shared/brand-wordmark.ts`, um módulo tão puro/sem-I/O quanto
 * este (só depende de `design-tokens.ts`), então importá-lo aqui não
 * reintroduz o acoplamento que o parágrafo acima evita.
 */
import { escHtml as esc } from "../html-escape.ts";
import { applyBrandWordmark } from "./brand-wordmark.ts"; // #4797 — texto puro fora dos links `[texto](url)` ganha o mesmo tratamento tipográfico da marca (negrito + `.`/`.br` teal) já usado no e-mail

/** Um link markdown `[label](url)` já parseado — `start`/`end` são o span
 * (índices) do match completo na string de origem, meio-aberto (`end`
 * exclusivo). */
export interface ParsedLink {
  url: string;
  label: string;
  start: number;
  end: number;
}

/**
 * Só `https:` passa. Guard de esquema (#4919 item 7) — defesa em
 * profundidade: até aqui todo `url` de `[texto](url)` vinha de prosa
 * escrita à mão (editor/writer agent), sempre `https:`. Com `primarySourceUrl`
 * (`scripts/generate-hub-sources.ts`) o dado passa a vir de `href` extraído
 * de HTML de TERCEIRO (`content.free.web` do cache Beehiiv) — a primeira
 * URL `http:`/`javascript:`/outro esquema não pode ser a que descobre esse
 * gap. `URL` lança em input malformado — tratado como esquema inseguro
 * (nunca deixa passar por engano de parse).
 */
export function isSafeUrlScheme(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Acha links markdown `[texto](url)` numa string, com parênteses
 * balanceados na URL (mesmo algoritmo de `findMarkdownLinks` em
 * `scripts/lib/newsletter-render-html.ts` — ver nota do módulo sobre por
 * que é REIMPLEMENTADO aqui, não importado).
 *
 * `[texto]()` com URL vazia NÃO é tratado como link (mesmo guard do
 * `mdInlineToHtml`/`processInlineLinks` na função original — "preserva
 * texto bruto") — sem isso, um typo comum ao digitar link à mão vira um
 * `href=""` silencioso (link morto, sem erro nenhum; achado do fleet
 * review da PR #4635). Mesmo tratamento pra URL de esquema não-`https:`
 * (#4919 item 7, `isSafeUrlScheme`) — preserva texto bruto em vez de virar
 * `<a href="javascript:...">`.
 *
 * **O label não aceita `[` aninhado** (`[^\[\]]+`, não `[^\]]+` como o
 * original em `newsletter-render-html.ts`) — achado do fleet review da PR
 * #4642: com `[^\]]+`, um `[` solto ANTES de um link real (ex: "modelo
 * [meio-citado, mas [Claude](url) é melhor") engolia tudo entre os dois
 * colchetes pro label, corrompendo o link e o texto ao redor em silêncio.
 * Correção só nesta cópia — divergir do original aqui é estritamente mais
 * correto, não uma quebra de paridade de algoritmo.
 */
export function findParagraphLinks(s: string): ParsedLink[] {
  const out: ParsedLink[] = [];
  const linkStart = /\[([^[\]]+)\]\(/g;
  let m: RegExpExecArray | null;
  while ((m = linkStart.exec(s)) !== null) {
    const label = m[1];
    const destStart = m.index + m[0].length;
    let depth = 0;
    let j = destStart;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (j >= s.length) continue; // sem `)` de fechamento — não é link válido
    const url = s.slice(destStart, j).trim();
    if (!url) continue; // `[texto]()` — URL vazia, preserva texto bruto (não vira <a href="">)
    if (!isSafeUrlScheme(url)) continue; // esquema não-https — preserva texto bruto (#4919 item 7)
    out.push({ url, label, start: m.index, end: j + 1 });
    linkStart.lastIndex = j + 1;
  }
  return out;
}

/** Converte `[texto](url)` numa string em `<a href>`. Todo texto fora dos
 * links, e o `label`/`url` de cada link, passa por `esc()`; nunca interpola
 * HTML cru vindo do conteúdo. Usado tanto nas `HubSection.paragraphs`
 * (`hub-page.ts`) quanto nas respostas de FAQ (`geo-faq.ts`).
 *
 * #4797: o texto FORA dos links (já escapado) passa por
 * `applyBrandWordmark` — uma ocorrência de "diar.ia.br" em prosa comum
 * ganha o mesmo tratamento tipográfico (negrito + `.`/`.br` teal) já usado
 * no e-mail. Só o texto puro: o `label`/`url` de um link markdown NUNCA
 * recebe o wordmark (evita `<strong>` aninhado dentro de `<a>` e duplicar a
 * marcação de um link que já resolveu pra `diar.ia.br` como destino/rótulo)
 * — mesma disciplina de "nunca dentro de um href já resolvido" do e-mail.
 *
 * `titleFor` (#5265, OPCIONAL) — resolve o `title="Na edição: {…}"` de um
 * link, quando o caller tiver um jeito de saber o título REAL da página de
 * destino. Motivação: em prosa de hub, "[texto](diar.ia.br/p/{slug})"
 * frequentemente linka pra uma edição onde a manchete casada foi um destaque
 * SECUNDÁRIO — clicar em "rodada Série H de US$ 65 bi" pode levar a uma
 * edição cujo H1 é outra coisa inteira, sem aviso nenhum antes do clique. Só
 * emite o atributo quando `titleFor(url)` devolve algo E esse título difere
 * do `label` do link (comparação exata pós-trim) — sem isso todo link cujo
 * texto-âncora já É o título real ganharia uma tooltip redundante repetindo
 * a mesma frase. `undefined`/omitido preserva o comportamento antigo
 * byte-a-byte (nenhum `title=` emitido) — as 3 páginas de curadoria que não
 * passam este parâmetro (livros/cursos/arquivo, via `geo-faq.ts`) continuam
 * exatamente como antes. */
export function renderInlineLinks(s: string, titleFor?: (url: string) => string | undefined): string {
  const links = findParagraphLinks(s);
  if (links.length === 0) return applyBrandWordmark(esc(s));
  const parts: string[] = [];
  let lastIdx = 0;
  for (const { url, label, start, end } of links) {
    parts.push(applyBrandWordmark(esc(s.slice(lastIdx, start))));
    const realTitle = titleFor?.(url);
    const titleAttr = realTitle && realTitle.trim() !== label.trim() ? ` title="${esc(`Na edição: ${realTitle}`)}"` : "";
    parts.push(`<a href="${esc(url)}"${titleAttr}>${esc(label)}</a>`);
    lastIdx = end;
  }
  parts.push(applyBrandWordmark(esc(s.slice(lastIdx))));
  return parts.join("");
}

/** Converte `[texto](url)` numa string pra TEXTO PURO ("texto", sem
 * colchete/URL) — usado onde a marcação markdown não pode aparecer, ex:
 * `acceptedAnswer.text` do JSON-LD `FAQPage` (schema.org espera texto
 * legível, não markup; embutir `[label](url)` cru ali renderizaria colchete
 * literal em rich results/snippet de assistente). NÃO escapa HTML — quem
 * usa isso em contexto HTML deve aplicar `esc()` depois, se for o caso;
 * JSON.stringify (o caso de uso real, `renderGeoJsonLd`) não precisa. */
export function stripMarkdownLinks(s: string): string {
  const links = findParagraphLinks(s);
  if (links.length === 0) return s;
  const parts: string[] = [];
  let lastIdx = 0;
  for (const { label, start, end } of links) {
    parts.push(s.slice(lastIdx, start));
    parts.push(label);
    lastIdx = end;
  }
  parts.push(s.slice(lastIdx));
  return parts.join("");
}
