/**
 * stage4-post-edit-checks-core.ts (#8123 Fatia 3)
 *
 * Miolo puro (sem I/O de CLI, sem lock, sem exit code) do agregador de
 * checagens determinísticas do Stage 4 — chamado pela CLI
 * `scripts/stage4-post-edit-checks.ts` (rodada em background pelo
 * orchestrator, `.claude/agents/orchestrator-stage-4.md` §4d.1) depois de
 * CADA ajuste inline, substituindo a cadeia de ~6 invocações de processo
 * separadas que o playbook disparava sincronamente antes do gate.
 *
 * Consolida exatamente os mesmos checks que já rodavam em §4b/§4c —
 * nenhuma lógica nova, só uma chamada de processo em vez de várias:
 *   1. `lint-newsletter-md.ts` modo `--stage 4 --json` (agregador já
 *      existente, #5416) — cobre `no-xml-artifacts`, os tic-lints e as
 *      demais ~15 regras de `02-reviewed.md`.
 *   2. `lint-social-md.ts` modo `--stage 4 --json` (idem, #5416) — cobre
 *      `post_pixel-matches-d1`, `no-xml-artifacts` do social, etc.
 *   3. `validate-lancamentos.ts` (modo `<md-path>`, sem `--approved` — o
 *      modo approved ESCREVE de volta em `01-approved.json`; este
 *      agregador é read-only por design, então usa só o modo puro
 *      `validateLancamentos(text, allowlist)`).
 *   4. `validate-domain-diversity.ts` (#5735).
 *   5. `check-invariants.ts --stage 4` (via `getRulesForStage(4)` — inclui
 *      as regras de carrossel `carousel-*`, `intentional-error-present-
 *      in-final`, etc.).
 *   6. `check-humanizer-social.ts --check` (selo do humanizador social) +
 *      `lintTicsOnMismatch` (tics quando o hash diverge).
 *
 * Cada fonte já tem seu próprio teste unitário — este arquivo não
 * reimplementa nenhuma regra, só chama as funções puras já exportadas e
 * normaliza o resultado num único formato de "achado" (`Stage4Finding`).
 *
 * **Sai JSON só com achados** (issue #8123 §3): `findings[]` contém
 * SOMENTE entradas com violação — nenhuma entrada "ok" é emitida. Uma
 * edição limpa produz `findings: []`, barato de notificar ("1 linha,
 * nenhuma ação").
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runStage4LintReport } from "../lint-newsletter-md.ts";
import { runStage4SocialLintReport } from "../lint-social-md.ts";
import { validateLancamentos, loadToolAllowlist } from "../validate-lancamentos.ts";
import { validateDomainDiversity } from "../validate-domain-diversity.ts";
import { getRulesForStage } from "./invariant-checks/index.ts";
import { checkSentinel } from "../check-humanizer-social.ts";
import { hashContent } from "./stage4-cas.ts";

export interface Stage4Finding {
  /** Qual sub-checagem originou o achado — útil pra "onde eu corrijo isso". */
  source:
    | "lint-newsletter"
    | "lint-social"
    | "validate-lancamentos"
    | "validate-domain-diversity"
    | "invariants"
    | "humanizer-social";
  id: string;
  source_issue?: string;
  severity: "error" | "warning";
  /** true = mesma classe de achado que hoje impede o sentinel na aprovação (#8123 §3, "gates bloqueantes continuam bloqueando"). */
  gate_blocking: boolean;
  message: string;
  file?: string;
  line?: number;
}

export interface Stage4PostEditChecksReport {
  generated_at: string;
  edition_dir: string;
  /** Hash de `02-reviewed.md` + `03-social.md` no INÍCIO da rodada — usado pelo caller pra decidir staleness (coalescing) e pra confirmar, na aprovação do gate, que o relatório reflete o estado FINAL. */
  inputs_hash: string;
  ok: boolean;
  /** true = pelo menos 1 achado com `gate_blocking: true`. */
  gate_blocking: boolean;
  findings_count: number;
  findings: Stage4Finding[];
  checks_run: string[];
  duration_ms: number;
}

