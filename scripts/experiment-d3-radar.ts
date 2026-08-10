#!/usr/bin/env npx tsx
/**
 * experiment-d3-radar.ts (#4846)
 *
 * Mecanismo do experimento "D3 vs slot 1 do Radar" — o único desenho que
 * separa POSIÇÃO de CONTEÚDO na newsletter (auditoria retrospectiva de
 * cliques, 260810). Pré-registro completo (hipótese, medição, poder,
 * regras de parada): `docs/experiments/d3-radar-4846.md`.
 *
 * **Opcional por design, DESLIGADO por padrão** — `platform.config.json` →
 * `experiment_d3_radar.enabled` (default `false`), mesma convenção do
 * `social_critic_pass` (#4505). Esta unidade implementa só o MECANISMO —
 * randomização + seed determinístico + registro. Ativar em produção é uma
 * decisão de ativação SEPARADA (ver #4846), fora do escopo deste código.
 *
 * Roda no Stage 1, DEPOIS do gate humano (`apply-gate-edits.ts` já escreveu
 * `_internal/01-approved.json`). Sorteia — de forma determinística por
 * edição — o braço da edição:
 *
 *   Braço A (controle): o 3º destaque (D3) permanece D3, como hoje. No-op.
 *   Braço B (tratamento): o highlight de rank 3 é removido de `highlights`
 *   (a edição fica com 2 destaques — configuração já suportada pelo #3369,
 *   edge case #2316/#2343) e o MESMO artigo (mesmo processo de seleção, sem
 *   reescrita) é inserido como PRIMEIRO item de `radar[]` — só a
 *   posição/apresentação muda, nunca o conteúdo nem o processo de seleção.
 *
 * A decisão de braço é ÚNICA por edição — sorteada e persistida em
 * `_internal/.experiment-d3.json` na primeira invocação; invocações
 * subsequentes (resume do Stage 1) leem o braço já decidido e NUNCA
 * re-sorteiam. A mutação de `01-approved.json` (braço B) também acontece no
 * máximo 1×, marcada por `applied_at` no state file — reinvocar depois de
 * aplicado é um no-op que reporta `already_applied: true`.
 *
 * Uso:
 *   npx tsx scripts/experiment-d3-radar.ts --edition AAMMDD \
 *     --approved data/editions/AAMMDD/_internal/01-approved.json \
 *     [--state <path, default: <dir de --approved>/.experiment-d3.json>] \
 *     [--config <path, default: platform.config.json>]
 *
 * Exit codes:
 *   0 — braço decidido (e aplicado, se braço B com ≥3 highlights, ou já
 *       aplicado em invocação anterior). Stdout: JSON com o resultado.
 *   1 — erro (args faltando, approved.json ausente/inválido/não-parseável,
 *       state corrompido ou pertencente a outra edição).
 *   2 — desabilitado via config (`experiment_d3_radar.enabled !== true`) —
 *       orchestrator pula o passo sem tratar como falha (mesmo padrão do
 *       `run-social-critic.ts`, #4505).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import type { ApprovedJson, Highlight, Article } from "./lib/schemas/edition-state.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_CONFIG_PATH = resolve(ROOT, "platform.config.json");

// ---------------------------------------------------------------------------
// Config — opt-in, default desligado (mesma convenção do social_critic_pass,
// #4505 / run-social-critic.ts)
// ---------------------------------------------------------------------------

export interface ExperimentD3RadarConfig {
  enabled?: boolean;
}

/**
 * Lê `experiment_d3_radar` de `platform.config.json`. Fail-soft: arquivo
 * ausente, JSON malformado, ou chave ausente → `{ enabled: false }` — um
 * experimento opcional nunca deve ativar sozinho por causa de um config
 * quebrado; o default seguro é "desligado".
 */
export function readExperimentD3RadarConfig(configPath: string): ExperimentD3RadarConfig {
  if (!existsSync(configPath)) return { enabled: false };
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      experiment_d3_radar?: ExperimentD3RadarConfig;
    };
    return cfg.experiment_d3_radar ?? { enabled: false };
  } catch {
    return { enabled: false };
  }
}

