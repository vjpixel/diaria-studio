/**
 * fix-post-slug.ts (#2011)
 *
 * Corrige o slug de um post Beehiiv via API v2 PATCH quando o wizard de
 * Schedule re-deriva o slug do título e mangla acentos PT-BR.
 *
 * Problema: após clicar em Schedule, o Beehiiv re-deriva o slug do título e
 * mangla acentos (`automação` → `automa-o`, `pânico` → `p-nico`). O slug
 * correto setado no passo SEO (#1989) é sobrescrito silenciosamente.
 *
 * Solução: PATCH /publications/{pubId}/posts/{postId} com body
 * `{ web_settings: { slug } }` — confirmado suportado pela API v2 doc
 * (https://developers.beehiiv.com/api-reference/posts/update.md).
 *
 * Fluxo:
 *   1. GET post pra confirmar estado atual (slug + status).
 *   2. Se dry-run: imprimir o que faria e sair.
 *   3. PATCH web_settings.slug.
 *   4. GET verify pós-update (#573) — confirmar que slug persistiu.
 *
 * Uso:
 *   npx tsx scripts/fix-post-slug.ts --post-id POST_ID --slug meu-slug-correto
 *   npx tsx scripts/fix-post-slug.ts --post-id POST_ID --slug meu-slug-correto --execute
 *
 * Flags:
 *   --post-id POST_ID   ID do post Beehiiv (obrigatório)
 *   --slug SLUG         Slug desejado (obrigatório)
 *   --execute           Executar o PATCH (default: dry-run apenas)
 *
 * Variáveis de ambiente:
 *   BEEHIIV_API_KEY           obrigatório
 *   BEEHIIV_PUBLICATION_ID    obrigatório (ou platform.config.json)
 *
 * Exit codes:
 *   0 = sucesso (ou dry-run OK)
 *   1 = erro de API / slug não persistiu após update
 *   2 = config inválida ou args inválidos
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
import { parseArgs } from "./lib/cli-args.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { seoSlug } from "./lib/slug.ts";
import { BEEHIIV_API_BASE } from "./lib/beehiiv-config.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// #2834: base URL centralizada em lib/beehiiv-config.ts (`BEEHIIV_API_URL`
// override pra tests continua honrado lá).
const BEEHIIV_API = BEEHIIV_API_BASE;

// ── Config ────────────────────────────────────────────────────────────────────

interface Config {
  apiKey: string;
  publicationId: string;
}

function loadConfig(): Config {
  const apiKey = process.env.BEEHIIV_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      "[fix-post-slug] BEEHIIV_API_KEY não definida. Configure no .env (veja .env.example).\n",
    );
    process.exit(2);
  }

  const configPath = resolve(ROOT, "platform.config.json");
  let publicationId = process.env.BEEHIIV_PUBLICATION_ID ?? "";
  if (!publicationId) {
    if (!existsSync(configPath)) {
      process.stderr.write(
        `[fix-post-slug] platform.config.json não encontrado em ${configPath}\n`,
      );
      process.exit(2);
    }
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
        beehiiv?: { publicationId?: string };
      };
      publicationId = cfg.beehiiv?.publicationId ?? "";
    } catch (e) {
      process.stderr.write(
        `[fix-post-slug] platform.config.json inválido: ${(e as Error).message}\n`,
      );
      process.exit(2);
    }
  }
  if (!publicationId) {
    process.stderr.write(
      "[fix-post-slug] publicationId ausente — adicione `beehiiv.publicationId` em platform.config.json ou exporte BEEHIIV_PUBLICATION_ID.\n",
    );
    process.exit(2);
  }

  return { apiKey, publicationId };
}

// ── API helpers ───────────────────────────────────────────────────────────────

interface BeehiivWebSettings {
  slug?: string;
  [key: string]: unknown;
}

interface BeehiivPost {
  id: string;
  title?: string;
  status?: string;
  web_settings?: BeehiivWebSettings;
  [key: string]: unknown;
}

/**
 * GET /publications/{pubId}/posts/{postId}
 * Returns the post object (data property).
 */