/**
 * Hash determinístico de `02-reviewed.md`+`03-social.md` — os 2 arquivos que
 * o loop `ajustar` (§4d.1) edita. Ausência de um dos dois (edição sem social
 * ainda escrito, por exemplo) entra no hash como string vazia — ainda
 * determinístico, só não é comparável a um estado com o arquivo presente
 * (o que é o comportamento correto: presença/ausência É uma mudança de estado).
 * @pure
 */
export function computeInputsHash(editionDir: string): string {
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  const socialPath = resolve(editionDir, "03-social.md");
  const reviewed = existsSync(reviewedPath) ? readFileSync(reviewedPath, "utf8") : "";
  const social = existsSync(socialPath) ? readFileSync(socialPath, "utf8") : "";
  // Separador com tamanho explícito evita colisão degenerada tipo
  // ("ab", "") vs ("a", "b") — combinando os hashes individuais, não o
  // texto bruto concatenado.
  return hashContent(`${hashContent(reviewed)}:${hashContent(social)}`);
}

function pushFrom(
  findings: Stage4Finding[],
  source: Stage4Finding["source"],
  items: Array<{
    id: string;
    source_issue?: string;
    severity: "error" | "warning";
    gate_blocking: boolean;
    message: string;
    file?: string;
    line?: number;
  }>,
): void {
  for (const item of items) {
    findings.push({ source, ...item });
  }
}

/**
 * Roda os 6 checks acima sobre `editionDir` e devolve o relatório
 * consolidado. Nunca lança — uma exceção em qualquer sub-checagem vira um
 * achado `gate_blocking: true` (fail-safe, mesmo padrão de `runCheckSafely`
 * em `lint-newsletter-md.ts`) em vez de derrubar as checagens restantes.
 */
