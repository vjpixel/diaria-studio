/**
 * test/stage4-docs-sync.test.ts (#9964)
 *
 * Doc editável do gate do Stage 4: round-trip render → parse, cada ramo do
 * merge de 3 vias, conflito que não grava, sentinela corrompida → erro sem
 * escrita parcial, normalização de escapes de export e edição só num arquivo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DocsSyncFormatError,
  beginSentinel,
  decideFile,
  docEquivalent,
  endSentinel,
  matchSentinel,
  mergeDocOnto,
  normalizeLine,
  parseDocExport,
  parseResolutions,
  renderDocMarkdown,
  runApply,
  runRender,
  statePath,
  unescapeForWrite,
} from "../scripts/lib/stage4-docs-sync.ts";

const REVIEWED = [
  "Para esta edição, eu (o editor) enviei 5 artigos.",
  "",
  "---",
  "",
  "DESTAQUE 1 | 💰 MERCADO",
  "",
  "Anthropic levanta rodada série E de US$ 2 bi",
  "",
  "[https://techcrunch.com/2026/04/23/anthropic_funding/](https://techcrunch.com/2026/04/23/anthropic_funding/)",
  "",
  "A Anthropic fechou uma rodada de **US$ 2 bilhões** liderada por Google.",
  "",
  "Por que isso importa:",
  "",
  "Cada rodada redefine as apostas do mercado.",
  "",
].join("\n");

const SOCIAL = [
  "# Social",
  "",
  "## d1",
  "",
  "A regra proíbe conteúdo sintético. **Uma investigação contou 554 vídeos.**",
  "",
  "#InteligenciaArtificial #Deepfake",
  "",
  "## d2",
  "",
  "Texto do d2.",
  "",
].join("\n");

function files(reviewed = REVIEWED, social = SOCIAL) {
  return { "02-reviewed.md": reviewed, "03-social.md": social } as const;
}

/** Simula um export markdown "agressivo": escapes, `__`, `<url>`, CRLF, brancos extras. */
function aggressiveExport(md: string): string {
  return md
    .split("\n")
    .map((l) =>
      l
        .replace(/\$/g, "\\$")
        .replace(/^#(?=[A-Za-z])/g, "\\#")
        .replace(/\|/g, "\\|")
        .replace(/\*\*(.+?)\*\*/g, "__$1__")
        .replace(/\[(https?:\/\/[^\]]+)\]\(\1\)/g, (_m, u: string) => `<${u}>`)
        .replace(/^---$/, "***") + "  ",
    )
    .join("\r\n")
    .replace(/(\r\n  ){2,}/g, "\r\n  \r\n  \r\n");
}

function tmpEdition(reviewed = REVIEWED, social = SOCIAL): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-docs-sync-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), reviewed);
  writeFileSync(join(dir, "03-social.md"), social);
  return dir;
}

describe("render → parse (round-trip)", () => {
  it("devolve exatamente o conteúdo de cada arquivo (sem brancos de borda)", () => {
    const md = renderDocMarkdown({ edition: "261012", files: files(), summary: "Resumo: 3 destaques." });
    const parsed = parseDocExport(md);
    assert.equal(parsed["02-reviewed.md"], REVIEWED.trimEnd());
    assert.equal(parsed["03-social.md"], SOCIAL.trimEnd());
    assert.ok(md.includes("Resumo: 3 destaques."));
  });

  it("sentinelas sobrevivem a escapes/ênfase/heading/acento perdido do export", () => {
    assert.deepEqual(matchSentinel("\\=== INICIO 02\\-reviewed (nao edite esta linha) \\==="), {
      kind: "begin",
      file: "02-reviewed.md",
    });
    assert.deepEqual(matchSentinel("**=== FIM 03-social (não edite esta linha) ===**"), {
      kind: "end",
      file: "03-social.md",
    });
    assert.deepEqual(matchSentinel("## === FIM 02-reviewed ==="), { kind: "end", file: "02-reviewed.md" });
    assert.equal(matchSentinel("=== qualquer coisa ==="), null);
    assert.equal(matchSentinel("DESTAQUE 1 | MERCADO"), null);
  });

  it("render recusa conteúdo que já contém uma linha-sentinela", () => {
    assert.throws(
      () => renderDocMarkdown({ edition: "261012", files: files(REVIEWED + beginSentinel("03-social.md") + "\n") }),
      DocsSyncFormatError,
    );
  });

  it("export agressivo do doc intocado é equivalente à base (nada a puxar)", () => {
    const md = renderDocMarkdown({ edition: "261012", files: files() });
    const parsed = parseDocExport(aggressiveExport(md));
    assert.ok(docEquivalent(REVIEWED, parsed["02-reviewed.md"]));
    assert.ok(docEquivalent(SOCIAL, parsed["03-social.md"]));
    // E o merge preserva o arquivo byte a byte.
    assert.equal(mergeDocOnto(REVIEWED, parsed["02-reviewed.md"]).content, REVIEWED);
  });
});

