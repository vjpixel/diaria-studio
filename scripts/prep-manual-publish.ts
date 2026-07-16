/**
 * prep-manual-publish.ts (#1047, refatorado em #1185, simplificado em #1186)
 *
 * Gate técnico antes de publicação manual no Beehiiv. Valida pré-condições
 * e imprime instruções step-by-step pra paste + publish + close-poll.
 *
 * Desde #1186, a URL de voto usa modo merge-tag (`{{email}}` sem sig HMAC) —
 * `inject-poll-sig.ts` foi removido. As pré-condições agora são:
 *   1. newsletter-final.html existe e tem merge tag `{{email}}`
 *   2. Worker de poll está respondendo
 *
 * Uso:
 *   npx tsx scripts/prep-manual-publish.ts --edition 260510
 *   [--editions-dir <path>]  # override do editions root — só para testes (#3491)
 *
 * Env:
 *   BEEHIIV_API_KEY        - acesso à API Beehiiv (required)
 *   BEEHIIV_PUBLICATION_ID - ID da publicação (required)
 *   POLL_WORKER_URL        - default https://poll.diaria.workers.dev
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { isWorkerReachable } from "./lib/worker-reachability.ts"; // #2551
import { dohFetch } from "./lib/doh-fetch.ts"; // #2551: stats fetch via DoH quando DNS local filtra
import { resolveEditionDir } from "./lib/find-current-edition.ts"; // #3491: layout flat+nested

loadProjectEnv(); // #1219 — carrega .env/.env.local antes de ler process.env.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_WORKER_URL =
  process.env.POLL_WORKER_URL ?? "https://poll.diaria.workers.dev";

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

interface BeehiivPostListItem {
  id: string;
  title: string;
  status: string;
}

interface DefaultTemplateMatch {
  /** Post id (sem prefixo `post_`), ou `null` quando resolvido só via fallback
   *  hardcoded por falha de API — nesse caso não dá pra confiar no id pra
   *  fetch de conteúdo (#3221 checkTemplateNotStale trata `null` como "não
   *  verificável", não como stale). */
  id: string | null;
  url: string;
}

/**
 * Procura post template "Default" via Beehiiv API por title exato.
 * Fallback hardcoded preserva URL conhecida (`5232180a`) em caso de API failure —
 * mas `id: null` nesse caso, pra `checkTemplateNotStale` (#3221) não tentar
 * fetch de conteúdo sobre um id que pode não ser mais o post real.
 */
async function findDefaultTemplate(opts: {
  publicationId: string;
  apiKey: string;
}): Promise<DefaultTemplateMatch> {
  const HARDCODED_FALLBACK: DefaultTemplateMatch = {
    id: null,
    url: "https://app.beehiiv.com/posts/5232180a-0224-4cd2-a0cb-276aadc7b4f6/edit",
  };
  const baseUrl = `${beehiivApiBase()}/publications/${opts.publicationId}/posts`; // #2834/#2850
  let cursor: string | undefined;
  try {
    while (true) {
      const params = new URLSearchParams({ status: "draft", limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const res = await fetch(`${baseUrl}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${opts.apiKey}` },
      });
      if (!res.ok) return HARDCODED_FALLBACK;
      const json = (await res.json()) as {
        data?: BeehiivPostListItem[];
        has_more?: boolean;
        next_cursor?: string;
      };
      const match = (json.data ?? []).find((p) => p.title === "Default");
      if (match) {
        const id = match.id.replace(/^post_/, "");
        return { id, url: `https://app.beehiiv.com/posts/${id}/edit` };
      }
      if (!json.has_more || !json.next_cursor) break;
      cursor = json.next_cursor;
    }
  } catch {
    return HARDCODED_FALLBACK;
  }
  return HARDCODED_FALLBACK;
}

/**
 * #3221: detecta se um HTML de post/template ainda carrega a versão ANTIGA
 * (pré-#3220) da linha "Resultado da última edição: X% ..." — bold +
 * uppercase + letter-spacing + cor teal (padrão kicker/whyBox herdado de
 * #3103/#3104). #3220 destylizou essa linha pra parágrafo comum (sem esses
 * três atributos). #2283 documenta que o Beehiiv PERSISTE o htmlSnippet do
 * template "Default"/"HTML" entre usos — se o snippet salvo é de uma edição
 * anterior ao fix, o estilo antigo pode reaparecer visualmente mesmo com o
 * renderer do repo já corrigido. Puro/testável sem rede (recebe o HTML já
 * buscado).
 */
