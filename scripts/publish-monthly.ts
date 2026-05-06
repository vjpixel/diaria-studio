/**
 * publish-monthly.ts
 *
 * Cria uma campanha de email Brevo para o digest mensal e envia email de teste.
 *
 * Uso:
 *   npx tsx scripts/publish-monthly.ts --yymm 2604 [--send-test] [--dry-run]
 *
 * Flags:
 *   --yymm      Mês no formato YYMM (obrigatório)
 *   --send-test Envia email de teste após criar a campanha
 *   --dry-run   Valida inputs e exibe preview HTML sem chamar a API
 *
 * Output: data/monthly/{YYMM}/_internal/05-published.json
 *
 * Pré-requisitos:
 *   - BREVO_CLARICE_API_KEY definido no ambiente (ou .env)
 *   - platform.config.json → brevo_monthly.list_id e sender_email preenchidos
 *   - data/monthly/{YYMM}/draft.md existente (Etapa 2)
 */

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

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
  status: "draft" | "test_sent" | "failed";
  brevo_dashboard_url: string;
  test_email?: string;
  test_sent_at?: string;
  created_at: string;
  error?: string;
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(): { yymm: string; sendTest: boolean; dryRun: boolean } {
  const argv = process.argv.slice(2);
  let yymm = "";
  let sendTest = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--yymm" && i + 1 < argv.length) {
      yymm = argv[++i];
    } else if (argv[i] === "--send-test") {
      sendTest = true;
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    }
  }

  if (!yymm || !/^\d{4}$/.test(yymm)) {
    process.stderr.write(
      "Uso: publish-monthly.ts --yymm YYMM [--send-test] [--dry-run]\n" +
      "Exemplo: --yymm 2604\n"
    );
    process.exit(1);
  }

  return { yymm, sendTest, dryRun };
}

// ─── HTML conversion ───────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Converts [text](url) markdown links to <a> tags. Escapes surrounding text. */
function renderInline(text: string): string {
  // Split by link pattern; odd indices = link matches
  const parts = text.split(/(\[[^\]]+\]\([^)]+\))/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (m) {
          return `<a href="${escHtml(m[2])}" style="color:#0066cc;text-decoration:underline;">${escHtml(m[1])}</a>`;
        }
      }
      return escHtml(part);
    })
    .join("");
}

/** Renders blank-line-separated paragraphs as <p> tags. */
function renderParagraphs(text: string): string {
  const paras = text.split(/\n\n+/).filter((p) => p.trim());
  return paras
    .map((p) => {
      const inline = renderInline(p.trim().replace(/\n/g, " "));
      return `<p style="margin:0 0 16px 0;">${inline}</p>`;
    })
    .join("\n");
}

/** Renders a DESTAQUE section block. */
function renderDestaque(chunk: string): string {
  const lines = chunk.split("\n");
  const headerLine = lines[0];
  const m = headerLine.match(/^DESTAQUE (\d+) \| (.+)$/);
  const num = m ? m[1] : "?";
  const tema = m ? m[2] : headerLine;

  // Find title: first non-empty line after header
  let i = 1;
  while (i < lines.length && !lines[i].trim()) i++;
  const title = i < lines.length ? lines[i].trim() : "";
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

  const label = `<p style="margin:0 0 4px 0;font-size:11px;font-weight:bold;letter-spacing:0.12em;color:#888;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">DESTAQUE ${escHtml(num)} | ${escHtml(tema)}</p>`;
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
    ? `<p style="margin:20px 0 0 0;font-style:italic;color:#444;border-left:3px solid #ddd;padding-left:16px;">${renderInline(conductorText.replace(/\n/g, " "))}</p>`
    : "";

  return label + titleHtml + mainHtml + conductorHtml;
}

/** Renders a CLARICE placeholder section. */
function renderClarice(chunk: string): string {
  const lines = chunk.split("\n");
  const headerLine = escHtml(lines[0]);
  const content = lines.slice(1).join("\n").trim();
  return [
    `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border:2px dashed #bbb;border-radius:4px;background:#fafaf4;">`,
    `<tr><td style="padding:20px 24px;">`,
    `<p style="margin:0 0 8px 0;font-size:11px;font-weight:bold;letter-spacing:0.12em;text-transform:uppercase;color:#888;font-family:Arial,Helvetica,sans-serif;">${headerLine}</p>`,
    `<p style="margin:0;color:#999;font-style:italic;">${renderInline(content)}</p>`,
    `</td></tr></table>`,
  ].join("");
}

