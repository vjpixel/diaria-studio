/**
 * register-report.ts (#3714)
 *
 * CLI fina sobre `scripts/studio-ui/studio-reports.ts::registerReport` — o
 * ponto de chamada dos fechos de pipeline que rodam como PROMPT de agente
 * (não código): `/diaria-overnight` e `/diaria-develop` narram o fecho da
 * sessão em markdown (`.claude/skills/{skill}/SKILL.md`), então precisam de um
 * comando de shell pra registrar o relatório — diferente de
 * `send-edition-report.ts`, que já é TS e chama `registerReport` direto.
 *
 * **Decisão do editor (#3714, 2026-07-20): substituir** o draft de e-mail
 * pelo link na UI do Studio — não somar aos dois. Este comando é o que
 * ocupa o lugar do antigo `mcp__claude_ai_Gmail__create_draft` nos fechos de
 * overnight/develop.
 *
 * Fail-soft por design: registrar é só uma escrita local em
 * `data/reports/index.jsonl` (via `registerReport`) — nunca uma chamada de
 * rede, nunca depende do `npm run studio` estar no ar. Qualquer falha
 * imprime um warning em stderr e sai 0 (nunca aborta o fecho da sessão
 * chamadora).
 *
 * Uso:
 *   npx tsx scripts/register-report.ts --kind overnight --id 260720 \
 *     --title "Diar.ia overnight 260720 — 5 resolvidas, 2 puladas" \
 *     --html-path data/overnight/260720/report.md
 *
 * Imprime em stdout a URL do Studio (`http://127.0.0.1:{porta}/relatorios/{id}`)
 * — porta default 4174 (mesma de `scripts/studio-ui/server.ts`), overridável
 * via `STUDIO_PORT` (mesma env var que o server já lê em `main()`), pra o
 * link impresso no terminal ser correto mesmo com o Studio numa porta
 * não-default.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { registerReport, isReportKind } from "./studio-ui/studio-reports.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STUDIO_PORT = "4174";

async function main(): Promise<void> {
  const { values } = parseArgs(process.argv.slice(2));
  const kind = values["kind"];
  const id = values["id"];
  const title = values["title"];
  const htmlPath = values["html-path"];

  if (!kind || !isReportKind(kind) || !id || !title || !htmlPath) {
    console.error(
      "Uso: register-report.ts --kind {edicao|overnight|develop|mensal} --id <sessionId> --title <title> --html-path <path relativo ao repo>",
    );
    process.exit(2);
  }

  const result = registerReport(ROOT, { kind, sessionId: id, title, htmlPath });
  if (!result.ok || !result.entry) {
    // Fail-soft (#3714): registro é observabilidade extra, nunca crítico —
    // exit 0 pra nunca travar o fecho de sessão que chamou este comando.
    process.stderr.write(
      `[register-report] falha ao registrar (fail-soft, não bloqueia o pipeline): ${result.error}\n`,
    );
    process.exit(0);
    return;
  }

  const port = process.env.STUDIO_PORT ?? DEFAULT_STUDIO_PORT;
  const url = `http://127.0.0.1:${port}${result.entry.url}`;
  process.stderr.write(`[register-report] registrado: ${result.entry.id} -> ${result.entry.htmlPath}\n`);
  process.stdout.write(`${url}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[register-report] erro inesperado (fail-soft, seguindo): ${(e as Error).message}`);
    process.exit(0);
  });
}
