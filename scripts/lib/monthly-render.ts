/**
 * monthly-render.ts (#1844 — extraído de publish-monthly.ts)
 *
 * Camada de APRESENTAÇÃO do digest mensal: markdown → HTML do email Brevo.
 * Funções puras (string in → string out), sem I/O — escHtml, render* por
 * seção, parsing de labels (splitByLabels/parseHeaderChunk/normalizeLabel) e
 * draftToEmail (orquestra o render do draft inteiro). publish-monthly.ts
 * re-exporta pra back-compat (testes importam por nome) e o main() importa
 * draftToEmail pra montar a campanha.
 */

export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Strip backslash escapes do export Drive (`\!` `\&` `\[` `\]`). */
export function stripBackslashEscapes(s: string): string {
  return s.replace(/\\([!&\[\]])/g, "$1");
}

/** Converts [text](url) markdown links to <a> tags + **bold** to <strong>. Escapes surrounding text. */
export function renderInline(text: string): string {
  // Pre-strip backslash escapes ANTES do escHtml — assim `\&` vira `&` que então
  // vira `&amp;`, e não `\&amp;` (que aconteceria se strippássemos depois).
  const preStripped = stripBackslashEscapes(text);
  // Split by link pattern; odd indices = link matches
  const parts = preStripped.split(/(\[[^\]]+\]\([^)]+\))/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (m) {
          return `<a href="${escHtml(m[2])}" style="color:#0066cc;text-decoration:underline;">${escHtml(m[1])}</a>`;
        }
      }
      // Escapa primeiro, depois converte `**bold**` em <strong>.
      return escHtml(part).replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    })
    .join("");
}

/**
 * Renders blank-line-separated blocks. Cada bloco é renderizado como `<p>`
 * por padrão, ou como `<ul>` / `<ol>` se todas as linhas forem itens de lista.
 *
 * Detecta:
 *   - bullet list: `- texto`, `* texto` (com indent opcional)
 *   - ordered list: `1. texto`, `2. texto` (com indent opcional)
 */
