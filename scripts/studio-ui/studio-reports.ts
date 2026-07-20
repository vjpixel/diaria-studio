/**
 * studio-reports.ts (#3714, fatia da EPIC "Studio UI" #3554)
 *
 * Superfície de "Relatórios" do Studio — decisão do editor (comentário de
 * 2026-07-20 na issue #3714): **substituir** o draft de e-mail dos fechos de
 * pipeline (edição diária, `/diaria-overnight`, `/diaria-develop`) por um
 * link acessível na UI do Studio, não somar aos dois. O acesso remoto do
 * Studio (#3560) já cobre o alcance mobile que o e-mail dava.
 *
 * **Design: registry leve, conteúdo fica onde já estava.** Os HTMLs/markdowns
 * dos relatórios continuam na estrutura per-edição/per-sessão já existente
 * (`data/editions/{AAMMDD}/_internal/edition-report.html`,
 * `data/overnight/{AAMMDD}/report.md`, `data/develop/{AAMMDD}/report.md`) —
 * este arquivo NÃO reinventa onde o conteúdo mora. O único artefato novo é um
 * índice append-only (`data/reports/index.jsonl`, mesma convenção de
 * `data/run-log.jsonl`/`data/sources/{slug}.jsonl`) que aponta pra esses
 * arquivos, porque não existe hoje um jeito barato de descobrir "todos os
 * relatórios de todas as sessões" sem esse índice (teria que varrer
 * `data/editions/*`, `data/overnight/*`, `data/develop/*` a cada request).
 *
 * **Registro é 100% file-based, nunca uma chamada HTTP ao Studio** — o
 * servidor pode estar parado no momento em que um relatório é gerado (é um
 * dev server local, não sempre no ar); `registerReport` só escreve no disco,
 * então o Studio descobre o relatório na próxima vez que `listReports` rodar
 * (próximo load de `/relatorios` ou próximo request de `/api/reports`),
 * nunca bloqueia nem falha o produtor do relatório por o servidor estar
 * offline.
 *
 * `registerReport`/`listReports`/`getReportById`/`resolveReportHtml` são
 * puras o suficiente pra testar sem subir o servidor HTTP — só I/O de
 * arquivo, injetável via `rootDir` (mesmo padrão de `studio-round.ts`/
 * `studio-issues.ts`).
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export type ReportKind = "edicao" | "overnight" | "develop" | "mensal";

const VALID_KINDS: ReportKind[] = ["edicao", "overnight", "develop", "mensal"];

export function isReportKind(value: string): value is ReportKind {
  return (VALID_KINDS as string[]).includes(value);
}

const REPORTS_DIR = "data/reports";
const REGISTRY_FILE = "index.jsonl";

function registryPath(rootDir: string): string {
  return resolve(rootDir, REPORTS_DIR, REGISTRY_FILE);
}

/** Id estável do relatório — `{kind}-{sessionId}` (ex: `overnight-260720`).
 * Registrar de novo o mesmo `(kind, sessionId)` (relatório regenerado, ex:
 * `edition-report.html` reescrito em 6b-8 depois do 6b-6 descartável) reusa o
 * mesmo id — a leitura (`listReports`) sempre usa a linha mais recente. */
export function reportId(kind: ReportKind, sessionId: string): string {
  return `${kind}-${sessionId}`;
}

export interface ReportRegistryInput {
  kind: ReportKind;
  /** AAMMDD (edição/overnight/develop) ou ciclo (mensal, ex: "2605-06"). */
  sessionId: string;
  title: string;
  /** Path do relatório (HTML ou markdown) já persistido pelo caller,
   * relativo a `rootDir` — NUNCA absoluto (o registry é portável entre
   * máquinas via o junction `data/` do OneDrive). */
  htmlPath: string;
  /** ISO timestamp — default `now()` no momento do registro. */
  createdAt?: string;
}

export interface ReportEntry extends ReportRegistryInput {
  id: string;
  createdAt: string;
  /** Path servido pelo Studio — `GET {url}` (ver `server.ts`). */
  url: string;
}

