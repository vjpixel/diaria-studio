/**
 * block-staleness.ts (#6259)
 *
 * A re-varredura de convergência (`state-changed-tracker.ts`/#5706) só
 * responde "apareceu issue NOVA em `gh issue list`?" — uma issue que sai de
 * *indisponível* (PR em voo cobrindo o mesmo escopo, claim de outra sessão
 * ativa, label de bloqueio ainda aplicada) para *disponível* sem nenhuma
 * issue nova sendo criada fica invisível pra esse mecanismo, mesmo
 * representando trabalho igualmente pronto pra dispatch.
 *
 * Achado ao vivo (#6259, rodada overnight 260826): 5 issues do
 * `plan.json` estavam `status: "pulada"`, `motivo: "pr-em-voo"`. Ao
 * reconferir, 4 dos PRs citados já tinham MERGED havia horas — o motivo do
 * bloqueio tinha caducado e nenhum re-scan de convergência (que só olha
 * `gh issue list` por issue nova) detectava isso.
 *
 * Este módulo cobre as 3 transições descritas na issue como "libera
 * trabalho sem criar issue nova":
 *
 * 1. **`pr-em-voo`** — o PR citado (campo `pr`, ou extraído do texto livre
 *    de `nota` via `/PR\s*#(\d+)/i`, porque a prática observada no
 *    `plan.json` real grava o número só em prosa) já está `MERGED`/`CLOSED`.
 * 2. **`claimed-por-outra-sessao`** — nenhuma sessão ativa (não-stale)
 *    segura mais a issue em `claimed_issues` (`session-registry.ts`).
 * 3. **`bloqueio-execucao`** — NENHUMA label de bloqueio real
 *    (`BLOCKED_LABELS_SET`, reexportado de `issue-exec-track.ts` —
 *    `external-blocker`, `kit-migration`, `beehiiv`, `bloqueio-execucao`)
 *    está mais presente na issue. **#6754**: checar só a label
 *    `bloqueio-execucao` isoladamente dava falso positivo numa issue
 *    bloqueada por `kit-migration` (sem `bloqueio-execucao` presente) — o
 *    motivo do `plan.json` é sempre a categoria `bloqueio-execucao`
 *    (nome da TRANSIÇÃO, não da label), mas a label real que sustenta o
 *    bloqueio pode ser qualquer uma do conjunto.
 *

 * **Motivos explicitamente EXCLUÍDOS de propósito** (não são caducáveis por
 * este mecanismo — ver corpo da issue #6259, seção "Motivos NÃO
 * transitórios"): `bloqueio-externo` (conta de terceiro — só o editor
 * destrava, nenhuma sessão vizinha terminando muda isso), `requer-sessao-local`
 * (restrição de MÁQUINA, não de disputa entre sessões — label `windows`
 * nunca "some" por outra sessão terminar), `ambigua`/`trade-off-real`
 * (esperam decisão humana, não um evento mecânico). Tratar qualquer um
 * desses como caducável reabriria bloqueio genuíno só porque o texto do
 * motivo parece parecido — por isso a checagem é por **motivo exato**, não
 * heurística de texto.
 *
 * A parte PURA (`findStaleBlocks`) recebe um `BlockStalenessConsultor`
 * injetável — nenhuma chamada de rede/`gh`/`session-registry` acontece
 * aqui, só no CLI (`scripts/check-block-staleness.ts`), que monta o
 * consultor real. Isso permite testar as 3 transições com fixtures
 * determinísticas, zero rede (mesmo padrão de
 * `scripts/lib/state-changed-tracker.ts`).
 *
 * @see scripts/check-block-staleness.ts (CLI/entrypoint, monta o consultor real)
 * @see scripts/lib/state-changed-tracker.ts (irmão — cobre issue NOVA, não bloqueio caducado)
 * @see scripts/lib/session-registry.ts (`isIssueClaimedByOther`, fonte do consultor de claim)
 * @see context/overnight-dispatch-rules.md
 * @see .claude/skills/diaria-overnight/SKILL.md
 * @see .claude/skills/diaria-develop/SKILL.md
 */

/** Entrada mínima de `plan.json.issues[N]` que este módulo precisa — shape
 * agnóstico de overnight (array) vs develop (dict); o chamador já normaliza
 * via `normalizeIssues` antes de passar pra cá. */
export interface BlockStalenessPlanIssue {
  number: number;
  status?: string;
  motivo?: string | null;
  pr?: number | null;
  nota?: string | null;
  [key: string]: unknown;
}

/** Os 3 motivos que este mecanismo sabe reavaliar. Qualquer outro motivo
 * de `pulada` (inclusive os explicitamente não-transitórios listados no
 * docblock acima) é ignorado — `findStaleBlocks` nunca reporta falso
 * positivo fora deste conjunto fechado. */
export type StaleBlockCategory = "pr-em-voo" | "claimed-por-outra-sessao" | "bloqueio-execucao";

const TRANSIENT_MOTIVOS: ReadonlySet<string> = new Set<StaleBlockCategory>([
  "pr-em-voo",
  "claimed-por-outra-sessao",
  "bloqueio-execucao",
]);

export interface StaleBlockFinding {
  number: number;
  category: StaleBlockCategory;
  motivo: string;
  reason: string;
}

