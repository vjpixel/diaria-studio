/**
 * test/use-melhor-pick-13849.test.ts (#13849)
 *
 * Caso 261123: o editor moveu "O que o Gemini sabe sobre você?" do RADAR para o
 * USE MELHOR no gate e pediu o 4º post sobre ele. `select-use-melhor-post.ts
 * --reviewed --force` re-selecionou "7 formas de usar o Claude Code" (score 68,
 * único item do bucket `use_melhor`), porque só considerava esse bucket; o item
 * movido (score 85 no RADAR) nunca entrava na disputa. Sem caminho oficial, o
 * `_internal/use-melhor-post.json` foi escrito à mão.
 *
 * Cobre: (1) `--url`/`--pick` escolhe qualquer item do USE MELHOR final;
 * (2) `--reviewed` considera item movido de outro bucket, com o score do pool
 * limitado ao maior score do bucket `use_melhor` (self-review PR #13858,
 * finding 1); (3) a nota "há item de maior score" do `--status` olha todos os
 * buckets (finding 2); (4) `--url` com o 4º post desligado avisa (nota 3).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  comparableUseMelhorScore,
  describeUseMelhorPostStatus,
  higherScoredRenderedItem,
  pickUseMelhorItem,
  poolCandidatesForReviewed,
  selectUseMelhorItem,
  USE_MELHOR_PICK_SELECTED_FROM,
  USE_MELHOR_SOURCE_TEXT_REL,
  type UseMelhorPostConfigState,
} from "../scripts/lib/use-melhor-post.ts";
import { PickError, pickIgnoredWarning, runSelection, runSelectionWithSteps } from "../scripts/select-use-melhor-post.ts";
import { gatherUseMelhorStatusInput } from "../scripts/lib/use-melhor-status.ts";

const ON: UseMelhorPostConfigState = { enabled: true, time: "07:45" };

const CLAUDE = {
  url: "https://canaltech.com.br/inteligencia-artificial/como-usar-claude-code-tocar-negocio-sem-saber-programar/",
  title: "7 formas de usar o Claude Code para tocar um negócio sem saber programar",
  summary: "Quem toca um pequeno negócio cuida de várias tarefas ao mesmo tempo.",
  score: 68,
};
const GEMINI = {
  url: "https://canaltech.com.br/inteligencia-artificial/veja-o-que-o-gemini-sabe-sobre-voce/",
  title: "O que o Gemini sabe sobre você? Veja como acessar e apagar a memória da IA",
  summary: "Você sabe quais informações o Gemini guarda sobre você? O Google lançou um painel que facilita a consulta e a edição desses dados.",
  score: 85,
};
const HF = {
  url: "https://huggingface.co/blog/moe-expert-streaming",
  title: "180B Parameters, 32GB of RAM: Pushing MoE Inference to the Limit with Transformers",
  summary: "Como rodar um modelo MoE de 180 bilhões de parâmetros com 32 GB de RAM.",
  score: 40,
};
/** Item do RADAR com score maior que todos, mas que FICOU no RADAR. */
const RADAR_TOP = { url: "https://blog.google/products/gemini-app/computer-use-mac/", title: "Gemini no Mac", summary: "", score: 105 };

/** Pool da 261123 (recortado): Gemini e o HF estão no RADAR, só o Claude no `use_melhor`. */
const APPROVED = { use_melhor: [CLAUDE], radar: [RADAR_TOP, GEMINI, HF], lancamento: [], highlights: [] };
const CAPPED = { use_melhor: [CLAUDE], radar: [RADAR_TOP] };

