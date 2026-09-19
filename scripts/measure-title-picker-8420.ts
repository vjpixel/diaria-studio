/**
 * measure-title-picker-8420.ts — medição 7a do epic #8412 (issue #8420)
 *
 * @one-off-validity: expira=2026-10-19 pergunta="title-picker via Sonnet bate/supera Jev (choice entre 3 títulos) na escolha do título que sobrevive até 02-reviewed.md?"
 *
 * Mede se o Jev (tipo `choice`) bateria ou superaria o mecanismo atual
 * (`title-picker`, Sonnet) na escolha de 1 entre 3 opções de título por
 * destaque. Ao contrário das medições 1/4 (#8414/#8417), o gabarito aqui NÃO
 * precisa de rotulagem cega humana: o "rótulo verdadeiro" é um FATO mecânico
 * já registrado em disco — qual dos 3 títulos sobreviveu até `02-reviewed.md`
 * (o que o editor de fato publicou, seja porque ele podou manualmente, seja
 * porque não tocou na escolha do `title-picker`).
 *
 * Duas populações no corpus (`data/editions/*`):
 *   - "manual": `_internal/02-title-picks.json` AUSENTE — o editor podou os 3
 *     títulos pra 1 sozinho no gate, sem o fallback automático rodar. Gabarito
 *     limpo: são a intenção editorial direta.
 *   - "picked": `_internal/02-title-picks.json` PRESENTE — o title-picker
 *     rodou e escolheu; o título que sobreviveu até o final quase sempre é a
 *     escolha DELE (silêncio == concordância, mesmo padrão epistêmico de
 *     `BUCKET_TIEBREAKER_8211_FEATURE`/`NEGATIVE_IMPACT_8414_FEATURE` em
 *     `scripts/lib/blind-label-features.ts`).
 *
 * Como não há como re-invocar o `title-picker` (agente Sonnet real) em lote
 * sem custo alto, o "mecanismo" reproduzido aqui é um julgamento BLIND feito
 * por um humano/agente Sonnet aplicando o MESMO rubrico de
 * `.claude/agents/title-picker.md` sobre as 3 opções embaralhadas (sem ver
 * qual sobreviveu) — registrado em `mechanism-blind-picks.json`, um pick por
 * item na mesma ordem de `sample.json`. Isso é uma REPRODUÇÃO do mecanismo
 * (mesma família de modelo, mesmo rubrico), não uma leitura do mecanismo de
 * produção ao vivo — documentado aqui para quem for repetir a medição.
 *
 * Estado em `data/jev-eval/title-picker-8420/`:
 *   - `sample.json` — pool amostrado (--generate)
 *   - `mechanism-blind-picks.json` — 1 título escolhido por item, na ordem de
 *     `sample.json` (preenchido manualmente/por agente — NÃO gerado por
 *     este script)
 *   - `eval-rows.json` — output de --eval
 *
 * Uso:
 *   npx tsx scripts/measure-title-picker-8420.ts --generate [--n 40]
 *   # preencher mechanism-blind-picks.json manualmente
 *   npx tsx scripts/measure-title-picker-8420.ts --eval
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getIntArg, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { askJevBatch, type JevChoiceAnswer } from "./lib/jev.ts";
import { mcnemarTest } from "./lib/mcnemar.ts";

const ROOT = resolve(import.meta.dirname, "..");
const FEATURE_DIR = join(ROOT, "data", "jev-eval", "title-picker-8420");
const SAMPLE_PATH = join(FEATURE_DIR, "sample.json");
const PICKS_PATH = join(FEATURE_DIR, "mechanism-blind-picks.json");
const ROWS_PATH = join(FEATURE_DIR, "eval-rows.json");

function stableRank(id: string): number {
  return parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16);
}

interface DestaqueBlock {
  category: string;
  titles: string[];
  url: string | null;
}

export function parseDestaques(md: string): DestaqueBlock[] {
  const lines = md.split("\n");
  const blocks: DestaqueBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const headerMatch = lines[i].match(/^\*\*DESTAQUE\s+\d+\s*\|\s*(.+?)\*\*\s*$/);
    if (headerMatch) {
      const category = headerMatch[1].trim();
      const titles: string[] = [];
      let url: string | null = null;
      let j = i + 1;
      while (j < lines.length) {
        const line = lines[j].trim();
        if (line === "") { j++; continue; }
        const titleMatch = line.match(/^\*\*\[(.+?)\]\((.+?)\)\*\*/);
        if (titleMatch) {
          titles.push(titleMatch[1]);
          if (!url) url = titleMatch[2];
          j++;
          continue;
        }
        break;
      }
      blocks.push({ category, titles, url });
      i = j;
      continue;
    }
    i++;
  }
  return blocks;
}

