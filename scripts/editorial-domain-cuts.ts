#!/usr/bin/env tsx
/**
 * editorial-domain-cuts.ts (#9787)
 *
 * Domínios que o editor mais RETIRA do que MANTÉM no gate 4: auditoria
 * retroativa + monitor contínuo → pergunta ao editor → blacklist editorial
 * (`scripts/lib/editorial-blocklist.ts`) ou lista de mantidos
 * (`scripts/lib/editorial-keep-list.ts`). Lógica pura e definições
 * (retirado/mantido/candidato, piso de 10 ocorrências decidido pelo editor em
 * 06/10/2026) em `scripts/lib/editorial-domain-cuts.ts`.
 *
 * Fontes por edição (as mesmas de `measure-gate4-highlight-changes.ts`,
 * #9693): o que CHEGOU ao gate 4 = snapshot `stage2-post-gate/02-reviewed.md`
 * ou, sem snapshot confiável, o baseline reconstruído (`newsletterBaseline`
 * de `edition-manual-edits.ts`, #9357/#9647); o APROVADO = `02-reviewed.md`.
 * Só entra edição FECHADA (sentinel do Stage 4 presente, ou edição legada sem
 * sentinel nenhum) — nunca a edição em curso.
 *
 * Estado incremental em `data/editorial-domain-cuts.json` (cada edição
 * fechada é contada uma vez). Decisões do editor em
 * `data/editorial-domain-decisions.jsonl` — um domínio decidido nunca é
 * reperguntado, mesmo antes da decisão chegar ao código.
 *
 * Modos:
 *   --report     Atualiza o estado e imprime a tabela da auditoria (domínios
 *                com ≥ piso de ocorrências; `--all` mostra todos) + candidatos.
 *                `--json` imprime o JSON. `--no-write` não grava o estado.
 *   --questions  Gate 4 da edição `--edition AAMMDD`: atualiza o estado com as
 *                edições fechadas ANTERIORES a ela e imprime o bloco de
 *                perguntas (vazio sem candidato). Nunca falha o gate: erro ⇒
 *                aviso no stderr, stdout vazio, exit 0.
 *   --record     `--edition AAMMDD --answers "dominio=retirar,outro=manter"`:
 *                grava as decisões no JSONL. `--open-apply-issue` abre (uma
 *                só, dedup por título) a issue que leva as decisões ao código.
 *   --pending    Lista decisões registradas que ainda não estão no código.
 *   --apply-to-code  Insere as decisões pendentes em EDITORIAL_BLOCKLIST /
 *                EDITORIAL_KEEP_LIST (idempotente). Uso: sessão que vai
 *                commitar + abrir PR (overnight/develop), nunca no meio de
 *                uma edição no checkout compartilhado.
 *
 * Opções: --editions-root, --state, --decisions, --rebuild, --min N.
 * Exit: 0 ok; 1 uso inválido / `--answers` mal formado (nada gravado).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { assessStage2BaselineOnDisk, readSnapshots, STAGE2_BASELINE_LABEL, STAGE2_SNAPSHOT_FILES } from "./lib/editor-request-snapshots.ts";
import { normalizeNewsletterForComparison } from "./lib/manual-edit-diff.ts";
import { sentinelExists } from "./lib/pipeline-state.ts";
import { isDomainEditoriallyBlocked } from "./lib/editorial-blocklist.ts";
import { isEditoriallyKept } from "./lib/editorial-keep-list.ts";
import { spawnGhSync } from "./lib/shared/gh-run.ts";
import { newsletterBaseline } from "./edition-manual-edits.ts";
import {
  classifyEditionItems,
  domainInList,
  formatGateQuestions,
  formatListEntry,
  insertSetEntry,
  MIN_CUT_OCCURRENCES,
  parseDecisionAnswers,
  parseDecisions,
  parseState,
  renderAuditTable,
  selectCandidates,
  stateItems,
  tallyByDomain,
  type DecisionRecord,
  type DomainCutState,
  type DomainTally,
  type EditionCutRecord,
} from "./lib/editorial-domain-cuts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BLOCKLIST_FILE = join(ROOT, "scripts", "lib", "editorial-blocklist.ts");
const KEEP_LIST_FILE = join(ROOT, "scripts", "lib", "editorial-keep-list.ts");
export const APPLY_ISSUE_TITLE = "Aplicar decisões do editor sobre domínios cortados no gate 4 (#9787)";

/** Edição fechada: gate 4 aprovado (sentinel) ou edição legada sem sentinel nenhum. */
export function isClosedEdition(editionDir: string): boolean {
  if (sentinelExists(editionDir, 4)) return true;
  const internal = join(editionDir, "_internal");
  if (!existsSync(internal)) return true;
  try {
    return !readdirSync(internal).some((f) => /^\.step-\d+-done\.json$/.test(f));
  } catch {
    return false;
  }
}

