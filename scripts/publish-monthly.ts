/**
 * publish-monthly.ts
 *
 * Cria uma campanha de email Brevo para o digest mensal e envia email de teste.
 *
 * Uso:
 *   npx tsx scripts/publish-monthly.ts --yymm 2604 [flags]
 *
 * Flags:
 *   --yymm                 Mês no formato YYMM (obrigatório)
 *   --list-id N            Override da lista Brevo (sobrepõe platform.config.json → brevo_monthly.list_id)
 *   --send-test            Envia email de teste após criar a campanha
 *   --send-test-to <email> Override do destinatário do test email (default: brevo_monthly.test_email)
 *   --send-now             Dispara campanha IMEDIATAMENTE pra lista (irreversível)
 *   --schedule-at <ISO>    Agenda dispatch pra timestamp futuro (ISO 8601, com timezone)
 *                          Ex: --schedule-at 2026-05-09T12:00:00-03:00
 *   --update-existing N    Atualiza campanha existente (id N) em vez de criar nova
 *   --dry-run              Valida inputs e gera HTML preview local sem chamar a API
 *
 * Mutuamente exclusivos: --send-test, --send-now, --schedule-at.
 *
 * Output: data/monthly/{YYMM}/_internal/05-published.json
 *
 * Pré-requisitos:
 *   - BREVO_CLARICE_API_KEY definido no ambiente (ou .env)
 *   - platform.config.json → brevo_monthly.sender_email preenchido
 *   - list_id resolvido: --list-id N ou brevo_monthly.list_id (CLI tem prioridade)
 *   - data/monthly/{YYMM}/draft.md existente (Etapa 2)
 */

import { config as dotenvConfig } from "dotenv";
// override: true necessário pois shell pode ter CLOUDFLARE_ACCOUNT_ID=<placeholder> setado,
// e dotenv sem override não sobrescreve vars já existentes no processo.
dotenvConfig({ override: true });
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readEiaAnswerSidecar, aiSideFromAnswer } from "./lib/eia-answer.ts"; // #927
import { parseEiaMeta } from "./lib/schemas/eia-meta.ts"; // #1012
import { uploadImageToWorkerKV } from "./lib/cloudflare-kv-upload.ts"; // #1119

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── Types ─────────────────────────────────────────────────────────────────

interface BrevoConfig {
  api_key_env: string;
  list_id: number | null;
  sender_email: string | null;
  sender_name: string;
  test_email: string;
}

interface PlatformConfig {
  newsletter_monthly?: string;
  brevo_monthly?: BrevoConfig;
}

interface MonthlyPublished {
  campaign_id: number;
  campaign_name: string;
  subject: string;
  preview_text: string;
  status: "draft" | "test_sent" | "sent" | "scheduled" | "failed";
  brevo_dashboard_url: string;
  list_id: number;
  list_name: string;
  list_subscribers: number;
  test_email?: string;
  test_sent_at?: string;
  sent_at?: string;
  scheduled_at?: string;       // #1015: agendamento futuro
  updated_existing?: boolean;  // #1015: campanha reusada (não criada nova)
  created_at: string;
  error?: string;
}

// ─── CLI ───────────────────────────────────────────────────────────────────

interface ParsedArgs {
  yymm: string;
  sendTest: boolean;
  sendNow: boolean;
  dryRun: boolean;
  listIdOverride: number | null;
  sendTestTo: string | null;       // override do destinatário do test email (#1015)
  scheduleAt: string | null;       // timestamp ISO 8601 pra agendamento (#1015)
  updateExisting: number | null;   // campaign_id pra reusar (#1015)
}

