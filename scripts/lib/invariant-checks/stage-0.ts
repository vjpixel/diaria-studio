/**
 * Invariants de Stage 0 (#1007 Fase 1).
 *
 * Checks rodados antes de iniciar a edição. Falham se config crítica está
 * ausente — evita rodar 30min de pesquisa pra falhar no Stage 4.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
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
 * #1370: env vars críticas que outras stages dependem. Editor decisão (2026-05-19):
 * todas hard halt — pipeline não deve correr metade do caminho pra falhar.
 */
function checkRequiredEnvVar(
  name: string,
  ruleId: string,
  sourceIssue: string,
  context: string,
): InvariantViolation[] {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return [
      {
        rule: ruleId,
        message:
          `${name} ausente no env. ${context} ` +
          "Configure em .env ou exporte no shell antes de rodar a pipeline.",
        source_issue: sourceIssue,
        severity: "error",
      },
    ];
  }
  return [];
}

function checkClariceKeySet(): InvariantViolation[] {
  return checkRequiredEnvVar(
    "CLARICE_API_KEY",
    "clarice-key-set",
    "#1370",
    "Stage 2 (revisão Clarice) falha sem essa key — tanto MCP quanto REST fallback dependem dela.",
  );
}

/**
 * #1370: image_generator config decide qual key checar.
 * - gemini → GEMINI_API_KEY
 * - cloudflare → CLOUDFLARE_WORKERS_TOKEN
 * - comfyui → nenhuma (local)
 * - openai → OPENAI_API_KEY
 */
function checkImageGeneratorKeySet(): InvariantViolation[] {
  const configPath = resolve(ROOT, "platform.config.json");
  if (!existsSync(configPath)) return [];
  let generator: string;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { image_generator?: string };
    generator = (cfg.image_generator ?? "gemini").toLowerCase();
  } catch {
    return [];
  }
  if (generator === "comfyui") return []; // local, no key
  const keyMap: Record<string, { env: string; context: string }> = {
    gemini: {
      env: "GEMINI_API_KEY",
      context: "Stage 1 (eia-compose) e Stage 3 (image-generate) usam Gemini API.",
    },
    cloudflare: {
      env: "CLOUDFLARE_WORKERS_TOKEN",
      context: "Stage 1/3 usam Cloudflare Workers AI (Flux Schnell) — token precisa ter Workers AI permission.",
    },
    openai: {
      env: "OPENAI_API_KEY",
      context: "Stage 1/3 usam OpenAI DALL-E / gpt-image-2.",
    },
  };
  const cfg = keyMap[generator];
  if (!cfg) return []; // generator desconhecido — não check
  return checkRequiredEnvVar(
    cfg.env,
    "image-generator-key-set",
    "#1370",
    `image_generator="${generator}" em platform.config.json. ${cfg.context}`,
  );
}

function checkLinkedinCronCredsSet(): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  violations.push(
    ...checkRequiredEnvVar(
      "DIARIA_LINKEDIN_CRON_URL",
      "linkedin-cron-url-set",
      "#1370",
      "Stage 4 (publish-linkedin --schedule) usa o Worker Cloudflare pra enfileirar posts no horário.",
    ),
  );
  violations.push(
    ...checkRequiredEnvVar(
      "DIARIA_LINKEDIN_CRON_TOKEN",
      "linkedin-cron-token-set",
      "#1370",
      "Auth Bearer pra Worker LinkedIn — sem isso publish-linkedin --schedule aborta.",
    ),
  );
  return violations;
}

function checkPollSecretsSet(): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  violations.push(
    ...checkRequiredEnvVar(
      "POLL_SECRET",
      "poll-secret-set",
      "#1370",
      "Stage 0 inject-poll-sig + Stage 4 close-poll usam pra assinar URLs do É IA?.",
    ),
  );
  violations.push(
    ...checkRequiredEnvVar(
      "ADMIN_SECRET",
      "admin-secret-set",
      "#1370",
      "close-poll.ts assina /admin/correct com este secret. Sem ele, gabarito nunca é registrado.",
    ),
  );
  return violations;
}

/**
 * #1396: valida que `gemini.model` em platform.config.json resolve em
 * /v1beta/models da Gemini API. Pega config drift silently (caso real:
 * Bundle 6 PR #1391 mudou pra `gemini-2.5-flash-image-preview` que não
 * existe — só `gemini-2.5-flash-image` sem `-preview` suffix existe).
 *
 * Skip silencioso quando `image_generator !== gemini` (cloudflare/openai
 * têm catálogos próprios) ou GEMINI_API_KEY ausente (outro rule cobre).
 * Network failure também skip — não bloqueia pipeline em outage Gemini.
 *
 * Implementação: invariant chama spawnSync no script TS (similar a
 * stage-2 lints). Network fetch fica isolado no subprocess.
 */
