/**
 * scripts/acervo-staleness-alarm.ts (#7591)
 *
 * Alarma quando o leitor está vendo um acervo mais velho do que o que existe.
 *
 * ## O buraco que ele tapa
 *
 * O #7578 fechou a lacuna POR EDIÇÃO — o invariante `site-page-published` trava
 * o gate 6, e `site-sitemap-no-orphans` acusa página órfã. Os dois só correm
 * quando uma edição roda.
 *
 * O caso real foi outro: **nenhuma edição rodou por dias.** De 27/08 a
 * 07/09/2026 o acervo ficou parado, e o `Diaria-Edicao-Diaria-Staleness-Alarm`
 * (#5563) esteve correto e mudo — ele checa se a edição foi PRODUZIDA, e as de
 * setembro existiam em disco. Ninguém comparava produção com publicação, e o
 * problema só apareceu quando o editor abriu `arquivo.diar.ia.br` por acaso.
 *
 * ## Por que consulta o host AO VIVO
 *
 * `sitemap.xml` do repo pode estar em dia e o leitor ainda ver conteúdo velho:
 * `publish-edition-site-page.ts` abre PR e NUNCA mergeia (#6598), e o deploy só
 * dispara em push a `master`. A comparação local não veria isso. A que mede o
 * leitor é a única que fecha a cadeia inteira.
 *
 * Uso:
 *   npx tsx scripts/acervo-staleness-alarm.ts
 *   npx tsx scripts/acervo-staleness-alarm.ts --dry-run
 *
 * Exit codes:
 *   0 — acervo em dia, OU defasado com issue de alarme registrada (o alarme
 *       cumpriu seu papel; sair != 0 faria a task agendada parecer quebrada)
 *   1 — falha de execução (não deu para avaliar E nem registrar)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  ACERVO_STALENESS_MAX_BUSINESS_DAYS,
  editionIdToDate,
  evaluateAcervoStaleness,
  latestDateInArchiveHtml,
  latestLastmod,
  type AcervoSnapshot,
  type DateOnly,
} from "./lib/acervo-staleness.ts";
import {
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  planAlarmReconciliation,
  saveAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = "[acervo-staleness]";
const CHECK = "acervo-staleness";
const ARQUIVO_URL = "https://arquivo.diar.ia.br/";
const SITEMAP_PATH = join(ROOT, "workers", "site", "public", "sitemap.xml");
const EDITIONS_ROOT = join(ROOT, "data", "editions");
const STATE_PATH = join(ROOT, "data", "acervo-staleness", ".alarm-issues.json");
const CLOSE_AFTER_RUNS = 2;

/** Edição mais recente em `data/editions/{YYMM}/{AAMMDD}/`. `null` se `data/` ausente. */
export function latestProducedEdition(root = EDITIONS_ROOT): DateOnly | null {
  if (!existsSync(root)) return null;
  const ids: string[] = [];
  for (const ym of readdirSync(root)) {
    const dir = join(root, ym);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const ed of readdirSync(dir)) if (/^\d{6}$/.test(ed)) ids.push(ed);
  }
  // Ordena por DATA, não por string do id: um id inválido (fixture de teste,
  // `261299`) não pode virar "a edição mais recente" e mascarar a defasagem.
  const datas = ids.map(editionIdToDate).filter((d): d is DateOnly => d !== null);
  // Descarta data futura: fixture com AAMMDD adiante de hoje faria o acervo
  // parecer eternamente defasado.
  const hoje = new Date().toISOString().slice(0, 10);
  return datas.filter((d) => d <= hoje).sort().at(-1) ?? null;
}

async function fetchArchiveLatest(url = ARQUIVO_URL): Promise<DateOnly | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "diaria-acervo-staleness/1.0" } });
    if (!res.ok) return null;
    return latestDateInArchiveHtml(await res.text());
  } catch {
    // Rede indisponível vira "sem dado", nunca alarme: alarmar por falha de
    // rede transformaria instabilidade momentânea em issue aberta toda noite.
    return null;
  }
}