export function renderParagraphs(text: string): string {
  const paras = text.split(/\n\n+/).filter((p) => p.trim());
  return paras
    .map((p) => {
      const lines = p.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return "";

      const isUnordered = lines.every((l) => /^[-*]\s+/.test(l));
      const isOrdered = lines.every((l) => /^\d+\.\s+/.test(l));

      if (isUnordered) {
        const items = lines
          .map((l) => l.replace(/^[-*]\s+/, ""))
          .map((item) => `<li style="margin:0 0 8px 0;">${renderInline(item)}</li>`)
          .join("\n");
        return `<ul style="margin:0 0 16px 0;padding-left:24px;">${items}</ul>`;
      }
      if (isOrdered) {
        const items = lines
          .map((l) => l.replace(/^\d+\.\s+/, ""))
          .map((item) => `<li style="margin:0 0 8px 0;">${renderInline(item)}</li>`)
          .join("\n");
        return `<ol style="margin:0 0 16px 0;padding-left:24px;">${items}</ol>`;
      }

      const inline = renderInline(p.trim().replace(/\n/g, " "));
      return `<p style="margin:0 0 16px 0;">${inline}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Renders a DESTAQUE section block. Aceita override de tema (usado pra
 * LABORATÓRIO CLARICE etc — seções editorialmente equivalentes a destaques).
 *
 * Formatos de header reconhecidos (após `normalizeLabel`):
 *   - `DESTAQUE 1 | ANTHROPIC` (formato antigo, separador `|`)
 *   - `DESTAQUE 1\] ANTHROPIC` (Drive markdown export, com `\]` interno)
 *   - `DESTAQUE 1 ANTHROPIC` (qualquer separador whitespace)
 */
export function renderDestaque(chunk: string, temaOverride?: string): string {
  const lines = chunk.split("\n");
  // Limpar header: remover bold/brackets, separadores `\]` `|`, normalizar spaces.
  const cleaned = normalizeLabel(lines[0])
    .replace(/\\\]/g, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const m = cleaned.match(/^DESTAQUE\s+(\d+)\s+(.+)$/);
  const tema = temaOverride ?? (m ? m[2] : cleaned);

  // Find title: first non-empty line after header. Strip `**...**` (Drive bold).
  let i = 1;
  while (i < lines.length && !lines[i].trim()) i++;
  const title = i < lines.length
    ? lines[i].trim().replace(/^\*\*+/, "").replace(/\*\*+$/, "").trim()
    : "";
  i++;

  const remaining = lines.slice(i).join("\n").trim();
  const paragraphs = remaining.split(/\n\n+/).filter((p) => p.trim());

  const mainParas: string[] = [];
  let conductorText = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.startsWith("O fio condutor:")) {
      conductorText = trimmed.slice("O fio condutor:".length).trim();
    } else {
      mainParas.push(trimmed);
    }
  }

  // Renderiza o tema sempre (não filtra por VALID_CATEGORIES — temas mensais
  // como ANTHROPIC, OPENAI, LABORATÓRIO CLARICE são editoriais e devem aparecer).
  const label = tema
    ? `<p style="margin:0 0 4px 0;font-size:13px;font-weight:bold;letter-spacing:0.12em;color:#00A0A0;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">${escHtml(tema)}</p>`
    : "";
  const titleHtml = title
    ? `<h2 style="margin:0 0 20px 0;font-size:21px;font-weight:bold;font-family:Georgia,'Times New Roman',serif;line-height:1.3;">${renderInline(title)}</h2>`
    : "";
  const mainHtml = mainParas
    .map(
      (p) =>
        `<p style="margin:0 0 16px 0;">${renderInline(p.replace(/\n/g, " "))}</p>`
    )
    .join("\n");
  const conductorHtml = conductorText
    ? `<p style="margin:20px 0 0 0;font-style:italic;color:#444;border-left:3px solid #d0e8e8;padding-left:16px;">${renderInline(conductorText.replace(/\n/g, " "))}</p>`
    : "";

  return label + titleHtml + mainHtml + conductorHtml;
}

/**
 * Renders a INTRO section como sumário editorial destacado.
 * Estrutura: label teal "RESUMO DO MÊS" + parágrafo italic com border-left teal.
 */
export function renderIntro(body: string): string {
  const TEAL = "#00A0A0";
  const labelHtml = `<p style="margin:0 0 10px 0;font-size:13px;font-weight:bold;letter-spacing:0.12em;text-transform:uppercase;color:${TEAL};font-family:Arial,Helvetica,sans-serif;">Resumo do mês</p>`;
  const paras = body.split(/\n\n+/).filter((p) => p.trim());
  const bodyHtml = paras
    .map((p) => {
      const inline = renderInline(p.trim().replace(/\n/g, " "));
      return `<p style="margin:0 0 16px 0;font-size:19px;font-style:italic;color:#333;line-height:1.6;">${inline}</p>`;
    })
    .join("\n");
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:0;"><tr><td style="padding:8px 0 8px 20px;border-left:4px solid ${TEAL};">${labelHtml}${bodyHtml}</td></tr></table>`;
}

/**
 * Renders a LABORATÓRIO CLARICE section como caixa similar ao CLARICE
 * mas com formatação rica (h3 título, parágrafos, lista numerada).
 *
 * Estrutura esperada (após `**` strip):
 *   LABORATÓRIO CLARICE
 *
 *   **Subtítulo bold**
 *
 *   Parágrafo introdutório.
 *
 *   1. Item lista
 *   2. Item lista
 *   ...
 *
 *   Dica: ...
 *   → Teste agora: [link](url)
 */
