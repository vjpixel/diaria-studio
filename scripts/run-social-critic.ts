#!/usr/bin/env npx tsx
/**
 * run-social-critic.ts (#4505 item 3)
 *
 * Script de orquestração do subagente OPCIONAL `social-critic` no Stage 4.
 *
 * Contexto (#4352, #4505): o sentinel `check-humanizer-social.ts` só compara
 * hash antes/depois do humanizador — nunca relê o CONTEÚDO. Os lints
 * determinísticos GATE-BLOCKING (`no-antithesis-reveal`, `no-trailing-editorial-hook`,
 * #2526/#2658/#4352) cobrem só 2 padrões específicos do catálogo de ~27
 * padrões da skill `humanizador` — uma correção mecânica pós-humanizador
 * (fact-check autofix, ajuste de travessão residual no gate, etc.) pode
 * reintroduzir uma variante de tique de IA que nenhum dos 2 regex cobre
 * (achado #4505, recorrência ao vivo 260803). O `social-critic` fecha essa
 * lacuna com uma leitura holística — análoga aos passos 6-7 do rubric de 9
 * passos da skill `humanizador` ("o que ainda soa de IA?" + "responda
 * brevemente com os resquícios") — sem reescrever (passo 8 fica de fora).
 *
 * **Opcional por design** (issue #4505 item 3): controlado via
 * `platform.config.json` → `social_critic_pass.enabled` (default `false` —
 * desligado). O orchestrator só dispatcha o subagente quando este script,
 * em modo descoberta, sai com exit 0 (habilitado + `03-social.md` presente).
 *
 * Modos:
 *   Descoberta (default) — checa o flag de config e a presença de
 *   `03-social.md`, imprime os parâmetros de dispatch pro orchestrator montar
 *   `Agent("social-critic", {...})`.
 *
 *   `--input-json <path>` — recebe o veredito do subagente, normaliza, grava
 *   em `_internal/social-critic.json` e formata a seção pro gate.
 *   **Sempre exit 0** neste modo — mesmo racional do `image-crop-reviewer`
 *   (#3951) e do `fact-checker` (#2468 finding 4): é um passo de
 *   detecção/aviso, nunca bloqueia; um exit != 0 esconderia o achado do
 *   editor em vez de mostrá-lo no gate.
 *
 * Uso:
 *   npx tsx scripts/run-social-critic.ts --edition-dir data/editions/AAMMDD/
 *   npx tsx scripts/run-social-critic.ts --edition-dir data/editions/AAMMDD/ \
 *     --input-json <path-para-output-do-subagente>
 *
 * Exit codes (modo descoberta):
 *   0 — habilitado + `03-social.md` presente; stdout traz os parâmetros de dispatch.
 *   1 — erro de args, ou `03-social.md` ausente.
 *   2 — desabilitado (`social_critic_pass.enabled !== true`) — orchestrator
 *       pula o passo sem tratar como falha (#4505 — opcional por padrão).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG_PATH = resolve(ROOT, "platform.config.json");

// ---------------------------------------------------------------------------
// Config (#4505 item 3 — opt-in via platform.config.json)
// ---------------------------------------------------------------------------

export interface SocialCriticConfig {
  enabled?: boolean;
}

/**
 * Lê `social_critic_pass` de `platform.config.json`. Fail-soft (#4505):
 * arquivo ausente, JSON malformado, ou chave ausente → `{ enabled: false }`
 * — um passo OPCIONAL nunca deve ativar sozinho por causa de um config
 * quebrado; o default seguro é "desligado", igual ao default documentado.
 */
export function readSocialCriticConfig(configPath: string): SocialCriticConfig {
  if (!existsSync(configPath)) return { enabled: false };
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      social_critic_pass?: SocialCriticConfig;
    };
    return cfg.social_critic_pass ?? { enabled: false };
  } catch {
    return { enabled: false };
  }
}

export function isSocialCriticEnabled(configPath: string): boolean {
  return readSocialCriticConfig(configPath).enabled === true;
}

// ---------------------------------------------------------------------------
// Types — exportados para teste
// ---------------------------------------------------------------------------

export interface SocialCriticFinding {
  /** Seção do 03-social.md onde o trecho foi encontrado (ex: "d1", "post_pixel"). */
  section: string;
  /** Trecho exato (curto) que ainda soa de IA. */
  trecho: string;
  /** Por que soa de IA — 1 frase, referenciando o padrão (ver skill humanizador). */
  motivo: string;
}

export interface SocialCriticResult {
  edition: string;
  checked_at: string;
  /** true = ao menos 1 finding; false = nada soou de IA nesta leitura. */
  sounds_ai: boolean;
  findings: SocialCriticFinding[];
}

