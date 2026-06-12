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
 *
 * Env:
 *   BEEHIIV_API_KEY        - acesso à API Beehiiv (required)
 *   BEEHIIV_PUBLICATION_ID - ID da publicação (required)
 *   POLL_WORKER_URL        - default https://poll.diaria.workers.dev
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";

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

/**
 * Procura post template "Default" via Beehiiv API por title exato.
 * Fallback hardcoded preserva URL conhecida (`5232180a`) em caso de API failure.
 */
async function findDefaultTemplateUrl(opts: {
  publicationId: string;
  apiKey: string;
}): Promise<string> {
  const HARDCODED_FALLBACK =
    "https://app.beehiiv.com/posts/5232180a-0224-4cd2-a0cb-276aadc7b4f6/edit";
  const baseUrl = `https://api.beehiiv.com/v2/publications/${opts.publicationId}/posts`;
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
        return `https://app.beehiiv.com/posts/${id}/edit`;
      }
      if (!json.has_more || !json.next_cursor) break;
      cursor = json.next_cursor;
    }
  } catch {
    return HARDCODED_FALLBACK;
  }
  return HARDCODED_FALLBACK;
}

async function pingWorker(edition: string): Promise<{
  ok: boolean;
  total: number;
  correct_answer: string | null;
}> {
  try {
    const res = await fetch(`${POLL_WORKER_URL}/stats?edition=${edition}`);
    if (!res.ok) return { ok: false, total: 0, correct_answer: null };
    const data = (await res.json()) as {
      total?: number;
      correct_answer?: string | null;
    };
    return {
      ok: true,
      total: data.total ?? 0,
      correct_answer: data.correct_answer ?? null,
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
    return {
      name: "Worker poll",
      passed: false,
      detail: `${POLL_WORKER_URL} não responde — verificar deploy`,
    };
  }
  return {
    name: "Worker disponível",
    passed: true,
    detail: `${POLL_WORKER_URL} respondendo (edition ${edition} stats: total=${result.total}, gabarito=${result.correct_answer ?? "null"})`,
  };
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

  const apiKey = process.env.BEEHIIV_API_KEY;
  const publicationId = process.env.BEEHIIV_PUBLICATION_ID;
  const missing: string[] = [];
  if (!apiKey) missing.push("BEEHIIV_API_KEY");
  if (!publicationId) missing.push("BEEHIIV_PUBLICATION_ID");
  if (missing.length > 0) {
    console.error(
      `[prep-manual-publish] envs ausentes: ${missing.join(", ")} — abortando`,
    );
    process.exit(1);
  }

  const editionDir = resolve(ROOT, "data", "editions", edition);
  if (!existsSync(editionDir)) {
    console.error(
      `[prep-manual-publish] edição ${edition} não existe em ${editionDir}`,
    );
    process.exit(1);
  }

  const apiOpts = { publicationId: publicationId!, apiKey: apiKey! };

  // Run all checks
  const checks: Check[] = [
    checkNewsletterHtml(editionDir),
    await checkWorker(edition),
  ];
  const allPassed = printChecks(checks);

  if (!allPassed) {
    console.error("[prep-manual-publish] algumas pré-condições falharam — fix antes de prosseguir.");
    process.exit(1);
  }

  // Print step-by-step instructions
  const htmlPath = resolve(editionDir, "_internal", "newsletter-final.html");
  const templateUrl = await findDefaultTemplateUrl(apiOpts);
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

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[prep-manual-publish] ${(e as Error).message}`);
    process.exit(2);
  });
}
