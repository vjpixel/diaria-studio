/**
 * monthly-html-convert.ts (#2791)
 *
 * A API REST v2 do Beehiiv só expõe o conteúdo publicado em HTML
 * (`content.free.email`/`content.free.web`) — sem endpoint markdown, que
 * existia no MCP antigo. `fetch-monthly-posts.ts` grava esse HTML bruto nos
 * `raw-posts/*.txt` quando não há alternativa local (ver
 * `parseLocalEdition` em `collect-monthly.ts` — precedência: local > este
 * fallback), mas o parser de `collect-monthly.ts` (`parsePost`/
 * `splitSections`) só entende o pseudo-markdown do formato antigo do MCP
 * (`##### CATEGORIA` + `# [Título](url)` + `Por que isso importa:`,
 * separados por `----------`).
 *
 * Este módulo converte o HTML pra esse pseudo-markdown ANTES da gravação,
 * pra `parsePost` seguir funcionando sem mudanças. Extrai, por destaque:
 * categoria (linha totalmente em maiúsculas — heurística de header),
 * título+URL (primeiro link markdown-like após a categoria) e o parágrafo
 * "Por que isso importa:".
 *
 * Conservador (mesma filosofia do guardrail #2794): só emite um destaque
 * quando os 4 elementos (categoria, título, url, why) convertem limpo.
 * Blocos que não batem geram warning — nunca falha silenciosa.
 */

export interface HtmlConvertResult {
  markdown: string;
  destaquesFound: number;
  warnings: string[];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lsquo;|&rsquo;|&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"');
}

/**
 * Normaliza HTML pra linhas de texto, preservando links como
 * `[texto](url)` (convertidos ANTES de remover as demais tags) e inserindo
 * quebra de linha nos limites de bloco (`<br>`, `</p>`, `</h1-6>`, `</div>`,
 * `</td>`, `</tr>`, `</li>`). Linhas vazias são descartadas.
 */
export function htmlToLines(html: string): string[] {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  // Preserva links como markdown ANTES de stripar as demais tags — senão o
  // href se perde junto com o resto da marcação.
  s = s.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
    const text = decodeEntities(String(inner).replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    return text ? `[${text}](${href})` : "";
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|h[1-6]|div|td|tr|li)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// Heurística de header de categoria: linha inteira em maiúsculas (Unicode),
// só letras/espaços — cobre "LANÇAMENTO", "BRASIL", "GEOPOLÍTICA" etc. sem
// casar títulos/frases mistas.
const CATEGORY_LINE_RE = /^[\p{Lu}][\p{Lu}\s]{1,38}$/u;
const LINK_LINE_RE = /^\[(.+?)\]\((https?:\/\/[^\s)]+)\)$/;
const WHY_LINE_RE = /^por que isso importa:?$/i;

/**
 * Converte o HTML de um post Beehiiv pro pseudo-markdown que `parsePost`
 * (collect-monthly.ts) já sabe parsear. `label` (ex: nome do arquivo) só
 * decora as mensagens de warning.
 */
export function convertBeehiivHtmlToMarkdown(html: string, label = "post"): HtmlConvertResult {
  const lines = htmlToLines(html);
  const warnings: string[] = [];
  const blocks: string[] = [];
  let destaquesFound = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!CATEGORY_LINE_RE.test(line) || WHY_LINE_RE.test(line) || LINK_LINE_RE.test(line)) {
      i++;
      continue;
    }
    const category = line;

    // Procura o link título nas próximas linhas (tolera 1-2 linhas de
    // ruído, ex: espaçadores). Encontrar outra categoria antes de achar um
    // link derruba o candidato — não era header de destaque.
    let j = i + 1;
    let titleLink: { title: string; url: string } | null = null;
    while (j < lines.length && j < i + 4) {
      const m = lines[j].match(LINK_LINE_RE);
      if (m) {
        titleLink = { title: m[1], url: m[2] };
        break;
      }
      if (CATEGORY_LINE_RE.test(lines[j])) break;
      j++;
    }
    if (!titleLink) {
      i++;
      continue;
    }

    // Corpo: da linha após o título até "Por que isso importa:" ou até
    // esbarrar na próxima categoria (sinal de que não há why — bloco sujo).
    let k = j + 1;
    const bodyLines: string[] = [];
    while (k < lines.length && !WHY_LINE_RE.test(lines[k]) && !CATEGORY_LINE_RE.test(lines[k])) {
      bodyLines.push(lines[k]);
      k++;
    }
    if (k >= lines.length || !WHY_LINE_RE.test(lines[k])) {
      warnings.push(
        `${label}: bloco "${category}" (${titleLink.title}) sem "Por que isso importa:" — pulado`,
      );
      i = j + 1;
      continue;
    }

    // Why: da linha após o delimitador até a próxima categoria (ou fim).
    let w = k + 1;
    const whyLines: string[] = [];
    while (w < lines.length && !CATEGORY_LINE_RE.test(lines[w])) {
      whyLines.push(lines[w]);
      w++;
    }
    if (whyLines.length === 0 || bodyLines.length === 0) {
      warnings.push(
        `${label}: bloco "${category}" (${titleLink.title}) com corpo ou "Por que isso importa:" vazio — pulado`,
      );
      i = w;
      continue;
    }

    blocks.push(
      `##### ${category}\n\n` +
        `# [${titleLink.title}](${titleLink.url})\n\n` +
        `${bodyLines.join("\n\n")}\n\n` +
        `Por que isso importa:\n\n` +
        `${whyLines.join("\n\n")}`,
    );
    destaquesFound++;
    i = w;
  }

  if (destaquesFound === 0) {
    warnings.push(`${label}: conversão HTML→markdown não encontrou nenhum destaque limpo`);
  }

  return {
    markdown: blocks.join("\n\n----------\n\n"),
    destaquesFound,
    warnings,
  };
}