export function renderLaboratorio(chunk: string): string {
  const lines = chunk.split("\n");
  // Skip header (LABORATÓRIO CLARICE) + blank lines.
  let i = 1;
  while (i < lines.length && !lines[i].trim()) i++;

  // Subtítulo: primeira linha não-vazia (espera `**...**`).
  const subtitleRaw = i < lines.length ? lines[i].trim() : "";
  const subtitle = subtitleRaw.replace(/^\*\*+/, "").replace(/\*\*+$/, "").trim();
  i++;

  const remaining = lines.slice(i).join("\n").trim();

  // Split em blocos: parágrafos, listas, dica final.
  const blocks = remaining.split(/\n\n+/).filter((b) => b.trim());

  const renderedBlocks: string[] = [];
  for (const block of blocks) {
    const blockLines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    // Bloco é uma lista numerada se TODAS as linhas começam com `\d+\.`.
    const isOrdered = blockLines.length > 0 && blockLines.every((l) => /^\d+\.\s/.test(l));
    if (isOrdered) {
      const items = blockLines
        .map((l) => l.replace(/^\d+\.\s+/, ""))
        .map((item) => `<li style="margin:0 0 8px 0;">${renderInline(item)}</li>`)
        .join("\n");
      renderedBlocks.push(
        `<ol style="margin:0 0 16px 0;padding-left:24px;color:#444;">${items}</ol>`
      );
    } else {
      const inline = renderInline(block.trim().replace(/\n/g, " "));
      renderedBlocks.push(`<p style="margin:0 0 16px 0;color:#444;">${inline}</p>`);
    }
  }

  const TEAL = "#00A0A0";
  const headerLabel = `<p style="margin:0 0 8px 0;font-size:13px;font-weight:bold;letter-spacing:0.12em;text-transform:uppercase;color:${TEAL};font-family:Arial,Helvetica,sans-serif;">LABORATÓRIO CLARICE</p>`;
  const subtitleHtml = subtitle
    ? `<h3 style="margin:0 0 16px 0;font-size:18px;font-weight:bold;font-family:Georgia,'Times New Roman',serif;line-height:1.3;color:#1a1a1a;">${renderInline(subtitle)}</h3>`
    : "";

  return [
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border:2px dashed #bbb;border-radius:4px;background:#fafaf4;">`,
    `<tr><td style="padding:24px 28px;">`,
    headerLabel,
    subtitleHtml,
    renderedBlocks.join("\n"),
    `</td></tr></table>`,
  ].join("");
}

/** Renders a CLARICE — DIVULGAÇÃO placeholder section. */
export function renderClarice(chunk: string): string {
  const lines = chunk.split("\n");
  // Drive exporta `**[CLARICE — DIVULGAÇÃO]**` ou `**LABORATÓRIO CLARICE**`.
  const headerLine = escHtml(normalizeLabel(lines[0]));
  const content = lines.slice(1).join("\n").trim();
  return [
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border:2px dashed #bbb;border-radius:4px;background:#fafaf4;">`,
    `<tr><td style="padding:20px 24px;">`,
    `<p style="margin:0 0 8px 0;font-size:13px;font-weight:bold;letter-spacing:0.12em;text-transform:uppercase;color:#888;font-family:Arial,Helvetica,sans-serif;">${headerLine}</p>`,
    `<p style="margin:0;color:#999;font-style:italic;">${renderInline(content)}</p>`,
    `</td></tr></table>`,
  ].join("");
}

/**
 * Renderiza uma seção de lista de links (título inline + descrição). Usada por
 * USE MELHOR DO MÊS, RADAR DO MÊS (#1901/#1902) e a legada OUTRAS NOTÍCIAS DO MÊS.
 */
