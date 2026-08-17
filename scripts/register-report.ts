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
 * **Exceção desde #5521:** divergência entre as contagens do `--title` e a
 * tabela de unidades do relatório sai `exit 1` sem registrar nada — ver
 * `assertTitleMatchesReport`. É a única exceção no fluxo de REGISTRO (a
 * validação de argumentos de uso já saía `exit 2` antes disto).
 *
 * Uso:
 *   npx tsx scripts/register-report.ts --kind overnight --id 260720 \
 *     --title "diar.ia.br overnight 260720 — 5 unidades, 7 issues, 2 puladas" \
 *     --html-path data/overnight/260720/report.md
 *
 * `--no-email` registra sem notificar — use em reexecução/auditoria/teste, que
 * senão manda e-mail real pro editor a cada invocação (#5521).
 *
 * Imprime em stdout a URL do Studio (`http://127.0.0.1:{porta}/relatorios/{id}`)
 * — porta default 4174 (mesma de `scripts/studio-ui/server.ts`), overridável
 * via `STUDIO_PORT` (mesma env var que o server já lê em `main()`), pra o
 * link impresso no terminal ser correto mesmo com o Studio numa porta
 * não-default.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { registerReport, isReportKind } from "./studio-ui/studio-reports.ts";
import { compareTitleWithReport, UNITS_TABLE_MARKER } from "./lib/overnight-report-counts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STUDIO_PORT = "4174";

/**
 * Kinds cujo relatório traz a tabela "Unidades mergeadas" e, portanto, permitem
 * conferir as contagens do título (#5521). Os demais kinds (`edicao`, `mensal`,
 * `clarice-*`, `cac`) têm outro formato e não passam por esta checagem.
 */
const COUNT_CHECKED_KINDS = new Set(["overnight", "develop"]);

/**
 * Confere o título contra o próprio relatório antes de registrar (#5521).
 *
 * O título vira o assunto do e-mail que o editor recebe — na rodada 260816e ele
 * anunciou "10 unidades, 13 issues fechadas" para um relatório cuja tabela
 * mostrava 13 unidades e 17 issues. Ninguém percebeu porque nada comparava as
 * duas coisas.
 *
 * BLOQUEANTE de propósito (`exit 1`), ao contrário do resto do fluxo de
 * registro, que é fail-soft (a validação de argumentos de uso já era `exit 2`):
 * um relatório registrado com número errado já cumpriu o estrago no instante
 * em que o assunto sai, e não há como desfazer depois. Falhar aqui
 * custa ao coordenador reescrever uma linha; deixar passar custa a confiança do
 * editor em todo assunto seguinte. Divergência é sempre erro de quem escreveu o
 * título — a tabela vem do fecho já conferido contra o git.
 *
 * Passa sem reprovar quando genuinamente não há o que conferir: kind fora de
 * `COUNT_CHECKED_KINDS`, ou relatório sem tabela de unidades (formato antigo —
 * a checagem existe pra pegar contradição, não pra impor formato novo a
 * relatório antigo). Relatório ausente/ilegível também passa, mas com AVISO em
 * stderr: ali a conferência deixou de rodar por um motivo que pode ser erro do
 * coordenador, e silêncio faria parecer que rodou e aprovou.
 */
function assertTitleMatchesReport(kind: string, title: string, htmlPath: string): void {
  const warnUnchecked = (motivo: string): void => {
    process.stderr.write(
      `[register-report] AVISO: título NÃO conferido — ${htmlPath} ${motivo} (#5521).\n`,
    );
  };

  if (!COUNT_CHECKED_KINDS.has(kind)) return;
  if (!htmlPath.endsWith(".md")) {
    warnUnchecked("não é .md — a conferência só sabe ler relatório em markdown");
    return;
  }

  // Relatório ausente/ilegível é justamente a entrada mais correlacionada com
  // erro do coordenador (AAMMDD errado no `--html-path`) — e `registerReport`
  // registra assim mesmo, com link morto e título não conferido. Não dá pra
  // BLOQUEAR (o registro é fail-soft por desenho e o relatório pode
  // legitimamente ainda não estar em disco), mas sumir em silêncio faria
  // parecer que a conferência rodou e aprovou.
  const abs = resolve(ROOT, htmlPath);
  if (!existsSync(abs)) {
    warnUnchecked("não existe");
    return;
  }

  let markdown: string;
  try {
    markdown = readFileSync(abs, "utf-8");
  } catch {
    warnUnchecked("ilegível");
    return;
  }

  const check = compareTitleWithReport(title, markdown);
  if (check.kind === "skipped") {
    // Marcador ausente: o guard não rodou. Avisar ALTO em vez de sumir — um
    // guard dormente que parece ativo é pior do que guard nenhum, e essa é a
    // única forma de o coordenador perceber que esqueceu o marcador.
    warnUnchecked(`não traz o marcador ${UNITS_TABLE_MARKER} antes da tabela de unidades`);
    return;
  }
  if (check.problems.length === 0) return;

  const detail =
    check.kind === "checked"
      ? `  Sufixo correto pela tabela: "${check.suggestion}"\n  Nota: ${check.issuesNote}\n`
      : "";

  process.stderr.write(
    `[register-report] título não bate com ${htmlPath} (#5521):\n` +
      check.problems.map((p) => `  - ${p}\n`).join("") +
      detail +
      `  Corrija o --title e rode de novo (nada foi registrado, nenhum e-mail saiu).\n`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs(process.argv.slice(2));
  const kind = values["kind"];
  const id = values["id"];
  const title = values["title"];
  const htmlPath = values["html-path"];
  // #5521: sem isto, QUALQUER reexecução (auditoria, retry, teste) manda
  // e-mail pro editor — foi assim que uma auditoria de 73 relatórios
  // históricos disparou ~50 e-mails de uma vez em 17/08/2026.
  const noEmail = process.argv.includes("--no-email");

  if (!kind || !isReportKind(kind) || !id || !title || !htmlPath) {
    console.error(
      "Uso: register-report.ts --kind {edicao|overnight|develop|mensal} --id <sessionId> --title <title> --html-path <path relativo ao repo> [--no-email]",
    );
    process.exit(2);
  }

  assertTitleMatchesReport(kind, title, htmlPath);

  const result = registerReport(
    ROOT,
    { kind, sessionId: id, title, htmlPath },
    undefined,
    !noEmail,
  );
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
  const dispatch = await result.emailDispatch;
  if (!dispatch.sent && "skipped" in dispatch && dispatch.skipped === "already-notified") {
    process.stderr.write(
      "[register-report] e-mail suprimido: esta rodada já foi notificada — " +
        "o link do e-mail original já aponta pra versão atual (#5521).\n",
    );
  }
  process.stdout.write(`${url}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[register-report] erro inesperado (fail-soft, seguindo): ${(e as Error).message}`);
    process.exit(0);
  });
}
