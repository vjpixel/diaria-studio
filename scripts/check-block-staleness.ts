#!/usr/bin/env npx tsx
/**
 * check-block-staleness.ts (#6259)
 *
 * CLI para o gate de "bloqueio caducado" — ver `scripts/lib/block-staleness.ts`
 * pra lógica pura/documentação completa do mecanismo. Este arquivo monta o
 * `BlockStalenessConsultor` real (via `gh` e `session-registry.ts`) e é só o
 * ponto de entrada de linha de comando, seguindo o mesmo padrão de
 * `scripts/check-state-changed-pending.ts`.
 *
 * Reforça, não substitui, a re-varredura de convergência (#5706): aquela
 * cobre issue NOVA em `gh issue list`; esta cobre issue JÁ CONHECIDA cujo
 * bloqueio (`pulada` com motivo `pr-em-voo`/`claimed-por-outra-sessao`/
 * `bloqueio-execucao`) caducou — ver docblock de `block-staleness.ts`.
 *
 * Uso:
 *   npx tsx scripts/check-block-staleness.ts --plan data/overnight/260826/plan.json
 *   npx tsx scripts/check-block-staleness.ts --plan data/develop/260826/plan.json
 *
 * `exit 0` = nenhum bloqueio caducado (ou nada verificável — fail-soft,
 * #738: `gh`/`session-registry` indisponível nunca trava, só reduz
 * cobertura e avisa em stderr). `exit 1` = lista de issues cujo motivo
 * `pulada` já não se sustenta — reavaliar dispatch antes de fechar a
 * rodada/sessão (mesma disciplina do gate 0.5/#5476/#5706).
 *
 * **#6436 — 2ª checagem, independente do `plan.json`:** além dos 3 motivos
 * transitórios acima, este CLI também varre `data/sessions/` inteiro
 * (`listActiveSessions`) por claims mais velhas que `CLAIM_STALE_AGE_MS`
 * (`scripts/lib/claim-staleness.ts`) SEM PR aberto correspondente — cobre a
 * sessão `continuo` (cron de 60min do Hermes), que re-reivindica a mesma
 * issue indefinidamente sem nunca soltar, deixando-a `claimed-por-outra-
 * sessao` pra sempre mesmo sem nenhum trabalho visível em andamento.
 *
 * **#7297 — `isIssueClaimedActive` (via `buildRealConsultor` abaixo) usa
 * `isIssueClaimedByActiveSession`, NÃO `isIssueClaimedByOther`.** As duas
 * funções de `session-registry.ts` divergiram desde o #7227 (que alargou a
 * janela de RETENÇÃO de claim, `claimed_issues_effective`, pra 24h nos 3
 * kinds coordenadores) sem que nenhum commit tocasse este arquivo — a
 * reabertura de bloqueio que era em 90min (a razão de existir deste CLI
 * desde o #6259: não deixar a rodada ociosa esperando sessão morta) virou
 * silenciosamente 24h por herança. Decisão tomada no #7297: manter a janela
 * curta AQUI (constante própria, `session.stale`/`SOFT_STALE_MS`), distinta
 * da janela de 24h que `isIssueClaimedByOther` usa pra decidir se uma
 * sessão NOVA pode reivindicar — ver a docstring de
 * `isIssueClaimedByActiveSession` pro raciocínio completo (os dois
 * consumidores fazem perguntas opostas, com custo de erro em direções
 * opostas).
 *
 * **#8842 — `suppressAgedClaimOverlap` remove findings `claimed-por-outra-
 * sessao` cuja issue já aparece na lista de claims envelhecidas (#6436)
 * abaixo.** Sem essa dedup, uma sessão `continuo` que re-reivindica sem
 * nunca soltar produzia DOIS sinais contraditórios pra mesma issue: este
 * gate dizia "claim liberado, reavalie dispatch" (janela curta, 90min,
 * #7297) enquanto `claimed_issues_effective` ainda segurava a issue por até
 * 24h (#7227) — reavaliar nesse caso é sempre inútil, `claim-issue`/
 * `is-claimed` recusam de novo. Ver docstring de `suppressAgedClaimOverlap`
 * em `block-staleness.ts` pro racional completo e o achado ao vivo (#8795).
 *
 * **#10618 (fatia 3) — multi-repo.** Entrada do `plan.json` de outro repo
 * (`"vjpixel/diaria-design#21"`) é avaliada NO REPO DELA: toda consulta `gh`
 * leva `-R owner/repo` e a claim é lida como `IssueRef` (nunca o número cru,
 * que é o da studio#21). Só repo da allowlist `platform.config.json →
 * issue_repos` é consultado; repo fora dela e identidade desconhecida ficam
 * FORA da checagem, com aviso em stderr (#10778) que nomeia a entrada (índice
 * + `ref`/`repo` crus) — só pra entrada que o gate avaliaria (`pulada` com
 * motivo transitório). A checagem de claim envelhecida (#6436) também cobre
 * `claimed_foreign_issues` (`flattenAllClaims`). Toda consulta que voltou
 * "não sei" (`gh` falhou, repo fora da allowlist) e toda claim sem timestamp
 * é listada por chave em stderr, e a linha de ok vira "ok PARCIAL — … (exceto
 * N não verificáveis …)" — nunca "ok" sem ressalva. Saída: `#N` pro
 * diaria-studio (como sempre), `owner/repo#N` pros outros.
 *
 * @see scripts/lib/block-staleness.ts
 * @see scripts/lib/claim-staleness.ts (#6436, checagem de claim envelhecida)
 * @see scripts/check-state-changed-pending.ts (padrão de estilo + gate irmão)
 * @see .claude/skills/diaria-overnight/SKILL.md
 * @see .claude/skills/diaria-develop/SKILL.md
 * @see context/overnight-dispatch-rules.md
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  findStaleBlocks,
  findingKey,
  isTransientBlockEntry,
  suppressAgedClaimOverlap,
  type BlockStalenessConsultor,
  type BlockStalenessPlanIssue,
  type IssueState,
  type PrState,
} from "./lib/block-staleness.ts";
import { isIssueClaimedByActiveSession, listActiveSessions } from "./lib/session-registry.ts";
import { normalizeIssues, type IssuesBearing } from "./lib/plan-issues-normalize.ts";
import { flattenAllClaims, findAgedClaims, CLAIM_STALE_AGE_MS } from "./lib/claim-staleness.ts";
import { DEFAULT_ISSUE_REPO, loadIssueRepos, normalizeRepoSlug } from "./lib/issue-repos.ts";
import {
  compareIssueKeys,
  describeUnknownPlanEntry,
  issueKeyLabel,
  issueKeyOfPlanEntry,
  repoOfIssueKey,
  type IssueKey,
} from "./lib/issue-key.ts";

/** `-R owner/repo` para um repo que não é o diaria-studio; `[]` para o
 * studio (a chamada de sempre, que resolve pelo cwd). */