export type PrState = "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";

/** Labels que, presentes na issue, significam "ainda bloqueada" para efeito
 * da categoria `bloqueio-execucao` (#6754). Reexportado de
 * `issue-exec-track.ts` (`BLOCKED_LABELS_SET`) — não duplicar a lista aqui:
 * o achado ao vivo do #6754 foi exatamente checar só a label
 * `bloqueio-execucao` e ignorar as demais labels de bloqueio real
 * (`external-blocker`, `kit-migration`, `beehiiv`) que `classifyExecTrack`
 * já reconhece. */
import { BLOCKED_LABELS_SET } from "./issue-exec-track.ts";
export { BLOCKED_LABELS_SET };

/**
 * Consultor de estado externo, injetável — implementação real (CLI) chama
 * `gh`/`session-registry.ts`; testes injetam fixtures em memória. Retornos
 * "não sei" (`UNKNOWN`/`null`) nunca viram finding — fail-soft: preferir
 * silêncio a reabrir um bloqueio genuíno por engano.
 */
export interface BlockStalenessConsultor {
  getPrState(prNumber: number): PrState;
  /** `true` = ainda reivindicada por sessão ativa não-stale; `false` = livre. */
  isIssueClaimedActive(issueNumber: number): boolean;
  /** `true`/`false` = presença confirmada; `null` = não verificável (gh
   * indisponível) — nunca reportar caducidade nesse caso. */
  hasLabel(issueNumber: number, label: string): boolean | null;
}

/** Pure: extrai o número do PR citado numa entrada — prioriza o campo
 * estruturado `pr`; cai pro texto livre de `nota` (`/PR\s*#(\d+)/i`) porque
 * a prática observada no `plan.json` real (rodada 260826) grava o número
 * só em prosa (`"PR #6216 aberto por outra sessao..."`), nunca no campo
 * `pr`. `null` quando nenhuma das duas fontes tem um número — o chamador
 * trata como "não verificável", nunca como caducado. */
export function extractPrNumber(entry: BlockStalenessPlanIssue): number | null {
  if (typeof entry.pr === "number" && Number.isFinite(entry.pr)) return entry.pr;
  const nota = typeof entry.nota === "string" ? entry.nota : "";
  const match = nota.match(/PR\s*#(\d+)/i);
  return match ? Number(match[1]) : null;
}

/**
 * Pure: entre as issues `pulada` do plano, devolve as que têm motivo
 * transitório e cujo consultor confirma que o bloqueio já caducou. Nunca
 * reporta issue com motivo fora de `TRANSIENT_MOTIVOS`, nem issue cujo
 * consultor devolveu "não sei" — ver docblock do módulo.
 */
export function findStaleBlocks(
  issues: readonly BlockStalenessPlanIssue[],
  consultor: BlockStalenessConsultor,
): StaleBlockFinding[] {
  const findings: StaleBlockFinding[] = [];

  for (const entry of issues) {
    if (entry.status !== "pulada") continue;
    const motivo = typeof entry.motivo === "string" ? entry.motivo : null;
    if (!motivo || !TRANSIENT_MOTIVOS.has(motivo as StaleBlockCategory)) continue;
    const category = motivo as StaleBlockCategory;

    if (category === "pr-em-voo") {
      const pr = extractPrNumber(entry);
      if (pr === null) continue; // não verificável — nunca falso positivo
      const state = consultor.getPrState(pr);
      if (state === "MERGED" || state === "CLOSED") {
        findings.push({
          number: entry.number,
          category,
          motivo,
          reason: `PR #${pr} já está ${state === "MERGED" ? "mergeado" : "fechado"} — bloqueio caducou`,
        });
      }
      continue;
    }

    if (category === "claimed-por-outra-sessao") {
      const stillClaimed = consultor.isIssueClaimedActive(entry.number);
      if (!stillClaimed) {
        findings.push({
          number: entry.number,
          category,
          motivo,
          reason: "nenhuma sessão ativa segura mais esta issue — claim liberado",
        });
      }
      continue;
    }

    if (category === "bloqueio-execucao") {
      // #6754 — checa TODAS as labels de bloqueio real, não só
      // `bloqueio-execucao` isoladamente: uma issue pode estar bloqueada por
      // `kit-migration`/`external-blocker`/`beehiiv` sem carregar a label
      // `bloqueio-execucao`. Presença confirmada de QUALQUER uma delas ⇒
      // ainda bloqueada (não reporta). `null` (não verificável) em qualquer
      // label ⇒ fail-soft, não reporta. Só reporta quando TODAS foram
      // confirmadas ausentes.
      const results = [...BLOCKED_LABELS_SET].map((label) =>
        consultor.hasLabel(entry.number, label),
      );
      if (results.some((r) => r === true)) continue; // alguma label de bloqueio ainda presente
      if (results.some((r) => r === null)) continue; // alguma não verificável — fail-soft
      findings.push({
        number: entry.number,
        category,
        motivo,
        reason: "nenhuma label de bloqueio (bloqueio-execucao/external-blocker/kit-migration/beehiiv) está mais presente na issue — bloqueio caducou",
      });
      continue;
    }
  }

  return findings.sort((a, b) => a.number - b.number);
}