export function hasStaleResultLineStyle(html: string): boolean {
  const match = /<p style="([^"]*)">\s*Resultado da última edição/i.exec(html);
  if (!match) return false;
  const style = match[1];
  return (
    /font-weight:\s*bold/i.test(style) &&
    /letter-spacing/i.test(style) &&
    /text-transform:\s*uppercase/i.test(style)
  );
}

const CHECK_NAME_TEMPLATE_STALE = 'Template Default sem "Resultado da última edição" no estilo antigo (#3221)';

/**
 * #3221: busca o conteúdo persistido do template "Default" via API (mesmo
 * expand[]=free_web_content usado por fetch-beehiiv-poll-stats.ts) e roda
 * `hasStaleResultLineStyle` sobre ele. Falha de API/rede não bloqueia o
 * fluxo manual (fail-open, `passed: true`) — vira aviso pra conferência
 * manual, já que essa checagem é aditiva, não uma pré-condição de dados
 * locais como `checkNewsletterHtml`/`checkWorker`.
 */
async function checkTemplateNotStale(
  template: DefaultTemplateMatch,
  opts: { publicationId: string; apiKey: string },
): Promise<Check> {
  if (!template.id) {
    return {
      name: CHECK_NAME_TEMPLATE_STALE,
      passed: true,
      detail:
        "id do template Default não resolvido via API (fallback hardcoded) — não foi possível verificar automaticamente, confira manualmente antes do paste",
    };
  }
  try {
    const url = `${beehiivApiBase()}/publications/${opts.publicationId}/posts/${template.id}?expand[]=free_web_content`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });
    if (!res.ok) {
      return {
        name: CHECK_NAME_TEMPLATE_STALE,
        passed: true,
        detail: `Beehiiv API ${res.status} ao buscar conteúdo do template Default — não foi possível verificar automaticamente, confira manualmente antes do paste`,
      };
    }
    const json = (await res.json()) as {
      data?: { content?: { free?: { web?: string } } };
    };
    const html = json.data?.content?.free?.web ?? "";
    if (hasStaleResultLineStyle(html)) {
      return {
        name: CHECK_NAME_TEMPLATE_STALE,
        passed: false,
        detail:
          'htmlSnippet persistido no template "Default" ainda tem "Resultado da última edição" no estilo ANTIGO (bold+uppercase+letter-spacing, pré-#3220) — abrir o template e limpar o Custom HTML block antes de colar o conteúdo desta edição (raiz #2283: Beehiiv persiste o snippet entre usos)',
      };
    }
    return {
      name: CHECK_NAME_TEMPLATE_STALE,
      passed: true,
      detail: html
        ? 'conteúdo persistido não tem o estilo antigo de "Resultado da última edição"'
        : "template Default está vazio — sem risco de conteúdo stale",
    };
  } catch (e) {
    return {
      name: CHECK_NAME_TEMPLATE_STALE,
      passed: true,
      detail: `erro ao verificar template Default (${(e as Error).message}) — não foi possível verificar automaticamente, confira manualmente antes do paste`,
    };
  }
}