/**
 * Parse args. Aceita `argv` opcional pra testabilidade — em produção usa
 * `process.argv.slice(2)` (CLI). Em testes, pass `["--yymm", "2604", ...]`.
 *
 * Side-effect: chama `process.exit(1)` em casos inválidos. Tests precisam
 * cuidar com try/catch ou interceptar process.exit se testar errors.
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  let yymm = "";
  let sendTest = false;
  let sendNow = false;
  let dryRun = false;
  let listIdOverride: number | null = null;
  let sendTestTo: string | null = null;
  let scheduleAt: string | null = null;
  let updateExisting: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--yymm" && i + 1 < argv.length) {
      yymm = argv[++i];
    } else if (argv[i] === "--send-test") {
      sendTest = true;
    } else if (argv[i] === "--send-now") {
      sendNow = true;
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--list-id" && i + 1 < argv.length) {
      const raw = argv[++i];
      const n = parseInt(raw, 10);
      if (Number.isNaN(n) || n <= 0) {
        process.stderr.write(`ERRO: --list-id inválido: "${raw}"\n`);
        process.exit(1);
      }
      listIdOverride = n;
    } else if (argv[i] === "--send-test-to" && i + 1 < argv.length) {
      const raw = argv[++i].trim();
      // Validação básica de email (não hard, só checa que tem @ e .)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
        process.stderr.write(`ERRO: --send-test-to inválido: "${raw}"\n`);
        process.exit(1);
      }
      sendTestTo = raw;
    } else if (argv[i] === "--schedule-at" && i + 1 < argv.length) {
      const raw = argv[++i];
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        process.stderr.write(`ERRO: --schedule-at não é ISO 8601 válido: "${raw}"\n`);
        process.exit(1);
      }
      if (d.getTime() <= Date.now()) {
        process.stderr.write(
          `ERRO: --schedule-at deve estar no futuro. Recebido: ${d.toISOString()}, agora: ${new Date().toISOString()}\n`,
        );
        process.exit(1);
      }
      scheduleAt = d.toISOString();
    } else if (argv[i] === "--update-existing" && i + 1 < argv.length) {
      const raw = argv[++i];
      const n = parseInt(raw, 10);
      if (Number.isNaN(n) || n <= 0) {
        process.stderr.write(`ERRO: --update-existing inválido: "${raw}"\n`);
        process.exit(1);
      }
      updateExisting = n;
    }
  }

  if (!yymm || !/^\d{4}$/.test(yymm)) {
    process.stderr.write(
      "Uso: publish-monthly.ts --yymm YYMM [--list-id N]\n" +
      "                         [--send-test [--send-test-to <email>]]\n" +
      "                         [--send-now] [--schedule-at <ISO>]\n" +
      "                         [--update-existing <campaign_id>] [--dry-run]\n" +
      "Exemplo: --yymm 2604 --list-id 9 --send-test --send-test-to felipe@clarice.ai\n",
    );
    process.exit(1);
  }

  return { yymm, sendTest, sendNow, dryRun, listIdOverride, sendTestTo, scheduleAt, updateExisting };
}

// ─── HTML conversion ───────────────────────────────────────────────────────

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

/** Renders the OUTRAS NOTÍCIAS DO MÊS section. */
export function renderOutrasNoticias(chunk: string): string {
  const lines = chunk.split("\n");
  const content = lines.slice(1).join("\n").trim();

  const header = `<p style="margin:0 0 24px 0;font-size:13px;font-weight:bold;letter-spacing:0.12em;text-transform:uppercase;color:#00A0A0;font-family:Arial,Helvetica,sans-serif;">Outras Notícias do Mês</p>`;

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

/** Renders the É IA? section with images and voting buttons (#465). */
export function renderEia(chunk: string, yymm: string, imageUrlA?: string, imageUrlB?: string): string {
  const lines = chunk.split("\n");
  const content = lines.slice(1).join("\n").trim();
  const workerUrl = process.env.POLL_WORKER_URL ?? "https://diar-ia-poll.diaria.workers.dev";
  const edition = eiaEditionFromYymm(yymm);
  const TEAL = "#00A0A0";
  const voteUrlA = `${workerUrl}/vote?email={{ contact.EMAIL }}&amp;edition=${edition}&amp;choice=A`;
  const voteUrlB = `${workerUrl}/vote?email={{ contact.EMAIL }}&amp;edition=${edition}&amp;choice=B`;

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
      <a href="${workerUrl}/leaderboard" style="color:${TEAL};text-decoration:underline;">Ver ranking</a>
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
  return /^(REMETENTE|ASSUNTO|PREVIEW|APRESENTAÇÃO|APRESENTACAO|INTRO|DESTAQUE\s+\d+|CLARICE\s+—|LABORAT[ÓO]RIO\s+CLARICE|OUTRAS\s+NOTÍCIAS\s+DO\s+M[ÊE]S|É\s+IA\?|ENCERRAMENTO|PARA\s+ENCERRAR)/i.test(
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

    if (label === "OUTRAS NOTÍCIAS DO MÊS") {
      bodyParts.push(renderOutrasNoticias(chunk));
      continue;
    }

    if (label === "É IA?") {
      bodyParts.push(renderEia(chunk, yymm, eiaImageUrlA, eiaImageUrlB));
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

// ─── Brevo API ─────────────────────────────────────────────────────────────

/**
 * Lê o ai_side do É IA? mensal e pré-registra o gabarito no Worker.
 * Isso permite que o leitor veja o resultado imediatamente ao votar,
 * sem esperar até a próxima edição.
 *
 * Tenta ler de (em ordem):
 *   1. data/monthly/{YYMM}/_internal/01-eia-answer.json — sidecar (#927)
 *   2. data/monthly/{YYMM}/_internal/01-eia-meta.json — campo ai_side
 *   3. data/monthly/{YYMM}/01-eia.md — frontmatter eia_answer
 */
async function registerEiaAnswer(monthlyDir: string, edition: string): Promise<void> {
  const workerUrl = process.env.POLL_WORKER_URL ?? "https://diar-ia-poll.diaria.workers.dev";
  const secret = process.env.POLL_SECRET;
  if (!secret) {
    process.stderr.write("warn: POLL_SECRET não definido — gabarito É IA? não pré-registrado\n");
    return;
  }

  // #927: sidecar JSON é canonical (sobrevive Drive round-trip).
  let aiSide: string | null = null;
  const sidecar = readEiaAnswerSidecar(monthlyDir);
  if (sidecar) {
    aiSide = aiSideFromAnswer(sidecar);
  }

  // Fallback 1: ler ai_side de 01-eia-meta.json (schema-validado, #1012)
  if (!aiSide) {
    const metaPath = resolve(monthlyDir, "_internal", "01-eia-meta.json");
    if (existsSync(metaPath)) {
      try {
        const meta = parseEiaMeta(JSON.parse(readFileSync(metaPath, "utf8")));
        aiSide = meta.ai_side;
      } catch { /* ignorar — schema drift cai no fallback 2 (frontmatter) */ }
    }
  }

  // Fallback 2: parsear frontmatter de 01-eia.md
  if (!aiSide) {
    const eiaPath = resolve(monthlyDir, "01-eia.md");
    if (existsSync(eiaPath)) {
      const text = readFileSync(eiaPath, "utf8");
      const m = text.match(/^---[\s\S]*?eia_answer:\s*([AB])/m);
      if (m) aiSide = m[1];
    }
  }

  if (!aiSide || !["A", "B"].includes(aiSide)) {
    process.stderr.write("warn: ai_side não encontrado — gabarito É IA? não pré-registrado (leitor verá resultado na próxima edição)\n");
    return;
  }

  // Calcular HMAC admin (mesmo algoritmo de close-poll.ts)
  const { createHmac } = await import("node:crypto");
  const sig = createHmac("sha256", secret).update(`${edition}:${aiSide}`).digest("hex");
  const url = `${workerUrl}/admin/correct?edition=${edition}&answer=${aiSide}&sig=${sig}`;

  try {
    const res = await fetch(url, { method: "POST" });
    const data = await res.json() as { ok?: boolean; updated_votes?: number };
    if (res.ok && data.ok) {
      process.stdout.write(`Gabarito registrado: É IA? edição ${edition} = ${aiSide} (${data.updated_votes ?? 0} votos retroativos)\n`);
    } else {
      process.stderr.write(`warn: falha ao registrar gabarito: ${JSON.stringify(data)}\n`);
    }
  } catch (e) {
    process.stderr.write(`warn: erro ao registrar gabarito É IA? — ${(e as Error).message}\n`);
  }
}

/**
 * Faz upload de uma imagem do digest mensal pro KV do Worker.
 * Wrapper sobre `uploadImageToWorkerKV` (lib/cloudflare-kv-upload.ts) que
 * resolve o `kvNamespaceId` de `platform.config.json` e usa key prefix
 * `img-monthly-`.
 *
 * Extraído em #1119 — a função genérica agora vive em lib pra ser reutilizada
 * pelo upload de imagens da newsletter daily (#1119).
 */
async function uploadMonthlyImage(filePath: string): Promise<string> {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const kvNamespaceId: string = cfg?.poll?.kv_namespace_id;
  if (!kvNamespaceId) throw new Error("platform.config.json → poll.kv_namespace_id não configurado");

  const workerUrl = process.env.POLL_WORKER_URL ?? cfg?.poll?.worker_url ?? "https://diar-ia-poll.diaria.workers.dev";
  const filename = filePath.split(/[\\/]/).pop() ?? "image.jpg";
  const key = `img-monthly-${filename}`;

  return uploadImageToWorkerKV(filePath, key, {
    kvNamespaceId,
    workerUrl,
  });
}

async function brevoPost(
  apiKey: string,
  path: string,
  body: unknown
): Promise<unknown> {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API POST ${path} falhou (${res.status}): ${text}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const text = await res.text();
    return text.length > 0 ? JSON.parse(text) : {};
  }
  return {};
}

/**
 * GET de uma campanha Brevo. Usado pra validar status antes de PUT em
 * `--update-existing` (#1015) — Brevo rejeita update em campanha já enviada,
 * mas o erro é pouco amigável. Vale checar antes pra dar mensagem clara.
 */
async function brevoGetCampaign(
  apiKey: string,
  campaignId: number,
): Promise<{ id: number; name: string; status: string }> {
  const res = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}`, {
    method: "GET",
    headers: { "api-key": apiKey, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API GET /emailCampaigns/${campaignId} falhou (${res.status}): ${text}`);
  }
  const data = await res.json() as { id: number; name: string; status: string };
  return data;
}