/** Mede uma edição: itens do rascunho que chegou ao gate × aprovado. `null` = não mensurável. */
export function measureEditionCuts(editionDir: string): EditionCutRecord | null {
  const finalPath = join(editionDir, "02-reviewed.md");
  if (!existsSync(finalPath)) return null;
  const finalRaw = readFileSync(finalPath, "utf8");
  const health = assessStage2BaselineOnDisk(editionDir);
  const snap = readSnapshots(editionDir, STAGE2_BASELINE_LABEL, STAGE2_SNAPSHOT_FILES).get("02-reviewed.md");
  const raw = newsletterBaseline(editionDir, health, snap, finalRaw);
  if (raw === null) return null;
  const items = classifyEditionItems(raw.baseline, normalizeNewsletterForComparison(finalRaw));
  if (items.length === 0) return null;
  return { baseline_source: raw.source, items };
}

/**
 * Atualiza o estado com as edições fechadas ainda não contadas (todas, com
 * `rebuild`), estritamente anteriores a `before` quando dado. Devolve o
 * número de edições novas contadas.
 */
export function updateState(
  state: DomainCutState,
  editionsRoot: string,
  opts: { before?: string; rebuild?: boolean; now: string },
): number {
  if (opts.rebuild) state.editions = {};
  let added = 0;
  const dirs = [...enumerateEditionDirs(editionsRoot).entries()]
    .filter(([e]) => /^\d{6}$/.test(e) && (!opts.before || e < opts.before))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [edition, dir] of dirs) {
    if (state.editions[edition] || !isClosedEdition(dir)) continue;
    const rec = measureEditionCuts(dir);
    if (!rec) continue;
    state.editions[edition] = rec;
    added++;
  }
  state.updated_at = opts.now;
  return added;
}

