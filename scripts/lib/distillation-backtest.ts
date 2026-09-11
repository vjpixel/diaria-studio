/**
 * scripts/lib/distillation-backtest.ts (#7981, Camada 3 da #7972 — Fase 7)
 *
 * Backtest DETERMINÍSTICO contra os lints/invariantes de produção já
 * existentes (issue #7981: "diff estrutural determinístico contra todas as
 * instâncias históricas do tipo de pedido: overflow de texto do carrossel,
 * lint da newsletter, 'agêntico nunca agentivo', título até 52
 * caracteres"). Mede a taxa histórica de violação de cada check — a
 * evidência de que um padrão de correção é REAL e RECORRENTE, não um
 * incidente isolado, antes de propor qualquer mudança de prompt.
 *
 * Read-only: só LÊ arquivos já produzidos por edições passadas
 * (`03-social.md`, `02-reviewed.md`, `_internal/scoring-features.json`) —
 * nunca escreve, nunca re-gera nada.
 *
 * Leitura das taxas (achado ao vivo contra o corpus real, 11/09/2026,
 * mesma disciplina de `calibrate-scoring-weights.ts`/#7990 pro gate de
 * cap de domínio): `newsletter-lint-gate-blocking` roda TODAS as regras
 * atuais (`context/editorial-rules.md` de HOJE) contra `02-reviewed.md`
 * de edições passadas, muitas delas escritas sob regras mais antigas —
 * uma taxa alta aqui (medida: ~98%) não significa "a pipeline está
 * quebrada", significa "as regras evoluíram desde então". `title-length-
 * 52-chars` (medida: 100%) é o oposto — mede uma regra que NUNCA mudou
 * (#0, desde sempre no template) contra o campo já extraído
 * (`title_char_count`), então uma taxa alta ali é sinal genuíno de
 * padrão recorrente, não artefato de regra que mudou. `distill-prompt-
 * corrections.ts` usa estas taxas como CONTEXTO/evidência de
 * recorrência, nunca como corte automático — decisão do editor no
 * sign-off, não deste módulo.
 *
 * Reusa 4 mecanismos já existentes, nenhum duplicado:
 * 1. `checkCarouselTextOverflow` (`lib/invariant-checks/stage-4.ts`, #6078) —
 *    overflow de texto do carrossel diário.
 * 2. `checkBannedLexicon` (`lib/lint-checks/banned-lexicon.ts`, #7260) —
 *    léxico banido, cobre "agentivo" → "agêntico".
 * 3. `lintNewsletterMd` (`lint-newsletter-md.ts`) — agregado de todos os
 *    lints GATE-BLOCKING da newsletter.
 * 4. `title_char_count` de `ScoringFeatureRow` (#7975, `scoring-features.ts`)
 *    — título ≤52 chars NÃO tem checker mecânico dedicado hoje (só
 *    orientativo no prompt do writer, igual o cap de carrossel era antes do
 *    #6439) — medido diretamente do feature store já persistido, sem
 *    reimplementar extração de título.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { enumerateEditionDirs } from "./find-current-edition.ts";
import { checkCarouselTextOverflow } from "./invariant-checks/stage-4.ts";
import { checkBannedLexicon } from "./lint-checks/banned-lexicon.ts";
import { runStage2LintReport } from "../lint-newsletter-md.ts";
import type { ScoringFeatureRow } from "./scoring-features.ts";

export const TITLE_MAX_CHARS = 52;

export interface BacktestCheckResult {
  name: string;
  editions_evaluated: number;
  editions_with_violation: number;
  violation_rate: number;
}

export interface DistillationBacktestReport {
  editions_analyzed: number;
  checks: BacktestCheckResult[];
}

function safeReadText(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function backtestCheck(
  editionDirsByAammdd: ReadonlyMap<string, string>,
  name: string,
  hasViolation: (edition: string, dir: string) => boolean | null,
): BacktestCheckResult {
  let evaluated = 0;
  let withViolation = 0;
  for (const [edition, dir] of editionDirsByAammdd) {
    const result = hasViolation(edition, dir);
    if (result === null) continue; // arquivo ausente pra esta edição — não é "sem violação", é "não avaliável", excluído do denominador
    evaluated++;
    if (result) withViolation++;
  }
  return {
    name,
    editions_evaluated: evaluated,
    editions_with_violation: withViolation,
    violation_rate: evaluated > 0 ? withViolation / evaluated : 0,
  };
}

/** Roda os 4 checks nomeados contra todo o corpus de `editionsRoot`. `rootDir` (raiz do repo) é passado pra `runStage2LintReport`, que precisa dele pra resolver outros arquivos de config/lint (ex: `context/editorial-rules.md`). */
export function runDistillationBacktest(editionsRoot: string, rootDir: string): DistillationBacktestReport {
  const editionDirsByAammdd = enumerateEditionDirs(editionsRoot);

  const carouselOverflow = backtestCheck(editionDirsByAammdd, "carousel-text-overflow", (_edition, dir) => {
    if (!existsSync(join(dir, "03-social.md"))) return null;
    try {
      return checkCarouselTextOverflow(dir).length > 0;
    } catch {
      return null; // estrutura inesperada (destaque_count ausente etc.) — não avaliável, nunca fabricado
    }
  });

  const bannedLexicon = backtestCheck(editionDirsByAammdd, "banned-lexicon", (_edition, dir) => {
    const md = safeReadText(join(dir, "02-reviewed.md"));
    if (md === null) return null;
    try {
      return !checkBannedLexicon(md).ok;
    } catch {
      return null;
    }
  });

  const newsletterLint = backtestCheck(editionDirsByAammdd, "newsletter-lint-gate-blocking", (_edition, dir) => {
    if (!existsSync(join(dir, "02-reviewed.md"))) return null;
    try {
      const report = runStage2LintReport(dir, rootDir);
      return !report.passed;
    } catch {
      return null;
    }
  });

  const titleLength = backtestCheck(editionDirsByAammdd, "title-length-52-chars", (_edition, dir) => {
    const featuresPath = join(dir, "_internal", "scoring-features.json");
    if (!existsSync(featuresPath)) return null;
    try {
      const payload = JSON.parse(readFileSync(featuresPath, "utf8"));
      const rows: ScoringFeatureRow[] = Array.isArray(payload?.rows) ? payload.rows : [];
      const highlightRows = rows.filter((r) => r.bucket === "highlights");
      if (highlightRows.length === 0) return null; // sem destaque nesta edição no feature store — não avaliável
      return highlightRows.some((r) => r.title_char_count > TITLE_MAX_CHARS);
    } catch {
      return null;
    }
  });

  return {
    editions_analyzed: editionDirsByAammdd.size,
    checks: [carouselOverflow, bannedLexicon, newsletterLint, titleLength],
  };
}