export function renderLinkListSection(chunk: string, displayTitle: string): string {
  const lines = chunk.split("\n");
  const content = lines.slice(1).join("\n").trim();

  const header = `<p style="margin:0 0 24px 0;font-size:13px;font-weight:bold;letter-spacing:0.12em;text-transform:uppercase;color:#00A0A0;font-family:Arial,Helvetica,sans-serif;">${escHtml(displayTitle)}</p>`;

  // Items: [título](url) + blank line + descrição (separados por blank entre itens).
  // split(/\n\n+/) quebra título e descrição em chunks separados — a descrição
  // ficaria sem título e renderizaria como negrito indevidamente.
  // Fix: agrupar por linha de inline link (nova entrada = [título](url)).
  const TITLE_RE = /^\[.+\]\(https?:\/\/[^)]+\)/;
  const nonBlankLines = content.split("\n").map((l) => l.trim()).filter((l) => l);

  const parsed: Array<{ title: string; desc: string }> = [];
  let currentTitle: string | null = null;
  const descBuf: string[] = [];

  for (const line of nonBlankLines) {
    if (TITLE_RE.test(line)) {
      if (currentTitle !== null) {
        parsed.push({ title: currentTitle, desc: descBuf.join(" ").trim() });
        descBuf.length = 0;
      }
      currentTitle = line;
    } else {
      descBuf.push(line);
    }
  }
  if (currentTitle !== null) {
    parsed.push({ title: currentTitle, desc: descBuf.join(" ").trim() });
  }

  const itemsHtml = parsed
    .map(({ title, desc }) =>
      `<p style="margin:0 0 4px 0;font-weight:bold;">${renderInline(title)}</p>` +
      (desc
        ? `<p style="margin:0 0 20px 0;color:#444;">${renderInline(desc)}</p>`
        : `<div style="margin-bottom:20px;"></div>`)
    )
    .join("\n");

  return header + itemsHtml;
}

/** @deprecated back-compat: use renderLinkListSection. */
export function renderOutrasNoticias(chunk: string): string {
  return renderLinkListSection(chunk, "Outras Notícias do Mês");
}

/**
 * Deriva o código de edição AAMMDD do É IA? mensal = último dia do mês.
 * Ex: "2604" → "260430" (30 de abril de 2026).
 */
export function eiaEditionFromYymm(yymm: string): string {
  const yr = 2000 + parseInt(yymm.slice(0, 2), 10);
  const mo = parseInt(yymm.slice(2, 4), 10);
  const lastDay = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
  return `${String(yr).slice(2)}${String(mo).padStart(2, "0")}${String(lastDay).padStart(2, "0")}`;
}

/**
 * Pure (#1914): extrai a legenda/crédito do `01-eia.md` (o corpo após o header
 * `**É IA?**`, sem o frontmatter `eia_answer`). É essa legenda que vira o crédito
 * da imagem no card do É IA? mensal. Retorna "" se não achar corpo.
 */
export function parseEiaLegend(eiaMd: string): string {
  const noFront = eiaMd.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "");
  // Remove a linha de header (`**É IA?**` ou `É IA?`), pega o resto. Sem `\b`:
  // o boundary ASCII não casa antes de `É` nem depois de `*` (#1914 review).
  const lines = noFront.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /É\s?IA\?/.test(l));
  const body = (startIdx >= 0 ? lines.slice(startIdx + 1) : lines).join("\n").trim();
  return body;
}

/**
 * Renders the É IA? section with images and voting buttons (#465).
 * `creditOverride` (#1914): legenda vinda do `01-eia.md` — quando presente,
 * substitui o corpo do chunk (que na mensal é só um placeholder `[...]`).
 */