/** USE MELHOR final da 261123, depois dos `move-pool-item.ts` do gate. */
const REVIEWED = [
  "**🛠️ USE MELHOR**",
  "",
  `**[${CLAUDE.title}](${CLAUDE.url})**`,
  `${CLAUDE.summary} (10 min)`,
  "",
  `**[${GEMINI.title}](${GEMINI.url})**`,
  `${GEMINI.summary} (5 min)`,
  "",
  `**[${HF.title}](${HF.url})**`,
  `${HF.summary} (15 min)`,
  "",
  "---",
  "",
  "**📡 RADAR**",
  "",
  `**[${RADAR_TOP.title}](${RADAR_TOP.url})**`,
  "Texto. (3 min)",
  "",
].join("\n");

/** Mesmo USE MELHOR sem o Claude (o único item do bucket `use_melhor`). */
const REVIEWED_SEM_CLAUDE = REVIEWED.replace(`**[${CLAUDE.title}](${CLAUDE.url})**\n${CLAUDE.summary} (10 min)\n\n`, "");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function edition261123(opts: { withState?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-13849-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(CAPPED));
  writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(APPROVED));
  writeFileSync(join(dir, "02-reviewed.md"), REVIEWED);
  if (opts.withState) {
    // Estado do Stage 2: o Claude (único do bucket use_melhor).
    writeFileSync(
      join(dir, "_internal", "use-melhor-post.json"),
      JSON.stringify({ enabled: true, time: "07:45", item: CLAUDE, selected_from: "approved", generated_at: "x" }),
    );
  }
  return dir;
}
const readState = (dir: string) => JSON.parse(readFileSync(join(dir, "_internal", "use-melhor-post.json"), "utf8"));

describe("#13849 item 2 — --reviewed considera item movido de outro bucket", () => {
  it("item movido entra na disputa: sem o Claude renderizado, --reviewed --force escolhe o Gemini (veio do RADAR)", () => {
    const dir = edition261123({ withState: true });
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_SEM_CLAUDE);
    const r = runSelection(dir, ON, { useReviewed: true, forceReselect: true, discontinuationTopics: [] });
    assert.equal(r.state.item?.url, GEMINI.url, JSON.stringify(r.state));
    assert.equal(r.state.item?.score, 85, "o score gravado é o do pool, sem o limite da disputa");
    assert.equal(r.state.item?.pool_bucket, "radar");
    assert.equal(r.state.selected_from, "reviewed");
  });

  it("self-review PR #13858 finding 1: o score do RADAR não vence só pela escala — Gemini (85) limitado ao Claude (68), empate fica com o use_melhor", () => {
    const dir = edition261123({ withState: true });
    const r = runSelection(dir, ON, { useReviewed: true, forceReselect: true, discontinuationTopics: [] });
    assert.equal(r.state.item?.url, CLAUDE.url, JSON.stringify(r.state));
  });

  it("item movido com score do RADAR abaixo do teto do use_melhor ainda vence item do use_melhor de score menor", () => {
    const low = { ...CLAUDE, score: 30 };
    const cs = poolCandidatesForReviewed([{ use_melhor: [CLAUDE, low], radar: [HF] }]);
    // HF (40, RADAR) < teto 68, mas > 30: vence o `low` quando o Claude não está renderizado.
    const sel = selectUseMelhorItem(cs.slice(1), [low.url, HF.url]);
    assert.equal(sel.item?.url, HF.url);
    const cmp = comparableUseMelhorScore(cs);
    assert.equal(cmp({ ...GEMINI, pool_bucket: "radar" }), 68);
    assert.equal(cmp(HF as never), 40);
    // Sem nenhum candidato do use_melhor, não há teto.
    assert.equal(comparableUseMelhorScore([{ ...RADAR_TOP, pool_bucket: "radar" }])({ ...RADAR_TOP, pool_bucket: "radar" }), 105);
  });

  it("item do RADAR com score maior que ficou no RADAR nunca é escolhido", () => {
    const dir = edition261123();
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_SEM_CLAUDE);
    const r = runSelection(dir, ON, { useReviewed: true, discontinuationTopics: [] });
    assert.notEqual(r.state.item?.url, RADAR_TOP.url);
    assert.equal(r.state.item?.url, GEMINI.url);
  });

  it("sem --force, o item já escolhido que segue no USE MELHOR é preservado (#9610 intacto)", () => {
    const dir = edition261123({ withState: true });
    const r = runSelection(dir, ON, { useReviewed: true, discontinuationTopics: [] });
    assert.equal(r.preserved, true);
    assert.equal(r.state.item?.url, CLAUDE.url);
  });

  it("poolCandidatesForReviewed: use_melhor primeiro, depois os demais buckets, sem duplicar URL", () => {
    const cs = poolCandidatesForReviewed([CAPPED, APPROVED]);
    assert.deepEqual(
      cs.map((c) => c.url),
      [CLAUDE.url, RADAR_TOP.url, GEMINI.url, HF.url],
    );
  });
});