function readText(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function loadDecisions(path: string): DecisionRecord[] {
  return parseDecisions(readText(path) ?? "");
}

/** Domínio já decidido: blacklist, lista de mantidos, ou decisão registrada. */
export function makeIsDecided(decisions: readonly DecisionRecord[]): (domain: string) => boolean {
  const recorded = decisions.map((d) => d.domain);
  return (domain) => isDomainEditoriallyBlocked(domain) || isEditoriallyKept(domain) || domainInList(domain, recorded);
}

/** Decisões registradas que ainda não chegaram ao arquivo de lista correspondente. */
export function pendingDecisions(decisions: readonly DecisionRecord[], blocklistSrc: string, keepSrc: string): DecisionRecord[] {
  return decisions.filter((d) => {
    const src = d.decision === "retirar" ? blocklistSrc : keepSrc;
    return !src.includes(JSON.stringify(d.domain));
  });
}

function statusOf(decisions: readonly DecisionRecord[]): (domain: string) => string {
  return (domain) => {
    if (isDomainEditoriallyBlocked(domain)) return "blacklist";
    if (isEditoriallyKept(domain)) return "mantido (lista)";
    const d = decisions.find((x) => domainInList(domain, [x.domain]));
    if (d) return d.decision === "retirar" ? "decidido: retirar (pendente no código)" : "decidido: manter (pendente no código)";
    return "—";
  };
}

function writeState(path: string, state: DomainCutState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function issueBody(pending: readonly DecisionRecord[]): string {
  return [
    "Decisões do editor registradas no gate 4 pelo monitor de domínios cortados (#9787) que ainda não estão no código.",
    "",
    ...pending.map((d) => `- \`${d.domain}\` → **${d.decision}** (registrado em ${d.decided_at}${d.edition ? `, gate da edição ${d.edition}` : ""})`),
    "",
    "Aplicar (idempotente), commitar e abrir PR:",
    "",
    "```",
    "npx tsx scripts/editorial-domain-cuts.ts --apply-to-code",
    "```",
    "",
    "Prioridade P2: a decisão já é respeitada pelo monitor (o domínio não é reperguntado), mas `retirar` só tira o domínio da pesquisa depois de entrar em `EDITORIAL_BLOCKLIST`.",
  ].join("\n");
}

/** Abre a issue de aplicação (uma só — dedup por título entre as abertas). Fail-soft. */
function openApplyIssue(pending: readonly DecisionRecord[]): void {
  if (pending.length === 0) return;
  const list = spawnGhSync(["issue", "list", "--state", "open", "--search", `"${APPLY_ISSUE_TITLE}" in:title`, "--json", "number,title"], ROOT);
  if (list.status !== 0) {
    console.error(`[editorial-domain-cuts] ⚠️ gh issue list falhou — issue de aplicação não aberta: ${list.stderr.trim()}`);
    return;
  }
  try {
    const open = (JSON.parse(list.stdout || "[]") as Array<{ number: number; title: string }>).find((i) => i.title === APPLY_ISSUE_TITLE);
    if (open) {
      const c = spawnGhSync(["issue", "comment", String(open.number), "--body", issueBody(pending)], ROOT);
      console.error(c.status === 0 ? `[editorial-domain-cuts] issue #${open.number} atualizada.` : `[editorial-domain-cuts] ⚠️ comentário na #${open.number} falhou.`);
      return;
    }
  } catch {
    console.error("[editorial-domain-cuts] ⚠️ resposta do gh ilegível — issue de aplicação não aberta.");
    return;
  }
  const c = spawnGhSync(["issue", "create", "--title", APPLY_ISSUE_TITLE, "--label", "enhancement", "--label", "P2", "--body", issueBody(pending)], ROOT);
  console.error(c.status === 0 ? `[editorial-domain-cuts] issue aberta: ${c.stdout.trim()}` : `[editorial-domain-cuts] ⚠️ gh issue create falhou: ${c.stderr.trim()}`);
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionsRoot = resolve(values["editions-root"] ?? join(ROOT, "data", "editions"));
  const statePath = resolve(values["state"] ?? join(ROOT, "data", "editorial-domain-cuts.json"));
  const decisionsPath = resolve(values["decisions"] ?? join(ROOT, "data", "editorial-domain-decisions.jsonl"));
  const min = values["min"] ? Number(values["min"]) : MIN_CUT_OCCURRENCES;
  const now = new Date().toISOString();
  const mode = ["report", "questions", "record", "pending", "apply-to-code"].find((m) => flags.has(m));
  if (!mode || !Number.isFinite(min) || min < 1) {
    console.error("Uso: editorial-domain-cuts.ts (--report [--all] [--json] [--no-write] | --questions --edition AAMMDD | --record --edition AAMMDD --answers \"dominio=retirar\" [--open-apply-issue] | --pending | --apply-to-code)");
    process.exit(1);
  }
  const decisions = loadDecisions(decisionsPath);

  if (mode === "report" || mode === "questions") {
    const edition = values["edition"];
    if (mode === "questions" && !/^\d{6}$/.test(edition ?? "")) {
      console.error("--questions exige --edition AAMMDD");
      process.exit(1);
    }
    let tallies: DomainTally[];
    let candidates: DomainTally[];
    try {
      const state = parseState(readText(statePath), now);
      const added = updateState(state, editionsRoot, { before: mode === "questions" ? edition : undefined, rebuild: flags.has("rebuild"), now });
      if (!flags.has("no-write")) writeState(statePath, state);
      // No gate, conta só o que é anterior à edição em curso, mesmo que o estado tenha mais.
      const items = stateItems(state);
      if (mode === "questions") for (const e of Object.keys(items)) if (e >= edition!) delete items[e];
      tallies = tallyByDomain(items);
      candidates = selectCandidates(tallies, { minOccurrences: min, isDecided: makeIsDecided(decisions) });
      console.error(`[editorial-domain-cuts] ${Object.keys(items).length} edições contadas (${added} novas); ${candidates.length} candidato(s).`);
    } catch (err) {
      if (mode === "questions") {
        console.error(`[editorial-domain-cuts] ⚠️ monitor indisponível: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      throw err;
    }
    if (mode === "questions") {
      const block = formatGateQuestions(candidates);
      if (block) process.stdout.write(block + "\n");
      return;
    }
    if (flags.has("json")) {
      console.log(JSON.stringify({ min_occurrences: min, candidates, tallies: flags.has("all") ? tallies : tallies.filter((t) => t.total >= min) }, null, 2));
      return;
    }
    console.log(`## Domínios no gate 4: retirado × mantido (piso ${min} ocorrências)\n`);
    console.log(renderAuditTable(tallies, { minOccurrences: min, all: flags.has("all"), status: statusOf(decisions) }));
    console.log(`\nCandidatos (retirado > mantido, ≥ ${min}, não decididos): ${candidates.map((c) => `${c.domain} (${c.retirado}×${c.mantido})`).join(", ") || "nenhum"}.`);
    return;
  }

  if (mode === "record") {
    const edition = values["edition"];
    let answers: ReturnType<typeof parseDecisionAnswers>;
    try {
      answers = parseDecisionAnswers(values["answers"] ?? "");
    } catch (err) {
      console.error(`[editorial-domain-cuts] ❌ ${err instanceof Error ? err.message : String(err)} — nada gravado.`);
      process.exit(1);
    }
    const state = parseState(readText(statePath), now);
    const tallies = tallyByDomain(stateItems(state));
    mkdirSync(dirname(decisionsPath), { recursive: true });
    for (const a of answers) {
      const t = tallies.find((x) => x.domain === a.domain);
      const rec: DecisionRecord = { domain: a.domain, decision: a.decision, decided_at: now, ...(edition ? { edition } : {}), ...(t ? { retirado: t.retirado, mantido: t.mantido } : {}) };
      appendFileSync(decisionsPath, JSON.stringify(rec) + "\n", "utf8");
      console.error(`[editorial-domain-cuts] registrado: ${a.domain} → ${a.decision}`);
    }
    if (flags.has("open-apply-issue")) {
      openApplyIssue(pendingDecisions(loadDecisions(decisionsPath), readFileSync(BLOCKLIST_FILE, "utf8"), readFileSync(KEEP_LIST_FILE, "utf8")));
    }
    return;
  }

  const blockSrc = readFileSync(BLOCKLIST_FILE, "utf8");
  const keepSrc = readFileSync(KEEP_LIST_FILE, "utf8");
  const pending = pendingDecisions(decisions, blockSrc, keepSrc);
  if (mode === "pending") {
    for (const d of pending) console.log(`${d.domain}\t${d.decision}\t${d.decided_at}${d.edition ? `\t${d.edition}` : ""}`);
    if (pending.length === 0) console.error("[editorial-domain-cuts] nenhuma decisão pendente.");
    return;
  }
  // apply-to-code
  let nextBlock = blockSrc;
  let nextKeep = keepSrc;
  for (const d of pending) {
    if (d.decision === "retirar") nextBlock = insertSetEntry(nextBlock, "EDITORIAL_BLOCKLIST", d.domain, formatListEntry(d));
    else nextKeep = insertSetEntry(nextKeep, "EDITORIAL_KEEP_LIST", d.domain, formatListEntry(d));
    console.error(`[editorial-domain-cuts] aplicado: ${d.domain} → ${d.decision === "retirar" ? "EDITORIAL_BLOCKLIST" : "EDITORIAL_KEEP_LIST"}`);
  }
  if (nextBlock !== blockSrc) writeFileSync(BLOCKLIST_FILE, nextBlock, "utf8");
  if (nextKeep !== keepSrc) writeFileSync(KEEP_LIST_FILE, nextKeep, "utf8");
  if (pending.length === 0) console.error("[editorial-domain-cuts] nada a aplicar.");
}

if (isMainModule(import.meta.url)) main();
