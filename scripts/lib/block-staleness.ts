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
  /** Número (PR no repo da issue) ou, desde a fatia 4 da #10618, a ref
   * qualificada `owner/repo#N`/URL do PR quando ele mora em OUTRO repo. */
  pr?: number | string | null;
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

/** Pure (#10618, fatia 3): `true` quando `findStaleBlocks` avaliaria a
 * entrada — `pulada` com um dos 3 motivos transitórios. O CLI só avisa
 * "fora da checagem" (identidade desconhecida, repo fora da allowlist) pra
 * entrada que passa daqui: aviso sobre entrada que o gate nunca olharia é
 * ruído. */
export function isTransientBlockEntry(entry: { status?: unknown; motivo?: unknown }): boolean {
  return entry?.status === "pulada" && typeof entry.motivo === "string" && TRANSIENT_MOTIVOS.has(entry.motivo);
}

export interface StaleBlockFinding {
  /** Número da issue no repo DELA (`key` diz qual) — pro diaria-studio é o
   * número legado de sempre. */
  number: number;
  /** #10618 (fatia 3): identidade canônica `owner/repo#N` — sempre presente
   * no que `findStaleBlocks` devolve. Opcional só no tipo: finding montado à
   * mão sem `key` (fixture legada) é lido como diaria-studio#`number`. */
  key?: IssueKey;
  category: StaleBlockCategory;
  motivo: string;
  reason: string;
}

export type PrState = "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";

/** Estado de uma ISSUE (distinto de `PrState` — issue não tem `MERGED`). */
export type IssueState = "OPEN" | "CLOSED" | "UNKNOWN";

/** Labels que, presentes na issue, significam "ainda bloqueada" para efeito
 * da categoria `bloqueio-execucao` (#6754). Reexportado de
 * `issue-exec-track.ts` (`BLOCKED_LABELS_SET`) — não duplicar a lista aqui:
 * o achado ao vivo do #6754 foi exatamente checar só a label
 * `bloqueio-execucao` e ignorar as demais labels de bloqueio real
 * (`external-blocker`, `kit-migration`, `beehiiv`) que `classifyExecTrack`
 * já reconhece. */
import { BLOCKED_LABELS_SET } from "./issue-exec-track.ts";
import { DEFAULT_ISSUE_REPO, normalizeRepoSlug, parseIssueRef } from "./issue-repos.ts";
import {
  compareIssueKeys,
  issueKeyOfPlanEntry,
  issueNumberInRepo,
  isStudioIssueKey,
  repoOfIssueKey,
  toIssueKey,
  type IssueKey,
} from "./issue-key.ts";
export { BLOCKED_LABELS_SET };

/**
 * Consultor de estado externo, injetável — implementação real (CLI) chama
 * `gh`/`session-registry.ts`; testes injetam fixtures em memória. Retornos
 * "não sei" (`UNKNOWN`/`null`) nunca viram finding — fail-soft: preferir
 * silêncio a reabrir um bloqueio genuíno por engano.
 */
export interface BlockStalenessConsultor {
  /**
   * #10618 (fatia 3): `true` declara que o consultor responde por QUALQUER
   * repo — todo método abaixo recebe `repo` (`owner/repo`) quando a entrada
   * não é do diaria-studio, e consulta esse repo (`gh -R`). Sem a marca, o
   * consultor é tratado como só-studio e entrada de outro repo nunca é
   * avaliada (o comportamento do #10778): um consultor legado que ignorasse
   * `repo` responderia pela studio#N com o mesmo número.
   */
  multiRepo?: boolean;
  /**
   * #10618 (fatia 4, review I): allowlist `issue_repos` — só um repo desta
   * lista é aceito como "repo do PR" numa citação qualificada
   * (`extractPrRef`). Ausente = só o diaria-studio.
   */
  issueRepos?: readonly string[];
  /** `repo` ausente = diaria-studio (o PR mora no repo da issue, decisão da #10618). */
  getPrState(prNumber: number, repo?: string): PrState;
  /** `true` = ainda reivindicada por sessão ativa não-stale; `false` = livre. */
  isIssueClaimedActive(issueNumber: number, repo?: string): boolean;
  /** `true`/`false` = presença confirmada; `null` = não verificável (gh
   * indisponível) — nunca reportar caducidade nesse caso. */
  hasLabel(issueNumber: number, label: string, repo?: string): boolean | null;
  /** Estado atual da ISSUE em si (não do PR/label) — `"UNKNOWN"` quando não
   * verificável (gh indisponível). Espelha `getPrState` (#6784): uma issue
   * já `CLOSED` (ex: auto-fechada por alarme que se auto-normalizou) não tem
   * "dispatch a reavaliar" — reportá-la como "bloqueio caducado" é ruído. */
  getIssueState(issueNumber: number, repo?: string): IssueState;
}