export function runStage4PostEditChecks(editionDir: string, root: string): Stage4PostEditChecksReport {
  const startedAt = Date.now();
  const inputsHash = computeInputsHash(editionDir);
  const findings: Stage4Finding[] = [];
  const checksRun: string[] = [];

  const safely = (name: string, fn: () => void): void => {
    checksRun.push(name);
    try {
      fn();
    } catch (err) {
      findings.push({
        source: "invariants",
        id: name,
        severity: "error",
        gate_blocking: true,
        message: `exceção não tratada em ${name}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  // 1. lint-newsletter-md.ts --stage 4 --json
  safely("lint-newsletter:stage-4", () => {
    const report = runStage4LintReport(editionDir, root);
    pushFrom(
      findings,
      "lint-newsletter",
      report.checks
        .filter((c) => !c.ok)
        .map((c) => ({
          id: c.id,
          source_issue: c.source_issue,
          severity: (c.severity === "gate-blocking" ? "error" : "warning") as "error" | "warning",
          gate_blocking: c.severity === "gate-blocking",
          message: `${c.id}: violação (ver result para detalhe)`,
        })),
    );
  });

  // 2. lint-social-md.ts --stage 4 --json (só roda se 03-social.md existir —
  // edição pode estar no meio de um ajuste que ainda não gerou o social).
  const socialPath = resolve(editionDir, "03-social.md");
  if (existsSync(socialPath)) {
    safely("lint-social:stage-4", () => {
      const report = runStage4SocialLintReport(editionDir);
      pushFrom(
        findings,
        "lint-social",
        report.checks
          .filter((c) => !c.ok)
          .map((c) => ({
            id: c.id,
            source_issue: c.source_issue,
            severity: (c.severity === "gate-blocking" ? "error" : "warning") as "error" | "warning",
            gate_blocking: c.severity === "gate-blocking",
            message: `${c.id}: violação (ver result para detalhe)`,
          })),
      );
    });
  }

  // 3. validate-lancamentos.ts (modo <md-path> puro, read-only)
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  if (existsSync(reviewedPath)) {
    safely("validate-lancamentos", () => {
      const text = readFileSync(reviewedPath, "utf8");
      const allowlist = loadToolAllowlist(root);
      const result = validateLancamentos(text, allowlist);
      for (const u of result.invalid_urls) {
        findings.push({
          source: "validate-lancamentos",
          id: "invalid-official-url",
          source_issue: "#160",
          severity: "error",
          gate_blocking: true,
          message: `LANÇAMENTOS com URL não-oficial: ${u.url}`,
          file: "02-reviewed.md",
          line: u.line,
        });
      }
      for (const u of result.not_a_tool) {
        findings.push({
          source: "validate-lancamentos",
          id: "not-a-tool",
          source_issue: "#1968",
          severity: "error",
          gate_blocking: true,
          message: `LANÇAMENTOS sem sinal positivo de produto: ${u.url}`,
          file: "02-reviewed.md",
          line: u.line,
        });
      }
      for (const u of result.non_product) {
        findings.push({
          source: "validate-lancamentos",
          id: "non-product-warn",
          source_issue: "#1799",
          severity: "warning",
          gate_blocking: false,
          message: `LANÇAMENTOS parece governança/política/programa: ${u.url}`,
          file: "02-reviewed.md",
          line: u.line,
        });
      }
    });

    // 4. validate-domain-diversity.ts (#5735)
    safely("validate-domain-diversity", () => {
      const text = readFileSync(reviewedPath, "utf8");
      const report = validateDomainDiversity(text);
      for (const v of report.violations) {
        findings.push({
          source: "validate-domain-diversity",
          id: "domain-diversity-exceeded",
          source_issue: "#5735",
          severity: "error",
          gate_blocking: true,
          message: `${v.domain}: ${v.urls.length} URLs (limite ${report.max_per_domain}) — ${v.urls.map((u) => u.url).join(", ")}`,
          file: "02-reviewed.md",
        });
      }
    });
  }

  // 5. check-invariants.ts --stage 4 (inclui carousel-*, intentional-error-
  // present-in-final, image-crop-warn, etc.)
  safely("invariants:stage-4", () => {
    for (const rule of getRulesForStage(4)) {
      const violations = rule.run(editionDir);
      for (const v of violations) {
        findings.push({
          source: "invariants",
          id: v.rule,
          source_issue: v.source_issue,
          severity: v.severity,
          gate_blocking: v.severity === "error",
          message: v.message,
          file: v.file,
          line: v.line,
        });
      }
    }
  });

  // 6. check-humanizer-social.ts --check (selo do humanizador). Os tic-lints
  // de antítese-revelação/gancho-editorial-emendado (#4505 item 2) NÃO são
  // recalculados aqui — já entram por `lint-social:stage-4` acima
  // (`runStage4SocialLintReport` cobre `no-antithesis-reveal`/
  // `no-trailing-editorial-hook` incondicionalmente, não só quando o hash
  // diverge); duplicar aqui produziria o mesmo achado 2×.
  if (existsSync(socialPath)) {
    safely("humanizer-social:check", () => {
      const result = checkSentinel(editionDir);
      if (!result.ok) {
        findings.push({
          source: "humanizer-social",
          id: `humanizer-social-${result.reason}`,
          source_issue: "#2373",
          severity: "error",
          gate_blocking: true,
          message:
            result.reason === "sentinel_missing"
              ? "selo do humanizador ausente em 03-social.md — humanizador não rodou ou sentinel não foi gravado após edição."
              : `03-social.md mudou após humanização (hash diverge) — stored=${result.stored.slice(0, 12)}… current=${result.current.slice(0, 12)}….`,
          file: "03-social.md",
        });
      }
    });
  }

  const gateBlocking = findings.some((f) => f.gate_blocking);
  return {
    generated_at: new Date().toISOString(),
    edition_dir: editionDir,
    inputs_hash: inputsHash,
    ok: findings.length === 0,
    gate_blocking: gateBlocking,
    findings_count: findings.length,
    findings,
    checks_run: checksRun,
    duration_ms: Date.now() - startedAt,
  };
}