export function renderEia(
  chunk: string,
  yymm: string,
  imageUrlA?: string,
  imageUrlB?: string,
  creditOverride?: string,
): string {
  const lines = chunk.split("\n");
  const content = creditOverride?.trim() || lines.slice(1).join("\n").trim();
  const workerUrl = process.env.POLL_WORKER_URL ?? "https://poll.diaria.workers.dev";
  const edition = eiaEditionFromYymm(yymm);
  const TEAL = "#00A0A0";
  // #1905: brand=clarice — votos do É IA? mensal vão pro leaderboard da Clarice
  // News, isolado do diário (Diar.ia).
  const voteUrlA = `${workerUrl}/vote?email={{ contact.EMAIL }}&amp;edition=${edition}&amp;choice=A&amp;brand=clarice`;
  const voteUrlB = `${workerUrl}/vote?email={{ contact.EMAIL }}&amp;edition=${edition}&amp;choice=B&amp;brand=clarice`;

  // Renderiza um bloco imagem + botão de votação (sem label separado — botão já identifica A/B)
  function imageBlock(label: string, imgUrl: string | undefined, voteUrl: string): string {
    const imgHtml = imgUrl
      ? `<img src="${escHtml(imgUrl)}" alt="Imagem ${label}" style="display:block;width:100%;height:auto;border-radius:6px;" />`
      : `<div style="width:100%;height:180px;background:#f0f0f0;border:2px dashed #ccc;border-radius:6px;text-align:center;line-height:180px;color:#bbb;font-family:Arial,sans-serif;font-size:13px;">Imagem ${label}</div>`;
    return `
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 12px;">
  <tr><td>${imgHtml}</td></tr>
  <tr><td align="center" style="padding:12px 0 0;">
    <a href="${voteUrl}"
       style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;background-color:${TEAL};border-radius:50px;padding:12px 32px;text-decoration:none;letter-spacing:0.02em;">Votar: esta é IA</a>
  </td></tr>
</table>`;
  }

  return `
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background:#f0fafa;border-radius:10px;margin:0;">
  <tr><td style="padding:24px 28px 20px;">

    <!-- Cabeçalho -->
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;">
      <tr>
        <td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;letter-spacing:0.12em;text-transform:uppercase;color:${TEAL};">🤔 É IA?</td>
      </tr>
      <tr>
        <td style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:bold;color:#1a1a1a;padding:4px 0 0;">Qual das imagens foi gerada por IA?</td>
      </tr>
    </table>

    <!-- Imagem A -->
    ${imageBlock("A", imageUrlA, voteUrlA)}

    <!-- Separador -->
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:4px 0 16px;">
      <tr><td><hr style="border:none;border-top:1px solid #d0e8e8;margin:0;" /></td></tr>
    </table>

    <!-- Imagem B -->
    ${imageBlock("B", imageUrlB, voteUrlB)}

    <!-- Crédito -->
    <p style="margin:12px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;font-style:italic;color:#666;">${renderInline(content)}</p>

    <!-- Leaderboard -->
    <p style="margin:12px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#888;">
      <a href="${workerUrl}/leaderboard?brand=clarice" style="color:${TEAL};text-decoration:underline;">Ver ranking</a>
    </p>

  </td></tr>
</table>`;
}

/**
 * Normaliza um label de seção, removendo bold (`**...**`), brackets escapados
 * (`\[...\]`) ou nus (`[...]`) e espaços. Necessário pois o Drive exporta
 * Google Docs com formatação markdown (negrito, brackets) que o parser original
 * não reconhecia.
 *
 * Exemplos:
 *   "**REMETENTE**"           → "REMETENTE"
 *   "**\\[INTRO\\]**"         → "INTRO"
 *   "**[CLARICE — DIVULGAÇÃO]**" → "CLARICE — DIVULGAÇÃO"
 *   "**DESTAQUE 1 | ANTHROPIC**" → "DESTAQUE 1 | ANTHROPIC"
 */
export function normalizeLabel(line: string): string {
  return line
    .trim()
    .replace(/^\*\*+/, "")
    .replace(/\*\*+$/, "")
    .replace(/^\\?\[/, "")
    .replace(/\\?\]$/, "")
    .trim();
}