export async function fetchPost(
  cfg: Config,
  postId: string,
  fetchFn: typeof fetch = fetch,
): Promise<BeehiivPost> {
  const url = `${BEEHIIV_API}/publications/${cfg.publicationId}/posts/${postId}?expand[]=web_settings`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET post ${postId}: ${res.status} ${res.statusText} — ${body}`);
  }
  const json = (await res.json()) as { data: BeehiivPost | null };
  if (!json.data) {
    throw new Error(`GET post ${postId}: API retornou 200 mas sem objeto data`);
  }
  return json.data;
}

/**
 * PATCH /publications/{pubId}/posts/{postId}
 * Updates web_settings.slug.
 * Returns the updated post object.
 */
export async function patchSlug(
  cfg: Config,
  postId: string,
  slug: string,
  fetchFn: typeof fetch = fetch,
): Promise<BeehiivPost> {
  const url = `${BEEHIIV_API}/publications/${cfg.publicationId}/posts/${postId}`;
  const body = JSON.stringify({ web_settings: { slug } });
  const res = await fetchFn(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) {
    const respBody = await res.text().catch(() => "");
    throw new Error(
      `PATCH post ${postId} slug: ${res.status} ${res.statusText} — ${respBody}`,
    );
  }
  const json = (await res.json()) as { data: BeehiivPost | null };
  if (!json.data) {
    throw new Error(`PATCH post ${postId}: API retornou 200 mas sem objeto data`);
  }
  return json.data;
}

// ── Slug validation ───────────────────────────────────────────────────────────

/**
 * Validates that a slug candidate is safe to set on Beehiiv:
 * - non-empty
 * - lowercase kebab (no accents, no special chars beyond hyphens)
 * - no leading/trailing hyphens
 * - no mangling signatures (bypassable with force)
 *
 * #2048 item 5: primary mangling detection is `slug !== seoSlug(title)` when
 * `title` is provided (the GET post already brings the title). This replaces the
 * consonant/vowel heuristics that had known false-positives (`x-ray`, `versao-a`,
 * range `v-z` includes `y`, etc.) with a definitive comparison against the
 * canonical PT-BR slug. Pass `force: true` to bypass the mangling check.
 *
 * When `title` is absent (pre-GET call for structural checks), falls back to the
 * original consonant/vowel heuristics for a lightweight pre-flight guard.
 * Hard errors (empty, non-kebab) are never bypassed by `force`.
 *
 * Returns null if valid, or an error message string if invalid.
 */
export function validateSlug(slug: string, force = false, title?: string): string | null {
  if (!slug || slug.trim() === "") return "slug vazio";
  if (slug !== slug.trim()) return "slug com espaços leading/trailing";

  // Must be lowercase kebab with no accented chars
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    return `slug inválido: "${slug}" deve ser lowercase kebab (a-z, 0-9, hífens internos). Acentos, letras maiúsculas e caracteres especiais não são permitidos.`;
  }

  if (!force) {
    if (title) {
      // #2048 item 5: primary check — comparar com seoSlug(title) é O sinal de
      // mangling. Heurísticas anteriores (consoante/vogal) tinham FP documentados
      // (x-ray, versao-a, y-* pelo range v-z). seoSlug é determinístico e exato.
      const canonical = seoSlug(title);
      if (slug !== canonical) {
        return (
          `slug "${slug}" diverge do slug canônico "${canonical}" derivado do título ` +
          `"${title}" (#2048, via seoSlug). Provável mangling Beehiiv (ex: "pânico" → "p-nico", ` +
          `"automação" → "automa-o"). Use --force se o slug é intencional.`
        );
      }
    } else {
      // Fallback pré-GET: heurísticas de consoante/vogal quando título não disponível.
      // Serve apenas como pre-flight estrutural antes do GET do post.
      const segments = slug.split("-");
      const vowels = new Set(["a", "e", "i", "o", "u"]);
      const consonants = /^[b-df-hj-np-tv-z]$/; // single consonant (excludes vowels)

      // Check 1: first segment is a single consonant
      if (segments.length > 1 && segments[0].length === 1 && consonants.test(segments[0])) {
        return (
          `slug "${slug}" começa com segmento de consoante única "${segments[0]}" — ` +
          `provável assinatura de mangling Beehiiv (vogal acentuada deletada, ex: "pânico" → "p-nico", #2011). ` +
          `Use seoSlug(title) pra gerar o slug correto, ou passe --force se o slug é intencional (ex: "x-ray", "b-side").`
        );
      }

      // Check 2: last segment is a single vowel
      const lastSegment = segments[segments.length - 1];
      if (segments.length > 1 && lastSegment.length === 1 && vowels.has(lastSegment)) {
        return (
          `slug "${slug}" termina com segmento de vogal única "${lastSegment}" — ` +
          `provável assinatura de mangling Beehiiv (ex: "automação" → "automa-o", #2011). ` +
          `Use seoSlug(title) pra gerar o slug correto, ou passe --force se o slug é intencional (ex: "versao-a", "parte-i").`
        );
      }
    }
  }

  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export interface FixSlugResult {
  post_id: string;
  publication_id: string;
  slug_before: string | null;
  slug_after: string | null;
  slug_target: string;
  updated: boolean;
  dry_run: boolean;
  verified: boolean;
}