describe("#13849 item 1 — --url/--pick escolhe qualquer item do USE MELHOR final", () => {
  it("REGRESSÃO 261123: --url do Gemini grava editor-override-pick com dados do pool", () => {
    const dir = edition261123({ withState: true });
    const r = runSelection(dir, ON, { pickUrl: GEMINI.url, discontinuationTopics: [] });
    assert.equal(r.state.selected_from, USE_MELHOR_PICK_SELECTED_FROM);
    assert.match(USE_MELHOR_PICK_SELECTED_FROM, /^editor-override-/);
    assert.equal(r.state.item?.title, GEMINI.title);
    assert.equal(r.state.item?.summary, GEMINI.summary);
    assert.equal(r.state.item?.score, 85);
    assert.equal(readState(dir).item.url, GEMINI.url);
  });

  it("a escolha sobrevive a um --reviewed depois (preservada, não re-selecionada por score)", () => {
    const dir = edition261123();
    runSelection(dir, ON, { pickUrl: HF.url, discontinuationTopics: [] });
    const r = runSelection(dir, ON, { useReviewed: true, discontinuationTopics: [] });
    assert.equal(r.preserved, true);
    assert.equal(r.state.item?.url, HF.url);
  });

  it("URL fora do USE MELHOR final → PickError, nada gravado", () => {
    const dir = edition261123({ withState: true });
    const before = readFileSync(join(dir, "_internal", "use-melhor-post.json"), "utf8");
    assert.throws(() => runSelection(dir, ON, { pickUrl: RADAR_TOP.url, discontinuationTopics: [] }), PickError);
    assert.equal(readFileSync(join(dir, "_internal", "use-melhor-post.json"), "utf8"), before);
  });

  it("casa a URL normalizada (utm, www, barra final)", () => {
    const r = pickUseMelhorItem(
      "https://www.canaltech.com.br/inteligencia-artificial/veja-o-que-o-gemini-sabe-sobre-voce?utm_source=x",
      REVIEWED,
      [APPROVED],
    );
    assert.equal(r.ok && r.item.url, GEMINI.url);
  });

  it("item colado à mão (fora do pool): título/resumo do markdown, sem '(N min)', score 0", () => {
    const md = ["**🛠️ USE MELHOR**", "", "**[Colado](https://colado.example.com/x)**", "Resumo do editor. (7 min)", ""].join("\n");
    const r = pickUseMelhorItem("https://colado.example.com/x", md, [APPROVED]);
    assert.ok(r.ok);
    assert.deepEqual(r.item, { url: "https://colado.example.com/x", title: "Colado", summary: "Resumo do editor.", score: 0 });
  });

  it("baixa o texto da fonte e grava source_text_path (runSelectionWithSteps)", async () => {
    const dir = edition261123({ withState: true });
    const html = "<html><body><article><p>Passo 1: Abra o Gemini</p><p>Passo 2: Clique em memória</p></article></body></html>";
    const fetchImpl = (async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as never;
    const { state } = await runSelectionWithSteps(dir, ON, { pickUrl: GEMINI.url, fetchImpl, discontinuationTopics: [] });
    assert.equal(state.item?.url, GEMINI.url);
    assert.equal(state.item?.source_text_path, USE_MELHOR_SOURCE_TEXT_REL);
    assert.equal(state.selected_from, USE_MELHOR_PICK_SELECTED_FROM);
    assert.ok(existsSync(join(dir, USE_MELHOR_SOURCE_TEXT_REL)));
    assert.equal(readState(dir).item.source_text_path, USE_MELHOR_SOURCE_TEXT_REL);
  });

  it("CLI: --url sem valor e --url fora do USE MELHOR saem 2", () => {
    const dir = edition261123({ withState: true });
    const run = (...a: string[]) =>
      spawnSync("npx", ["tsx", "scripts/select-use-melhor-post.ts", "--edition-dir", dir, ...a], { encoding: "utf8" });
    assert.equal(run("--url").status, 2);
    const before = readFileSync(join(dir, "_internal", "use-melhor-post.json"), "utf8");
    const off = run("--pick", RADAR_TOP.url);
    // Depende de `use_melhor_time` no platform.config.json real (ligado desde o #9568).
    // Desligado, a CLI só imprime enabled:false (exit 0) — o teste não teria o que provar.
    if (off.status === 0 && /"enabled": false/.test(off.stdout)) return;
    assert.equal(off.status, 2, off.stderr);
    assert.match(off.stderr, /--url recusado/);
    assert.equal(readFileSync(join(dir, "_internal", "use-melhor-post.json"), "utf8"), before);
  });
});

describe("self-review PR #13858 finding 2 — nota de score maior do --status olha todos os buckets", () => {
  it("item escolhido pelo editor (HF) e Claude fora: a nota aponta o Gemini, que veio do RADAR", () => {
    const top = higherScoredRenderedItem({ ...HF }, [CAPPED, APPROVED], REVIEWED_SEM_CLAUDE);
    assert.equal(top?.url, GEMINI.url);
    // Antes do fix: só o bucket use_melhor do capped (o Claude, fora da edição) → sem nota.
  });

  it("coerente com a seleção: Gemini limitado ao teto do Claude não gera nota quando o Claude é o escolhido", () => {
    assert.equal(higherScoredRenderedItem({ ...CLAUDE }, [CAPPED, APPROVED], REVIEWED), null);
  });

  it("--status (gatherUseMelhorStatusInput) lê o pool completo e mostra a nota do Gemini", () => {
    const dir = edition261123();
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_SEM_CLAUDE);
    writeFileSync(
      join(dir, "_internal", "use-melhor-post.json"),
      JSON.stringify({ enabled: true, time: "07:45", item: HF, selected_from: USE_MELHOR_PICK_SELECTED_FROM, generated_at: "x" }),
    );
    const status = describeUseMelhorPostStatus(gatherUseMelhorStatusInput(dir, ON));
    assert.ok(
      status.lines.some((l) => l.includes("ℹ️") && l.includes(GEMINI.title)),
      status.lines.join("\n"),
    );
  });

  it("aceita um JSON aprovado solto (contrato antigo)", () => {
    assert.equal(higherScoredRenderedItem({ ...HF }, APPROVED, REVIEWED_SEM_CLAUDE)?.url, GEMINI.url);
  });
});

describe("self-review PR #13858 nota 3 — --url com o 4º post desligado avisa", () => {
  it("pickIgnoredWarning: avisa quando enabled:false e há --url", () => {
    const w = pickIgnoredWarning(GEMINI.url, { enabled: false, reason: "use_melhor_time ausente" });
    assert.match(w ?? "", /ignorado/);
    assert.match(w ?? "", /use_melhor_time ausente/);
    assert.match(w ?? "", /Nada gravado/);
  });
  it("pickIgnoredWarning: sem --url ou com o 4º post ligado, nada a avisar", () => {
    assert.equal(pickIgnoredWarning(undefined, { enabled: false }), null);
    assert.equal(pickIgnoredWarning(GEMINI.url, { enabled: true }), null);
  });
});
