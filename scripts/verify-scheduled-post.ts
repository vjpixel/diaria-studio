/**
 * verify-scheduled-post.ts (#2074)
 *
 * Verifica o estado real de um post Beehiiv pós-Schedule e detecta se o
 * editor clicou em Publish (envio imediato) em vez de Schedule (agendamento).
 *
 * Caso real (260611): editor respondeu "agendado" após clicar no Beehiiv, mas a
 * API mostrou `status: published` com `scheduled_at = now` — o clique foi Publish
 * (envio imediato às 22:46 BRT), não o agendamento matinal (06:00). A sessão
 * detectou por iniciativa própria (#573) mas nada no playbook exigia isso.
 *
 * Este script codifica a sequência determinística de 260611:
 *   1. GET post via API.
 *   2. resolveBeehiivState(post, now) para distinguir scheduled vs published.
 *   3. Se published (envio imediato detectado): alerta + atualiza 05-published.json.
 *   4. Se scheduled corretamente: confirma com timestamp.
 *
 * Uso:
 *   npx tsx scripts/verify-scheduled-post.ts \
 *     --post-id POST_ID \
 *     --edition-dir data/editions/260611/
 *
 * Flags:
 *   --post-id POST_ID        ID do post Beehiiv (obrigatório)
 *   --edition-dir PATH       diretório da edição (obrigatório — pra atualizar 05-published.json)
 *
 * Variáveis de ambiente:
 *   BEEHIIV_API_KEY          obrigatório
 *   BEEHIIV_PUBLICATION_ID   opcional (fallback: platform.config.json)
 *
 * Exit codes:
 *   0 = scheduled (agendado corretamente no futuro)
 *   1 = published (envio imediato detectado — ação necessária)
 *   2 = config inválida, args inválidos ou erro de API
 *
 * Stdout: JSON com shape { state, post_id, scheduled_at, published_at,
 *   immediate_send_detected, published_json_updated }
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
import { parseArgs } from "./lib/cli-args.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBeehiivState } from "./lib/publish-state.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// BEEHIIV_API_URL override permite testes apontarem para mock server.
const BEEHIIV_API = process.env.BEEHIIV_API_URL ?? "https://api.beehiiv.com/v2";

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface Config {
  apiKey: string;
  publicationId: string;
}

interface BeehiivPost {
  id: string;
  title?: string;
  status?: string;
  publish_date?: number | null;
  /** scheduled_at é um campo da API Beehiiv v2 (ISO 8601 string ou null). */
  scheduled_at?: string | null;
  [key: string]: unknown;
}

export interface VerifyResult {
  state: "scheduled" | "published" | "draft" | "unknown";
  post_id: string;
  /** ISO string do agendamento (se scheduled). */
  scheduled_at: string | null;
  /** ISO string de quando foi publicado (se published imediato). */
  published_at: string | null;
  /** true quando detectou envio imediato em vez de agendamento. */
  immediate_send_detected: boolean;
  /** true quando 05-published.json foi atualizado por este script. */
  published_json_updated: boolean;
}

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig(): Config {
  const apiKey = process.env.BEEHIIV_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      "[verify-scheduled-post] BEEHIIV_API_KEY não definida. Configure no .env (veja .env.example).\n",
    );
    process.exit(2);
  }

  const configPath = resolve(ROOT, "platform.config.json");
  let publicationId = process.env.BEEHIIV_PUBLICATION_ID ?? "";
  if (!publicationId) {
    if (!existsSync(configPath)) {
      process.stderr.write(
        `[verify-scheduled-post] platform.config.json não encontrado em ${configPath}\n`,
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
        `[verify-scheduled-post] platform.config.json inválido: ${(e as Error).message}\n`,
      );
      process.exit(2);
    }
  }
  if (!publicationId) {
    process.stderr.write(
      "[verify-scheduled-post] publicationId ausente — adicione `beehiiv.publicationId` em platform.config.json ou exporte BEEHIIV_PUBLICATION_ID.\n",
    );
    process.exit(2);
  }

  return { apiKey, publicationId };
}

// ── API ───────────────────────────────────────────────────────────────────────

/**
 * GET /publications/{pubId}/posts/{postId}
 * Retorna o objeto post (campo data).
 * Exportado para testes com fetchFn mockado.
 */
