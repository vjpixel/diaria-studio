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
  contentType: string;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
 * `report.md`) vira um wrap HTML mínimo (escape + `<pre>`), sem dependência
 * de lib de markdown — fidelidade menor que renderizar markdown de verdade,
 * mas suficiente pra leitura no celular/desktop sem investir num parser novo
 * nesta fatia.
 */
export function resolveReportHtml(rootDir: string, entry: ReportEntry): ReportRenderResult {
  const rootAbs = resolve(rootDir);
  const abs = resolve(rootDir, entry.htmlPath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    return { ok: false, html: `<!doctype html><p>path inválido</p>`, contentType: "text/html; charset=utf-8" };
  }
  if (!existsSync(abs)) {
    return {
      ok: false,
      html: `<!doctype html><p>arquivo do relatório não encontrado: ${escHtml(entry.htmlPath)}</p>`,
      contentType: "text/html; charset=utf-8",
    };
  }

  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (e) {
    return {
      ok: false,
      html: `<!doctype html><p>falha ao ler o relatório: ${escHtml((e as Error).message)}</p>`,
      contentType: "text/html; charset=utf-8",
    };
  }

  if (abs.toLowerCase().endsWith(".html")) {
    return { ok: true, html: raw, contentType: "text/html; charset=utf-8" };
  }

  const wrapped = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${escHtml(entry.title)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 24px; color: #222; }
pre { white-space: pre-wrap; word-wrap: break-word; font-family: inherit; line-height: 1.6; }
h1 { font-size: 18px; border-bottom: 2px solid #2563eb; padding-bottom: 8px; }
</style>
</head>
<body>
<h1>${escHtml(entry.title)}</h1>
<pre>${escHtml(raw)}</pre>
</body>
</html>`;
  return { ok: true, html: wrapped, contentType: "text/html; charset=utf-8" };
}