function loadState(path: string): AlarmIssuesState {
  if (!existsSync(path)) return emptyAlarmIssuesState();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AlarmIssuesState;
  } catch (e) {
    console.error(`${LOG} estado corrompido em ${path} — resetando: ${(e as Error).message}`);
    return emptyAlarmIssuesState();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const dryRun = hasFlag(argv, "dry-run");
  const snap: AcervoSnapshot = {
    produzida: latestProducedEdition(),
    sitemapLocal: existsSync(SITEMAP_PATH) ? latestLastmod(readFileSync(SITEMAP_PATH, "utf8")) : null,
    aoVivo: await fetchArchiveLatest(),
    hoje: new Date().toISOString().slice(0, 10),
  };
  const r = evaluateAcervoStaleness(snap, ACERVO_STALENESS_MAX_BUSINESS_DAYS);

  console.log(
    `${LOG} produzida=${snap.produzida ?? "—"} sitemap=${snap.sitemapLocal ?? "—"} ` +
      `aoVivo=${snap.aoVivo ?? "—"} → ${r.verdict}${r.diasUteis === null ? "" : ` (${r.diasUteis}d úteis)`}`,
  );
  console.log(`${LOG} ${r.resumo}`);
  for (const l of r.lacunas) console.log(`${LOG}   lacuna: ${l}`);

  // `sem-dado` NÃO alarma: não saber é diferente de estar defasado, e abrir
  // issue por falta de rede treina o editor a ignorar este alarme.
  const findings: AlarmFinding[] =
    r.verdict === "defasado"
      ? [
          {
            check: CHECK,
            fingerprint: `acervo:${snap.aoVivo ?? "?"}`,
            title: `[diar.ia.br] acervo público defasado em ${r.diasUteis} dias úteis`,
            body:
              `Achado automático do alarme \`Diaria-Acervo-Staleness\`\n(\`scripts/acervo-staleness-alarm.ts\`, #7591).\n\n` +
              `${r.resumo}\n\n` +
              `| sinal | valor |\n|---|---|\n` +
              `| edição mais recente produzida | ${snap.produzida ?? "—"} |\n` +
              `| \`lastmod\` no sitemap do repo | ${snap.sitemapLocal ?? "—"} |\n` +
              `| edição no ar em arquivo.diar.ia.br | ${snap.aoVivo ?? "—"} |\n\n` +
              `O que checar, nesta ordem:\n\n` +
              `1. \`npx tsx scripts/reconcile-site-sitemap.ts --check\` — há página órfã?\n` +
              `2. PR aberta com branch \`site-publish/*\`? \`publish-edition-site-page.ts\` abre PR e NUNCA mergeia (#6598).\n` +
              `3. \`cd workers/site && npx wrangler deploy\` — mergeou mas não deployou?\n\n` +
              (r.lacunas.length > 0 ? `Lacunas desta execução: ${r.lacunas.join("; ")}.\n\n` : "") +
              `Fecha sozinha quando o achado não reproduzir por ${CLOSE_AFTER_RUNS} execuções.`,
            // `estado`, não `evento`: a defasagem é uma condição que se
            // resolve (publicou/deployou), então a issue deve fechar sozinha
            // quando parar de reproduzir — não é um fato histórico a preservar.
            family: "estado",
            labels: ["bug"],
            priority: "P1",
          },
        ]
      : [];

  const state = loadState(STATE_PATH);
  if (dryRun) {
    const acoes = planAlarmReconciliation(findings, state, CLOSE_AFTER_RUNS);
    console.log(`${LOG} --dry-run: ${acoes.length} ação(ões) — ${acoes.map((a) => a.kind).join(", ") || "nenhuma"}`);
    return 0;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, state, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState, STATE_PATH);
  for (const o of findingOutcomes) {
    console.log(`${LOG} issue ${o.action}${o.issueNumber ? ` #${o.issueNumber}` : ""}${o.url ? ` ${o.url}` : ""}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  // `process.exitCode`, NUNCA `process.exit()`: sair à força com a conexão do
  // `fetch` ainda aberta derruba o libuv no Windows ("Assertion failed:
  // !(handle->flags & UV_HANDLE_CLOSING)") e o processo termina em 127 — a
  // task agendada leria como falha um alarme que rodou certo. Deixar o node
  // fechar sozinho custa alguns milissegundos e devolve o código verdadeiro.
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`${LOG} erro fatal: ${(e as Error).message}`);
      process.exitCode = 1;
    });
}