export function isExperimentD3RadarEnabled(configPath: string): boolean {
  return readExperimentD3RadarConfig(configPath).enabled === true;
}

// ---------------------------------------------------------------------------
// Randomização determinística (#4846)
// ---------------------------------------------------------------------------

export type ExperimentArm = "A" | "B";

/**
 * Sorteio determinístico 1:1 por edição, via sha256: a mesma edição sempre
 * produz o mesmo braço (idempotente entre invocações/resumes), e edições
 * diferentes se distribuem ~50/50 ao longo de muitas edições (bytes de um
 * digest sha256 são uniformemente distribuídos). `salt` existe só para
 * teste (gera séries alternativas sem precisar inventar edições fictícias).
 */
export function computeArmForEdition(edition: string, salt = "diaria-d3-radar-v1"): ExperimentArm {
  const digest = createHash("sha256").update(`${salt}:${edition}`).digest();
  return digest[0] % 2 === 0 ? "A" : "B";
}

// ---------------------------------------------------------------------------
// State — _internal/.experiment-d3.json (decisão de braço + status de aplicação)
// ---------------------------------------------------------------------------

export interface ExperimentD3RadarState {
  edition: string;
  arm: ExperimentArm;
  decided_at: string;
  applied: boolean;
  reason?: string;
  promoted_url?: string;
  /** Presente só depois que a mutação (ou o no-op definitivo) foi resolvida. */
  applied_at?: string;
}

// ---------------------------------------------------------------------------
// Mutação — braço B: D3 sai de highlights, entra como 1º item do radar
// ---------------------------------------------------------------------------

export interface ApplyArmResult {
  approved: ApprovedJson;
  applied: boolean;
  reason: string;
  promoted_url?: string;
}

function highlightUrl(h: Highlight): string | undefined {
  return (h as { article?: { url?: string } }).article?.url ?? (h as { url?: string }).url;
}

function highlightArticle(h: Highlight): Article {
  const nested = (h as { article?: Article }).article;
  if (nested) return nested;
  // Flat shape (pré-#229) — o próprio highlight já É o article (+ rank/reason
  // no mesmo objeto). Strip os campos de highlight antes de tratar como Article.
  const { rank: _rank, reason: _reason, bucket: _bucket, score: _score, ...rest } =
    h as Record<string, unknown>;
  return rest as Article;
}

/**
 * Aplica o braço sorteado a `approved`.
 *
 * - Braço A: no-op — retorna `approved` inalterado.
 * - Braço B com <3 highlights (edge case editorial dos 2 destaques,
 *   #2316/#2343 — não há D3 pra demover): no-op.
 * - Braço B com ≥3 highlights: remove o highlight de rank 3 (fallback:
 *   índice 2, pra tolerar highlights sem `rank` explícito — não deveria
 *   acontecer pós-`apply-gate-edits.ts`, mas o parse é defensivo) e insere
 *   o artigo correspondente como PRIMEIRO item de `radar[]`, marcado com
 *   `experiment_d3_radar_promoted: true` (auditabilidade — cruza com
 *   `link-layout.json`/`published-links.json`, #4841). Os 2 highlights
 *   remanescentes são renumerados rank 1/2.
 */