/** Renders the OUTRAS NOTÍCIAS DO MÊS section. */
function renderOutrasNoticias(chunk: string): string {
  const lines = chunk.split("\n");
  const content = lines.slice(1).join("\n").trim();

  const header = `<p style="margin:0 0 24px 0;font-size:11px;font-weight:bold;letter-spacing:0.12em;text-transform:uppercase;color:#888;font-family:Arial,Helvetica,sans-serif;">Outras Notícias do Mês</p>`;

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
function eiaEditionFromYymm(yymm: string): string {
  const yr = 2000 + parseInt(yymm.slice(0, 2), 10);
  const mo = parseInt(yymm.slice(2, 4), 10);
  const lastDay = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
  return `${String(yr).slice(2)}${String(mo).padStart(2, "0")}${String(lastDay).padStart(2, "0")}`;
}

/** Renders the É IA? section with images and voting buttons (#465). */
function renderEia(chunk: string, yymm: string, imageUrlA?: string, imageUrlB?: string): string {
  const lines = chunk.split("\n");
  const content = lines.slice(1).join("\n").trim();
  const workerUrl = process.env.POLL_WORKER_URL ?? "https://diar-ia-poll.diaria.workers.dev";
  const edition = eiaEditionFromYymm(yymm);
  const imgStyle = "display:block;width:100%;max-width:560px;height:auto;margin:0 auto 8px;border-radius:4px;";
  const placeholderStyle = "display:block;width:100%;max-width:560px;height:200px;margin:0 auto 8px;background:#f0f0f0;border:2px dashed #ccc;border-radius:4px;text-align:center;line-height:200px;color:#999;font-family:Arial,sans-serif;font-size:14px;";
  const imagesHtml = (imageUrlA && imageUrlB) ? `
<p style="margin:0 0 4px 0;font-size:12px;font-weight:bold;color:#888;font-family:Arial,Helvetica,sans-serif;">A</p>
<img src="${escHtml(imageUrlA)}" alt="Imagem A" style="${imgStyle}" />
<p style="margin:8px 0 4px 0;font-size:12px;font-weight:bold;color:#888;font-family:Arial,Helvetica,sans-serif;">B</p>
<img src="${escHtml(imageUrlB)}" alt="Imagem B" style="${imgStyle}" />
` : `
<div style="${placeholderStyle}">Imagem A — adicionar no editor Brevo</div>
<div style="${placeholderStyle}">Imagem B — adicionar no editor Brevo</div>
`;
  // Brevo merge tag para email do assinante (substituído no envio).
  // &amp; necessário em href para HTML válido em email clients estritos.
  const voteButtons = `
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:16px 0;">
  <tr>
    <td align="center">
      <a href="${workerUrl}/vote?email={{ contact.EMAIL }}&amp;edition=${edition}&amp;choice=A"
         style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#00A0A0;border:2px solid #00A0A0;border-radius:50px;padding:10px 24px;text-decoration:none;font-weight:600;margin:0 8px;">Votar A</a>
      <a href="${workerUrl}/vote?email={{ contact.EMAIL }}&amp;edition=${edition}&amp;choice=B"
         style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#00A0A0;border:2px solid #00A0A0;border-radius:50px;padding:10px 24px;text-decoration:none;font-weight:600;margin:0 8px;">Votar B</a>
    </td>
  </tr>
</table>`;
  return [
    `<p style="margin:0 0 8px 0;font-size:11px;font-weight:bold;letter-spacing:0.12em;text-transform:uppercase;color:#888;font-family:Arial,Helvetica,sans-serif;">É IA? — Destaque do Mês</p>`,
    imagesHtml,
    `<p style="margin:0 0 16px 0;font-style:italic;color:#444;">${renderInline(content)}</p>`,
    voteButtons,
  ].join("\n");
}

/** Parses the header chunk (before first ---) to extract subject, preview, intro. */
function parseHeaderChunk(chunk: string): {
  subjectOptions: string[];
  preview: string;
  intro: string;
} {
  const text = chunk.trim();

  // Split by recognized section headers within the chunk
  const subjectOptions: string[] = [];
  let preview = "";
  let intro = "";

  // Find ASSUNTO section
  const assuntoMatch = text.match(
    /ASSUNTO[^\n]*\n([\s\S]*?)(?=\nPREVIEW|\nINTRO|$)/
  );
  if (assuntoMatch) {
    const lines = assuntoMatch[1].trim().split("\n");
    for (const line of lines) {
      const m = line.match(/^\d+\.\s+(.+)$/);
      if (m) subjectOptions.push(m[1].trim());
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
function wrapEmail(subject: string, bodyParts: string[]): string {
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

/** Converts draft.md content + optional chosen subject to { subject, previewText, html }. */
function draftToEmail(
  draft: string,
  chosenSubject: string | null,
  yymm: string,
  eiaImageUrlA?: string,
  eiaImageUrlB?: string,
): { subject: string; previewText: string; html: string } {
  const text = draft.replace(/\r\n/g, "\n");
  const rawSections = text.split(/\n---\n/);

  let subject = chosenSubject ?? "";
  let previewText = "";
  const bodyParts: string[] = [];

  for (let idx = 0; idx < rawSections.length; idx++) {
    const chunk = rawSections[idx].trim();
    if (!chunk) continue;

    const firstLine = chunk.split("\n")[0].trim();

    if (idx === 0 && (firstLine.startsWith("ASSUNTO") || firstLine === "PREVIEW" || firstLine === "INTRO")) {
      // Header chunk: ASSUNTO + PREVIEW + INTRO combined
      const { subjectOptions, preview, intro } = parseHeaderChunk(chunk);
      if (!subject && subjectOptions.length > 0) subject = subjectOptions[0];
      previewText = preview;
      if (intro) bodyParts.push(renderParagraphs(intro));
      continue;
    }

    if (firstLine.match(/^DESTAQUE \d+ \|/)) {
      bodyParts.push(renderDestaque(chunk));
      continue;
    }

    if (firstLine.startsWith("CLARICE —")) {
      bodyParts.push(renderClarice(chunk));
      continue;
    }

    if (firstLine === "OUTRAS NOTÍCIAS DO MÊS") {
      bodyParts.push(renderOutrasNoticias(chunk));
      continue;
    }

    if (firstLine === "É IA?") {
      bodyParts.push(renderEia(chunk, yymm, eiaImageUrlA, eiaImageUrlB));
      continue;
    }

    if (firstLine === "ENCERRAMENTO") {
      const content = chunk.split("\n").slice(1).join("\n").trim();
      if (content) bodyParts.push(renderParagraphs(content));
      continue;
    }

    // Fallback: render as plain paragraphs
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
 * Faz upload de uma imagem para o KV do Worker de poll via Cloudflare API.
 * Retorna a URL pública servida pelo Worker em /img/{key}.
 *
 * O Brevo não expõe endpoint de upload via API REST — usamos o KV do Worker
 * como CDN de imagens para o digest mensal.
 */
async function uploadImageToWorkerKV(filePath: string): Promise<string> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_WORKERS_TOKEN;
  const kvNamespaceId = "72784da4ae39444481eb422ebac357c6"; // namespace POLL do Worker
  const workerUrl = process.env.POLL_WORKER_URL ?? "https://diar-ia-poll.diaria.workers.dev";

  if (!accountId || !token) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_WORKERS_TOKEN não definidos no .env");
  }

  const buf = readFileSync(filePath);
  const filename = filePath.split(/[\\/]/).pop() ?? "image.jpg";
  // Chave única por edição + filename para não colidir entre meses
  const key = `img-monthly-${filename}`;

  // Usar https nativo para evitar problemas com chunked encoding do fetch global
  await new Promise<void>((resolve, reject) => {
    const req = https.request({
      hostname: "api.cloudflare.com",
      path: `/client/v4/accounts/${accountId}/storage/kv/namespaces/${kvNamespaceId}/values/${encodeURIComponent(key)}`,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": buf.length,
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => body += chunk.toString());
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`KV upload ${filename} falhou (${res.statusCode}): ${body}`));
        }
      });
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });

  return `${workerUrl}/img/${encodeURIComponent(key)}`;
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

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { yymm, sendTest, dryRun } = parseArgs();

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

  if (!dryRun) {
    if (brevo.list_id === null) {
      process.stderr.write(
        "ERRO: brevo_monthly.list_id é null.\n" +
        "Configure a lista de contatos no painel Brevo e preencha list_id em platform.config.json (#653).\n"
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

  // Load draft
  const monthlyDir = resolve(ROOT, `data/monthly/${yymm}`);
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

  // Upload É IA? images to Brevo file manager (needed to host images in email)
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
          eiaImageUrlA = await uploadImageToWorkerKV(pathA);
          eiaImageUrlB = await uploadImageToWorkerKV(pathB);
          process.stdout.write(`Imagens enviadas:\n  A: ${eiaImageUrlA}\n  B: ${eiaImageUrlB}\n`);
        } catch (e) {
          process.stderr.write(`warn: upload de imagens É IA? falhou — ${(e as Error).message}\n`);
        }
        break;
      }
    }
    if (!eiaImageUrlA) process.stderr.write("warn: imagens É IA? não encontradas — seção sem imagens\n");
  }

  // Convert draft to email
  const { subject, previewText, html } = draftToEmail(draft, chosenSubject, yymm, eiaImageUrlA, eiaImageUrlB);

  if (!subject) {
    process.stderr.write(
      "Não foi possível extrair subject do draft.\n" +
      "Verifique a seção ASSUNTO em draft.md ou crie _internal/02-chosen-subject.txt.\n"
    );
    process.exit(1);
  }

  const campaignName = `Diar.ia Mensal ${yymm} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

  if (dryRun) {
    process.stdout.write(
      `[DRY RUN] Campanha que seria criada:\n` +
      `  Nome:     ${campaignName}\n` +
      `  Assunto:  ${subject}\n` +
      `  Preview:  ${previewText}\n` +
      `  List ID:  ${brevo.list_id}\n` +
      `  Remetente: ${brevo.sender_name} <${brevo.sender_email}>\n` +
      `  HTML (primeiros 600 chars):\n${html.slice(0, 600)}\n...\n`
    );
    return;
  }

  // Create campaign
  const campaignResp = await brevoPost(apiKey, "/emailCampaigns", {
    name: campaignName,
    subject,
    previewText,
    sender: {
      name: brevo.sender_name,
      email: brevo.sender_email,
    },
    recipients: { listIds: [brevo.list_id] },
    htmlContent: html,
  }) as Record<string, unknown>;

  if (typeof campaignResp.id !== "number") {
    throw new Error(
      `Brevo API retornou resposta inesperada (sem campo 'id'): ${JSON.stringify(campaignResp)}`
    );
  }
  const campaignId = campaignResp.id;
  const dashboardUrl = `https://app.brevo.com/campaign/email/${campaignId}/edit`;

  process.stdout.write(
    `Campanha criada: id=${campaignId}\n` +
    `Dashboard: ${dashboardUrl}\n`
  );

  const published: MonthlyPublished = {
    campaign_id: campaignId,
    campaign_name: campaignName,
    subject,
    preview_text: previewText,
    status: "draft",
    brevo_dashboard_url: dashboardUrl,
    created_at: new Date().toISOString(),
  };

  // Send test email
  if (sendTest) {
    await brevoPost(apiKey, `/emailCampaigns/${campaignId}/sendTest`, {
      emailTo: [brevo.test_email],
    });

    published.status = "test_sent";
    published.test_email = brevo.test_email;
    published.test_sent_at = new Date().toISOString();

    process.stdout.write(
      `Email de teste enviado para: ${brevo.test_email}\n`
    );
  }

  // Save output
  const internalDir = resolve(monthlyDir, "_internal");
  if (!existsSync(internalDir)) mkdirSync(internalDir, { recursive: true });

  const outputPath = resolve(internalDir, "05-published.json");
  writeFileSync(outputPath, JSON.stringify(published, null, 2) + "\n");

  process.stdout.write(`Output salvo: ${outputPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