function repoArgs(repo: string | undefined): string[] {
  return repo && repo !== DEFAULT_ISSUE_REPO ? ["-R", repo] : [];
}

/**
 * #10618 (fatia 3): `true` quando `repo` pode ser consultado — o diaria-studio
 * (ausente) ou um repo da allowlist `issue_repos`. Consultor que receber repo
 * fora dela responde "não sei" (nunca roda `gh -R` num repo arbitrário).
 */
function makeRepoAllowed(allowlist: readonly string[]): (repo: string | undefined) => boolean {
  const allowed = new Set(allowlist);
  return (repo) => repo === undefined || allowed.has(normalizeRepoSlug(repo) ?? "");
}

/** Monta um consultor real, apoiado em `gh` (PR state + labels) e
 * `isIssueClaimedByActiveSession` (leitura direta de `data/sessions/*.json`,
 * sem rede — janela CURTA de 90min, #7297, não a de retenção de 24h que
 * `isIssueClaimedByOther` usa). Cada método é fail-soft na própria chamada:
 * falha de `gh` (offline, sem auth, rate limit) vira `UNKNOWN`/`null`, nunca
 * lança — `findStaleBlocks` já trata esses valores como "não verificável".
 */
function buildRealConsultor(repoRoot: string, allowlist: readonly string[]): BlockStalenessConsultor {
  const repoAllowed = makeRepoAllowed(allowlist);
  // #6754 fleet review — a categoria `bloqueio-execucao` agora checa TODAS
  // as labels de `BLOCKED_LABELS_SET` (4 labels) por issue; sem cache isso
  // vira 4 chamadas `gh issue view` idênticas (mesmo issue, mesmo campo
  // `labels`, só o filtro final muda). #6784 acrescentou uma checagem de
  // ESTADO por issue (`getIssueState`) — em vez de mais uma chamada `gh`
  // separada, busca `labels` e `state` NUM SÓ fetch e memoiza os dois numa
  // única entrada por issueNumber: 1 chamada `gh issue view` cobre tanto
  // `hasLabel` (× N labels) quanto `getIssueState`, independente de quantas
  // vezes cada um for consultado pra mesma issue.
  interface IssueData {
    labels: Set<string> | null;
    state: IssueState;
  }
  // #10618 (fatia 3): cache por `repo#N` — a design#21 e a studio#21 são
  // entradas diferentes.
  const issueDataCache = new Map<string, IssueData>();
  function fetchIssueData(issueNumber: number, repo?: string): IssueData {
    const cacheKey = `${repo ?? DEFAULT_ISSUE_REPO}#${issueNumber}`;
    const cached = issueDataCache.get(cacheKey);
    if (cached) return cached;
    if (!repoAllowed(repo)) {
      const unknown: IssueData = { labels: null, state: "UNKNOWN" };
      issueDataCache.set(cacheKey, unknown);
      return unknown;
    }
    const result = spawnSync("gh", ["issue", "view", String(issueNumber), ...repoArgs(repo), "--json", "labels,state"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15_000,
    });
    let value: IssueData;
    if (result.error || result.status !== 0 || !result.stdout) {
      value = { labels: null, state: "UNKNOWN" };
    } else {
      try {
        const parsed = JSON.parse(result.stdout) as {
          labels?: Array<{ name?: string }>;
          state?: string;
        };
        const labels = new Set((parsed.labels ?? []).map((l) => l.name).filter((n): n is string => !!n));
        const rawState = (parsed.state ?? "").toUpperCase();
        const state: IssueState = rawState === "OPEN" || rawState === "CLOSED" ? rawState : "UNKNOWN";
        value = { labels, state };
      } catch {
        value = { labels: null, state: "UNKNOWN" };
      }
    }
    issueDataCache.set(cacheKey, value);
    return value;
  }

  return {
    multiRepo: true,
    issueRepos: allowlist,
    getPrState(prNumber: number, repo?: string): PrState {
      if (!repoAllowed(repo)) return "UNKNOWN";
      const result = spawnSync("gh", ["pr", "view", String(prNumber), ...repoArgs(repo), "--json", "state"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 15_000,
      });
      if (result.error || result.status !== 0 || !result.stdout) return "UNKNOWN";
      try {
        const parsed = JSON.parse(result.stdout) as { state?: string };
        const state = (parsed.state ?? "").toUpperCase();
        if (state === "OPEN" || state === "MERGED" || state === "CLOSED") return state;
        return "UNKNOWN";
      } catch {
        return "UNKNOWN";
      }
    },
    isIssueClaimedActive(issueNumber: number, repo?: string): boolean {
      try {
        // #7297 — janela CURTA (90min, `session.stale`), não a de retenção
        // de 24h — ver docstring do arquivo/da função importada.
        // #10618 (fatia 3): issue de outro repo é lida como `IssueRef`
        // (`claimed_foreign_issues`), nunca pelo número cru.
        const target = repo && repo !== DEFAULT_ISSUE_REPO ? { repo, number: issueNumber } : issueNumber;
        return isIssueClaimedByActiveSession(repoRoot, target, "") !== null;
      } catch {
        // Falha de leitura de data/sessions/ (junction ausente, JSON
        // corrompido por conflito de sync) — fail-soft pro lado "ainda
        // reivindicada" (nunca reabre bloqueio por engano de infraestrutura).
        return true;
      }
    },
    hasLabel(issueNumber: number, label: string, repo?: string): boolean | null {
      const { labels } = fetchIssueData(issueNumber, repo);
      if (labels === null) return null;
      return labels.has(label);
    },
    getIssueState(issueNumber: number, repo?: string): IssueState {
      return fetchIssueData(issueNumber, repo).state;
    },
  };
}