describe("sentinela corrompida → erro explícito", () => {
  const md = renderDocMarkdown({ edition: "261012", files: files() });

  it("FIM apagado", () => {
    assert.throws(() => parseDocExport(md.replace(endSentinel("02-reviewed.md"), "")), DocsSyncFormatError);
  });
  it("INÍCIO duplicado", () => {
    const dup = md.replace(beginSentinel("03-social.md"), `${beginSentinel("03-social.md")}\n\n${beginSentinel("03-social.md")}`);
    assert.throws(() => parseDocExport(dup), DocsSyncFormatError);
  });
  it("FIM antes do INÍCIO", () => {
    const swapped = md
      .replace(beginSentinel("02-reviewed.md"), "@@B@@")
      .replace(endSentinel("02-reviewed.md"), beginSentinel("02-reviewed.md"))
      .replace("@@B@@", endSentinel("02-reviewed.md"));
    assert.throws(() => parseDocExport(swapped), DocsSyncFormatError);
  });
  it("seções sobrepostas", () => {
    const lines = md.split("\n");
    const endIdx = lines.indexOf(endSentinel("02-reviewed.md"));
    const [endLine] = lines.splice(endIdx, 1);
    lines.push(endLine);
    assert.throws(() => parseDocExport(lines.join("\n")), DocsSyncFormatError);
  });
});

describe("normalização de escapes de export", () => {
  it("escapes de pontuação, entidades, ênfase, listas, quebra temática, links", () => {
    assert.equal(normalizeLine("US\\$ 2 \\| \\#tag \\[x\\] 1\\."), normalizeLine("US$ 2 | #tag [x] 1."));
    assert.equal(normalizeLine("A &amp; B"), "A & B");
    assert.equal(normalizeLine("__forte__ e _leve_"), normalizeLine("**forte** e *leve*"));
    assert.equal(normalizeLine("* item"), "- item");
    assert.equal(normalizeLine("+ item"), "- item");
    assert.equal(normalizeLine("2) item"), "2. item");
    assert.equal(normalizeLine("* * *"), "---");
    assert.equal(normalizeLine("<https://a.com/x_y>"), "https://a.com/x_y");
    assert.equal(normalizeLine("[https://a.com/x](https://a.com/x)"), "https://a.com/x");
    assert.equal(normalizeLine("  texto   com   espaços  "), "texto com espaços");
  });

  it("snake_case e URLs com `_` não viram ênfase", () => {
    assert.equal(normalizeLine("arquivo_de_teste.ts"), "arquivo_de_teste.ts");
  });

  it("unescapeForWrite des-escapa o seguro e recusa o ambíguo", () => {
    assert.deepEqual(unescapeForWrite("US\\$ 3 bi e \\#Tag __forte__  "), { ok: true, text: "US$ 3 bi e #Tag **forte**" });
    assert.equal(unescapeForWrite("<https://a.com/novo>").text, "[https://a.com/novo](https://a.com/novo)");
    assert.equal(unescapeForWrite("C:\\\\pasta").ok, false);
    assert.equal(unescapeForWrite("texto <u>sublinhado</u>").ok, false);
    assert.equal(unescapeForWrite("<?claude block x?>").ok, false);
  });

  it("quebra de linha mole re-arranjada dentro do parágrafo é cosmética", () => {
    const base = "linha um\nlinha dois\n\noutro parágrafo\n";
    assert.ok(docEquivalent(base, "linha um linha dois\n\noutro parágrafo"));
    // Mas juntar parágrafos (some a linha em branco no meio do texto) é edição.
    assert.ok(!docEquivalent("a\n\nb\n", "a b"));
  });
});

describe("mergeDocOnto — edição pontual preserva o resto byte a byte", () => {
  it("troca só a linha editada, mantém CRLF e bytes originais", () => {
    const crlf = REVIEWED.replace(/\n/g, "\r\n");
    const md = renderDocMarkdown({ edition: "261012", files: files() });
    const edited = aggressiveExport(md).replace("liderada por Google", "liderada por Google e Amazon");
    const section = parseDocExport(edited)["02-reviewed.md"];
    const r = mergeDocOnto(crlf, section);
    assert.equal(r.changed, true);
    assert.deepEqual(r.unsafe, []);
    const expected = crlf.replace(
      "A Anthropic fechou uma rodada de **US$ 2 bilhões** liderada por Google.",
      "A Anthropic fechou uma rodada de **US$ 2 bilhões** liderada por Google e Amazon.",
    );
    assert.equal(r.content, expected);
  });

  it("linha inserida e linha removida", () => {
    const base = "a\n\nb\n\nc\n";
    const r = mergeDocOnto(base, "a\n\nnova\n\nc");
    assert.equal(r.content, "a\n\nnova\n\nc\n");
    assert.deepEqual(r.removed, ["b"]);
    assert.deepEqual(r.added, ["nova"]);
  });
});

