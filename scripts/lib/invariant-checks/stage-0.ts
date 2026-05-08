/**
 * Invariants de Stage 0 (#1007 Fase 1).
 *
 * Checks rodados antes de iniciar a edição. Falham se config crítica está
 * ausente — evita rodar 30min de pesquisa pra falhar no Stage 4.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { InvariantRule, InvariantViolation } from "./types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * `data/past-editions-raw.json` deve existir e ser parseável JSON. Sem isso,
 * `refresh-dedup` faz bootstrap (busca todas as ~14 edições do Beehiiv) em
 * vez de incremental — caro e pode causar race com pipeline.
 */
function checkPastEditionsRawValid(): InvariantViolation[] {
  const path = resolve(ROOT, "data/past-editions-raw.json");
  if (!existsSync(path)) {
    // Bootstrap legítimo OK — não bloqueia.
    return [];
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(data)) {
      return [
        {
          rule: "past-editions-raw-shape",
          message: "data/past-editions-raw.json não é array — refresh-dedup vai falhar incremental",
          source_issue: "#162",
          severity: "error",
          file: "data/past-editions-raw.json",
        },
      ];
    }
  } catch (e) {
    return [
      {
        rule: "past-editions-raw-parseable",
        message: `data/past-editions-raw.json não parseável: ${(e as Error).message}`,
        source_issue: "#162",
        severity: "error",
        file: "data/past-editions-raw.json",
      },
    ];
  }
  return [];
}

/**
 * `BEEHIIV_API_KEY` deve estar setado. refresh-dedup, fetch-poll-stats,
 * collect-monthly-runner e outros falham silenciosamente sem ela.
 */
function checkBeehiivKeySet(): InvariantViolation[] {
  if (!process.env.BEEHIIV_API_KEY || process.env.BEEHIIV_API_KEY.trim().length === 0) {
    return [
      {
        rule: "beehiiv-key-set",
        message:
          "BEEHIIV_API_KEY não definida no env. Configure em .env.local ou exporte no shell. " +
          "Sem ela, refresh-dedup, fetch-poll-stats e collect-monthly falham.",
        source_issue: "#895",
        severity: "error",
      },
    ];
  }
  return [];
}

/**
 * `data/.credentials.json` deve existir e ser parseável (Drive OAuth tokens).
 * Sem ela, drive-sync falha cedo no Stage 1 (push após gate humano) ou tarde
 * (Stage 2/3/4 push) — melhor pegar no preflight.
 */
function checkDriveCredsValid(): InvariantViolation[] {
  const path = resolve(ROOT, "data/.credentials.json");
  if (!existsSync(path)) {
    return [
      {
        rule: "drive-creds-valid",
        message:
          "data/.credentials.json ausente — Drive sync vai falhar. " +
          "Rode `npx tsx scripts/oauth-setup.ts` se nunca configurou.",
        source_issue: "#121",
        severity: "warning", // warning porque editor pode ter desligado Drive sync intencional
      },
    ];
  }
  try {
    const creds = JSON.parse(readFileSync(path, "utf8")) as {
      access_token?: string;
      refresh_token?: string;
      expiry_ms?: number;
    };
    if (!creds.refresh_token) {
      return [
        {
          rule: "drive-creds-valid",
          message:
            "data/.credentials.json sem refresh_token — token expira sem renew. " +
            "Re-rodar `npx tsx scripts/oauth-setup.ts` pra gerar novo.",
          source_issue: "#121",
          severity: "warning",
        },
      ];
    }
  } catch (e) {
    return [
      {
        rule: "drive-creds-valid",
        message: `data/.credentials.json não parseável: ${(e as Error).message}`,
        source_issue: "#121",
        severity: "error",
        file: "data/.credentials.json",
      },
    ];
  }
  return [];
}

export const STAGE_0_RULES: InvariantRule[] = [
  {
    id: "past-editions-raw-parseable",
    description: "data/past-editions-raw.json existe e parseável (#162)",
    source_issue: "#162",
    stage: 0,
    run: () => checkPastEditionsRawValid(),
  },
  {
    id: "beehiiv-key-set",
    description: "BEEHIIV_API_KEY env var presente (#895)",
    source_issue: "#895",
    stage: 0,
    run: () => checkBeehiivKeySet(),
  },
  {
    id: "drive-creds-valid",
    description: "data/.credentials.json existe e tem refresh_token (#121)",
    source_issue: "#121",
    stage: 0,
    run: () => checkDriveCredsValid(),
  },
];

export {
  checkPastEditionsRawValid,
  checkBeehiivKeySet,
  checkDriveCredsValid,
};