export function extractBodyForUrl(md: string, url: string): string | null {
  const idx = md.indexOf(`](${url})`);
  if (idx === -1) return null;
  const afterTitles = md.slice(idx);
  const whyIdx = afterTitles.indexOf("Por que isso importa");
  if (whyIdx === -1) return null;
  const block = afterTitles.slice(0, whyIdx);
  const bodyLines = block
    .split("\n")
    .filter((l) => !l.trim().startsWith("**[") && l.trim() !== "")
    .join(" ")
    .trim();
  return bodyLines.slice(0, 500);
}

interface PoolCandidate {
  edition: string;
  category: string;
  url: string;
  options: string[];
  finalTitle: string;
  titlePickerRan: boolean;
  titlePickerChoice: string | null;
  summary: string;
  shuffledOptions: string[];
}

function collectPool(): { candidates: PoolCandidate[]; skippedNoFiles: number; skippedNoMatch: number; totalEditions: number } {
  const editionsRoot = join(ROOT, "data", "editions");
  const dirs = enumerateEditionDirs(editionsRoot);
  const candidates: PoolCandidate[] = [];
  let skippedNoFiles = 0;
  let skippedNoMatch = 0;

  for (const [edition, dir] of dirs) {
    const draftPath = join(dir, "_internal", "02-draft.md");
    const reviewedPath = join(dir, "02-reviewed.md");
    if (!existsSync(draftPath) || !existsSync(reviewedPath)) { skippedNoFiles++; continue; }

    let draft: string, reviewed: string;
    try {
      draft = readFileSync(draftPath, "utf8");
      reviewed = readFileSync(reviewedPath, "utf8");
    } catch { skippedNoFiles++; continue; }

    const draftBlocks = parseDestaques(draft);
    const reviewedBlocks = parseDestaques(reviewed);

    let picks: any = null;
    const picksPath = join(dir, "_internal", "02-title-picks.json");
    if (existsSync(picksPath)) {
      try { picks = JSON.parse(readFileSync(picksPath, "utf8")); } catch { picks = null; }
    }

    for (const rb of reviewedBlocks) {
      if (!rb.url || rb.titles.length !== 1) continue;
      const db = draftBlocks.find((b) => b.url === rb.url);
      if (!db) { skippedNoMatch++; continue; }
      if (db.titles.length < 2) continue;
      const finalTitle = rb.titles[0];
      const exactMatch = db.titles.some((t) => t.trim() === finalTitle.trim());
      if (!exactMatch) { skippedNoMatch++; continue; }

      let titlePickerRan = false;
      let titlePickerChoice: string | null = null;
      if (picks?.picks) {
        const pick = picks.picks.find((p: any) => db.titles.includes(p.chosen));
        if (pick) { titlePickerRan = true; titlePickerChoice = pick.chosen; }
      }

      const summary = extractBodyForUrl(draft, rb.url) ?? "";
      const withRank = db.titles.slice(0, 3).map((t, idx) => ({ t, r: stableRank(rb.url + "|" + idx) }));
      withRank.sort((a, b) => a.r - b.r);

      candidates.push({
        edition, category: rb.category, url: rb.url,
        options: db.titles.slice(0, 3), finalTitle, titlePickerRan, titlePickerChoice, summary,
        shuffledOptions: withRank.map((w) => w.t),
      });
    }
  }
  return { candidates, skippedNoFiles, skippedNoMatch, totalEditions: dirs.size };
}