async function pingWorker(edition: string): Promise<{
  ok: boolean;
  total: number;
  correct_answer: string | null;
  local_dns_filtered?: boolean;
  abort_timeout?: boolean;
}> {
  const url = `${POLL_WORKER_URL}/stats?edition=${edition}`;
  // #2551: usar isWorkerReachable (DoH fallback) em vez de fetch nativo,
  // pra distinguir "filtro DNS local" de "Worker realmente down".
  const reachability = await isWorkerReachable(url);
  if (!reachability.up) {
    if (reachability.local_dns_filtered) {
      console.warn(
        `[prep-manual-publish] ⚠️  DNS local filtrou ${new URL(url).hostname} — ` +
          `mas DoH/anycast também não respondeu. Pode ser filtro de rede sem acesso ao Worker. ` +
          `Detalhes: ${reachability.error ?? "(sem detalhe)"}`,
      );
    } else if (reachability.abort_timeout) {
      console.warn(
        `[prep-manual-publish] ⚠️  Timeout de conexão com ${new URL(url).hostname} ` +
          `(servidor lento ou DNS filtrado por drop) — DoH/anycast também falhou. ` +
          `Detalhes: ${reachability.error ?? "(sem detalhe)"}`,
      );
    }
    return {
      ok: false,
      total: 0,
      correct_answer: null,
      local_dns_filtered: reachability.local_dns_filtered,
      abort_timeout: reachability.abort_timeout,
    };
  }
  // Worker UP — fazer chamada pra extrair stats via dohFetch (suporta DNS local filtrado)
  try {
    const res = await dohFetch(url);
    if (!res.ok) return { ok: false, total: 0, correct_answer: null };
    const data = (await res.json()) as {
      total?: number;
      correct_answer?: string | null;
    };
    return {
      ok: true,
      total: data.total ?? 0,
      correct_answer: data.correct_answer ?? null,
      local_dns_filtered: reachability.local_dns_filtered,
      abort_timeout: reachability.abort_timeout,
    };
  } catch {
    return { ok: false, total: 0, correct_answer: null };
  }
}

export function checkNewsletterHtml(editionDir: string): Check {
  const path = resolve(editionDir, "_internal", "newsletter-final.html");
  if (!existsSync(path)) {
    return {
      name: "newsletter-final.html existe",
      passed: false,
      detail: `${path} não encontrado — rode publish-newsletter render primeiro`,
    };
  }
  const html = readFileSync(path, "utf8");
  // Design atual (#1186): URL inline com merge tag `{{email}}` (modo merge-tag,
  // sem sig HMAC). Sintaxe Beehiiv: SEM espaços, SEM prefix (docs 2026-05-11).
  const hasEmailMergeTag = /\{\{email\}\}/.test(html);
  if (!hasEmailMergeTag) {
    return {
      name: "newsletter-final.html tem merge tag {{email}}",
      passed: false,
      detail: `Design atual requer URL inline com {{email}} (modo merge-tag, #1186). Re-rodar render-newsletter-html.ts.`,
    };
  }
  const sizeKb = Math.round(statSync(path).size / 1024);
  return {
    name: "newsletter-final.html",
    passed: true,
    detail: `${sizeKb}KB, inline URL com {{email}} (merge-tag mode)`,
  };
}

async function checkWorker(edition: string): Promise<Check> {
  const result = await pingWorker(edition);
  if (!result.ok) {
    // #2551/#2592: distinguir "DNS filtrado", "timeout (servidor lento ou DNS drop)" e "Worker realmente down"
    const dnsSuffix = result.local_dns_filtered
      ? " (DNS local filtrou o hostname — Worker pode estar UP via DoH/anycast)"
      : result.abort_timeout
        ? " (timeout — servidor lento ou DNS filtrado por drop de pacotes)"
        : " — verificar deploy";
    return {
      name: "Worker poll",
      passed: false,
      detail: `${POLL_WORKER_URL} não responde${dnsSuffix}`,
    };
  }
  const dnsSuffix = result.local_dns_filtered
    ? " (via DoH/anycast — DNS local filtrado)"
    : result.abort_timeout
      ? " (via DoH/anycast — fetch nativo teve timeout)"
      : "";
  return {
    name: "Worker disponível",
    passed: true,
    detail: `${POLL_WORKER_URL} respondendo${dnsSuffix} (edition ${edition} stats: total=${result.total}, gabarito=${result.correct_answer ?? "null"})`,
  };
}

/**
 * #3491: resolve o diretório da edição a partir do editions root (real ou
 * override de teste) usando `resolveEditionDir` (flat legado + nested,
 * #2463/#3024) em vez de montar `data/editions/{AAMMDD}` à mão. Extraído
 * como função pura pra ser testável sem spawnar o CLI inteiro (que faz
 * chamadas de rede via checkWorker).
 */
export function resolvePrepPublishEditionDir(
  edition: string,
  editionsDirOverride?: string,
): string {
  const editionsRootDir = editionsDirOverride
    ? resolve(editionsDirOverride)
    : resolve(ROOT, "data", "editions");
  return resolveEditionDir(editionsRootDir, edition);
}

