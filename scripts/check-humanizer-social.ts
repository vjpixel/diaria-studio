#!/usr/bin/env npx tsx
/**
 * check-humanizer-social.ts (#2279, #2373, #2529)
 *
 * Sentinel determinístico para garantir que o humanizador rodou no social
 * e que o `03-social.md` não foi editado depois da humanização sem re-humanizar.
 *
 * Modos:
 *   --write   Grava `_internal/.humanizer-social-done.json` com sha256 do
 *             `03-social.md` atual. Chamar APÓS humanização bem-sucedida.
 *
 *             Se um sentinel anterior já existe e hash diverge (social foi editado
 *             após a humanização anterior), --write EXIGE --bypass-reason para
 *             evitar uso como atalho que bypassa a humanização (#2373).
 *             Sem --bypass-reason nesse caso: exit 3 com mensagem de erro.
 *
 *   --check   Compara o hash armazenado com o sha256 atual do `03-social.md`.
 *             Exit 0 = hash bate (humanizador rodou e social não mudou depois).
 *             Exit 1 = sentinel ausente (humanizador nunca rodou).
 *             Exit 2 = hash diverge (social editado/reordenado pós-humanização
 *                      sem re-humanizar).
 *
 *             Quando exit 2 (hash diverge), o guard também roda lint de tics de IA
 *             determinísticos (#2529) sobre o `03-social.md` editado e emite
 *             WARNs adicionais no stderr se tics forem detectados. O lint usa
 *             `lintAntithesisReveal` de lint-social-md.ts. A decisão de
 *             re-humanizar fica com o editor/orchestrator — não é bloqueio extra.
 *             Logar a decisão (acusou / passou limpo) no run-log via log-event.ts
 *             quando --edition-dir é fornecido (sempre o caso no Stage 4).
 *
 * Flags:
 *   --bypass-reason <motivo>   (opcional, só válido com --write)
 *             Registra o motivo no sentinel quando --write é chamado com hash
 *             divergente (ex: "humanizador re-rodou após ajuste D1↔D2 no Stage 4").
 *             OBRIGATÓRIO quando --write é chamado após edição pós-humanização
 *             para garantir rastreabilidade (#2373).
 *
 * Uso:
 *   npx tsx scripts/check-humanizer-social.ts --write --edition-dir data/editions/AAMMDD/
 *   npx tsx scripts/check-humanizer-social.ts --check --edition-dir data/editions/AAMMDD/
 *   npx tsx scripts/check-humanizer-social.ts --write --bypass-reason "humanizador re-rodou após ajuste Stage 4" --edition-dir data/editions/AAMMDD/
 *
 * Integração com Stage 4 (§4c.2b, §4d.1): checar antes do gate humano para garantir
 * que qualquer edição/reorder pós-Stage-2 re-dispara o humanizador.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseArgs } from "./lib/cli-args.ts";
import { lintAntithesisReveal, type AntithesisRevealMatch } from "./lint-social-md.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SENTINEL_FILENAME = ".humanizer-social-done.json";

export interface HumanizerSocialSentinel {
  social_sha256: string;
  written_at: string;
  /** Razão de bypass quando --write foi chamado após edição pós-humanização (#2373). */
  bypass_reason?: string;
}

/**
 * Calcula sha256 do arquivo 03-social.md.
 */
export function computeSocialHash(socialPath: string): string {
  const content = readFileSync(socialPath, "utf8");
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

/**
 * Escreve o sentinel `.humanizer-social-done.json` em `_internal/`.
 * Deve ser chamado logo após a humanização bem-sucedida do social.
 *
 * Guard (#2373): se um sentinel anterior existe e o hash diverge (social foi editado
 * após a humanização anterior), `bypassReason` é OBRIGATÓRIO — forçar rastreabilidade.
 * Sem `bypassReason` nesse caso, lança erro (use --bypass-reason na CLI).
 *
 * @param editionDir  Diretório da edição (ex: data/editions/AAMMDD/)
 * @param bypassReason  (opcional) Motivo registrado quando --write é chamado após edição
 *                      pós-humanização. Obrigatório quando hash diverge.
 * @returns path do sentinel gravado
 */
export function writeSentinel(editionDir: string, bypassReason?: string): string {
  const socialPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialPath)) {
    throw new Error(`check-humanizer-social: 03-social.md não existe em ${editionDir}`);
  }
  const internalDir = join(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const sentinelPath = join(internalDir, SENTINEL_FILENAME);

  // Guard #2373: se sentinel anterior existe e hash diverge, exigir bypassReason
  // para evitar uso de --write como atalho que bypassa a humanização.
  if (existsSync(sentinelPath)) {
    let existing: HumanizerSocialSentinel | null = null;
    try {
      existing = JSON.parse(readFileSync(sentinelPath, "utf8")) as HumanizerSocialSentinel;
    } catch {
      // Sentinel corrompido — pode sobrescrever sem guard.
    }
    if (existing?.social_sha256) {
      const currentHash = computeSocialHash(socialPath);
      if (existing.social_sha256 !== currentHash && !bypassReason) {
        throw new Error(
          "check-humanizer-social: 03-social.md foi editado após a última humanização " +
          "(hash diverge) e --bypass-reason não foi fornecido. " +
          "Re-rodar o humanizador ANTES de --write, ou passar --bypass-reason se " +
          "o humanizador já rodou nesta sessão (#2373).",
        );
      }
    }
  }

  const sentinel: HumanizerSocialSentinel = {
    social_sha256: computeSocialHash(socialPath),
    written_at: new Date().toISOString(),
    ...(bypassReason ? { bypass_reason: bypassReason } : {}),
  };
  writeFileSync(sentinelPath, JSON.stringify(sentinel, null, 2) + "\n", "utf8");
  return sentinelPath;
}

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: "sentinel_missing" }
  | { ok: false; reason: "hash_mismatch"; stored: string; current: string };

