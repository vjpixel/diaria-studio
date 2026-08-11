/**
 * scripts/lib/hub-primary-source.ts (#4919 Parte A)
 *
 * Acha, dentro do HTML publicado de uma edição (`RawCachedPost.content.free.web`,
 * `generate-arquivo-titles.ts`), a URL de fonte primária de uma manchete —
 * pra popular `HubSourceEntry.primarySourceUrls` (`generate-hub-sources.ts`).
 *
 * **Regra dura, não-negociável (issue #4919): só casamento EXATO de texto de
 * âncora. Nunca fallback posicional.** A issue mediu 3 casos reais em que um
 * fallback "1ª âncora externa depois da manchete" atribui errado — link de
 * patrocinador, matéria de OUTRA manchete da mesma edição. Melhor a entrada
 * sair SEM `primarySourceUrl` do que com atribuição suspeita — em NENHUM
 * caminho deste módulo um href é aceito só por proximidade.
 *
 * O arquivo confirmado do hub Anthropic/Claude atravessa 4 gerações de
 * template Beehiiv (medido 10/08/2026, 76 edições):
 *   1. `<a class="headline" href="{url}">{manchete}</a>` (atual, 18 edições)
 *   2. rótulo "Aprofunde" logo após a manchete (23 edições)
 *   3. rótulo "Saiba mais" logo após a manchete (2 edições, as mais antigas)
 *   4. manchete como âncora SEM `class` (33 edições)
 *
 * Templates 1 e 4 são o MESMO caso pra este matcher: uma âncora cujo texto
 * normalizado é idêntico à manchete (Regra A, `class` é irrelevante).
 * Templates 2 e 3 não têm a manchete dentro da âncora — o texto do link é o
 * rótulo fixo "Aprofunde"/"Saiba mais" (Regra B). Ainda assim é casamento de
 * TEXTO, não posição: a âncora precisa ter texto EXATAMENTE igual a um dos
 * dois rótulos conhecidos, E precisa estar entre a ocorrência da manchete e
 * a ocorrência da PRÓXIMA manchete da mesma edição (nunca vazando pro bloco
 * de outra manchete nem pro rodapé/patrocinador). Um "Saiba mais sobre a
 * Deel" não bate a Regra B — o texto não é EXATAMENTE "saiba mais".
 */

/** NFC + colapso de espaço + lowercase — mesma normalização usada por
 * `stripAccents` neste repo, mas SEM strip de acento (a manchete e a âncora
 * vêm do MESMO html/post, não há o mismatch NFC/NFD entre campos distintos
 * que motivou `stripAccents` em `generate-hub-sources.ts`). Especificado
 * literalmente pela issue #4919 item 3: "NFC, colapso de espaço, lowercase". */
export function normalizeAnchorText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

/** Decodifica só as entidades HTML de fato usadas em manchete/URL de
 * newsletter — não é um decoder genérico (não cobre `&#x...;` numérico). */
function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => HTML_ENTITIES[name] ?? `&${name};`);
}

/** Remove tags HTML de dentro do texto de uma âncora (ex: `<strong>` em
 * volta de parte da manchete) e decodifica entidades — usado só pra obter o
 * TEXTO comparável, nunca a URL. */
function stripInnerTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ""));
}

export interface ExtractedAnchor {
  /** Texto visível da âncora, tags internas removidas, entidades decodificadas — CRU (não normalizado). */
  text: string;
  href: string;
  /** Índice (em `html`) do início da tag `<a`. */
  start: number;
}

/** Extrai toda âncora `<a ... href="...">texto</a>` do HTML, em ordem de
 * documento. Aceita `href` entre aspas simples ou duplas (Beehiiv usa
 * duplas, mas não custa aceitar as duas). Âncora sem `href` é ignorada. */