export async function fixPostSlug(opts: {
  postId: string;
  slug: string;
  execute: boolean;
  force?: boolean;
  cfg: Config;
  fetchFn?: typeof fetch;
}): Promise<FixSlugResult> {
  const { postId, slug, execute, cfg } = opts;
  const force = opts.force ?? false;
  const fetchFn = opts.fetchFn ?? fetch;

  // 1. Validate slug structure before any network call (no title yet — structural only).
  const structuralError = validateSlug(slug, force);
  if (structuralError) {
    throw new Error(`Slug inválido: ${structuralError}`);
  }

  // 2. GET current state
  process.stderr.write(`[fix-post-slug] GET post ${postId}…\n`);
  const before = await fetchPost(cfg, postId, fetchFn);
  const slugBefore = (before.web_settings?.slug as string | undefined) ?? null;
  const title = (before.title as string | undefined) ?? undefined;

  process.stderr.write(
    `[fix-post-slug] slug atual: ${slugBefore ?? "(ausente)"} | status: ${before.status ?? "?"} | title: ${title ?? "?"}\n`,
  );

  const result: FixSlugResult = {
    post_id: postId,
    publication_id: cfg.publicationId,
    slug_before: slugBefore,
    slug_after: null,
    slug_target: slug,
    updated: false,
    dry_run: !execute,
    verified: false,
  };

  // 3. Short-circuit if slug already correct — checked BEFORE title validation so that
  // idempotent re-runs succeed without --force even when the slug differs from seoSlug(title).
  // (User already asserted correctness when they first set the slug, possibly with --force.)
  if (slugBefore === slug) {
    process.stderr.write(
      `[fix-post-slug] Slug já está correto ("${slug}") — nada a fazer.\n`,
    );
    result.slug_after = slug;
    result.verified = true;
    return result;
  }

  // 2b. Re-validate with title (if available) — #2048 item 5: seoSlug(title) comparison
  // replaces the consonant/vowel heuristics with the definitive canonical check.
  // Runs after the no-op short-circuit (step 3) so idempotent re-runs are not blocked.
  if (title) {
    const titleError = validateSlug(slug, force, title);
    if (titleError) {
      throw new Error(`Slug inválido (vs título): ${titleError}`);
    }
  }

  // 4. Dry-run gate
  if (!execute) {
    process.stderr.write(
      `[fix-post-slug] DRY-RUN: PATCH web_settings.slug "${slugBefore}" → "${slug}" (passe --execute pra valer)\n`,
    );
    return result;
  }

  // 5. PATCH
  process.stderr.write(`[fix-post-slug] PATCH slug "${slugBefore}" → "${slug}"…\n`);
  const patchResponse = await patchSlug(cfg, postId, slug, fetchFn);
  const slugAfterPatch =
    (patchResponse.web_settings?.slug as string | undefined) ?? null;
  result.slug_after = slugAfterPatch;
  result.updated = true;

  // 6. GET-verify (#573) — confirm slug persisted
  process.stderr.write(`[fix-post-slug] GET-verify post ${postId}…\n`);
  const verified = await fetchPost(cfg, postId, fetchFn);
  const slugVerified = (verified.web_settings?.slug as string | undefined) ?? null;

  if (slugVerified === slug) {
    result.verified = true;
    result.slug_after = slugVerified;
    process.stderr.write(`[fix-post-slug] ✔ slug verificado: "${slugVerified}"\n`);
  } else {
    process.stderr.write(
      `[fix-post-slug] ✘ slug NÃO persistiu após update: esperado "${slug}", encontrado "${slugVerified ?? "(ausente)"}"\n`,
    );
    result.slug_after = slugVerified;
    // Exit 1 — caller can detect via throw or check result.verified
    throw new Error(
      `Slug não persistiu: esperado "${slug}", encontrado "${slugVerified ?? "(ausente)"}" — tente corrigir manualmente no dashboard.`,
    );
  }

  return result;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values, flags } = parseArgs(process.argv.slice(2));

  const postId = values["post-id"];
  const slug = values["slug"];
  const execute = flags.has("execute");
  const force = flags.has("force");

  if (!postId || !slug) {
    process.stderr.write(
      "Uso: fix-post-slug.ts --post-id POST_ID --slug SLUG [--execute] [--force]\n" +
        "  --post-id   ID do post Beehiiv\n" +
        "  --slug      Slug correto (lowercase kebab, sem acentos)\n" +
        "  --execute   Executar o PATCH (default: dry-run apenas)\n" +
        "  --force     Ignorar warnings de falso-positivo (ex: x-ray, versao-a)\n",
    );
    process.exit(2);
  }

  const cfg = loadConfig();

  try {
    const result = await fixPostSlug({ postId, slug, execute, force, cfg });
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    process.stderr.write(`[fix-post-slug] Erro: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

// Guard: só rodar main() quando invocado como CLI.
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    process.stderr.write(`[fix-post-slug] Fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