/**
 * Verifica se o sentinel existe e o hash armazenado bate com `03-social.md` atual.
 *
 * Retorna um objeto estruturado — o caller (main / invariant check) decide
 * o exit code e a mensagem de erro.
 */
export function checkSentinel(editionDir: string): CheckResult {
  const socialPath = resolve(editionDir, "03-social.md");
  const sentinelPath = join(editionDir, "_internal", SENTINEL_FILENAME);

  if (!existsSync(sentinelPath)) {
    return { ok: false, reason: "sentinel_missing" };
  }

  // Se 03-social.md não existe mas o sentinel existe, isso é erro: Stage 2 já
  // rodou (sentinel prova isso) mas o arquivo sumiu (Drive pull falhou, etc.).
  if (!existsSync(socialPath)) {
    return { ok: false, reason: "sentinel_missing" };
  }

  let stored: HumanizerSocialSentinel;
  try {
    stored = JSON.parse(readFileSync(sentinelPath, "utf8")) as HumanizerSocialSentinel;
  } catch {
    return { ok: false, reason: "sentinel_missing" };
  }

  // Guard contra sentinel malformado: JSON parseou mas falta social_sha256.
  if (!stored?.social_sha256) {
    return { ok: false, reason: "sentinel_missing" };
  }

  const current = computeSocialHash(socialPath);
  if (stored.social_sha256 !== current) {
    return { ok: false, reason: "hash_mismatch", stored: stored.social_sha256, current };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// #2529: Tic lint on mismatch — roda quando hash diverge (social editado pós-humanização)
// ---------------------------------------------------------------------------

/**
 * Resultado do lint de tics de IA sobre o social editado pós-humanizador.
 * WARN-ONLY: `tics_found` informa se há tics; não bloqueia o gate por si só.
 * O hash mismatch (exit 2) já é o sinal de bloqueio — o tic lint é informativo,
 * dando ao editor mais contexto para decidir se re-humaniza.
 */
export interface TicLintResult {
  /** true = lint rodou sem erros (tics pode existir ainda — ver `tics_found`). */
  ok: true;
  /** Se algum tic determinístico foi detectado no social editado. */
  tics_found: boolean;
  /** Matches de antítese-revelação detectados (pode estar vazio). */
  antithesis_matches: AntithesisRevealMatch[];
}

/**
 * #2529: roda lint de tics determinísticos sobre o `03-social.md` editado.
 * Chamado internamente pelo `--check` quando o hash diverge (exit 2).
 *
 * Só usa `lintAntithesisReveal` de lint-social-md.ts — o único tic check
 * disponível no lint-social-md.ts que: (a) cobre construções de IA, (b) é
 * WARN-ONLY por design (#2526), (c) roda sobre qualquer conteúdo do MD.
 * Travessões e anglicismos não têm equivalente check em lint-social-md.ts
 * (os existentes são de CTA e schema), então não incluídos (#2529 decisão).
 */
export function lintTicsOnMismatch(socialPath: string): TicLintResult {
  if (!existsSync(socialPath)) {
    return { ok: true, tics_found: false, antithesis_matches: [] };
  }
  const md = readFileSync(socialPath, "utf8");
  const antithesisResult = lintAntithesisReveal(md);
  return {
    ok: true,
    tics_found: antithesisResult.matches.length > 0,
    antithesis_matches: antithesisResult.matches,
  };
}

/**
 * Loga o resultado do tic lint via `scripts/log-event.ts` (fire-and-forget).
 * Falha silenciosa — o lint result já foi emitido no stderr.
 */
function logTicLintEvent(editionDir: string, result: TicLintResult): void {
  // Extrair AAMMDD do editionDir (último componente sem trailing slash)
  const normalized = editionDir.replace(/[/\\]+$/, "");
  const edition = normalized.split(/[/\\]/).pop() ?? "unknown";
  const logScriptPath = resolve(ROOT, "scripts/log-event.ts");
  if (!existsSync(logScriptPath)) return; // defensive — skip em testes sem scripts/

  const level = result.tics_found ? "warn" : "info";
  const message = result.tics_found
    ? `social_tic_lint: hash diverge E tics detectados (${result.antithesis_matches.length} antítese-revelação) — considerar re-humanizar`
    : "social_tic_lint: hash diverge mas sem tics detectados — edição pode ser só remoção de tic";

  const details = JSON.stringify({
    tics_found: result.tics_found,
    antithesis_count: result.antithesis_matches.length,
    kind: "humanizer_social_tic_lint",
  });

  try {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", logScriptPath,
        "--edition", edition,
        "--stage", "4",
        "--agent", "check-humanizer-social",
        "--level", level,
        "--message", message,
        "--details", details,
      ],
      { encoding: "utf8", stdio: "ignore" },
    );
    // Surface spawn errors (e.g. tsx resolver failure on Windows) without breaking prod.
    if (r.error) {
      console.warn(`[check-humanizer-social] logTicLintEvent: spawn falhou — ${r.error.message} (tic log perdido)`);
    } else if (r.status !== 0 && r.status !== null) {
      console.warn(`[check-humanizer-social] logTicLintEvent: log-event.ts saiu com status ${r.status} (tic log pode estar incompleto)`);
    }
  } catch (e: unknown) {
    // fire-and-forget: never block on log failure
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[check-humanizer-social] logTicLintEvent: erro inesperado — ${msg} (tic log perdido)`);
  }
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];

  if (!editionDirArg) {
    console.error("Uso: check-humanizer-social.ts [--write|--check] --edition-dir data/editions/AAMMDD/ [--bypass-reason <motivo>]");
    process.exit(1);
  }

  const editionDir = resolve(ROOT, editionDirArg);
  const bypassReason = values["bypass-reason"];

  if (flags.has("write")) {
    try {
      const path = writeSentinel(editionDir, bypassReason);
      const out: Record<string, unknown> = { ok: true, sentinel_path: path };
      if (bypassReason) out["bypass_reason"] = bypassReason;
      console.log(JSON.stringify(out));
      process.exit(0);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("hash diverge") || msg.includes("--bypass-reason")) {
        // Guard #2373: hash diverge sem bypass-reason — exit 3 (distinguível de I/O errors)
        console.error(`[check-humanizer-social] BYPASS REQUIRED — ${msg}`);
        process.exit(3);
      }
      console.error(`[check-humanizer-social] ERRO ao gravar sentinel: ${msg}`);
      process.exit(1);
    }
  } else if (flags.has("check")) {
    try {
      const result = checkSentinel(editionDir);
      if (result.ok) {
        console.log(JSON.stringify({ ok: true }));
        process.exit(0);
      }
      if (result.reason === "sentinel_missing") {
        console.error(
          "[check-humanizer-social] FAIL — sentinel ausente: humanizador não rodou no social " +
          "ou 03-social.md foi editado e sentinel não foi atualizado. " +
          "Re-rodar humanizador e gravar sentinel com --write.",
        );
        process.exit(1);
      }
      if (result.reason === "hash_mismatch") {
        console.error(
          "[check-humanizer-social] FAIL — 03-social.md mudou após humanização (hash diverge). " +
          `stored=${result.stored.slice(0, 12)}… current=${result.current.slice(0, 12)}… ` +
          "Re-humanizar 03-social.md e gravar sentinel com --write.",
        );

        // #2529: lint de tics de IA sobre o social editado (WARN-ONLY, não bloqueia além do exit 2)
        const socialPath = resolve(editionDir, "03-social.md");
        const ticResult = lintTicsOnMismatch(socialPath);
        if (ticResult.tics_found) {
          console.error(
            `[check-humanizer-social] ⚠️  TICS DE IA DETECTADOS no social editado pós-humanizador (#2529):`,
          );
          for (const m of ticResult.antithesis_matches) {
            console.error(`  linha ${m.line} [antítese-revelação/${m.pattern}]: "...${m.context}..."`);
          }
          console.error(
            "[check-humanizer-social] ⚠️  Considere re-humanizar antes de aprovar o gate.",
          );
        } else {
          console.error(
            "[check-humanizer-social] ℹ️  Lint de tics: nenhum tic detectado na edição — " +
            "a edição pode ter sido apenas remoção de tic (#2529).",
          );
        }

        // Logar decisão no run-log para rastreabilidade (#2529)
        logTicLintEvent(editionDir, ticResult);

        process.exit(2);
      }
      // Exhaustiveness guard — should never reach here
      console.error("[check-humanizer-social] INTERNAL ERROR: unhandled CheckResult");
      process.exit(1);
    } catch (e) {
      console.error(`[check-humanizer-social] ERRO no check: ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    console.error("Especifique --write ou --check.");
    process.exit(1);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