export function extractAnchors(html: string): ExtractedAnchor[] {
  const out: ExtractedAnchor[] = [];
  const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = decodeEntities(m[1] ?? m[2] ?? "");
    if (!href) continue;
    out.push({ text: stripInnerTags(m[3]), href, start: m.index });
  }
  return out;
}

const APROFUNDE_LABELS = new Set(["aprofunde", "saiba mais"]);

/**
 * Índice da primeira ocorrência de `needle` (comparação simples,
 * case-insensitive, SEM strip de acento) dentro de `haystack`, ou -1.
 * Casamento é sobre texto CONTÍGUO — se a manchete estiver quebrada por
 * tags no meio (raro; não observado nos 4 templates confirmados), a Regra B
 * simplesmente não encontra a âncora e a entrada sai sem `primarySourceUrl`
 * (fail-safe, nunca fallback posicional).
 */
function indexOfCaseInsensitive(haystack: string, needle: string, fromIndex = 0): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase(), fromIndex);
}

/**
 * Acha a URL de fonte primária de UMA manchete dentro do HTML de uma
 * edição. `allHeadlinesInOrder` é a lista de TODAS as manchetes/destaques
 * do post (não só a casada pelo hub) — usada como limite direito da janela
 * de busca da Regra B, pra nunca vazar pro bloco de outra manchete.
 *
 * Retorna `undefined` (nunca lança, nunca adivinha) quando nenhuma regra
 * bate — a "regra dura" da issue #4919: silêncio > atribuição suspeita.
 */
export function findPrimarySourceUrl(
  html: string,
  headline: string,
  allHeadlinesInOrder: readonly string[] = [headline],
): string | undefined {
  const anchors = extractAnchors(html);
  const normHeadline = normalizeAnchorText(headline);

  // Regra A — âncora cujo TEXTO normalizado é idêntico à manchete (templates 1 e 4).
  const exact = anchors.find((a) => normalizeAnchorText(a.text) === normHeadline);
  if (exact) return exact.href;

  // Regra B — rótulo "Aprofunde"/"Saiba mais" logo após a ocorrência da
  // manchete, antes da ocorrência da PRÓXIMA manchete (templates 2 e 3).
  const headlineIdx = indexOfCaseInsensitive(html, headline.trim());
  if (headlineIdx === -1) return undefined; // manchete nem aparece como texto puro — sem base pra Regra B

  // Limite direito: a próxima manchete (na ordem em que aparecem no post,
  // não a ordem de `allHeadlinesInOrder`) que ocorre DEPOIS de `headlineIdx`.
  let boundary = html.length;
  for (const other of allHeadlinesInOrder) {
    if (normalizeAnchorText(other) === normHeadline) continue; // é a própria manchete
    const otherIdx = indexOfCaseInsensitive(html, other.trim(), headlineIdx + headline.trim().length);
    if (otherIdx !== -1 && otherIdx < boundary) boundary = otherIdx;
  }

  const label = anchors.find(
    (a) => a.start > headlineIdx && a.start < boundary && APROFUNDE_LABELS.has(normalizeAnchorText(a.text)),
  );
  return label?.href;
}

/** Remove TODOS os parâmetros `utm_*` da query string (inclusive UTM de
 * terceiro, ex: `utm_source=www.therundown.ai` copiado junto no corpo de
 * uma edição — não só os nossos próprios `utm_source=diaria.beehiiv.com`/
 * `diar.ia.br`). Preserva qualquer outro parâmetro e o resto da URL intacto.
 * URL malformada volta como veio (o guard de esquema, `isSafeUrlScheme` em
 * `markdown-links.ts`, é quem decide se ela é segura de usar — este helper
 * só normaliza, não valida). */
export function stripTrackingParams(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const params = new URLSearchParams(url.search);
  for (const key of [...params.keys()]) {
    if (/^utm_/i.test(key)) params.delete(key);
  }
  const qs = params.toString();
  url.search = qs ? `?${qs}` : "";
  return url.toString();
}
