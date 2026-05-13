/**
 * prep-manual-publish.ts (#1047)
 *
 * Gate técnico antes de publicação manual no Beehiiv. Valida pré-condições,
 * roda `inject-poll-urls.ts`, e imprime instruções step-by-step pra paste +
 * publish + close-poll.
 *
 * Resolve risco do PR #1044: workflow manual sem inject prévio = botões A/B
 * com `href=""` (Beehiiv substitui {{poll_a_url}} por string vazia se subscriber
 * não tem custom field populado). Click → nada acontece → UX break visível.
 *
 * Uso:
 *   npx tsx scripts/prep-manual-publish.ts --edition 260510
 *   npx tsx scripts/prep-manual-publish.ts --edition 260510 --skip-inject
 *
 * Env:
 *   BEEHIIV_API_KEY        - acesso à API Beehiiv (required)
 *   BEEHIIV_PUBLICATION_ID - ID da publicação (required)
 *   POLL_SECRET            - HMAC key (required)
 *   POLL_WORKER_URL        - default https://diar-ia-poll.diaria.workers.dev
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli-args.ts";
import { run as injectPollUrls } from "./inject-poll-urls.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";

loadProjectEnv(); // #1219 — carrega .env/.env.local antes de ler process.env.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_WORKER_URL =
  process.env.POLL_WORKER_URL ?? "https://diar-ia-poll.diaria.workers.dev";

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

interface BeehiivCustomField {
  id: string;
  display: string;
  kind: string;
}

async function listCustomFields(opts: {
  publicationId: string;
  apiKey: string;
}): Promise<string[]> {
  // Pagina via cursor pra cobrir publications com >100 fields (consistência
  // com inject-poll-urls.ts:ensureCustomFields — mesmo padrão).
  const baseUrl = `https://api.beehiiv.com/v2/publications/${opts.publicationId}/custom_fields`;
  const all: string[] = [];
  let cursor: string | undefined;
  while (true) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${baseUrl}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });
    if (!res.ok)
      throw new Error(`Beehiiv API ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      data?: BeehiivCustomField[];
      has_more?: boolean;
      next_cursor?: string;
    };
    for (const f of json.data ?? []) all.push(f.display);
    if (!json.has_more || !json.next_cursor) break;
    cursor = json.next_cursor;
  }
  return all;
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

function checkNewsletterHtml(editionDir: string): Check {
  const path = resolve(editionDir, "_internal", "newsletter-final.html");
  if (!existsSync(path)) {
    return {
      name: "newsletter-final.html existe",
      passed: false,
      detail: `${path} não encontrado — rode publish-newsletter render primeiro`,
    };
  }
  const html = readFileSync(path, "utf8");
  // Aceita 3 designs (em ordem cronológica):
  //   (a) Legacy "Votar A/B" buttons + {{poll_X_url}} (pré-#1082)
  //   (b) Clickable images com {{poll_X_url}} (#1082)
  //   (c) Inline URL com {{ subscriber.email }} + {{ poll_sig }} (#1083, permanente)
  const hasVotarButtons = /Votar A/.test(html) && /Votar B/.test(html);
  const hasLegacyLinks =
    /href="\{\{poll_a_url\}\}"/.test(html) && /href="\{\{poll_b_url\}\}"/.test(html);
  // Beehiiv merge tag syntax: SEM espaços, SEM prefix (docs 2026-05-11).
  // Sintaxe correta: {{email}} (reserved) + {{poll_sig}} (custom field).
  const hasInlineSig =
    /\{\{email\}\}/.test(html) && /\{\{poll_sig\}\}/.test(html);
  const hasVoteAnchors = hasVotarButtons || hasLegacyLinks || hasInlineSig;
  const hasMergeTag = /\{\{poll_[ab]_url\}\}/.test(html) || hasInlineSig;
  if (!hasVoteAnchors || !hasMergeTag) {
    return {
      name: "newsletter-final.html tem ancoras A/B + merge tags",
      passed: false,
      detail: `Votar buttons=${hasVotarButtons}, legacy links=${hasLegacyLinks}, inline sig=${hasInlineSig}. Re-rodar render-newsletter-html.ts.`,
    };
  }
  const sizeKb = Math.round(statSync(path).size / 1024);
  const designLabel = hasInlineSig
    ? "inline URL + poll_sig"
    : hasLegacyLinks
    ? "imagens clicáveis A/B (legacy)"
    : "botões A/B (legacy)";
  return {
    name: "newsletter-final.html",
    passed: true,
    detail: `${sizeKb}KB, ${designLabel}`,
  };
}

async function checkCustomFields(opts: {
  publicationId: string;
  apiKey: string;
}): Promise<Check> {
  try {
    const fields = await listCustomFields(opts);
    const hasA = fields.includes("poll_a_url");
    const hasB = fields.includes("poll_b_url");
    if (!hasA || !hasB) {
      return {
        name: "custom fields poll_a_url + poll_b_url",
        passed: false,
        detail: `poll_a_url=${hasA}, poll_b_url=${hasB}. inject-poll-urls.ts cria automático no primeiro run, ou crie manualmente via API.`,
      };
    }
    return {
      name: "custom fields Beehiiv",
      passed: true,
      detail: `poll_a_url + poll_b_url existem (${fields.length} fields total)`,
    };
  } catch (e) {
    return {
      name: "custom fields Beehiiv",
      passed: false,
      detail: `erro consultando API: ${(e as Error).message}`,
    };
  }
}

async function checkWorker(edition: string): Promise<Check> {
  const result = await pingWorker(edition);
  if (!result.ok) {
    return {
      name: "Worker diar-ia-poll",
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
  const skipInject = flags.has("skip-inject");

  if (!edition || !/^\d{6}$/.test(edition)) {
    console.error(
      "Uso: prep-manual-publish.ts --edition AAMMDD [--skip-inject]",
    );
    process.exit(1);
  }

  const apiKey = process.env.BEEHIIV_API_KEY;
  const publicationId = process.env.BEEHIIV_PUBLICATION_ID;
  const secret = process.env.POLL_SECRET;
  const missing: string[] = [];
  if (!apiKey) missing.push("BEEHIIV_API_KEY");
  if (!publicationId) missing.push("BEEHIIV_PUBLICATION_ID");
  if (!secret) missing.push("POLL_SECRET");
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
    await checkCustomFields(apiOpts),
    await checkWorker(edition),
  ];
  const allPassed = printChecks(checks);

  if (!allPassed) {
    console.error("[prep-manual-publish] algumas pré-condições falharam — fix antes de prosseguir.");
    process.exit(1);
  }

  // Run inject-poll-urls unless skipped
  if (skipInject) {
    console.log("[prep-manual-publish] --skip-inject passado, pulando inject-poll-urls");
  } else {
    console.log("=== Rodando inject-poll-urls.ts ===");
    const result = await injectPollUrls({
      edition,
      dryRun: false,
      apiOpts,
      secret: secret!,
    });
    console.log(`[inject] ${result.patched}/${result.total_subscribers} subscribers OK, ${result.failed} falhas, ${result.skipped_no_email} skipped\n`);
    if (result.failed > result.total_subscribers * 0.1) {
      console.error(
        `[prep-manual-publish] ⚠️ ${result.failed}/${result.total_subscribers} (>10%) subscribers falharam — investigue antes de publicar.`,
      );
      process.exit(2);
    }
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
