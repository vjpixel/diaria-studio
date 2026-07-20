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
import { randomUUID } from "node:crypto";
import { escHtml } from "../lib/html-escape.ts";

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

/** Só linkifica esquemas conhecidos-seguros — nunca `javascript:`/`data:` etc.
 * (defesa extra: o conteúdo vem de output de agente, não de input confiável).
 * `/` sozinho é aceito (path relativo interno, ex: `/relatorios/outro-id`),
 * mas `//` (URL protocol-relative — resolve pro esquema da página atual,
 * `https:` em produção) é explicitamente rejeitado (#3788 Bug 2): sem essa
 * negative lookahead, `//evil.example/phish` casava no ramo `\/` sozinho e
 * virava um link clicável de phishing que escapou do allowlist. Bloqueia
 * também `/\` (barra seguida de contrabarra, ex: `/\evil.example/phish`) —
 * browsers normalizam `\` pra `/` na posição de authority delimiter, então
 * essa variante é o MESMO bypass do Bug 2 com um caractere diferente
 * (achado no self-review desta PR, nunca reportado na issue original). */
function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:|#|\/(?![/\\]))/i.test(url);
}

/** Aplica bold/itálico/código (nunca link) — usado tanto no texto fora de
 * links quanto no LABEL de um link (nunca na URL, ver `renderInline`).
 *
 * **Código roda PRIMEIRO, via extração por placeholder (#3797).** Antes,
 * código rodava por último, assumindo que os regexes de itálico (que exigem
 * delimitador não seguido/precedido de espaço) nunca casariam dentro de um
 * code-span já formado. Isso não cobre o caso em que o delimitador de ênfase
 * É o próprio conteúdo do code-span — bold ou itálico entre crases — onde
 * bold/itálico rodando antes do código corrompem a sintaxe literal que o
 * autor queria mostrar crua (ex: comentário/PR que documenta a sintaxe deste
 * próprio renderer). Agora cada code-span é extraído primeiro pro array
 * `codeSpans`, substituído por um token opaco (prefixo/sufixo `@@mdcode:...@@`
 * com um componente ALEATÓRIO por chamada — `session`, via `randomUUID()` —
 * pra nunca colidir com texto real do documento, mesma disciplina
 * anti-colisão usada pelo placeholder de link em `renderInline`) e só
 * restaurado depois que bold/itálico já rodaram sobre o resto da string — o
 * conteúdo do code-span nunca é reprocessado.
 *
 * **Ordem bold → itálico (#3790), depois restauração do código.** bold
 * (`**x**`) roda primeiro e consome TODOS os pares de asterisco duplo, então
 * quando o passe de itálico roda depois não sobra `**` pra confundir com
 * `*x*` (evita que `**negrito**` vire itálico-de-asterisco-solto por
 * acidente). Os regexes de itálico exigem fronteira de palavra (`\w`) nas
 * bordas — isso é o que protege identificadores `snake_case` e o marcador de
 * lista `- item`/`* item` (que já foi consumido pela regex de item de lista
 * ANTES desta função ser chamada — o `*`/`-` inicial nunca chega aqui) de
 * virarem itálico por engano. */
function applyInlineMarks(s: string): string {
  const session = randomUUID().replace(/-/g, "");
  const codeSpans: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => {
    const token = `@@mdcode:${session}:${codeSpans.length}@@`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, "<em>$1</em>");
  codeSpans.forEach((code, i) => {
    s = s.split(`@@mdcode:${session}:${i}@@`).join(code);
  });
  return s;
}