function printChecks(checks: Check[]): boolean {
  const allPassed = checks.every((c) => c.passed);
  console.log("\n=== Pré-condições ===");
  for (const c of checks) {
    const icon = c.passed ? "✓" : "✗";
    console.log(`${icon} ${c.name}: ${c.detail}`);
  }
  console.log("");
  return allPassed;
}

async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const edition = values["edition"];
  // #1185: --skip-inject ainda aceito por compat (1mo, remover 2026-06-19);
  // emite warn pois o script não roda mais inject (cron Stage 0 cobre).
  if (flags.has("skip-inject")) {
    console.warn(
      "[prep-manual-publish] ⚠️  --skip-inject é flag legacy desde #1185 (inject-poll-urls removido). Pode omitir.",
    );
  }

  if (!edition || !/^\d{6}$/.test(edition)) {
    console.error(
      "Uso: prep-manual-publish.ts --edition AAMMDD",
    );
    process.exit(1);
  }

  // #2286: publicationId lido via loadBeehiivConfig (env → platform.config.json).
  // BEEHIIV_API_KEY ainda é obrigatório (sem fallback); publicationId tem fallback
  // para beehiiv.publicationId em platform.config.json.
  const cfg = loadBeehiivConfig("[prep-manual-publish]");
  const { apiKey, publicationId } = cfg;

  // #3491: editionDir era montado à mão como `data/editions/{AAMMDD}` (layout
  // FLAT), sem passar por nenhum helper — a mesma classe de bug de #3483/#3484.
  // Este script faz parte do fluxo de publicação MANUAL documentado no
  // CLAUDE.md (gate técnico pré-paste no Beehiiv); ENOENT garantido em
  // qualquer edição já migrada pro layout nested (`{AAMM}/{AAMMDD}`,
  // #2463/#3024). `--editions-dir` é override só de teste (mesmo padrão de
  // close-poll.ts #3031); produção nunca passa essa flag.
  const editionDir = resolvePrepPublishEditionDir(edition, values["editions-dir"]);
  if (!existsSync(editionDir)) {
    console.error(
      `[prep-manual-publish] edição ${edition} não existe em ${editionDir}`,
    );
    process.exit(1);
  }

  const apiOpts = { publicationId, apiKey };

  // #3221: resolve o template Default ANTES dos checks pra poder incluir
  // checkTemplateNotStale (verifica conteúdo persistido) na mesma lista/gate
  // que checkNewsletterHtml/checkWorker, em vez de só imprimir a URL depois.
  const template = await findDefaultTemplate(apiOpts);

  // Run all checks
  const checks: Check[] = [
    checkNewsletterHtml(editionDir),
    await checkWorker(edition),
    await checkTemplateNotStale(template, apiOpts),
  ];
  const allPassed = printChecks(checks);

  if (!allPassed) {
    console.error("[prep-manual-publish] algumas pré-condições falharam — fix antes de prosseguir.");
    process.exit(1);
  }

  // Print step-by-step instructions
  const htmlPath = resolve(editionDir, "_internal", "newsletter-final.html");
  const templateUrl = template.url;
  console.log("=== Próximos passos (manual) ===\n");
  console.log("1. Abrir template no Beehiiv:");
  console.log(`   ${templateUrl}\n`);
  console.log("2. Editar Custom HTML block — substituir conteúdo pelo arquivo abaixo:");
  console.log(`   ${htmlPath}\n`);
  console.log("3. Preencher Title + Subject Line da edição (Compose tab)\n");
  console.log("4. Audience tab → confirmar segment correto (default = All subscribers)\n");
  console.log("5. Send test email pra você confirmar visualmente\n");
  console.log("6. Schedule ou Publish Now\n");
  console.log("=== Após publicar ===\n");
  console.log(`   npx tsx scripts/close-poll.ts --edition ${edition}`);
  console.log(
    "   (registra gabarito do É IA? no Worker pra retroactive scoring + display % na próxima edição)\n",
  );
  console.log("✓ Tudo pronto pra paste manual. Worker vai receber votos quando leitores clicarem.\n");
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[prep-manual-publish] ${(e as Error).message}`);
    process.exit(2);
  });
}
