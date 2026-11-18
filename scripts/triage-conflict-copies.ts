#!/usr/bin/env node
/**
 * triage-conflict-copies.ts (#13423)
 *
 * Triagem das cópias `.conflictN` do rclone bisync acumuladas em `data/` no
 * período de sync quebrado (#13404). Lógica em
 * `scripts/lib/conflict-copy-triage.ts`; este script é a camada de I/O.
 *
 * **Dry-run é o default.** Sem `--apply`, só lista: cada cópia sai com um
 * veredito (`archive`, `review`, `keep`) e o motivo. Nada é movido.
 *
 *   npx tsx scripts/triage-conflict-copies.ts                    # resumo + review/keep
 *   npx tsx scripts/triage-conflict-copies.ts --list all         # lista todas
 *   npx tsx scripts/triage-conflict-copies.ts --out /tmp/triagem-13423.json
 *
 * **`--apply` é do editor**, em dois passos, e só move o que o plano revisado
 * marcou `archive`:
 *
 *   npx tsx scripts/triage-conflict-copies.ts --out /tmp/triagem-13423.json   # 1. grava o plano
 *   (o editor lê o plano)
 *   npx tsx scripts/triage-conflict-copies.ts --apply --plan /tmp/triagem-13423.json
 *
 * Sem `--plan`, o `--apply` é recusado (`exit 2`): não existe caminho que
 * varra e mova numa chamada só. No apply cada entrada é reconferida (sha256
 * da cópia e do original iguais aos do plano, original ainda válido) e vai
 * para `_conflitos-{AAMMDD}/` ao lado dela. Nada é apagado; `review` e `keep`
 * nunca são movidos.
 *
 * Flags:
 *   --root DIR      raiz varrida (default: `data/` do repo)
 *   --out FILE      grava o plano em JSON
 *   --json          imprime o plano em JSON no stdout (em vez do resumo)
 *   --list QUAIS    `review,keep` (default), `all`, ou lista de vereditos
 *   --stamp AAMMDD  sufixo da pasta `_conflitos-*` (default: hoje em BRT)
 *   --apply         move as entradas `archive` do plano (exige --plan)
 *   --plan FILE     plano gravado por um dry-run com --out
 *
 * Saída: `0` ok; `1` falha de leitura (raiz ausente, plano ilegível); `2`
 * uso inválido.
 */

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findUnknownFlags, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  applyTriagePlan,
  buildTriagePlan,
  parseTriagePlan,
  summarizePlan,
  type TriagePlan,
  type Verdict,
} from "./lib/conflict-copy-triage.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KNOWN_FLAGS = ["root", "out", "json", "list", "stamp", "apply", "plan"] as const;
const VERDICTS: readonly Verdict[] = ["archive", "review", "keep"];

function resolveRoot(raw: string | undefined): string {
  const root = resolve(raw ?? `${ROOT}/data`);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`raiz ${root} não existe ou não é diretório (sessão sem data/? rodar no checkout principal)`);
  }
  return realpathSync(root);
}

function parseList(raw: string | undefined): Set<Verdict> {
  if (!raw) return new Set(["review", "keep"]);
  if (raw === "all") return new Set(VERDICTS);
  const out = new Set<Verdict>();
  for (const v of raw.split(",").map((s) => s.trim())) {
    if (!VERDICTS.includes(v as Verdict)) throw new Error(`--list: "${v}" não é veredito (archive, review, keep ou all)`);
    out.add(v as Verdict);
  }
  return out;
}