/** Aplica as transformações inline markdown→HTML (bold, itálico, código,
 * link) a um trecho de texto que já passou por `escHtml` — nunca chamar em
 * texto cru.
 *
 * **Ordem deliberada (#3788 Bug 3):** link é processado PRIMEIRO — extrai
 * label+url, aplica bold/código só ao LABEL (nunca à URL) e protege a tag
 * `<a>` já montada com um placeholder opaco (sem `*`/crase) antes dos passes
 * de bold/código rodarem sobre o resto do texto. Sem isso, uma URL contendo
 * `**` ou crase seria re-escaneada pelos passes seguintes e o `href` sairia
 * corrompido (`href="https://evil.com/<strong>pwn</strong>"`) — a versão
 * anterior processava link→bold→code em sequência sobre a MESMA string
 * mutável, deixando o href exposto a esse re-scan.
 *
 * **Restauração do placeholder é posicionalmente segura via token aleatório
 * por chamada (#3797 Bug 2).** Antes, o token era `__mdlink_N__` — um padrão
 * PREVISÍVEL — e a restauração usava `split/join` (substitui TODA ocorrência
 * da substring, não só a posição onde o placeholder foi de fato inserido).
 * Se o LABEL de um link contivesse literalmente o texto de um token que
 * ainda ia ser criado por um link processado depois na mesma linha (ex:
 * `[__mdlink_1__](url-boa)` seguido de um 2º link que gera exatamente o
 * token `__mdlink_1__`), a passada de restauração do 2º link casava também
 * essa ocorrência "acidental" dentro do label do 1º — produzindo `<a>`
 * aninhado (HTML inválido) e uma repetição indevida do 2º link. Agora o
 * token inclui um componente aleatório (`session`, via `randomUUID()`)
 * gerado UMA vez por chamada de `renderInline` — nenhum texto de usuário
 * (que só chega até aqui depois de `escHtml`, então nunca contém o padrão
 * `@@mdlink:...@@` cru gerado nesta invocação específica) pode colidir com
 * ele, então o `split/join` continua simples mas agora é seguro: garantido
 * que a única ocorrência da string é a que foi inserida por este código. */
