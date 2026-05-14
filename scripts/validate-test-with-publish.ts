#!/usr/bin/env tsx
/**
 * validate-test-with-publish.ts (#1267)
 *
 * Validator pós-run pro `/diaria-test --with-publish`. Verifica que o
 * Beehiiv playbook rodou de fato — não foi skippado com motivo genérico
 * tipo "complexity". Roda no Stage final do `/diaria-test`.
 *
 * Uso:
 *   npx tsx scripts/validate-test-with-publish.ts \
 *     --edition-dir data/editions/{AAMMDD}/ \
 *     --with-publish true
 *
 * Exit codes:
 *   0 — OK (Beehiiv rodou, ou skip legítimo com motivo verificável)
 *   1 — REGRESSÃO (with_publish=true mas 05-published.json status=skipped
 *       com motivo inválido tipo "complexity")
 *   2 — erro de input (file missing, shape inválido)
 *
 * Razão (#1267): incidente 2026-05-14 — 2 runs consecutivas pulei o
 * Beehiiv playbook rationalizing como "playbook complexo". Editor pediu
 * hard guard pra evitar regressão futura.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { runMain } from "./lib/exit-handler.ts";

// Motivos legítimos pra skip — extender quando descobrir novos casos válidos.
// Padrão: skip só é válido se há falha upstream concreta E verificável
// (ex: arquivo ausente, exit code != 0 documentado).
const LEGITIMATE_SKIP_REASONS = new Set([
  "upstream_eia_missing",
  "chrome_mcp_unavailable",
  "beehiiv_login_expired",
  "skipped_by_editor", // editor explicit "none" em consent
]);

interface PublishedJson {
  status?: string;
  skip_reason?: string;
  skip_details?: Record<string, unknown>;
  draft_url?: string | null;
  test_mode?: boolean;
  with_publish?: boolean;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

/**
 * Valida que se with_publish=true, o Beehiiv playbook rodou (status="draft")
 * OU foi skippado com motivo legítimo (concreto, verificável).
 *
 * Pure function pra testabilidade.
 */
export function validate(
  withPublish: boolean,
  published: PublishedJson | null,
): ValidationResult {
  if (!withPublish) {
    return { ok: true, reason: "with_publish=false — Beehiiv skip esperado" };
  }

  if (!published) {
    return {
      ok: false,
      reason: "with_publish=true mas 05-published.json ausente",
      details: { expected: "05-published.json com status=draft ou skip legítimo" },
    };
  }

  // Status "draft" é o caminho feliz — Beehiiv rodou.
  if (published.status === "draft") {
    if (!published.draft_url) {
      return {
        ok: false,
        reason: "status=draft mas draft_url ausente (regressão silenciosa do paste?)",
        details: { status: published.status },
      };
    }
    return { ok: true, reason: "Beehiiv playbook completou — draft criado", details: { draft_url: published.draft_url } };
  }

  // Status "skipped" só é OK com motivo legítimo
  if (published.status === "skipped") {
    const reason = published.skip_reason ?? "<no_reason>";
    if (LEGITIMATE_SKIP_REASONS.has(reason)) {
      return {
        ok: true,
        reason: `Skip legítimo — motivo: ${reason}`,
        details: { skip_reason: reason },
      };
    }
    return {
      ok: false,
      reason:
        `with_publish=true + status=skipped com motivo INVÁLIDO: '${reason}'. ` +
        `Motivos legítimos: ${[...LEGITIMATE_SKIP_REASONS].join(", ")}. ` +
        `Beehiiv playbook deveria ter rodado.`,
      details: {
        skip_reason: reason,
        skip_details: published.skip_details,
        valid_reasons: [...LEGITIMATE_SKIP_REASONS],
      },
    };
  }

  // Outros status (published, scheduled, sent) — também OK
  if (
    published.status === "published" ||
    published.status === "scheduled" ||
    published.status === "sent"
  ) {
    return { ok: true, reason: `status=${published.status}`, details: { status: published.status } };
  }

  // Status desconhecido / pending_manual — soft warn, OK
  return {
    ok: true,
    reason: `status='${published.status}' — soft accept (pode ser pending_manual ou estado em curso)`,
    details: { status: published.status },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const editionDir = args["edition-dir"] as string | undefined;
  // Aceita "true"/"false" ou flag bool
  const withPublishArg = args["with-publish"];
  const withPublish =
    withPublishArg === true || withPublishArg === "true" || withPublishArg === "1";

  if (!editionDir) {
    console.error("Uso: validate-test-with-publish.ts --edition-dir <path> --with-publish <true|false>");
    process.exit(2);
  }

  const publishedPath = resolve(process.cwd(), editionDir, "_internal/05-published.json");
  let published: PublishedJson | null = null;
  if (existsSync(publishedPath)) {
    try {
      published = JSON.parse(readFileSync(publishedPath, "utf8")) as PublishedJson;
    } catch (err) {
      console.error(`Erro lendo ${publishedPath}: ${(err as Error).message}`);
      process.exit(2);
    }
  }

  const result = validate(withPublish, published);

  process.stdout.write(
    JSON.stringify(
      {
        ok: result.ok,
        reason: result.reason,
        details: result.details,
        edition_dir: editionDir,
        with_publish: withPublish,
        published_exists: !!published,
      },
      null,
      2,
    ) + "\n",
  );

  if (!result.ok) {
    console.error(`\n[validate-test-with-publish] FAIL: ${result.reason}`);
    process.exit(1);
  }
  process.exit(0);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  runMain(main);
}