/** Pure: extrai o número do PR citado numa entrada — prioriza o campo
 * estruturado `pr`; cai pro texto livre de `nota` (`/PR\s*#(\d+)/i`) porque
 * a prática observada no `plan.json` real (rodada 260826) grava o número
 * só em prosa (`"PR #6216 aberto por outra sessao..."`), nunca no campo
 * `pr`. `null` quando nenhuma das duas fontes tem um número — o chamador
 * trata como "não verificável", nunca como caducado. */
export function extractPrNumber(entry: BlockStalenessPlanIssue): number | null {
  return extractPrRef(entry)?.number ?? null;
}

/** PR citado numa entrada `pr-em-voo`: número + repo onde ele mora. */
export interface CitedPrRef {
  number: number;
  /** `owner/repo` quando a citação nomeia o repo do PR; `null` = o repo da
   * própria issue (o caso de sempre: `pr: 6216`, `"PR #6216 aberto..."`). */
  repo: string | null;
}

/**
 * Pure (#10618, fatia 4): como `extractPrNumber`, mas devolve também o repo
 * do PR quando a citação o nomeia — o PR que segura uma issue pode morar em
 * OUTRO repo (ex: a issue do studio esperando um PR do diaria-design). Formas
 * aceitas, nesta ordem:
 * - campo `pr` numérico → repo da issue;
 * - campo `pr` string `owner/repo#N` ou URL `github.com/owner/repo/pull/N`
 *   (repo fora de `allowedRepos` → `null`: citação explícita de um repo que
 *   não dá pra consultar é "não verificável", nunca o repo da issue);
 * - em `nota`: URL de PR (mesma regra), `owner/repo#N`, `owner/repo PR #N`
 *   (o formato que o próprio gate imprime) e, por último, `PR #N` (repo da
 *   issue).
 *
 * Review I: em prosa livre, `algo/coisa PR #N` casa também nome de branch
 * (`develop/fix-x PR #N`) e caminho (`scripts/lib PR #500`). Por isso, na
 * `nota`, o `owner/repo` só é aceito quando está em `allowedRepos`
 * (`issue_repos`); senão a citação cai no `PR #N` do repo da issue.
 * `null` quando nada é legível — o chamador trata como "não verificável".
 */