function renderInline(escapedText: string): string {
  const session = randomUUID().replace(/-/g, "");
  const placeholders: string[] = [];
  let s = escapedText.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    if (!isSafeUrl(url)) return applyInlineMarks(label);
    const anchor = `<a href="${url}" target="_blank" rel="noopener noreferrer">${applyInlineMarks(label)}</a>`;
    const token = `@@mdlink:${session}:${placeholders.length}@@`;
    placeholders.push(anchor);
    return token;
  });
  s = applyInlineMarks(s);
  placeholders.forEach((anchor, i) => {
    s = s.split(`@@mdlink:${session}:${i}@@`).join(anchor);
  });
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
 * headings `#`/`##`/`###`, `**bold**`, `*itálico*`/`_itálico_` (#3790), `---`
 * como `<hr>`, parágrafos, listas `- item` e `1. item` (#3790), code fences
 * ` ``` ` (#3790, preservado literal em `<pre><code>`, sem syntax highlight)
 * e tabelas markdown (`| col | col |` + linha separadora `|---|---|`, só na
 * posição imediatamente após o header — #3789). Não é um parser CommonMark
 * completo (sem blockquotes, listas aninhadas, etc.) — suficiente pra leitura
 * no Studio sem investir num parser novo nesta fatia.
 *
 * **Ordem de segurança:** escapa o texto CRU inteiro primeiro (`escHtml`), só
 * depois aplica as transformações markdown em cima do texto já escapado —
 * HTML embutido no markdown (ex: um agente reportando `<script>` em texto
 * livre) nunca vira tag real, só entidade visível. Isso inclui o conteúdo de
 * code fences: como o `escHtml` já rodou sobre o texto inteiro ANTES do split
 * por linha, o conteúdo dentro de ` ``` ` já está seguro sem precisar de
 * processamento adicional (e sem re-rodar markdown inline dentro do bloco —
 * code é sempre literal).
 */
export function renderMarkdownToHtml(raw: string): string {
  const lines = escHtml(raw).split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let ulOpen = false;
  let olOpen = false;
  let tableRows: string[][] | null = null;
  let codeFenceOpen = false;
  let codeFenceLines: string[] = [];
  // #3796: comprimento (nº de backticks) da fence de ABERTURA — CommonMark
  // exige que o fechamento tenha comprimento >= abertura, senão uma fence de
  // 4 backticks fecharia numa linha interna de só 3 (conteúdo que devia ficar
  // literal dentro do bloco escaparia e seria reprocessado como markdown).
  let codeFenceMarkerLen = 0;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.join(" ")}</p>`);
      paragraph = [];
    }
  };
  const closeUl = () => {
    if (ulOpen) {
      out.push("</ul>");
      ulOpen = false;
    }
  };
  const closeOl = () => {
    if (olOpen) {
      out.push("</ol>");
      olOpen = false;
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
    closeUl();
    closeOl();
    closeTable();
  };
  const flushCodeFence = () => {
    out.push(`<pre><code>${codeFenceLines.join("\n")}</code></pre>`);
    codeFenceLines = [];
    codeFenceOpen = false;
    codeFenceMarkerLen = 0;
  };

  for (const rawLine of lines) {
    // Code fence é tratado ANTES de qualquer outra detecção de sintaxe —
    // enquanto aberto, TODA linha (inclusive vazia, `---`, `| tabela |`) é
    // conteúdo literal do bloco, nunca reinterpretada como markdown (#3790).
    if (codeFenceOpen) {
      // #3796: só fecha se o comprimento da fence de fechamento for >= o da
      // abertura (CommonMark) — uma fence de 4 backticks não fecha numa
      // linha interna de 3 (ex: bloco que documenta code fences de 3
      // backticks dentro de um bloco de 4).
      const closeMatch = rawLine.trim().match(/^(`{3,})\s*$/);
      if (closeMatch && closeMatch[1].length >= codeFenceMarkerLen) {
        flushCodeFence();
      } else {
        codeFenceLines.push(rawLine);
      }
      continue;
    }

    const line = rawLine.trim();

    const fenceOpen = line.match(/^(`{3,})/);
    if (fenceOpen) {
      // Abre o fence — a info string opcional (ex: ```ts) é descartada, sem
      // syntax highlight (#3790). Guarda o comprimento (#3796) pra comparar
      // no fechamento.
      closeBlocks();
      codeFenceOpen = true;
      codeFenceLines = [];
      codeFenceMarkerLen = fenceOpen[1].length;
      continue;
    }
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
      closeUl();
      closeOl();
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      const isSeparatorRow = cells.every((c) => /^:?-+:?$/.test(c));
      // #3789: só a linha imediatamente seguinte ao header (posição — quando
      // `tableRows` tem exatamente 1 linha, o header, e nada mais) pode ser
      // tratada como separador `|---|---|`. Uma linha dash-like em qualquer
      // OUTRA posição do bloco é dado real (ex: placeholder de "N/A"),
      // preservada como row — nunca descartada silenciosamente.
      if (isSeparatorRow && tableRows && tableRows.length === 1) {
        continue;
      }
      if (!tableRows) tableRows = [];
      tableRows.push(cells);
      continue;
    }
    closeTable();

    const listItem = line.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      closeOl();
      if (!ulOpen) {
        out.push("<ul>");
        ulOpen = true;
      }
      out.push(`<li>${renderInline(listItem[1])}</li>`);
      continue;
    }
    closeUl();

    const orderedItem = line.match(/^\d+\.\s+(.+)$/);
    if (orderedItem) {
      flushParagraph();
      if (!olOpen) {
        out.push("<ol>");
        olOpen = true;
      }
      out.push(`<li>${renderInline(orderedItem[1])}</li>`);
      continue;
    }
    closeOl();

    paragraph.push(renderInline(line));
  }
  closeBlocks();
  // Fence nunca fechado até o fim do texto (markdown malformado) — flush
  // gracioso do que foi coletado em vez de perder o conteúdo (#3790).
  // #3796: dispara mesmo com ZERO linhas de conteúdo coletadas (fence abre e
  // o input acaba ali) — antes o guard `&& codeFenceLines.length` descartava
  // esse caso em silêncio, sumindo com o marcador de abertura sem rastro
  // nenhum. Agora emite `<pre><code></code></pre>` vazio, preservando o fato
  // de que um fence foi aberto.
  if (codeFenceOpen) {
    flushCodeFence();
  }

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
 *
 * **`<pre>`/`<code>`/`<ol>` no CSS inline (#3798).** `renderMarkdownToHtml`
 * gera `<pre><code>` (code fences) e `<ol>` (listas numeradas) a partir de
 * `report.md`, mas o bloco `<style>` original só cobria `<code>` inline,
 * `<ul>` e headings — sem `overflow-x`/`white-space` em `<pre>`, uma linha
 * longa de code fence (comum: comando `npx tsx ... --flag` no relatório)
 * estoura a largura da página no Studio mobile (#3560), já que browsers não
 * quebram linha em `<pre>` por padrão.
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
pre { overflow-x: auto; white-space: pre-wrap; word-break: break-word; background: #f8f8f8; padding: 12px; border-radius: 4px; }
pre code { background: none; padding: 0; }
ul, ol { padding-left: 20px; }
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