/** Parses the header chunk (before first ---) to extract subject, preview, intro. */
export function parseHeaderChunk(chunk: string): {
  subjectOptions: string[];
  preview: string;
  intro: string;
} {
  // Pre-normaliza: strip `**` ao redor de labels canônicos pra os regex abaixo funcionarem.
  // (Drive exporta `**ASSUNTO**` em vez de `ASSUNTO`; mantemos os regex simples.)
  const text = chunk
    .trim()
    .replace(/^\*\*(REMETENTE|ASSUNTO|PREVIEW|INTRO)\*\*\s*$/gm, "$1")
    .replace(/^\*\*\\?\[(REMETENTE|ASSUNTO|PREVIEW|INTRO)\\?\]\*\*\s*$/gm, "$1");

  const subjectOptions: string[] = [];
  let preview = "";
  let intro = "";

  // Find ASSUNTO section
  const assuntoMatch = text.match(
    /ASSUNTO[^\n]*\n([\s\S]*?)(?=\nPREVIEW|\nINTRO|$)/
  );
  if (assuntoMatch) {
    const lines = assuntoMatch[1].trim().split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const m = line.match(/^\d+\.\s+(.+)$/);
      if (m) subjectOptions.push(m[1].trim());
    }
    // Fallback (#XXXX): se ASSUNTO não tem lista numerada, tratar conteúdo como
    // subject único. Drive doc só lista 1 ASSUNTO sem numeração.
    if (subjectOptions.length === 0 && lines.length > 0) {
      subjectOptions.push(lines.join(" ").trim());
    }
  }

  // Find PREVIEW section
  const previewMatch = text.match(/\nPREVIEW\n+([\s\S]*?)(?=\nINTRO|$)/);
  if (previewMatch) preview = previewMatch[1].trim();

  // Find INTRO section
  const introMatch = text.match(/\nINTRO\n+([\s\S]*)$/);
  if (introMatch) intro = introMatch[1].trim();

  return { subjectOptions, preview, intro };
}

/** Wraps rendered HTML parts in a full email document. */
export function wrapEmail(subject: string, bodyParts: string[]): string {
  const divider = `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:28px 0;"><tr><td><hr style="border:none;border-top:1px solid #e0e0e0;" /></td></tr></table>`;
  const body = bodyParts.join(divider);

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f2f2f2;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td align="center" style="padding:20px 10px;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;background:#ffffff;">
          <tr>
            <td style="padding:36px 44px;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;font-size:17px;line-height:1.7;">
              ${body}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Detecta se uma linha é um label de seção (formatado como `**LABEL**` ou
 * `**\[LABEL\]**` no Drive markdown). Não depende de `---` separators.
 */
export function isSectionLabel(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("**") || !trimmed.endsWith("**")) return false;
  const normalized = normalizeLabel(trimmed);
  // #1904-followup: aceita os rótulos com OU sem " DO MÊS" — o editor encurta
  // pra "USE MELHOR"/"RADAR" (igual ao diário). Sufixo opcional cobre ambos.
  // "RADAR"/"USE MELHOR" são ancorados ao fim ($) porque são palavras comuns:
  // sem o $, uma linha 100%-bold tipo **RADAR DA OPENAI** viraria seção espúria.
  return /^(REMETENTE|ASSUNTO|PREVIEW|APRESENTAÇÃO|APRESENTACAO|INTRO|DESTAQUE\s+\d+|CLARICE\s+—|LABORAT[ÓO]RIO\s+CLARICE|USE\s+MELHOR(\s+DO\s+M[ÊE]S)?$|RADAR(\s+DO\s+M[ÊE]S)?$|OUTRAS\s+NOTÍCIAS\s+DO\s+M[ÊE]S|É\s+IA\?|ENCERRAMENTO|PARA\s+ENCERRAR)/i.test(
    normalized
  );
}

/**
 * Splits draft text em chunks por section label (não por `\n---\n`).
 * Mais robusto: Drive export pode ou não preservar horizontal rules.
 */
export function splitByLabels(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (isSectionLabel(line)) {
      if (current.length > 0) {
        const chunk = current.join("\n").trim();
        if (chunk) sections.push(chunk);
      }
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    const chunk = current.join("\n").trim();
    if (chunk) sections.push(chunk);
  }

  // Strip horizontal rules residuais (caso o markdown ainda os tenha).
  return sections
    .map((s) => s.replace(/^---\s*$/gm, "").trim())
    .filter((s) => s.length > 0);
}