function checkGeminiModelValid(): InvariantViolation[] {
  const configPath = resolve(ROOT, "platform.config.json");
  if (!existsSync(configPath)) return [];
  let cfg: { image_generator?: string };
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return [];
  }
  if ((cfg.image_generator ?? "gemini") !== "gemini") return [];
  if (!process.env.GEMINI_API_KEY) return []; // outro rule cobre key ausente
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(ROOT, "scripts", "validate-gemini-config.ts")],
    { encoding: "utf8", env: process.env },
  );
  if (result.status === 0) return [];
  if (result.status === 3) {
    // network failure — skip silencioso (não queremos quebrar pipeline em
    // outage transient da Gemini API)
    return [];
  }
  // status 1 = model not found
  let parsed: { configured_model?: string; available_models?: string[]; suggestion?: string } = {};
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    /* ignore */
  }
  const suggestionMsg = parsed.suggestion
    ? ` Sugestão: \`gemini.model = "${parsed.suggestion}"\`.`
    : "";
  const availableMsg =
    parsed.available_models && parsed.available_models.length > 0
      ? ` Models image-capable disponíveis: ${parsed.available_models.slice(0, 5).join(", ")}.`
      : "";
  return [
    {
      rule: "gemini-model-valid",
      message:
        `gemini.model="${parsed.configured_model ?? "?"}" não está no catálogo /v1beta/models da Gemini API.` +
        suggestionMsg +
        availableMsg,
      source_issue: "#1396",
      severity: "error",
    },
  ];
}

/**
 * #1382: stdio MCPs declarados em .mcp.json têm `args[0]` (path do binário)
 * que precisa existir no filesystem. Path stale silently no MCP — Claude Code
 * tenta iniciar, falha, MCP vira indisponível, scripts caem no fallback (ou
 * em nada).
 *
 * Em 260519, .mcp.json apontava Clarice MCP pra path com username errado
 * (vjpix em vez do user real desta máquina). Resultou em fallback REST manual
 * pra todo o Stage 2 review.
 */
function checkMcpBinariesExist(): InvariantViolation[] {
  const mcpJsonPath = resolve(ROOT, ".mcp.json");
  if (!existsSync(mcpJsonPath)) return [];
  let parsed: { mcpServers?: Record<string, { type?: string; command?: string; args?: string[] }> };
  try {
    parsed = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
  } catch (e) {
    return [
      {
        rule: "mcp-binaries-exist",
        message: `.mcp.json não parseável: ${(e as Error).message}`,
        source_issue: "#1382",
        severity: "error",
        file: ".mcp.json",
      },
    ];
  }
  const violations: InvariantViolation[] = [];
  const servers = parsed.mcpServers ?? {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.type !== "stdio" && cfg.command !== "node") continue;
    const args = cfg.args ?? [];
    if (args.length === 0) continue;
    const binPath = args[0];
    if (binPath.startsWith("/") || /^[A-Z]:[\\/]/i.test(binPath)) {
      if (!existsSync(binPath)) {
        violations.push({
          rule: "mcp-binaries-exist",
          message:
            `MCP "${name}" em .mcp.json aponta pra ${binPath} mas o arquivo não existe. ` +
            "Path provavelmente stale (machine-specific). Considere mover MCP pra user-scope " +
            "(claude mcp add --scope user) e remover do .mcp.json.",
          source_issue: "#1382",
          severity: "error",
          file: ".mcp.json",
        });
      }
    }
  }
  return violations;
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
  {
    id: "clarice-key-set",
    description: "CLARICE_API_KEY env var presente (#1370)",
    source_issue: "#1370",
    stage: 0,
    run: () => checkClariceKeySet(),
  },
  {
    id: "image-generator-key-set",
    description: "API key do image_generator configurado em platform.config.json presente (#1370)",
    source_issue: "#1370",
    stage: 0,
    run: () => checkImageGeneratorKeySet(),
  },
  {
    id: "linkedin-cron-creds-set",
    description: "DIARIA_LINKEDIN_CRON_URL + TOKEN presentes (#1370)",
    source_issue: "#1370",
    stage: 0,
    run: () => checkLinkedinCronCredsSet(),
  },
  {
    id: "poll-secrets-set",
    description: "POLL_SECRET + ADMIN_SECRET presentes (#1370)",
    source_issue: "#1370",
    stage: 0,
    run: () => checkPollSecretsSet(),
  },
  {
    id: "mcp-binaries-exist",
    description: "stdio MCPs em .mcp.json apontam pra binários que existem (#1382)",
    source_issue: "#1382",
    stage: 0,
    run: () => checkMcpBinariesExist(),
  },
  {
    id: "gemini-model-valid",
    description: "platform.config.json > gemini.model resolve em /v1beta/models (#1396)",
    source_issue: "#1396",
    stage: 0,
    run: () => checkGeminiModelValid(),
  },
];

export {
  checkPastEditionsRawValid,
  checkBeehiivKeySet,
  checkDriveCredsValid,
  checkClariceKeySet,
  checkImageGeneratorKeySet,
  checkLinkedinCronCredsSet,
  checkPollSecretsSet,
  checkMcpBinariesExist,
  checkGeminiModelValid,
};
