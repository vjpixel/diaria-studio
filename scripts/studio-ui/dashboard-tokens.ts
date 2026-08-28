/**
 * dashboard-tokens.ts (#6445)
 *
 * Painel "Uso de tokens" do Studio — decisão do editor (28/08/2026, comentário
 * na issue #6445): "Sim — painel no Studio. Não só relatório de terminal."
 *
 * Reusa 100% da agregação já existente e MERGEADA (`scripts/aggregate-session-tokens.ts`,
 * PR #6476) — este arquivo não recalcula nada, só chama
 * `buildSessionTokensSummary`/`formatSessionTokensSummary` e serve o
 * resultado como HTML, igual ao que `resolveReportHtml` já faz para
 * relatórios `.md` registrados em `/relatorios` (mesmo wrap de estilo,
 * `renderMarkdownToHtml` de `studio-reports.ts` — zero fork de template).
 *
 * **Por que rota LIVE (`GET /painel/tokens`) em vez de relatório
 * pré-gerado+registrado em `data/reports/index.jsonl`:** as outras 3 fontes
 * que este painel consolida (`_internal/stage-status.json` por edição,
 * `data/run-log.jsonl`) já estão em disco e são baratas de ler a cada
 * request — não há I/O externo (Beehiiv/Brevo/API paga) a evitar, ao
 * contrário de `dashboard-clarice.ts` (que por isso tem um modo cacheado
 * "KV-only" + `?fresh=1`). Uma rota live evita depender de uma task agendada
 * rodando o `--register` do CLI pra manter o painel atualizado — sempre
 * fresco, sem lag, sem infra de cron adicional. Mesmo padrão de
 * `dashboard-diaria.ts`/`dashboard-clarice.ts` (`/painel/*` = documento
 * autocontido calculado on-demand a partir de `data/`).
 *
 * Janela default: últimos 14 dias (`defaultSinceAammdd`, #6445 item 2 —
 * "tabela por dia + por kind, últimos 14 dias"). `?since=AAMMDD` e
 * `?until=AAMMDD` na query string sobrepõem o default, mesma convenção de
 * `?fresh=1` em `dashboard-clarice.ts` (parâmetro de URL, sem UI dedicada
 * nesta 1ª fatia — o editor pode navegar direto pra
 * `/painel/tokens?since=260801` se quiser outra janela).
 *
 * O alarme (#6445 item 3 — "se um kind passar de X% do total do dia") já
 * vem embutido no markdown formatado por `formatSessionTokensSummary` (seção
 * "Alarmes") — puramente informativo, nunca bloqueia nada, igual ao resto
 * do mecanismo em `aggregate-session-tokens.ts`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSessionTokensSummary,
  formatSessionTokensSummary,
  defaultSinceAammdd,
} from "../aggregate-session-tokens.ts";
import { renderMarkdownToHtml } from "./studio-reports.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_ALARM_PCT = 50;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface TokensDashboardOptions {
  rootDir?: string;
  since?: string;
  until?: string;
  alarmPct?: number;
}

/**
 * Pura (dado `now` fixo): monta o HTML completo do painel. Separada de
 * `handlePainelTokens` pra ser testável sem `http.ServerResponse` — mesmo
 * padrão de `buildClariceDashboardHtml`/`buildDiariaDashboardHtml`.
 */
export function buildTokensDashboardHtml(opts: TokensDashboardOptions = {}, now: Date = new Date()): string {
  const rootDir = opts.rootDir ?? ROOT;
  const since = opts.since ?? defaultSinceAammdd(now, DEFAULT_WINDOW_DAYS);
  const summary = buildSessionTokensSummary(
    { rootDir, since, until: opts.until, alarmPct: opts.alarmPct ?? DEFAULT_ALARM_PCT },
    now,
  );
  const md = formatSessionTokensSummary(summary);
  const title = "Uso de tokens — sessões diar.ia.br";

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 24px; color: #222; line-height: 1.6; }
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
.window-form { margin: 8px 0 20px; font-size: 13px; color: #555; }
.window-form input { font-family: inherit; padding: 2px 6px; border: 1px solid #ccc; border-radius: 3px; width: 90px; }
.window-form button { padding: 3px 10px; border: 1px solid #2563eb; background: #2563eb; color: #fff; border-radius: 3px; cursor: pointer; }
</style>
</head>
<body>
<h1>${escHtml(title)}</h1>
<form class="window-form" method="get" action="/painel/tokens">
  Desde <input type="text" name="since" placeholder="AAMMDD" value="${escHtml(opts.since ?? since)}">
  até <input type="text" name="until" placeholder="AAMMDD" value="${escHtml(opts.until ?? "")}">
  <button type="submit">Atualizar janela</button>
  — default: últimos ${DEFAULT_WINDOW_DAYS} dias.
</form>
${renderMarkdownToHtml(md)}
</body>
</html>`;
}

function firstQueryValue(url: URL, key: string): string | undefined {
  const v = url.searchParams.get(key);
  return v && v.trim() ? v.trim() : undefined;
}

/** `GET /painel/tokens[?since=AAMMDD&until=AAMMDD]` — ver docstring do módulo. */
export function handlePainelTokens(req: IncomingMessage, res: ServerResponse): void {
  let since: string | undefined;
  let until: string | undefined;
  try {
    const url = new URL(req.url ?? "/painel/tokens", "http://localhost");
    since = firstQueryValue(url, "since");
    until = firstQueryValue(url, "until");
  } catch {
    // URL malformada — ignora query string, cai no default (fail-soft, mesmo
    // padrão de dashboard-clarice.ts pra `?fresh=1`).
  }
  // #6445 self-review: fail-soft — `buildSessionTokensSummary` lê arquivos
  // locais (`run-log.jsonl`, `_internal/stage-status.json` por edição) sem
  // travar exceção de I/O; qualquer falha inesperada (permissão, JSON
  // corrompido não coberto pelo parse defensivo interno) vira 500 com a
  // mensagem escapada, nunca derruba o processo do studio-server — mesmo
  // padrão de `handlePainelDiaria`/`handlePainelClarice` em server.ts.
  try {
    const html = buildTokensDashboardHtml({ since, until });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e) {
    const msg = escHtml(e instanceof Error ? e.message : String(e));
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body><h1>Painel de tokens — erro</h1><p>${msg}</p></body></html>`);
  }
}