export function extractPrRef(
  entry: BlockStalenessPlanIssue,
  allowedRepos: readonly string[] = [DEFAULT_ISSUE_REPO],
): CitedPrRef | null {
  const allowed = new Set(allowedRepos.map((r) => normalizeRepoSlug(r)).filter((r): r is string => r !== null));
  if (typeof entry.pr === "number" && Number.isFinite(entry.pr)) return { number: entry.pr, repo: null };
  if (typeof entry.pr === "string") {
    const ref = parseIssueRef(entry.pr.trim());
    if (ref && /[/]/.test(entry.pr)) return allowed.has(ref.repo) ? { number: ref.number, repo: ref.repo } : null;
    if (ref) return { number: ref.number, repo: null };
  }
  const nota = typeof entry.nota === "string" ? entry.nota : "";
  const url = nota.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i);
  if (url) {
    const cited = qualifiedPr(url[1], url[2]);
    return cited && cited.repo && allowed.has(cited.repo) ? cited : null;
  }
  for (const re of [/PR\s*([\w.-]+\/[\w.-]+)#(\d+)/gi, /([\w.-]+\/[\w.-]+)\s+PR\s*#(\d+)/gi]) {
    for (const m of nota.matchAll(re)) {
      const cited = qualifiedPr(m[1], m[2]);
      if (cited && cited.repo && allowed.has(cited.repo)) return cited;
    }
  }
  const match = nota.match(/PR\s*#(\d+)/i);
  return match ? { number: Number(match[1]), repo: null } : null;
}

function qualifiedPr(repoRaw: string, numberRaw: string): CitedPrRef | null {
  const repo = normalizeRepoSlug(repoRaw);
  const number = Number(numberRaw);
  if (!repo || !Number.isSafeInteger(number) || number <= 0) return null;
  return { number, repo };
}

/**
 * Pure: entre as issues `pulada` do plano, devolve as que têm motivo
 * transitório e cujo consultor confirma que o bloqueio já caducou. Nunca
 * reporta issue com motivo fora de `TRANSIENT_MOTIVOS`, nem issue cujo
 * consultor devolveu "não sei" — ver docblock do módulo.
 *
 * `onUnverifiable` (#10618, fatia 3): chamado com a chave da issue quando a
 * checagem dela ficou inconclusiva por "não sei" do consultor (`getPrState`
 * `UNKNOWN`, `hasLabel` `null`). Não muda o veredito — serve pro CLI contar
 * e pôr a ressalva na linha de ok, em vez de o "não sei" sumir em silêncio.
 */
export function findStaleBlocks(
  issues: readonly BlockStalenessPlanIssue[],
  consultor: BlockStalenessConsultor,
  onUnverifiable?: (key: IssueKey, what: string) => void,
): StaleBlockFinding[] {
  const findings: StaleBlockFinding[] = [];

  for (const entry of issues) {
    if (entry.status !== "pulada") continue;
    // #10778/#10618 (fatia 3): identidade pela chave, nunca por
    // `entry.number` cru. Identidade desconhecida nunca vira finding; entrada
    // de outro repo só é avaliada por consultor `multiRepo`, que recebe o
    // `repo` em toda consulta — um consultor só-studio responderia pela
    // studio#N com o mesmo número.
    const key = issueKeyOfPlanEntry(entry);
    if (!key) continue;
    const studio = isStudioIssueKey(key);
    if (!studio && consultor.multiRepo !== true) continue;
    const repo = studio ? undefined : repoOfIssueKey(key);
    const issueNumber = issueNumberInRepo(key);
    const motivo = typeof entry.motivo === "string" ? entry.motivo : null;
    if (!motivo || !TRANSIENT_MOTIVOS.has(motivo as StaleBlockCategory)) continue;
    const category = motivo as StaleBlockCategory;

    // #6784 — espelha a checagem irmã de PR (branch `pr-em-voo` abaixo, que
    // já compara `state === "MERGED" || state === "CLOSED"`): antes de
    // reportar caducidade por QUALQUER categoria, checa se a ISSUE em si já
    // está `CLOSED`. Issue fechada não tem "dispatch a reavaliar" — o
    // trabalho já não existe mais, reportá-la como "reavalie dispatch" é
    // ruído puro (achado ao vivo: 9/12 caducadas reportadas numa rodada já
    // estavam CLOSED, auto-fechadas por alarme auto-normalizado).
    // `UNKNOWN` (gh indisponível) não pula — fail-soft na direção oposta:
    // preferir reportar de mais a esconder um bloqueio genuinamente caducado.
    if (consultor.getIssueState(issueNumber, repo) === "CLOSED") continue;

    if (category === "pr-em-voo") {
      const cited = extractPrRef(entry, consultor.issueRepos ?? [DEFAULT_ISSUE_REPO]);
      if (cited === null) {
        // não verificável — nunca falso positivo, mas nunca em silêncio:
        // `pr-em-voo` sem PR legível (ou citando repo fora de issue_repos)
        // entra na ressalva da linha de ok.
        onUnverifiable?.(key, "PR citado ilegível ou de repo fora de issue_repos");
        continue;
      }
      const pr = cited.number;
      // #10618 (fatia 4): o PR mora no repo CITADO quando a entrada nomeia
      // um; senão no repo da issue. PR de outro repo só é consultado por
      // consultor `multiRepo` (um só-studio responderia pelo studio PR #N).
      const prRepoFull = cited.repo ?? (repo ?? DEFAULT_ISSUE_REPO);
      const prRepo = prRepoFull === DEFAULT_ISSUE_REPO ? undefined : prRepoFull;
      if (prRepo !== undefined && consultor.multiRepo !== true) {
        onUnverifiable?.(key, `estado do ${prRepo} PR #${pr} (consultor só-studio)`);
        continue;
      }
      const state = consultor.getPrState(pr, prRepo);
      // Rótulo de sempre (`estado do PR #N`) quando o PR mora no repo da
      // issue; o repo só aparece quando a citação aponta OUTRO repo.
      if (state === "UNKNOWN") onUnverifiable?.(key, `estado do ${cited.repo && prRepoFull !== (repo ?? DEFAULT_ISSUE_REPO) ? `${prRepoFull} ` : ""}PR #${pr}`);
      if (state === "MERGED" || state === "CLOSED") {
        findings.push({
          number: issueNumber,
          key,
          category,
          motivo,
          // #10618 (fatia 3/4): rótulo com o repo onde o PR mora (o citado,
          // ou o da issue) quando não é o studio — mesmo formato do
          // `prLabel` do check-pr-terminal-state.
          reason: `${prRepo ? `${prRepo} PR #${pr}` : `PR #${pr}`} já está ${state === "MERGED" ? "mergeado" : "fechado"} — bloqueio caducou`,
        });
      }
      continue;
    }

    if (category === "claimed-por-outra-sessao") {
      const stillClaimed = consultor.isIssueClaimedActive(issueNumber, repo);
      if (!stillClaimed) {
        findings.push({
          number: issueNumber,
          key,
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
        consultor.hasLabel(issueNumber, label, repo),
      );
      if (results.some((r) => r === true)) continue; // alguma label de bloqueio ainda presente
      if (results.some((r) => r === null)) {
        onUnverifiable?.(key, "labels da issue");
        continue; // alguma não verificável — fail-soft
      }
      findings.push({
        number: issueNumber,
        key,
        category,
        motivo,
        reason: "nenhuma label de bloqueio (bloqueio-execucao/external-blocker/kit-migration/beehiiv) está mais presente na issue — bloqueio caducou",
      });
      continue;
    }
  }

  return findings.sort((a, b) => compareIssueKeys(findingKey(a), findingKey(b)));
}

/**
 * #8842 — remove findings `claimed-por-outra-sessao` cuja issue também
 * aparece como claim ENVELHECIDA (`findAgedClaims`, `claim-staleness.ts`,
 * #6436). As duas checagens usam janelas DIFERENTES de propósito (ver
 * `isIssueClaimedActive`/`isIssueClaimedByActiveSession` em
 * `session-registry.ts`, #7297) e por isso podem apontar pra ações
 * opostas pra mesma issue: esta reporta "claim liberado, reavalie
 * dispatch" (janela curta, 90min) mesmo quando `claimed_issues_effective`
 * ainda segura a issue por até 24h (`claimReleaseMsForKind`, #7227) — que é
 * exatamente o caso de uma claim envelhecida sem PR (sessão `continuo` que
 * re-reivindica sem nunca soltar). Reavaliar dispatch nesse caso é
 * garantidamente inútil: `claim-issue`/`is-claimed` vão recusar de novo até
 * a janela de 24h passar (achado ao vivo #8842: exatamente essa sequência —
 * `check-block-staleness` disse "claim liberado" pra #8795, `claim-issue`
 * recusou por já estar reivindicada). Quando a claim já está listada como
 * envelhecida, a ação certa é a do #6436 (pendência de re-triagem via
 * `check-state-changed-pending.ts --add-pending`), não "reavalie
 * dispatch" — suprimir a duplicata evita o coordenador tentar (e falhar)
 * um reclaim que a própria idade da claim já garante que vai ser recusado.
 */
export function suppressAgedClaimOverlap(
  findings: readonly StaleBlockFinding[],
  agedClaims: ReadonlySet<number | IssueKey>,
): StaleBlockFinding[] {
  // #10618 (fatia 3): o conjunto aceita `IssueKey` (`owner/repo#N`) e, por
  // compatibilidade, número — número é SEMPRE diaria-studio, então só casa
  // finding do studio (a design#21 nunca é suprimida pela claim da studio#21).
  return findings.filter((f) => {
    if (f.category !== "claimed-por-outra-sessao") return true;
    const key = findingKey(f);
    if (agedClaims.has(key)) return false;
    return !(isStudioIssueKey(key) && agedClaims.has(f.number));
  });
}

/** Chave do finding — `key` quando presente; senão o número é do diaria-studio
 * (finding legado montado à mão). */
export function findingKey(f: Pick<StaleBlockFinding, "number" | "key">): IssueKey {
  const key = f.key ?? toIssueKey(f.number);
  if (!key) throw new Error(`StaleBlockFinding sem identidade válida: ${JSON.stringify(f)} (#10618)`);
  return key;
}