function cmdGenerate(n: number) {
  const { candidates, skippedNoFiles, skippedNoMatch, totalEditions } = collectPool();
  const manual = candidates.filter((c) => !c.titlePickerRan);
  const picked = candidates.filter((c) => c.titlePickerRan);
  picked.sort((a, b) => stableRank(a.url) - stableRank(b.url));
  const pickedSample = picked.slice(0, Math.max(0, n - manual.length));
  const sample = [...manual, ...pickedSample];

  console.log(`editions scanned: ${totalEditions}, skippedNoFiles: ${skippedNoFiles}, skippedNoMatch: ${skippedNoMatch}`);
  console.log(`pool total: ${candidates.length} (manual=${manual.length}, picked=${picked.length})`);
  console.log(`amostra: ${sample.length} (manual=${manual.length}, picked=${pickedSample.length})`);

  writeFileSync(SAMPLE_PATH, JSON.stringify(sample, null, 2));
  console.log(`\nwrote ${SAMPLE_PATH}`);
  console.log(`Próximo passo: preencher ${PICKS_PATH} com 1 título escolhido por item (na mesma ordem de sample.json,`);
  console.log(`aplicando o rubrico de .claude/agents/title-picker.md SEM olhar finalTitle/titlePickerChoice), depois rodar --eval.`);
}

const OPTION_KEYS = ["opcao_a", "opcao_b", "opcao_c"];

const TITLE_CHOICE_INSTRUCTIONS =
  "Escolha o melhor título de destaque de newsletter diária de IA (diar.ia.br), dado o resumo do fato. " +
  "Critérios em ordem de prioridade: " +
  "(1) Tom clickbait elegante: tensão/drama factual (verbo de conflito sustentado pelo fato), pergunta provocativa, " +
  "ou referência direta ao leitor — sem mentira, sem inflar fato. Nunca escolha uma opção com curiosity gap " +
  "(reter informação central pra forçar clique) ou na faixa vulgar (\"você não vai acreditar\", exclamação, CAPS LOCK). " +
  "(2) Concretude do hook: prefira a entidade (empresa/produto/pessoa) como sujeito de uma ação CONCRETA e verificável " +
  "(lança, cria, compra, apaga, força) em vez de projeção/estimativa (\"pode\", \"quer\", \"planeja\", cifra macro). " +
  "(3) Coerência de tom: direto, sem adjetivos vazios, sem superlativos vazios, sem exclamação, português natural. " +
  "(4) Em empate: prefira a opção que omite \"IA\"/\"inteligência artificial\" quando a frase continuar clara sem o termo.";