export function renderReport(plan: TriagePlan, list: Set<Verdict>): string {
  const s = summarizePlan(plan.entries);
  const lines: string[] = [];
  lines.push(`triagem de cópias .conflictN (#13423) — raiz ${plan.root}`);
  lines.push(`total ${s.total}: archive ${s.byVerdict.archive}, review ${s.byVerdict.review}, keep ${s.byVerdict.keep}`);
  lines.push(`motivos: ${Object.entries(s.byReason).map(([r, n]) => `${r} ${n}`).join(", ") || "—"}`);
  lines.push("por diretório:");
  for (const d of s.byDir) lines.push(`  ${String(d.count).padStart(4)}  ${d.dir}`);
  for (const v of VERDICTS) {
    if (!list.has(v)) continue;
    const items = plan.entries.filter((e) => e.verdict === v);
    if (!items.length) continue;
    lines.push("");
    lines.push(`${v} (${items.length}):`);
    for (const e of items) lines.push(`  ${e.rel} — ${e.reason}: ${e.detail}`);
  }
  lines.push("");
  lines.push(`dry-run: nada foi movido. Arquivar = --out <plano.json>, revisão do editor, depois --apply --plan <plano.json> (destino _conflitos-${plan.stamp}/).`);
  return lines.join("\n");
}

export function main(argv: string[]): number {
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  if (unknown.length) {
    console.error(`triage-conflict-copies: flag desconhecida: ${unknown.join(", ")}`);
    return 2;
  }
  let rootArg: string | undefined;
  let out: string | undefined;
  let listRaw: string | undefined;
  let stamp: string | undefined;
  let planPath: string | undefined;
  try {
    rootArg = getStringArg(argv, "root");
    out = getStringArg(argv, "out");
    listRaw = getStringArg(argv, "list");
    stamp = getStringArg(argv, "stamp");
    planPath = getStringArg(argv, "plan");
  } catch (e) {
    console.error(`triage-conflict-copies: ${(e as Error).message}`);
    return 2;
  }
  const apply = hasFlag(argv, "apply");
  if (stamp !== undefined && !/^[\w.-]+$/.test(stamp)) {
    console.error(`triage-conflict-copies: --stamp "${stamp}" não serve de nome de pasta`);
    return 2;
  }

  if (apply) {
    if (!planPath) {
      console.error("triage-conflict-copies: --apply exige --plan <arquivo> gravado por um dry-run com --out e revisado pelo editor");
      return 2;
    }
    if (out || stamp || listRaw || hasFlag(argv, "json")) {
      console.error("triage-conflict-copies: --apply só aceita --plan e --root (o stamp vem do plano)");
      return 2;
    }
    let root: string;
    let plan: TriagePlan;
    try {
      root = resolveRoot(rootArg);
      plan = parseTriagePlan(JSON.parse(readFileSync(planPath, "utf8")));
    } catch (e) {
      console.error(`triage-conflict-copies: ${(e as Error).message}`);
      return 1;
    }
    if (plan.root !== root) {
      console.error(`triage-conflict-copies: o plano é da raiz ${plan.root}, não de ${root}`);
      return 2;
    }
    const results = applyTriagePlan(plan, root);
    const moved = results.filter((r) => r.status === "moved");
    const skipped = results.filter((r) => r.status === "skipped");
    for (const r of skipped) console.log(`pulada: ${r.rel} — ${r.status === "skipped" ? r.why : ""}`);
    console.log(`arquivadas ${moved.length}, puladas ${skipped.length} (de ${plan.entries.filter((e) => e.verdict === "archive").length} archive no plano). Nada apagado.`);
    return 0;
  }

  if (planPath) {
    console.error("triage-conflict-copies: --plan só vale com --apply");
    return 2;
  }
  let list: Set<Verdict>;
  let plan: TriagePlan;
  try {
    list = parseList(listRaw);
    plan = buildTriagePlan(resolveRoot(rootArg), { stamp });
  } catch (e) {
    console.error(`triage-conflict-copies: ${(e as Error).message}`);
    return 1;
  }
  if (out) writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
  if (hasFlag(argv, "json")) console.log(JSON.stringify(plan, null, 2));
  else console.log(renderReport(plan, list) + (out ? `\nplano gravado em ${out}` : ""));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