export interface RegisterReportResult {
  ok: boolean;
  entry: ReportEntry | null;
  error: string | null;
}

/**
 * Registra um relatório — append de 1 linha JSON em `data/reports/index.jsonl`.
 * Nunca reescreve/trunca o arquivo (append-only, mesma convenção de
 * `data/run-log.jsonl`): registrar de novo o mesmo id apenas adiciona uma
 * linha nova que supera a anterior na leitura (`listReports` dedupa por id,
 * última linha vence).
 *
 * **Fail-soft por design (#3714):** qualquer falha de escrita (disco cheio,
 * permissão, `rootDir` inválido) nunca lança — retorna `{ok: false, error}`.
 * O caller (send-edition-report.ts, fechos de overnight/develop) não deve
 * travar o pipeline por causa do registro no Studio; é só observabilidade
 * extra, não um passo crítico.
 */
export function registerReport(rootDir: string, input: ReportRegistryInput): RegisterReportResult {
  const id = reportId(input.kind, input.sessionId);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const entry: ReportEntry = {
    ...input,
    id,
    createdAt,
    url: `/relatorios/${id}`,
  };
  try {
    mkdirSync(resolve(rootDir, REPORTS_DIR), { recursive: true });
    appendFileSync(registryPath(rootDir), JSON.stringify(entry) + "\n", "utf8");
    return { ok: true, entry, error: null };
  } catch (e) {
    return { ok: false, entry: null, error: (e as Error).message };
  }
}

/**
 * Lê o registry inteiro, dedupa por id (última linha física vence — um
 * relatório regenerado "sobrescreve" a entry anterior na leitura sem truncar
 * o arquivo) e ordena por `createdAt` desc (mais recente no topo — #3714
 * pede "mais recentes no topo").
 *
 * Fail-soft: registry ausente → `[]`; linha corrompida é ignorada
 * silenciosamente (nunca derruba a listagem inteira) — mesma convenção de
 * `tailJsonl`/outros leitores de jsonl do repo.
 */
export function listReports(rootDir: string): ReportEntry[] {
  const path = registryPath(rootDir);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const byId = new Map<string, ReportEntry>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Partial<ReportEntry>;
      if (
        entry &&
        typeof entry.id === "string" &&
        typeof entry.kind === "string" &&
        typeof entry.sessionId === "string" &&
        typeof entry.title === "string" &&
        typeof entry.htmlPath === "string" &&
        typeof entry.createdAt === "string" &&
        typeof entry.url === "string"
      ) {
        byId.set(entry.id, entry as ReportEntry);
      }
    } catch {
      // linha corrompida (escrita concorrente truncada, etc.) — ignora.
    }
  }

  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Busca uma entry específica pelo id (`{kind}-{sessionId}`) — `null` se
 * nunca registrada ou registry ausente. */
export function getReportById(rootDir: string, id: string): ReportEntry | null {
  return listReports(rootDir).find((r) => r.id === id) ?? null;
}

export interface ReportRenderResult {
  ok: boolean;
  html: string;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Só linkifica esquemas conhecidos-seguros — nunca `javascript:`/`data:` etc.
 * (defesa extra: o conteúdo vem de output de agente, não de input confiável). */
function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|\/|#|mailto:)/i.test(url);
}

/** Aplica as transformações inline markdown→HTML (bold, código, link) a um
 * trecho de texto que já passou por `escHtml` — nunca chamar em texto cru. */