describe("decideFile — cada ramo do merge de 3 vias", () => {
  const base = "a\n\nb\n";

  it("doc == base, arquivo == base → unchanged", () => {
    assert.equal(decideFile("02-reviewed.md", base, base, "a\n\nb").action, "unchanged");
  });
  it("doc == base, arquivo mudou → doc_stale (nada gravado)", () => {
    const o = decideFile("02-reviewed.md", base, "a\n\nB2\n", "a\n\nb");
    assert.equal(o.action, "doc_stale");
    assert.equal(o.write, undefined);
  });
  it("arquivo == base, doc editado → pulled (grava e avança a base)", () => {
    const o = decideFile("02-reviewed.md", base, base, "a\n\nb editado");
    assert.equal(o.action, "pulled");
    assert.equal(o.write, "a\n\nb editado\n");
    assert.equal(o.newBase, "a\n\nb editado\n");
  });
  it("arquivo != base e doc == arquivo → base_updated (sem gravar arquivo)", () => {
    const o = decideFile("02-reviewed.md", base, "a\n\nmesmo\n", "a\n\nmesmo");
    assert.equal(o.action, "base_updated");
    assert.equal(o.write, undefined);
    assert.equal(o.newBase, "a\n\nmesmo\n");
  });
  it("arquivo e doc mudaram diferente → conflict, sem write, com diff resumido", () => {
    const o = decideFile("02-reviewed.md", base, "a\n\npipeline\n", "a\n\neditor");
    assert.equal(o.action, "conflict");
    assert.equal(o.write, undefined);
    assert.equal(o.newBase, undefined);
    assert.deepEqual(o.editor_changes?.lines, ["- b", "+ editor"]);
    assert.deepEqual(o.pipeline_changes?.lines, ["- b", "+ pipeline"]);
  });
  it("edição não des-escapável → conflict (nunca grava)", () => {
    const o = decideFile("02-reviewed.md", base, base, "a\n\nb <u>x</u>");
    assert.equal(o.action, "conflict");
    assert.equal(o.write, undefined);
    assert.ok(o.unsafe && o.unsafe.length === 1);
  });
  it("conflito resolvido: arquivo → mantém arquivo; doc → aplica doc", () => {
    const keep = decideFile("02-reviewed.md", base, "a\n\npipeline\n", "a\n\neditor", "arquivo");
    assert.equal(keep.action, "resolved_keep_file");
    assert.equal(keep.write, undefined);
    assert.equal(keep.newBase, "a\n\npipeline\n");
    const doc = decideFile("02-reviewed.md", base, "a\n\npipeline\n", "a\n\neditor", "doc");
    assert.equal(doc.action, "resolved_apply_doc");
    assert.equal(doc.write, "a\n\neditor\n");
  });
});