export async function fetchPost(
  cfg: Config,
  postId: string,
  fetchFn: typeof fetch = fetch,
): Promise<BeehiivPost> {
  const url = `${BEEHIIV_API}/publications/${cfg.publicationId}/posts/${postId}`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET post ${postId}: ${res.status} ${res.statusText} — ${body}`,
    );
  }
  const json = (await res.json()) as { data: BeehiivPost | null };
  if (!json.data) {
    throw new Error(
      `GET post ${postId}: API retornou 200 mas sem objeto data`,
    );
  }
  return json.data;
}

// ── Lógica principal ──────────────────────────────────────────────────────────

/**
 * Verifica o estado pós-Schedule de um post Beehiiv.
 *
 * Exportado para uso em testes unitários com post mockado.
 *
 * @param post        Objeto post da API Beehiiv.
 * @param editionDir  Caminho para `data/editions/{AAMMDD}/` (lê+atualiza 05-published.json).
 * @param now         Timestamp atual (injetável para testes).
 * @returns           VerifyResult com state + flags de diagnóstico.
 */
export function verifyScheduledPost(
  post: BeehiivPost,
  editionDir: string,
  now: Date = new Date(),
): VerifyResult {
  const state = resolveBeehiivState(post, now);

  // Derivar timestamps úteis para o report.
  const publishDateMs =
    post.publish_date != null && post.publish_date !== 0
      ? post.publish_date * 1000
      : null;
  const scheduledAtIso =
    state === "scheduled" && publishDateMs != null
      ? new Date(publishDateMs).toISOString()
      : null;
  const publishedAtIso =
    state === "published" && publishDateMs != null
      ? new Date(publishDateMs).toISOString()
      : null;

  const immediateSendDetected = state === "published";

  let publishedJsonUpdated = false;

  if (immediateSendDetected) {
    // Atualizar 05-published.json — tanto path legado (root) quanto path interno.
    const internalPath = resolve(editionDir, "_internal", "05-published.json");
    const rootPath = resolve(editionDir, "05-published.json");
    const publishedPath = existsSync(internalPath)
      ? internalPath
      : existsSync(rootPath)
        ? rootPath
        : null;

    if (publishedPath) {
      try {
        const existing = JSON.parse(readFileSync(publishedPath, "utf8")) as Record<string, unknown>;
        const updated = {
          ...existing,
          status: "published",
          published_at: publishedAtIso ?? new Date().toISOString(),
          // Preservar campos existentes — só sobrescrever status + published_at.
        };
        writeFileSync(publishedPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
        publishedJsonUpdated = true;
      } catch (e) {
        process.stderr.write(
          `[verify-scheduled-post] warn: não consegui atualizar ${publishedPath}: ${(e as Error).message}\n`,
        );
      }
    } else {
      process.stderr.write(
        `[verify-scheduled-post] warn: 05-published.json não encontrado em ${editionDir} — não atualizei.\n`,
      );
    }
  }

  return {
    state,
    post_id: post.id,
    scheduled_at: scheduledAtIso,
    published_at: publishedAtIso,
    immediate_send_detected: immediateSendDetected,
    published_json_updated: publishedJsonUpdated,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const postId = args.values["post-id"];
  const editionDirRaw = args.values["edition-dir"];

  if (!postId) {
    process.stderr.write(
      "Uso: verify-scheduled-post.ts --post-id POST_ID --edition-dir data/editions/{AAMMDD}/\n",
    );
    process.exit(2);
  }
  if (!editionDirRaw) {
    process.stderr.write(
      "Uso: verify-scheduled-post.ts --post-id POST_ID --edition-dir data/editions/{AAMMDD}/\n",
    );
    process.exit(2);
  }

  const editionDir = resolve(ROOT, editionDirRaw);
  const cfg = loadConfig();

  let post: BeehiivPost;
  try {
    post = await fetchPost(cfg, postId);
  } catch (e) {
    process.stderr.write(`[verify-scheduled-post] erro API: ${(e as Error).message}\n`);
    process.exit(2);
  }

  const now = new Date();
  const result = verifyScheduledPost(post, editionDir, now);

  // Emitir diagnóstico pra stderr (visível ao top-level e ao editor).
  if (result.immediate_send_detected) {
    process.stderr.write(
      `\n⚠️  ENVIO IMEDIATO DETECTADO — post ${postId} foi publicado agora (${result.published_at}), NÃO agendado.\n` +
        `   O editor clicou em "Publish" (envio imediato) em vez de "Schedule" (agendamento).\n` +
        `   05-published.json ${result.published_json_updated ? "atualizado" : "NÃO atualizado (arquivo ausente)"}.\n` +
        `   Próximo passo obrigatório: npx tsx scripts/refresh-dedup.ts\n` +
        `   (regra "publicação manual requer refresh-dedup" do CLAUDE.md)\n\n`,
    );
  } else if (result.state === "scheduled") {
    process.stderr.write(
      `[verify-scheduled-post] OK — post agendado para ${result.scheduled_at} ✓\n`,
    );
  } else {
    process.stderr.write(
      `[verify-scheduled-post] estado inesperado: ${result.state} (post_id=${postId}, publish_date=${post.publish_date})\n`,
    );
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  // Exit codes para consumo pelo playbook/orchestrator:
  //   0 = scheduled (agendado corretamente)
  //   1 = published (envio imediato — requer ação)
  //   2 = unknown/draft ou erro (já tratado acima)
  if (result.state === "scheduled") process.exit(0);
  if (result.immediate_send_detected) process.exit(1);
  process.exit(2);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    process.stderr.write(`Fatal error: ${(e as Error).message}\n`);
    process.exit(2);
  });
}