function renderInline(escapedText: string): string {
  let s = escapedText;
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
    isSafeUrl(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : label,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s;
}

function renderTable(rows: string[][]): string {
  const [header, ...body] = rows;
  const thead = `<thead><tr>${header.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`
    : "";
  return `<table>${thead}${tbody}</table>`;
}

/**
 * Renderer markdown→HTML mínimo, zero-dep (#3784 — decisão do briefing: sem
 * lib `marked`/similar, "zero custo recorrente" também vale pra dependências
 * novas). Cobre o que `data/overnight|develop/{sessão}/report.md` de fato usa:
 * headings `#`/`##`/`###`, `**bold**`, `---` como `<hr>`, parágrafos, listas
 * `- item` e tabelas markdown (`| col | col |` + linha separadora `|---|---|`).
 * Não é um parser CommonMark completo (sem blockquotes, listas aninhadas,
 * numeradas, itálico, etc.) — suficiente pra leitura no Studio sem investir
 * num parser novo nesta fatia.
 *
 * **Ordem de segurança:** escapa o texto CRU inteiro primeiro (`escHtml`), só
 * depois aplica as transformações markdown em cima do texto já escapado —
 * HTML embutido no markdown (ex: um agente reportando `<script>` em texto
 * livre) nunca vira tag real, só entidade visível.
 */
export function renderMarkdownToHtml(raw: string): string {
  const lines = escHtml(raw).split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let listOpen = false;
  let tableRows: string[][] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.join(" ")}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };
  const closeTable = () => {
    if (tableRows && tableRows.length) {
      out.push(renderTable(tableRows));
    }
    tableRows = null;
  };
  const closeBlocks = () => {
    flushParagraph();
    closeList();
    closeTable();
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === "") {
      closeBlocks();
      continue;
    }
    if (/^-{3,}$/.test(line)) {
      closeBlocks();
      out.push("<hr>");
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeBlocks();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    if (line.startsWith("|") && line.endsWith("|")) {
      flushParagraph();
      closeList();
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      const isSeparatorRow = cells.every((c) => /^:?-+:?$/.test(c));
      if (isSeparatorRow && tableRows) {
        continue; // linha `|---|---|` do header — não vira row de dados.
      }
      if (!tableRows) tableRows = [];
      tableRows.push(cells);
      continue;
    }
    closeTable();

    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${renderInline(listItem[1])}</li>`);
      continue;
    }
    closeList();

    paragraph.push(renderInline(line));
  }
  closeBlocks();

  return out.join("\n");
}

/**
 * Resolve o conteúdo servível (HTTP) de uma `ReportEntry`.
 *
 * Guard de path traversal análogo a `resolveStaticPath` (static-serve.ts):
 * `htmlPath` vem de uma entry do registry — escrita pelos próprios scripts do
 * pipeline, mas nunca confiar cegamente num path relativo lido de um arquivo
 * em disco (#3563 mesma disciplina de escapar/validar antes de servir).
 *
 * `.html` é servido cru (edição/mensal já produzem HTML completo). Qualquer
 * outra extensão (`.md` — overnight/develop ainda geram markdown puro,
 * `report.md`) vira um wrap HTML mínimo com o corpo passado por
 * `renderMarkdownToHtml` (#3784) — headings/bold/hr/listas/tabelas viram
 * elementos de verdade em vez de markdown cru dentro de um `<pre>`.
 */
export function resolveReportHtml(rootDir: string, entry: ReportEntry): ReportRenderResult {
  const rootAbs = resolve(rootDir);
  const abs = resolve(rootDir, entry.htmlPath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    return { ok: false, html: `<!doctype html><p>path inválido</p>` };
  }
  if (!existsSync(abs)) {
    return {
      ok: false,
      html: `<!doctype html><p>arquivo do relatório não encontrado: ${escHtml(entry.htmlPath)}</p>`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (e) {
    return {
      ok: false,
      html: `<!doctype html><p>falha ao ler o relatório: ${escHtml((e as Error).message)}</p>`,
    };
  }

  if (abs.toLowerCase().endsWith(".html")) {
    return { ok: true, html: raw };
  }

  const wrapped = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${escHtml(entry.title)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px; color: #222; line-height: 1.6; }
h1 { font-size: 18px; border-bottom: 2px solid #2563eb; padding-bottom: 8px; }
h2 { font-size: 16px; margin-top: 28px; }
h3 { font-size: 14px; margin-top: 20px; }
hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; }
th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; vertical-align: top; }
code { background: #f1f1f1; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
ul { padding-left: 20px; }
a { color: #2563eb; }
</style>
</head>
<body>
<h1>${escHtml(entry.title)}</h1>
${renderMarkdownToHtml(raw)}
</body>
</html>`;
  return { ok: true, html: wrapped };
}