/** Converts draft.md content + optional chosen subject to { subject, previewText, html }. */
export function draftToEmail(
  draft: string,
  chosenSubject: string | null,
  yymm: string,
  eiaImageUrlA?: string,
  eiaImageUrlB?: string,
  eiaCredit?: string,
): { subject: string; previewText: string; html: string } {
  const text = draft.replace(/\r\n/g, "\n");
  const rawSections = splitByLabels(text);

  let subject = chosenSubject ?? "";
  let previewText = "";
  const bodyParts: string[] = [];

  // Helper: extrai conteúdo de um chunk (linhas após a primeira).
  const chunkBody = (chunk: string): string =>
    chunk.split("\n").slice(1).join("\n").trim();

  for (let idx = 0; idx < rawSections.length; idx++) {
    const chunk = rawSections[idx].trim();
    if (!chunk) continue;

    const firstLine = chunk.split("\n")[0].trim();
    const label = normalizeLabel(firstLine);

    // REMETENTE: metadata, não renderiza no corpo.
    if (label === "REMETENTE") continue;

    // ASSUNTO: extrai como subject (override se chosenSubject não setado).
    if (label === "ASSUNTO") {
      const body = chunkBody(chunk);
      const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
      let candidate = "";
      for (const line of lines) {
        const m = line.match(/^\d+\.\s+(.+)$/);
        if (m) { candidate = m[1].trim(); break; }
      }
      if (!candidate && lines.length > 0) candidate = lines.join(" ").trim();
      if (!subject && candidate) subject = candidate;
      continue;
    }

    // PREVIEW: extrai como previewText.
    if (label === "PREVIEW") {
      previewText = chunkBody(chunk).split("\n").join(" ").trim();
      continue;
    }

    // INTRO: sumário editorial do mês — render destacado (label teal + italic + border).
    if (label === "INTRO") {
      const body = chunkBody(chunk);
      if (body) bodyParts.push(renderIntro(body));
      continue;
    }

    // APRESENTAÇÃO: parágrafos planos.
    if (["APRESENTAÇÃO", "APRESENTACAO"].includes(label)) {
      const body = chunkBody(chunk);
      if (body) bodyParts.push(renderParagraphs(body));
      continue;
    }

    // DESTAQUE — aceita `DESTAQUE N | TEMA` antigo E `DESTAQUE N\] TEMA` novo.
    if (label.match(/^DESTAQUE\s+\d+/)) {
      bodyParts.push(renderDestaque(chunk));
      continue;
    }

    if (label.startsWith("CLARICE —")) {
      bodyParts.push(renderClarice(chunk));
      continue;
    }

    // LABORATÓRIO CLARICE: caixa dedicada (h3 + parágrafos + lista numerada).
    if (label === "LABORATÓRIO CLARICE") {
      bodyParts.push(renderLaboratorio(chunk));
      continue;
    }

    // #1904-followup: dispatch tolerante ao rótulo curto (editor encurta
    // "USE MELHOR DO MÊS" → "USE MELHOR"). O título de exibição é sempre o longo.
    if (label === "USE MELHOR" || label === "USE MELHOR DO MÊS") {
      bodyParts.push(renderLinkListSection(chunk, "Use Melhor do Mês"));
      continue;
    }

    if (label === "RADAR" || label === "RADAR DO MÊS") {
      bodyParts.push(renderLinkListSection(chunk, "Radar do Mês"));
      continue;
    }

    if (label === "OUTRAS NOTÍCIAS DO MÊS") {
      bodyParts.push(renderOutrasNoticias(chunk));
      continue;
    }

    // #1914: tolera o rótulo longo do template ("É IA? — DESTAQUE DO MÊS") além
    // do curto. Sem isso a seção caía no fallback e o placeholder `[...]`
    // aparecia literal no email.
    if (label === "É IA?" || label === "É IA? — DESTAQUE DO MÊS") {
      bodyParts.push(renderEia(chunk, yymm, eiaImageUrlA, eiaImageUrlB, eiaCredit));
      continue;
    }

    // ENCERRAMENTO antigo + PARA ENCERRAR (renomeado pelo editor).
    if (label === "ENCERRAMENTO" || label === "PARA ENCERRAR") {
      const body = chunkBody(chunk);
      if (body) bodyParts.push(renderParagraphs(body));
      continue;
    }

    // Fallback: render as plain paragraphs (chunk inteiro, com label).
    bodyParts.push(renderParagraphs(chunk));
  }

  return {
    subject,
    previewText,
    html: wrapEmail(subject, bodyParts),
  };
}
