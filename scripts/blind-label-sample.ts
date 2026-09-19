/**
 * blind-label-sample.ts (#5995 original, generalizado em #8413)
 *
 * CLI fino sobre `scripts/lib/blind-label-core.ts` — o motor genérico de
 * gabarito cego que substitui a versão anterior deste arquivo, hardcoded
 * pro bucket do categorizador. Toda medição do epic #8412 usa este mesmo
 * comando, trocando só `--feature`.
 *
 * `--feature` é OBRIGATÓRIO em todo comando (exceto `--list-features`) —
 * sem default, porque um default implícito faria uma medição nova rodar
 * silenciosamente contra o pool errado se o operador esquecer a flag.
 *
 * Estado por feature em `data/jev-eval/{feature}/` (sample.json + labels.jsonl,
 * gitignored junto com `data/`) — ver docstring de `blind-label-core.ts`.
 *
 * Uso:
 *   npx tsx scripts/blind-label-sample.ts --list-features
 *   npx tsx scripts/blind-label-sample.ts --feature X --generate 60
 *   npx tsx scripts/blind-label-sample.ts --feature X --next 4
 *   npx tsx scripts/blind-label-sample.ts --feature X --record <id> <label>
 *   npx tsx scripts/blind-label-sample.ts --feature X --report
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { generate, next, record, report } from "./lib/blind-label-core.ts";
import { FEATURE_REGISTRY, getFeature } from "./lib/blind-label-features.ts";

const ROOT = resolve(import.meta.dirname, "..");

function requireFeature(argv: string[]) {
  const id = getStringArg(argv, "feature");
  if (!id) {
    console.error(`--feature é obrigatório. Features registradas: ${Object.keys(FEATURE_REGISTRY).join(", ") || "(nenhuma)"}`);
    process.exit(2);
  }
  const def = getFeature(id);
  if (!def) {
    console.error(`feature desconhecida: ${id}. Registradas: ${Object.keys(FEATURE_REGISTRY).join(", ") || "(nenhuma)"}`);
    process.exit(2);
  }
  return def;
}

function requireCorpus() {
  const editions = resolve(ROOT, "data", "editions");
  if (!existsSync(editions)) {
    console.error(
      `data/editions/ ausente em ${ROOT}.\n` +
        `Esta máquina não tem o corpus montado (sessão cloud, clone fresco).\n` +
        `Crie a junction do OneDrive antes de rodar — ver CLAUDE.md passo 2b.`,
    );
    process.exit(2);
  }
}

function cmdGenerate(argv: string[]) {
  const def = requireFeature(argv);
  requireCorpus();
  const n = getIntArg(argv, "generate", { min: 1 }) ?? 60;
  try {
    const r = generate(ROOT, def, n);
    console.log(`pool: ${r.poolSize} itens`);
    console.log(`amostra: ${r.pickedCount} (${r.alreadyLabeled} já rotulados, preservados)`);
    for (const [stratum, count] of r.byStratum) console.log(`  ${stratum.padEnd(14)} ${count}`);
    if (r.skipped.length) {
      console.warn(`\n${r.skipped.length} edição(ões) ilegível(is), fora do pool:`);
      for (const s of r.skipped) console.warn(`  ${s}`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

function cmdNext(argv: string[]) {
  const def = requireFeature(argv);
  const k = getIntArg(argv, "next", { min: 1 }) ?? 4;
  try {
    const items = next(ROOT, def.id, k);
    // Saída SEM o palpite — é isso que garante a cegueira.
    console.log(JSON.stringify(items.map((i) => ({ id: i.id, ...i.display })), null, 2));
    console.error(`\n(use --report pra progresso)`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}

function cmdRecord(argv: string[]) {
  const def = requireFeature(argv);
  const i = argv.indexOf("--record");
  const [id, label] = [argv[i + 1], argv[i + 2]];
  if (!id || !label) {
    console.error("uso: --feature X --record <id> <label>");
    process.exit(2);
  }
  try {
    record(ROOT, def, id, label);
    console.log(`ok ${label} ← ${id}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}

function cmdReport(argv: string[]) {
  const def = requireFeature(argv);
  const r = report(ROOT, def);
  if (!r) {
    console.error("rode --generate primeiro");
    process.exit(2);
  }
  if (r.labeled === 0) {
    console.log("nenhum rótulo ainda");
    return;
  }
  console.log(`GABARITO LIMPO (n=${r.labeled} de ${r.total})`);
  console.log(`  mecanismo atual acerta: ${r.agree}/${r.labeled} (${((r.agree / r.labeled) * 100).toFixed(1)}%)`);
  if (r.disagreements.length) {
    console.log(`\n  discordâncias (mecanismo → editor):`);
    const dir = new Map<string, number>();
    for (const d of r.disagreements) {
      const k = `${d.hiddenGuess} → ${d.label}`;
      dir.set(k, (dir.get(k) ?? 0) + 1);
    }
    for (const [k, v] of [...dir].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${v}`);
    for (const d of r.disagreements) {
      console.log(`    · ${d.hiddenGuess} → ${d.label} [${d.hiddenRule ?? "?"}] ${d.id.slice(0, 70)}`);
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (parsed.flags.has("list-features")) {
    console.log(Object.keys(FEATURE_REGISTRY).join("\n") || "(nenhuma feature registrada)");
    return;
  }
  if (parsed.flags.has("generate") || parsed.values["generate"] !== undefined) {
    cmdGenerate(argv);
  } else if (parsed.flags.has("next") || parsed.values["next"] !== undefined) {
    cmdNext(argv);
  } else if (parsed.flags.has("record") || parsed.values["record"] !== undefined) {
    cmdRecord(argv);
  } else if (parsed.flags.has("report")) {
    cmdReport(argv);
  } else {
    console.error(
      "uso: --list-features | --feature X --generate N | --feature X --next K | " +
        "--feature X --record <id> <label> | --feature X --report",
    );
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
