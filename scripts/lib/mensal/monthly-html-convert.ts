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
 * quebra de linha nos limites de bloco (`<br>`, `<img>`, `</p>`, `</h1-6>`,
 * `</div>`, `</td>`, `</tr>`, `</li>`). Linhas vazias são descartadas.
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
  // O template atual (#3104) não envolve o link do headline num <h1-6> —
  // ele fica solto num <td>, seguido de <img class="hero"> e a legenda
  // ("Criada com Gemini") no <p> seguinte, sem tag de fechamento entre eles
  // pra marcar quebra de linha. Sem isso, `[Título](url)` gruda na legenda
  // na mesma linha e nunca bate no LINK_LINE_RE (que exige a linha INTEIRA
  // ser só o link) — achado ao vivo junto do bug do marcador ● (ciclo
  // 2607-08). Imagem nunca carrega texto relevante pro parser, então
  // sempre é seguro virar quebra de linha.
  s = s.replace(/<img\b[^>]*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|h[1-6]|div|td|tr|li)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !IMAGE_CREDIT_LINE_RE.test(l));
}

// Legenda de crédito da imagem de capa ("Criada com Gemini/gpt-image-2/
// Cloudflare FLUX/ComfyUI/IA" — ver credits{} em newsletter-render-html.ts),
// renderizada logo abaixo do <img> do headline. Puro ruído de metadata, não
// conteúdo editorial — sem filtrar, vira a primeira "linha de corpo" de todo
// destaque (achado junto do bug do marcador ●, ciclo 2607-08).
const IMAGE_CREDIT_LINE_RE = /^Criada com /;

// Heurística de header de categoria: linha inteira em maiúsculas (Unicode),
// só letras/espaços — cobre "LANÇAMENTO", "BRASIL", "GEOPOLÍTICA" etc. sem
// casar títulos/frases mistas. Tolera o marcador ● (tealDot(), #3104) que
// precede o label na renderização atual — `<span>●</span>&nbsp;LANÇAMENTO`
// vira a linha "● LANÇAMENTO" depois do strip de tags; sem isso a linha
// nunca batia (não começa com letra maiúscula) e TODO destaque era perdido
// silenciosamente convertido em "0 destaques" (achado ao vivo, ciclo 2607-08).
const CATEGORY_LINE_RE = /^[\p{Lu}][\p{Lu}\s]{1,38}$/u;
const BULLET_PREFIX_RE = /^●\s*/u;
const LINK_LINE_RE = /^\[(.+?)\]\((https?:\/\/[^\s)]+)\)$/;
// tealDot() (#3104) também prefixa o label "Por que isso importa" a partir
// de algum ponto do mês (visto ao vivo: presente desde 260710, ausente até
// 260709 — rollout incremental do marcador, não big-bang) — mesmo tratamento
// de stripBullet() do CATEGORY_LINE_RE, senão a linha "why" nunca fecha o
// destaque e todo bloco vira "sem Por que isso importa: — pulado".
const WHY_LINE_RE = /^por que isso importa:?$/i;

function stripBullet(line: string): string {
  return line.replace(BULLET_PREFIX_RE, "");
}

function isCategoryLine(line: string): boolean {
  return CATEGORY_LINE_RE.test(stripBullet(line));
}

function isWhyLine(line: string): boolean {
  return WHY_LINE_RE.test(stripBullet(line));
}

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
    const categoryCandidate = stripBullet(line);
    if (!CATEGORY_LINE_RE.test(categoryCandidate) || isWhyLine(line) || LINK_LINE_RE.test(line)) {
      i++;
      continue;
    }
    const category = categoryCandidate;

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
      if (isCategoryLine(lines[j])) break;
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
    while (k < lines.length && !isWhyLine(lines[k]) && !isCategoryLine(lines[k])) {
      bodyLines.push(lines[k]);
      k++;
    }
    if (k >= lines.length || !isWhyLine(lines[k])) {
      warnings.push(
        `${label}: bloco "${category}" (${titleLink.title}) sem "Por que isso importa:" — pulado`,
      );
      i = j + 1;
      continue;
    }

    // Why: da linha após o delimitador até a próxima categoria (ou fim).
    let w = k + 1;
    const whyLines: string[] = [];
    while (w < lines.length && !isCategoryLine(lines[w])) {
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