/**
 * #6436 — `true`/`false`/`null` (não verificável) se existe PR ABERTO cujo
 * título/corpo cita `#{issueNumber}`. Fail-soft: qualquer falha do `gh`
 * (offline, rate limit, não-autenticado) devolve `null`, nunca `false` —
 * `findAgedClaims` trata `null` como "não reportar" (mesmo princípio dos
 * demais métodos de `buildRealConsultor` acima).
 */
function buildHasOpenPr(
  repoRoot: string,
  allowlist: readonly string[],
): (issueNumber: number, repo?: string) => boolean | null {
  const repoAllowed = makeRepoAllowed(allowlist);
  return (issueNumber: number, repo?: string): boolean | null => {
    if (!repoAllowed(repo)) return null;
    const result = spawnSync(
      "gh",
      ["pr", "list", ...repoArgs(repo), "--state", "open", "--search", `#${issueNumber}`, "--json", "number"],
      { cwd: repoRoot, encoding: "utf8", timeout: 15_000 },
    );
    if (result.error || result.status !== 0 || !result.stdout) return null;
    try {
      const parsed = JSON.parse(result.stdout) as Array<{ number?: number }>;
      return Array.isArray(parsed) && parsed.length > 0;
    } catch {
      return null;
    }
  };
}

/**
 * #6754 — `true`/`false` se a issue está `CLOSED`; `null` (não verificável)
 * em qualquer falha de `gh` (offline, rate limit, não-autenticado). Issue
 * fechada nunca precisa de re-triagem por claim envelhecida — ver docstring
 * de `findAgedClaims` em `claim-staleness.ts`.
 */
