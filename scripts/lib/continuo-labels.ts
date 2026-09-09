/**
 * scripts/lib/continuo-labels.ts (#7704)
 *
 * Fonte única das specs (nome/cor/descrição) dos 3 labels que o gate de
 * merge do contínuo aplica em PR, mais a criação idempotente deles via
 * REST.
 *
 * **Por que existe (achado ao vivo, 09/09/2026).** As specs viviam
 * duplicadas em 3 lugares — duas cópias literais em
 * `hermes/scripts/continuo-pr-review.sh` (`gh label create ... || true`) e
 * uma em `scripts/mark-continuo-ci-fix-attempted.ts` — e **as três**
 * traziam uma `--description` acima do teto de 100 caracteres do GitHub.
 * Toda chamada de criação saía `HTTP 422: description is too long`, o erro
 * era engolido (`|| true` no bash, `catch {}` vazio no TS), e o
 * `gh pr edit --add-label` seguinte falhava porque o label simplesmente não
 * existia — também engolido. Resultado: `continuo-escalado` e
 * `continuo-rejeitado` nunca existiram no repo, e o pickup de PR rejeitada
 * do §3 passo 1 de `hermes-diaria-continuo/SKILL.md` (que dispara AO ACHAR
 * o label) nunca teve o que achar. `continuo-ci-fix-tentado` existia com
 * descrição VAZIA, criado por outro caminho — a prova de que a criação
 * pelo script nunca funcionou para nenhum dos três.
 *
 * O teto de 100 é do GitHub, não nosso: `POST /repos/{o}/{r}/labels`
 * responde 422 acima disso. `test/continuo-labels.test.ts` trava cada
 * descrição contra `GITHUB_LABEL_DESCRIPTION_MAX` — encurtar aqui e
 * esquecer de medir é justamente como isto passou despercebido.
 *
 * @see scripts/lib/gh-pr-safe-edit.ts (`addPrLabelsRest` — a APLICAÇÃO do
 *   label, também por REST e também com releitura pós-escrita, #6292)
 * @see hermes/scripts/continuo-pr-review.sh
 */
import { spawnGhSync, type GhSpawnResult } from "./shared/gh-run.ts";
import { CONTINUO_ESCALATED_LABEL } from "./continuo-escalate-owner.ts";
import { CONTINUO_REJECTED_LABEL } from "./continuo-reject-owner.ts";
import { CI_FIX_ATTEMPTED_LABEL } from "./continuo-ci-fixer-eligibility.ts";

export type GhRunFn = (args: string[], cwd: string) => GhSpawnResult;

/** Teto do campo `description` de um label no GitHub. Acima disso a API
 * responde `422 Validation Failed: description is too long (maximum is 100
 * characters)` — o erro que deixou os 3 labels do contínuo sem existir
 * (#7704). */
export const GITHUB_LABEL_DESCRIPTION_MAX = 100;

export interface ContinuoLabelSpec {
  /** Nome do label. IMPORTADO da lib de decisão de cada ramo
   * (`continuo-escalate-owner.ts`, `continuo-reject-owner.ts`,
   * `continuo-ci-fixer-eligibility.ts`), nunca redigitado aqui — quem
   * DECIDE pelo label (`isAlreadyEscalated` & cia.) e quem o CRIA precisam
   * ler o mesmo literal, senão a criação e a detecção divergem em
   * silêncio. */
  readonly name: string;
  /** Cor hex SEM `#` (formato que a API do GitHub aceita). */
  readonly color: string;
  /** ≤ `GITHUB_LABEL_DESCRIPTION_MAX` chars. A referência à issue fica na
   * descrição porque é o que um humano vê ao filtrar no GitHub; o rationale
   * longo mora nas docstrings das libs, não aqui. */
  readonly description: string;
}

export const CONTINUO_ESCALATED_LABEL_SPEC: ContinuoLabelSpec = {
  name: CONTINUO_ESCALATED_LABEL,
  color: "D93F0B",
  description: "Escalada pelo gate de merge do contínuo (#7446) — revisão humana ou pickup do overnight",
};

export const CONTINUO_REJECTED_LABEL_SPEC: ContinuoLabelSpec = {
  name: CONTINUO_REJECTED_LABEL,
  color: "B60205",
  description: "Rejeitada pelo gate de merge do contínuo (#7567) — decidir entre consertar ou fechar",
};

export const CONTINUO_CI_FIX_ATTEMPTED_LABEL_SPEC: ContinuoLabelSpec = {
  name: CI_FIX_ATTEMPTED_LABEL,
  color: "5319E7",
  description: "1 tentativa de conserto de CI já feita pelo contínuo (#7446) — não retentar",
};

export const CONTINUO_LABEL_SPECS: readonly ContinuoLabelSpec[] = [
  CONTINUO_ESCALATED_LABEL_SPEC,
  CONTINUO_REJECTED_LABEL_SPEC,
  CONTINUO_CI_FIX_ATTEMPTED_LABEL_SPEC,
];

export interface EnsureLabelResult {
  ok: boolean;
  /** `"created"` = não existia e foi criado; `"exists"` = já existia (a API
   * responde 422 `already_exists`, que NÃO é erro aqui). */
  outcome?: "created" | "exists";
  error?: string;
}

/** `true` só pro 422 de nome duplicado — qualquer outro 422 (descrição longa
 * demais, cor inválida) é falha real e precisa aparecer. Era exatamente a
 * distinção que o `|| true` do bash não fazia. */
function isAlreadyExists(output: string): boolean {
  return /already_exists|already exists/i.test(output);
}

/**
 * Cria o label se ausente, via `POST /repos/{owner}/{repo}/labels`. Nunca
 * usa `gh label create` — ele mistura "já existe" com erro de validação num
 * único exit 1, e é isso que os call sites vinham engolindo com `|| true`.
 *
 * `{owner}`/`{repo}` são resolvidos pelo próprio `gh` a partir do remote
 * `origin` do `cwd` (mesmo padrão de `gh-pr-safe-edit.ts`).
 */
export function ensureContinuoLabel(
  spec: ContinuoLabelSpec,
  cwd: string,
  ghRun: GhRunFn = spawnGhSync,
): EnsureLabelResult {
  if (spec.description.length > GITHUB_LABEL_DESCRIPTION_MAX) {
    return {
      ok: false,
      error:
        `descrição do label "${spec.name}" tem ${spec.description.length} chars, acima do teto ` +
        `de ${GITHUB_LABEL_DESCRIPTION_MAX} do GitHub — a API responderia 422 e o label nunca existiria (#7704)`,
    };
  }

  const res = ghRun(
    [
      "api",
      "-X",
      "POST",
      "repos/{owner}/{repo}/labels",
      "-f",
      `name=${spec.name}`,
      "-f",
      `color=${spec.color}`,
      "-f",
      `description=${spec.description}`,
    ],
    cwd,
  );
  if (res.status === 0) return { ok: true, outcome: "created" };

  const output = `${res.stderr}\n${res.stdout}`;
  if (isAlreadyExists(output)) return { ok: true, outcome: "exists" };

  return {
    ok: false,
    error: `gh api POST labels (${spec.name}) falhou: ${res.stderr.trim() || res.stdout.trim() || "sem saída"}`,
  };
}