// ---------------------------------------------------------------------------
// normalizeSocialCriticResult — valida/normaliza o output do subagente
// ---------------------------------------------------------------------------

export function normalizeSocialCriticResult(raw: unknown, edition: string): SocialCriticResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("social-critic output não é um objeto JSON");
  }
  const obj = raw as Record<string, unknown>;

  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: SocialCriticFinding[] = rawFindings
    .filter(
      (f): f is Record<string, unknown> =>
        !!f &&
        typeof f === "object" &&
        typeof (f as Record<string, unknown>).section === "string" &&
        typeof (f as Record<string, unknown>).trecho === "string" &&
        typeof (f as Record<string, unknown>).motivo === "string",
    )
    .map((f) => ({
      section: f.section as string,
      trecho: f.trecho as string,
      motivo: f.motivo as string,
    }));

  if (findings.length !== rawFindings.length) {
    console.warn(
      `run-social-critic: ${rawFindings.length - findings.length} finding(s) descartado(s) por schema inválido (faltando section/trecho/motivo como string) — ver output bruto do subagente.`,
    );
  }

  return {
    edition,
    checked_at: typeof obj.checked_at === "string" ? obj.checked_at : new Date().toISOString(),
    // Deriva de findings.length — nunca confia num `sounds_ai` inconsistente
    // vindo do subagente (mesmo racional de `normalizeCropReviewResult`
    // recalcular `summary` a partir de `results`, #3951).
    sounds_ai: findings.length > 0,
    findings,
  };
}

// ---------------------------------------------------------------------------
// formatGateSummary — sempre warning-only
// ---------------------------------------------------------------------------

export function formatGateSummary(result: SocialCriticResult): string {
  const { findings } = result;
  const lines: string[] = [];

  lines.push("━━━ CRITIC PASS SOCIAL (#4505, opcional) ━━━━");

  if (findings.length === 0) {
    lines.push("  ✅ Nenhum trecho ainda soa como texto gerado por IA nesta leitura.");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    return lines.join("\n");
  }

  lines.push(
    `  ⚠️  ${findings.length} trecho(s) ainda soam como texto gerado por IA (rubric humanizador, passo 6):`,
  );
  lines.push("");
  for (const f of findings) {
    lines.push(`  [${f.section}] "${f.trecho}" — ${f.motivo}`);
  }
  lines.push("");
  lines.push(
    "  Puramente informativo — nunca bloqueia. Decisão final (re-humanizar ou aprovar assim mesmo) é do editor.",
  );
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function extractEditionId(editionDir: string): string {
  const parts = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "unknown";
}

function main(): void {
  const { values: args } = parseArgs(process.argv.slice(2));
  if (!args["edition-dir"]) {
    console.error(
      "Uso: run-social-critic.ts --edition-dir data/editions/AAMMDD/ [--input-json <path>]",
    );
    process.exit(1);
  }

  const editionDir = resolve(process.cwd(), args["edition-dir"]);
  const edition = args.edition ?? extractEditionId(editionDir);
  const internalDir = join(editionDir, "_internal");
  const outPath = args.out ? resolve(process.cwd(), args.out) : join(internalDir, "social-critic.json");
  const configPath = args.config ? resolve(process.cwd(), args.config) : DEFAULT_CONFIG_PATH;

  // Modo --input-json: recebe o veredito do subagente, normaliza, grava e formata.
  if (args["input-json"]) {
    const inputPath = resolve(process.cwd(), args["input-json"]);
    if (!existsSync(inputPath)) {
      console.error(`[run-social-critic] --input-json não encontrado: ${inputPath}`);
      process.exit(1);
    }
    const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
    const result = normalizeSocialCriticResult(raw, edition);

    mkdirSync(internalDir, { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
    console.log(formatGateSummary(result));

    // Warning-only (#4505 item 3, mesmo racional do image-crop-reviewer
    // #3951 e do fact-checker #2468 finding 4): exit sempre 0.
    return;
  }

  // Modo descoberta (default): checa o flag opt-in + presença do arquivo.
  if (!isSocialCriticEnabled(configPath)) {
    console.error(
      "[run-social-critic] desabilitado (platform.config.json → social_critic_pass.enabled !== true) " +
        "— pulando passo opcional (#4505 item 3). Ativar setando `\"social_critic_pass\": { \"enabled\": true }`.",
    );
    process.exit(2);
  }

  const socialPath = join(editionDir, "03-social.md");
  if (!existsSync(socialPath)) {
    console.error(`[run-social-critic] 03-social.md não existe em ${editionDir}`);
    process.exit(1);
  }

  mkdirSync(internalDir, { recursive: true });
  console.log(JSON.stringify({ edition, social_path: socialPath, out_path: outPath }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