async function brevoGetList(
  apiKey: string,
  listId: number,
): Promise<{ id: number; name: string; totalSubscribers: number }> {
  const res = await fetch(`https://api.brevo.com/v3/contacts/lists/${listId}`, {
    method: "GET",
    headers: { "api-key": apiKey, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API GET /contacts/lists/${listId} falhou (${res.status}): ${text}`);
  }
  const data = await res.json() as { id: number; name: string; totalSubscribers: number };
  return data;
}

/**
 * PUT genérico pra Brevo. Usado em #1015 pra:
 *   - --schedule-at:    PUT /emailCampaigns/{id} body { scheduledAt }
 *   - --update-existing: PUT /emailCampaigns/{id} body { subject, htmlContent, ... }
 *
 * Nota (#1025): Brevo API usa PUT (não PATCH) pra updates de emailCampaigns;
 * PATCH retorna 404. Verificado empiricamente em 2026-05-08.
 */
async function brevoPut(
  apiKey: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    method: "PUT",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API PUT ${path} falhou (${res.status}): ${text}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const text = await res.text();
    return text.length > 0 ? JSON.parse(text) : {};
  }
  return {};
}

// ─── Main ──────────────────────────────────────────────────────────────────

/**
 * Main entrypoint do script.
 *
 * @param monthlyDirOverride Opcional. Default = `data/monthly/{yymm}`.
 *                           Em testes, passar tempdir com fixture controlado
 *                           pra evitar tocar dados reais (#1029).
 */
export async function main(monthlyDirOverride?: string): Promise<void> {
  const { yymm, sendTest, sendNow, dryRun, listIdOverride, sendTestTo, scheduleAt, updateExisting } = parseArgs();

  // #1015: --send-test, --send-now e --schedule-at são 3 ações mutuamente exclusivas.
  const actions = [sendTest && "--send-test", sendNow && "--send-now", scheduleAt && "--schedule-at"].filter(Boolean);
  if (actions.length > 1) {
    process.stderr.write(`ERRO: ${actions.join(", ")} são mutuamente exclusivos.\n`);
    process.exit(1);
  }
  // --send-test-to só faz sentido com --send-test
  if (sendTestTo && !sendTest) {
    process.stderr.write("ERRO: --send-test-to requer --send-test.\n");
    process.exit(1);
  }

  // Load platform config
  const configPath = resolve(ROOT, "platform.config.json");
  const platformConfig: PlatformConfig = JSON.parse(
    readFileSync(configPath, "utf8")
  );

  if (platformConfig.newsletter_monthly !== "brevo") {
    process.stderr.write(
      `newsletter_monthly é "${platformConfig.newsletter_monthly}", esperado "brevo"\n`
    );
    process.exit(1);
  }

  const brevo = platformConfig.brevo_monthly;
  if (!brevo) {
    process.stderr.write(
      "brevo_monthly não configurado em platform.config.json\n"
    );
    process.exit(1);
  }

  // Resolve list_id: CLI override (--list-id) tem prioridade sobre platform.config.json.
  const effectiveListId = listIdOverride ?? brevo.list_id;
  const listSource = listIdOverride !== null ? "--list-id flag" : "platform.config.json";

  if (!dryRun) {
    if (effectiveListId === null) {
      process.stderr.write(
        "ERRO: list_id não definido. Passe --list-id N ou configure brevo_monthly.list_id em platform.config.json.\n"
      );
      process.exit(1);
    }

    if (brevo.sender_email === null) {
      process.stderr.write(
        "ERRO: brevo_monthly.sender_email é null.\n" +
        "Configure o remetente verificado no painel Brevo e preencha sender_email em platform.config.json (#653).\n"
      );
      process.exit(1);
    }
  }

  const apiKeyRaw = process.env[brevo.api_key_env];
  if (!apiKeyRaw && !dryRun) {
    process.stderr.write(
      `ERRO: ${brevo.api_key_env} não está definido no ambiente.\n` +
      `Adicione ao .env: ${brevo.api_key_env}=<chave>\n`
    );
    process.exit(1);
  }
  // After this point we're either dry-run (apiKey unused) or apiKeyRaw is non-empty.
  const apiKey = apiKeyRaw ?? "";

  // Load draft (#1029: monthlyDirOverride permite injetar fixture em testes)
  const monthlyDir = monthlyDirOverride ?? resolve(ROOT, `data/monthly/${yymm}`);
  const draftPath = resolve(monthlyDir, "draft.md");

  if (!existsSync(draftPath)) {
    process.stderr.write(
      `draft.md não encontrado: ${draftPath}\n` +
      "Rode a Etapa 2 do /diaria-mensal primeiro.\n"
    );
    process.exit(1);
  }

  const draft = readFileSync(draftPath, "utf8");

  // Load chosen subject if available
  const chosenSubjectPath = resolve(
    monthlyDir,
    "_internal/02-chosen-subject.txt"
  );
  const chosenSubject = existsSync(chosenSubjectPath)
    ? readFileSync(chosenSubjectPath, "utf8").trim()
    : null;

  // Upload É IA? images to Cloudflare KV (Brevo não expõe API de upload de arquivos)
  let eiaImageUrlA: string | undefined;
  let eiaImageUrlB: string | undefined;
  if (!dryRun) {
    const eiaNames = [
      ["01-eia-A.jpg", "01-eia-B.jpg"],
      ["01-eai-A.jpg", "01-eai-B.jpg"], // legacy naming
    ];
    for (const [nameA, nameB] of eiaNames) {
      const pathA = resolve(monthlyDir, nameA);
      const pathB = resolve(monthlyDir, nameB);
      if (existsSync(pathA) && existsSync(pathB)) {
        try {
          process.stdout.write(`Uploading É IA? images to Cloudflare KV...\n`);
          eiaImageUrlA = await uploadMonthlyImage(pathA);
          eiaImageUrlB = await uploadMonthlyImage(pathB);
          process.stdout.write(`Imagens enviadas:\n  A: ${eiaImageUrlA}\n  B: ${eiaImageUrlB}\n`);
        } catch (e) {
          process.stderr.write(`warn: upload de imagens É IA? falhou — ${(e as Error).message}\n`);
        }
        break;
      }
    }
    if (!eiaImageUrlA) process.stderr.write("warn: imagens É IA? não encontradas — seção sem imagens\n");

    // Pré-registrar gabarito no Worker para resultado imediato ao votar
    const eiaEdition = eiaEditionFromYymm(yymm);
    await registerEiaAnswer(monthlyDir, eiaEdition);
  }

  // Convert draft to email
  let { subject, previewText, html } = draftToEmail(draft, chosenSubject, yymm, eiaImageUrlA, eiaImageUrlB);

  if (!subject) {
    process.stderr.write(
      "Não foi possível extrair subject do draft.\n" +
      "Verifique a seção ASSUNTO em draft.md ou crie _internal/02-chosen-subject.txt.\n"
    );
    process.exit(1);
  }

  const ts = new Date().toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(0, 16);
  let campaignName = `Diar.ia Mensal ${yymm} — ${ts}`;

  // Para `--send-test`: PRÉ-COMPUTA o próximo número, prefixa subject + nome
  // com `[Teste N]`. O write em disco do counter só acontece DEPOIS do sucesso
  // do /sendTest API call (mais abaixo) — assim falhas de API não consomem
  // numbers de teste fantasmas.
  let nextTestNumber = 0;
  if (sendTest && !dryRun) {
    const internalDir = resolve(monthlyDir, "_internal");
    if (!existsSync(internalDir)) mkdirSync(internalDir, { recursive: true });
    const counterPath = resolve(internalDir, "test-counter.txt");
    const current = existsSync(counterPath)
      ? parseInt(readFileSync(counterPath, "utf8").trim(), 10) || 0
      : 0;
    nextTestNumber = current + 1;
    subject = `[Teste ${nextTestNumber}] ${subject}`;
    campaignName = `${campaignName} — Teste ${nextTestNumber}`;
  }

  if (dryRun) {
    const internalDir = resolve(monthlyDir, "_internal");
    if (!existsSync(internalDir)) mkdirSync(internalDir, { recursive: true });
    const previewPath = resolve(internalDir, `preview-list${effectiveListId ?? "default"}.html`);
    writeFileSync(previewPath, html);
    const action = updateExisting !== null
      ? `atualizada (id=${updateExisting})`
      : "criada";
    const dispatchLabel = scheduleAt
      ? `\n  Dispatch: AGENDADO pra ${scheduleAt}`
      : sendNow
      ? "\n  Dispatch: ENVIO IMEDIATO"
      : sendTest
      ? `\n  Dispatch: TEST EMAIL pra ${sendTestTo ?? brevo.test_email}`
      : "\n  Dispatch: nenhum (só draft)";
    process.stdout.write(
      `[DRY RUN] Campanha que seria ${action}:\n` +
      `  Nome:     ${campaignName}\n` +
      `  Assunto:  ${subject}\n` +
      `  Preview:  ${previewText}\n` +
      `  List ID:  ${effectiveListId} (fonte: ${listSource})\n` +
      `  Remetente: ${brevo.sender_name} <${brevo.sender_email}>${dispatchLabel}\n` +
      `  HTML completo: ${previewPath}\n`,
    );
    return;
  }

  // Lookup list metadata para confirmar destinatário antes de criar a campanha (#336).
  const listInfo = await brevoGetList(apiKey, effectiveListId as number);
  process.stdout.write(
    `\nDestinatário:\n` +
    `  List ID:        ${listInfo.id} (fonte: ${listSource})\n` +
    `  Nome da lista:  ${listInfo.name}\n` +
    `  Assinantes:     ${listInfo.totalSubscribers}\n\n`
  );

  // #1015: --update-existing reusa campanha existente (PUT), default cria nova (POST).
  let campaignId: number;
  if (updateExisting !== null) {
    // Pre-check: campanha existe e não está em status terminal (sent).
    // Brevo rejeita update em sent campaigns, mas mensagem nativa é confusa.
    const existing = await brevoGetCampaign(apiKey, updateExisting);
    const TERMINAL_STATUSES = new Set(["sent", "archive"]);
    if (TERMINAL_STATUSES.has(existing.status)) {
      process.stderr.write(
        `ERRO: campanha ${updateExisting} está em status "${existing.status}" e não pode ser atualizada.\n` +
        `Crie uma campanha nova (omitir --update-existing) ou use uma diferente.\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `Campanha ${updateExisting} encontrada (status: ${existing.status}). Prosseguindo com PUT.\n`,
    );

    await brevoPut(apiKey, `/emailCampaigns/${updateExisting}`, {
      name: campaignName,
      subject,
      previewText,
      sender: {
        name: brevo.sender_name,
        email: brevo.sender_email,
      },
      recipients: { listIds: [effectiveListId] },
      htmlContent: html,
    });
    campaignId = updateExisting;
    process.stdout.write(`Campanha atualizada: id=${campaignId} (--update-existing)\n`);
  } else {
    const campaignResp = await brevoPost(apiKey, "/emailCampaigns", {
      name: campaignName,
      subject,
      previewText,
      sender: {
        name: brevo.sender_name,
        email: brevo.sender_email,
      },
      recipients: { listIds: [effectiveListId] },
      htmlContent: html,
    }) as Record<string, unknown>;

    if (typeof campaignResp.id !== "number") {
      throw new Error(
        `Brevo API retornou resposta inesperada (sem campo 'id'): ${JSON.stringify(campaignResp)}`
      );
    }
    campaignId = campaignResp.id;
    process.stdout.write(`Campanha criada: id=${campaignId}\n`);
  }
  const dashboardUrl = `https://app.brevo.com/campaign/email/${campaignId}/edit`;
  process.stdout.write(`Dashboard: ${dashboardUrl}\n`);

  const published: MonthlyPublished = {
    campaign_id: campaignId,
    campaign_name: campaignName,
    subject,
    preview_text: previewText,
    status: "draft",
    brevo_dashboard_url: dashboardUrl,
    updated_existing: updateExisting !== null ? true : undefined,
    list_id: listInfo.id,
    list_name: listInfo.name,
    list_subscribers: listInfo.totalSubscribers,
    created_at: new Date().toISOString(),
  };

  // Send test email — destinatário pode ser overrideado via --send-test-to (#1015)
  if (sendTest) {
    const testRecipient = sendTestTo ?? brevo.test_email;
    await brevoPost(apiKey, `/emailCampaigns/${campaignId}/sendTest`, {
      emailTo: [testRecipient],
    });

    // Counter só persiste após sucesso do /sendTest — evita "queimar" números
    // se a API falhar (rate limit, sender unverified, etc.).
    if (nextTestNumber > 0) {
      const counterPath = resolve(monthlyDir, "_internal/test-counter.txt");
      writeFileSync(counterPath, String(nextTestNumber));
    }

    published.status = "test_sent";
    published.test_email = testRecipient;
    published.test_sent_at = new Date().toISOString();

    const sourceLabel = sendTestTo ? "--send-test-to flag" : "platform.config.json";
    process.stdout.write(
      `Email de teste enviado para: ${testRecipient} (fonte: ${sourceLabel})\n`,
    );
  }

  // Send campaign now (real dispatch para a lista)
  if (sendNow) {
    await brevoPost(apiKey, `/emailCampaigns/${campaignId}/sendNow`, {});
    published.status = "sent";
    published.sent_at = new Date().toISOString();
    process.stdout.write(
      `Campanha disparada para lista ${listInfo.id} ("${listInfo.name}", ${listInfo.totalSubscribers} assinante${listInfo.totalSubscribers === 1 ? "" : "s"}).\n`,
    );
  }

  // #1015: agenda dispatch futuro via PUT /emailCampaigns/{id} { scheduledAt }
  if (scheduleAt) {
    await brevoPut(apiKey, `/emailCampaigns/${campaignId}`, {
      scheduledAt: scheduleAt,
    });
    published.status = "scheduled";
    published.scheduled_at = scheduleAt;
    const localTime = new Date(scheduleAt).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    process.stdout.write(
      `Campanha agendada pra ${scheduleAt} (BRT: ${localTime}) → lista ${listInfo.id} ("${listInfo.name}", ${listInfo.totalSubscribers} assinantes).\n`,
    );
  }

  // Save output
  const internalDir = resolve(monthlyDir, "_internal");
  if (!existsSync(internalDir)) mkdirSync(internalDir, { recursive: true });

  const outputPath = resolve(internalDir, "05-published.json");
  writeFileSync(outputPath, JSON.stringify(published, null, 2) + "\n");

  process.stdout.write(`Output salvo: ${outputPath}\n`);
}

// Guard: só roda main() quando invocado como CLI (não em import de test).
// Pattern: import.meta.url vs file:// do argv[1] (entrypoint Node).
const _argv1 = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