export function applyExperimentArm(approved: ApprovedJson, arm: ExperimentArm): ApplyArmResult {
  if (arm === "A") {
    return { approved, applied: false, reason: "control_arm" };
  }

  const highlights = approved.highlights ?? [];
  if (highlights.length < 3) {
    return { approved, applied: false, reason: "insufficient_highlights" };
  }

  const d3Index = highlights.findIndex((h) => (h as { rank?: number }).rank === 3);
  const idx = d3Index !== -1 ? d3Index : 2;
  const d3 = highlights[idx];
  const d3Url = highlightUrl(d3);
  const d3Article = highlightArticle(d3);

  const remaining = highlights
    .filter((_, i) => i !== idx)
    .map((h, i) => ({ ...h, rank: i + 1 }));

  const promotedArticle: Article = { ...d3Article, experiment_d3_radar_promoted: true } as Article;
  const radar = [promotedArticle, ...(approved.radar ?? [])];

  return {
    approved: { ...approved, highlights: remaining, radar },
    applied: true,
    reason: "promoted_to_radar_slot_1",
    promoted_url: d3Url,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const { values: args } = parseArgs(process.argv.slice(2));
  const edition = args.edition;
  const approvedArg = args.approved;
  if (!edition || !approvedArg) {
    console.error(
      "Uso: experiment-d3-radar.ts --edition AAMMDD --approved <path/01-approved.json> [--state <path>] [--config <path>]",
    );
    process.exit(1);
  }

  const configPath = args.config ? resolve(process.cwd(), args.config) : DEFAULT_CONFIG_PATH;
  if (!isExperimentD3RadarEnabled(configPath)) {
    console.error(
      "[experiment-d3-radar] desabilitado (platform.config.json → experiment_d3_radar.enabled !== true) " +
        "— pulando (#4846, opcional/desligado por padrão). Ver docs/experiments/d3-radar-4846.md antes de ativar.",
    );
    process.exit(2);
  }

  const approvedPath = resolve(process.cwd(), approvedArg);
  if (!existsSync(approvedPath)) {
    console.error(`[experiment-d3-radar] approved.json não encontrado: ${approvedPath}`);
    process.exit(1);
  }

  const statePath = args.state
    ? resolve(process.cwd(), args.state)
    : join(dirname(approvedPath), ".experiment-d3.json");

  let state: ExperimentD3RadarState | null = null;
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf8")) as ExperimentD3RadarState;
    } catch (e) {
      console.error(`[experiment-d3-radar] state corrompido em ${statePath}: ${(e as Error).message}`);
      process.exit(1);
    }
    if (state.edition !== edition) {
      console.error(
        `[experiment-d3-radar] state em ${statePath} pertence à edição ${state.edition}, esperava ${edition} — path errado ou state stale de outra edição.`,
      );
      process.exit(1);
    }
  }

  // Idempotência (resume do Stage 1): já resolvido nesta edição (braço A,
  // braço B aplicado, ou braço B sem D3 pra demover) — nunca re-sorteia nem
  // re-muta `01-approved.json`.
  if (state?.applied_at) {
    console.log(
      JSON.stringify(
        {
          edition,
          arm: state.arm,
          applied: state.applied,
          reason: state.reason,
          promoted_url: state.promoted_url,
          already_applied: true,
        },
        null,
        2,
      ),
    );
    return;
  }

  const arm = state?.arm ?? computeArmForEdition(edition);
  const decidedAt = state?.decided_at ?? new Date().toISOString();

  // Persistir a decisão de braço IMEDIATAMENTE, antes de mutar
  // `01-approved.json` — um crash entre a decisão e a mutação ainda
  // preserva o braço sorteado pra próxima invocação (nunca re-sorteia).
  writeFileSync(
    statePath,
    JSON.stringify({ edition, arm, decided_at: decidedAt, applied: false }, null, 2),
    "utf8",
  );

  let approved: ApprovedJson;
  try {
    approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
  } catch (e) {
    console.error(`[experiment-d3-radar] approved.json não parseável: ${(e as Error).message}`);
    process.exit(1);
  }

  const result = applyExperimentArm(approved, arm);

  if (result.applied) {
    writeFileSync(approvedPath, JSON.stringify(result.approved, null, 2), "utf8");
  }

  const finalState: ExperimentD3RadarState = {
    edition,
    arm,
    decided_at: decidedAt,
    applied: result.applied,
    reason: result.reason,
    promoted_url: result.promoted_url,
    applied_at: new Date().toISOString(),
  };
  writeFileSync(statePath, JSON.stringify(finalState, null, 2), "utf8");

  console.log(
    JSON.stringify(
      { edition, arm, applied: result.applied, reason: result.reason, promoted_url: result.promoted_url },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