describe("runRender/runApply com arquivos (diretório temporário)", () => {
  it("render grava md + base; apply sem edição não toca nos arquivos", () => {
    const dir = tmpEdition();
    try {
      const { out } = runRender({ editionDir: dir, edition: "261012", docUrl: "https://claude.ai/artifact/x" });
      const state = JSON.parse(readFileSync(statePath(dir), "utf8"));
      assert.equal(state.doc_url, "https://claude.ai/artifact/x");
      assert.equal(state.base["02-reviewed.md"].content, REVIEWED);
      assert.match(state.base["03-social.md"].sha256, /^[0-9a-f]{64}$/);
      // Re-render sem --doc-url preserva o link.
      runRender({ editionDir: dir, edition: "261012" });
      assert.equal(JSON.parse(readFileSync(statePath(dir), "utf8")).doc_url, "https://claude.ai/artifact/x");

      const exp = join(dir, "export.md");
      writeFileSync(exp, aggressiveExport(readFileSync(out, "utf8")));
      const report = runApply({ editionDir: dir, docExport: exp });
      assert.equal(report.ok, true);
      assert.deepEqual(report.pulled, []);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), REVIEWED);
      assert.equal(readFileSync(join(dir, "03-social.md"), "utf8"), SOCIAL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição só no 03-social.md: puxa social, 02-reviewed intacto", () => {
    const dir = tmpEdition();
    try {
      const { out } = runRender({ editionDir: dir, edition: "261012" });
      const exp = join(dir, "export.md");
      writeFileSync(exp, readFileSync(out, "utf8").replace("Texto do d2.", "Texto do d2 revisado pelo editor."));
      const report = runApply({ editionDir: dir, docExport: exp });
      assert.equal(report.ok, true);
      assert.deepEqual(report.pulled, ["03-social.md"]);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), REVIEWED);
      assert.equal(
        readFileSync(join(dir, "03-social.md"), "utf8"),
        SOCIAL.replace("Texto do d2.", "Texto do d2 revisado pelo editor."),
      );
      // A base avançou: um 2º apply com o mesmo export é no-op.
      const again = runApply({ editionDir: dir, docExport: exp });
      assert.deepEqual(again.pulled, []);
      assert.deepEqual(
        again.files.map((f) => f.action),
        ["unchanged", "unchanged"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("conflito num arquivo não grava nele, mas puxa o outro; exit 1 via CLI", () => {
    const dir = tmpEdition();
    try {
      const { out } = runRender({ editionDir: dir, edition: "261012" });
      // Pipeline mexe no 02-reviewed depois do render (cenário da 261009: gate mudou).
      const pipelineReviewed = REVIEWED.replace("Cada rodada redefine", "Cada rodada (pipeline) redefine");
      writeFileSync(join(dir, "02-reviewed.md"), pipelineReviewed);
      const exp = join(dir, "export.md");
      writeFileSync(
        exp,
        readFileSync(out, "utf8")
          .replace("Cada rodada redefine", "Cada rodada (editor) redefine")
          .replace("Texto do d2.", "Texto do d2 novo."),
      );
      const stateBefore = readFileSync(statePath(dir), "utf8");
      const report = runApply({ editionDir: dir, docExport: exp });
      assert.equal(report.ok, false);
      assert.equal(report.conflicts.length, 1);
      assert.equal(report.conflicts[0].file, "02-reviewed.md");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), pipelineReviewed);
      assert.deepEqual(report.pulled, ["03-social.md"]);
      const stateAfter = JSON.parse(readFileSync(statePath(dir), "utf8"));
      // Base do arquivo em conflito NÃO avança.
      assert.equal(stateAfter.base["02-reviewed.md"].content, JSON.parse(stateBefore).base["02-reviewed.md"].content);

      // Pela CLI: exit 1 e conflicts[] no stdout.
      const cli = spawnSync(
        process.execPath,
        ["--import", "tsx", resolve("scripts/stage4-docs-sync.ts"), "apply", "--edition-dir", dir, "--doc-export", exp],
        { encoding: "utf8" },
      );
      assert.equal(cli.status, 1, cli.stderr);
      assert.equal(JSON.parse(cli.stdout).conflicts[0].file, "02-reviewed.md");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), pipelineReviewed);

      // Editor decide aplicar o doc.
      const resolved = runApply({ editionDir: dir, docExport: exp, resolutions: parseResolutions("02-reviewed.md=doc") });
      assert.equal(resolved.ok, true);
      assert.ok(readFileSync(join(dir, "02-reviewed.md"), "utf8").includes("Cada rodada (editor) redefine"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sentinela corrompida: exit 2 e nada gravado (nem o arquivo íntegro)", () => {
    const dir = tmpEdition();
    try {
      const { out } = runRender({ editionDir: dir, edition: "261012" });
      const exp = join(dir, "export.md");
      writeFileSync(
        exp,
        readFileSync(out, "utf8")
          .replace("Texto do d2.", "Texto do d2 novo.")
          .replace(endSentinel("02-reviewed.md"), "(apagado)"),
      );
      assert.throws(() => runApply({ editionDir: dir, docExport: exp }), DocsSyncFormatError);
      assert.equal(readFileSync(join(dir, "03-social.md"), "utf8"), SOCIAL);
      const cli = spawnSync(
        process.execPath,
        ["--import", "tsx", resolve("scripts/stage4-docs-sync.ts"), "apply", "--edition-dir", dir, "--doc-export", exp],
        { encoding: "utf8" },
      );
      assert.equal(cli.status, 2, cli.stderr);
      assert.equal(readFileSync(join(dir, "03-social.md"), "utf8"), SOCIAL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("apply sem render prévio → erro de pré-condição", () => {
    const dir = tmpEdition();
    try {
      const exp = join(dir, "export.md");
      writeFileSync(exp, "nada");
      assert.throws(() => runApply({ editionDir: dir, docExport: exp }), /render/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseResolutions", () => {
  it("aceita com e sem .md e recusa valor inválido", () => {
    assert.deepEqual(parseResolutions("02-reviewed=arquivo,03-social.md=doc"), {
      "02-reviewed.md": "arquivo",
      "03-social.md": "doc",
    });
    assert.throws(() => parseResolutions("02-reviewed.md=talvez"), DocsSyncFormatError);
  });
});