function buildIsIssueClosed(
  repoRoot: string,
  allowlist: readonly string[],
): (issueNumber: number, repo?: string) => boolean | null {
  const repoAllowed = makeRepoAllowed(allowlist);
  return (issueNumber: number, repo?: string): boolean | null => {
    if (!repoAllowed(repo)) return null;
    const result = spawnSync("gh", ["issue", "view", String(issueNumber), ...repoArgs(repo), "--json", "state"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (result.error || result.status !== 0 || !result.stdout) return null;
    try {
      const parsed = JSON.parse(result.stdout) as { state?: string };
      const state = (parsed.state ?? "").toUpperCase();
      if (state === "CLOSED") return true;
      if (state === "OPEN") return false;
      return null;
    } catch {
      return null;
    }
  };
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const planPath = values.plan;
  if (!planPath) {
    console.error("[check-block-staleness] uso: --plan {path}");
    process.exit(2);
  }
  if (!existsSync(planPath)) {
    console.error(`[check-block-staleness] plan.json não encontrado: ${planPath}`);
    process.exit(2);
  }

  let planRaw: unknown;
  try {
    planRaw = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (e) {
    console.error(
      `[check-block-staleness] plan.json malformado — pulando checagem (fail-soft, #738): ${(e as Error).message}`,
    );
    process.exit(0);
  }

  // #10618 (fatia 3): entrada de outro repo é consultada no repo dela (`-R`),
  // desde que o repo esteja na allowlist `issue_repos`. Identidade
  // desconhecida (`repo` ilegível) e repo fora da allowlist ficam de fora,
  // com aviso — nunca caem no diaria-studio por omissão (#10778).
  const repoRoot = process.cwd();
  const allowlist = loadIssueRepos(repoRoot);
  const allowedRepos = new Set(allowlist);
  const issues: BlockStalenessPlanIssue[] = [];
  const skipped: string[] = [];
  normalizeIssues<BlockStalenessPlanIssue>(planRaw as IssuesBearing<BlockStalenessPlanIssue>).forEach((entry, index) => {
    // Só avisa sobre entrada que o gate avaliaria (`pulada` com motivo
    // transitório) — o resto nunca foi olhado por este gate.
    if (!isTransientBlockEntry(entry)) return;
    const key = issueKeyOfPlanEntry(entry);
    if (!key) skipped.push(`${describeUnknownPlanEntry(entry, index)} (identidade desconhecida)`);
    else if (!allowedRepos.has(repoOfIssueKey(key))) skipped.push(`${key} (repo fora de issue_repos)`);
    else issues.push(entry);
  });
  if (skipped.length > 0) {
    console.error(
      `[check-block-staleness] ${skipped.length} entrada(s) FORA desta checagem (não dá pra consultar o repo certo): ${skipped.join(", ")}`,
    );
  }

  // #10618 (fatia 3): toda checagem que ficou inconclusiva por "não sei" do
  // `gh` (estado do PR, labels, PR aberto da claim) ou por claim sem
  // timestamp — por chave. Nunca muda o veredito (fail-soft), mas entra na
  // linha de ok como ressalva.
  const unverifiable = new Map<IssueKey, Set<string>>();
  const markUnverifiable = (key: IssueKey, what: string) => {
    const set = unverifiable.get(key) ?? new Set<string>();
    set.add(what);
    unverifiable.set(key, set);
  };

  const consultor = buildRealConsultor(repoRoot, allowlist);
  const rawFindings = findStaleBlocks(issues, consultor, markUnverifiable);

  // #6436 — teto de idade de claim sem PR aberto, INDEPENDENTE do plan.json
  // (varre `data/sessions/` inteiro, não só as issues `pulada` deste plano —
  // uma issue claimed pela `continuo` pode nunca ter entrado neste plan.json).
  const sessions = listActiveSessions(repoRoot);
  // #10618 (fatia 3): inclui as claims de outro repo (`claimed_foreign_issues`).
  const claimEntries = flattenAllClaims(sessions);
  const hasOpenPr = buildHasOpenPr(repoRoot, allowlist);
  const isIssueClosed = buildIsIssueClosed(repoRoot, allowlist);
  const agedClaims = findAgedClaims(
    claimEntries,
    Date.now(),
    CLAIM_STALE_AGE_MS,
    hasOpenPr,
    isIssueClosed,
    (key, reason) => {
      if (reason === "sem-timestamp") markUnverifiable(key, "claim sem timestamp (claimed_*_at)");
      else if (!allowedRepos.has(repoOfIssueKey(key))) markUnverifiable(key, "claim de repo fora de issue_repos");
      else markUnverifiable(key, "PR aberto da claim (gh falhou)");
    },
  );

  // #8842 — suprime `claimed-por-outra-sessao` quando a mesma issue já
  // aparece como claim envelhecida (#6436): reavaliar dispatch nesse caso é
  // garantidamente inútil (`claim-issue` recusa até a janela de 24h passar,
  // #7227) — ver docstring de `suppressAgedClaimOverlap`.
  const agedClaimKeys = new Set<IssueKey>(agedClaims.map((c) => c.issueKey));
  const findings = suppressAgedClaimOverlap(rawFindings, agedClaimKeys);

  // Chave que virou finding foi verificada o bastante — sai da ressalva.
  for (const f of findings) unverifiable.delete(findingKey(f));
  for (const c of agedClaims) unverifiable.delete(c.issueKey);
  if (unverifiable.size > 0) {
    console.error(`[check-block-staleness] ${unverifiable.size} issue(s) NÃO verificáveis nesta invocação (fail-soft, não reprova):`);
    for (const [key, what] of [...unverifiable].sort(([a], [b]) => compareIssueKeys(a, b))) {
      console.error(`  ${issueKeyLabel(key)} — ${[...what].join("; ")}`);
    }
  }
  const ressalvaParts: string[] = [];
  if (unverifiable.size > 0) ressalvaParts.push(`${unverifiable.size} não verificáveis`);
  if (skipped.length > 0) ressalvaParts.push(`${skipped.length} entrada(s) fora da checagem`);
  const ressalva = ressalvaParts.length > 0 ? ` (exceto ${ressalvaParts.join(" e ")}, listadas acima)` : "";

  if (findings.length === 0 && agedClaims.length === 0) {
    console.log(
      `ok${ressalva ? " PARCIAL" : ""} — nenhum bloqueio pulada (pr-em-voo/claimed-por-outra-sessao/bloqueio-execucao) caducado, nenhuma claim envelhecida sem PR${ressalva}`,
    );
    process.exit(0);
  }

  if (findings.length > 0) {
    console.error(
      `[check-block-staleness] bloqueio(s) caducado(s) — reavalie dispatch antes de fechar a rodada:`,
    );
    for (const f of findings) {
      console.error(`  ${issueKeyLabel(findingKey(f))} (motivo "${f.motivo}"): ${f.reason}`);
    }
  }
  if (agedClaims.length > 0) {
    console.error(
      `[check-block-staleness] claim(s) envelhecida(s) sem PR aberto (#6436, teto ${CLAIM_STALE_AGE_MS / 3_600_000}h) — considerar pendência de re-triagem (check-state-changed-pending.ts --add-pending):`,
    );
    for (const c of agedClaims) {
      const ageH = (c.ageMs / 3_600_000).toFixed(1);
      console.error(
        `  ${issueKeyLabel(c.issueKey)} — claimed por ${c.kind}-${c.machineTag}-${c.sessionId} há ${ageH}h (desde ${c.claimedAt}), sem PR aberto`,
      );
    }
  }
  process.exit(1);
}