async function cmdEval() {
  if (!existsSync(SAMPLE_PATH)) { console.error(`rode --generate primeiro (${SAMPLE_PATH} ausente)`); process.exit(2); }
  if (!existsSync(PICKS_PATH)) { console.error(`${PICKS_PATH} ausente — preencha com os picks blind do mecanismo antes de --eval`); process.exit(2); }

  loadProjectEnv(ROOT);
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) { console.error("TYPESAFE_API_KEY ausente"); process.exit(2); }

  const sample: PoolCandidate[] = JSON.parse(readFileSync(SAMPLE_PATH, "utf8"));
  const myPicks: string[] = JSON.parse(readFileSync(PICKS_PATH, "utf8"));
  if (myPicks.length !== sample.length) throw new Error(`mismatch: ${myPicks.length} picks vs ${sample.length} items em sample.json`);

  const jevItems = sample.map((item, idx) => {
    const criteria: Record<string, string> = {};
    item.shuffledOptions.forEach((t, i) => { criteria[OPTION_KEYS[i]] = t; });
    return {
      id: String(idx),
      state: { category: item.category, summary: item.summary },
      questions: [{ id: "title_choice", type: "choice" as const, instructions: TITLE_CHOICE_INSTRUCTIONS, criteria }],
      cacheKey: `title-picker-8420:${item.edition}:${item.url}`,
    };
  });

  const cacheDir = join(FEATURE_DIR, "cache");
  const { results, errors } = await askJevBatch(jevItems, { apiKey, cacheDir });
  if (errors.size > 0) {
    console.error(`${errors.size} falha(s) de transporte:`);
    for (const [id, e] of errors) console.error(`  ${id}: ${e instanceof Error ? e.message : e}`);
  }
  const byId = new Map(results.map((r) => [r.id, r.answers[0] as JevChoiceAnswer]));

  type Row = {
    edition: string; category: string; finalTitle: string; titlePickerRan: boolean; titlePickerChoice: string | null;
    myPick: string; myCorrect: boolean; jevPick: string | null; jevConfidence: number | null; jevCorrect: boolean | null;
    tpCorrect: boolean | null;
  };

  const rows: Row[] = sample.map((item, idx) => {
    const optKeyToTitle: Record<string, string> = {};
    item.shuffledOptions.forEach((t, i) => { optKeyToTitle[OPTION_KEYS[i]] = t; });
    const ans = byId.get(String(idx));
    const jevPick = ans ? optKeyToTitle[ans.choice] ?? null : null;
    const myPick = myPicks[idx];
    if (!item.shuffledOptions.includes(myPick)) throw new Error(`item ${idx}: pick não está entre as opções: ${myPick}`);
    return {
      edition: item.edition, category: item.category, finalTitle: item.finalTitle,
      titlePickerRan: item.titlePickerRan, titlePickerChoice: item.titlePickerChoice,
      myPick, myCorrect: myPick.trim() === item.finalTitle.trim(),
      jevPick, jevConfidence: ans?.confidence ?? null,
      jevCorrect: jevPick !== null ? jevPick.trim() === item.finalTitle.trim() : null,
      tpCorrect: item.titlePickerRan ? (item.titlePickerChoice as string).trim() === item.finalTitle.trim() : null,
    };
  });

  writeFileSync(ROWS_PATH, JSON.stringify(rows, null, 2));

  const n = rows.length;
  const myAgree = rows.filter((r) => r.myCorrect).length;
  const withJev = rows.filter((r) => r.jevCorrect !== null);
  const jevAgree = withJev.filter((r) => r.jevCorrect).length;

  console.log(`\n=== título-picker (#8420) — n=${n} ===`);
  console.log(`mecanismo (Sonnet, reprodução blind do rubrico) acerta vs. final publicado: ${myAgree}/${n} (${((myAgree / n) * 100).toFixed(1)}%)`);
  console.log(`Jev acerta vs. final publicado: ${jevAgree}/${withJev.length} (${withJev.length ? ((jevAgree / withJev.length) * 100).toFixed(1) : "—"}%)`);

  const tpRan = rows.filter((r) => r.titlePickerRan);
  const tpCorrect = tpRan.filter((r) => r.tpCorrect).length;
  console.log(`\nsubset onde o title-picker rodou de fato (n=${tpRan.length}): escolha real sobreviveu até o final em ${tpCorrect}/${tpRan.length} (trivial — silêncio == concordância, não é sinal de qualidade)`);

  const both = withJev;
  const aCorrectBWrong = both.filter((r) => r.myCorrect && !r.jevCorrect).length;
  const aWrongBCorrect = both.filter((r) => !r.myCorrect && r.jevCorrect).length;
  const mc = mcnemarTest({ aCorrectBWrong, aWrongBCorrect });
  console.log(`\nMcNemar (mecanismo blind vs Jev) — n comparável=${both.length}`);
  console.log(`  mecanismo certo / Jev errado: ${mc.b}`);
  console.log(`  mecanismo errado / Jev certo: ${mc.c}`);
  console.log(`  p (exato, binomial) = ${mc.pValueExact.toFixed(4)}`);
  console.log(`  p (chi2) = ${mc.pValueChiSquare.toFixed(4)}`);

  console.log(`\nCurva confiança x acerto (Jev):`);
  for (let i = 0; i < 5; i++) {
    const lo = i * 0.2, hi = i === 4 ? 1.0001 : (i + 1) * 0.2;
    const inb = withJev.filter((r) => r.jevConfidence !== null && r.jevConfidence >= lo && r.jevConfidence < hi);
    const correct = inb.filter((r) => r.jevCorrect).length;
    console.log(`  [${lo.toFixed(1)},${hi === 1.0001 ? "1.0" : hi.toFixed(1)}) n=${inb.length} acerto=${inb.length ? ((correct / inb.length) * 100).toFixed(1) + "%" : "—"}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--generate")) {
    cmdGenerate(getIntArg(argv, "n", { min: 1 }) ?? 40);
  } else if (argv.includes("--eval")) {
    await cmdEval();
  } else {
    console.error("uso: npx tsx scripts/measure-title-picker-8420.ts --generate [--n 40] | --eval");
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
