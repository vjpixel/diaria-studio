/**
 * test/stage4-docs-sync.test.ts (#9964)
 *
 * Doc editável do gate do Stage 4: round-trip render → parse, cada ramo do
 * merge de 3 vias, conflito que não grava, sentinela corrompida → erro sem
 * escrita parcial, normalização de escapes de export, edição só num arquivo,
 * e as regressões do fleet review do PR #10075 (resolve=arquivo seguido de
 * apply, render com doc existente, heading setext, 3 vias real, exit 3, token
 * de resolução, URLs com `_`, remoção em massa, TOCTOU, check final).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  DocsSyncFormatError,
  beginSentinel,
  decideFile,
  diffSummary,
  docEquivalent,
  endSentinel,
  matchSentinel,
  merge3,
  mergeDocOnto,
  normalizeLine,
  parseDocExport,
  parseResolutions,
  readState,
  renderDocMarkdown,
  resolveToken,
  runApply,
  runCheck,
  runCheckRoundtrip,
  runConfirm,
  runDisable,
  runEnable,
  runRender,
  runSetUrl,
  runStatus,
  statePath,
  unescapeForWrite,
} from "../scripts/lib/stage4-docs-sync.ts";

const CLI = fileURLToPath(new URL("../scripts/stage4-docs-sync.ts", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8", timeout: 60_000 });
}

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

function withEdition(fn: (dir: string) => void, reviewed = REVIEWED, social = SOCIAL) {
  const dir = tmpEdition(reviewed, social);
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Cria o "doc": render + set-url, e devolve o markdown do doc. */
function createDoc(dir: string): string {
  const { out } = runRender({ editionDir: dir, edition: "261012" });
  runSetUrl({ editionDir: dir, docUrl: "https://claude.ai/artifact/x" });
  return readFileSync(out, "utf8");
}

const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const writeExport = (dir: string, md: string, name = "export.md") => {
  const p = join(dir, "_internal", name);
  writeFileSync(p, md);
  return p;
};
const conflictToken = (report: ReturnType<typeof runApply>, file: string) =>
  report.conflicts.find((c) => c.file === file)!.resolve_token;

describe("render → parse (round-trip)", () => {
  it("devolve exatamente o conteúdo de cada arquivo (sem brancos de borda)", () => {
    const md = renderDocMarkdown({ edition: "261012", files: files(), summary: "Resumo: 3 destaques." });
    const parsed = parseDocExport(md);
    assert.equal(parsed["02-reviewed.md"], REVIEWED.trimEnd());
    assert.equal(parsed["03-social.md"], SOCIAL.trimEnd());
    assert.ok(md.includes("Resumo: 3 destaques."));
    assert.ok(md.startsWith("# Revisão editorial — Edição 261012\n"));
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
    assert.equal(mergeDocOnto(REVIEWED, parsed["02-reviewed.md"]).content, REVIEWED);
  });
});

describe("heading setext acidental (parágrafo colado em `---`, arquivos reais 261001/261008)", () => {
  const SETEXT = "Primeiro parágrafo.\n\nAgentes ficam mais baratos de manter rodando.\n---\n\nDESTAQUE 2\n";

  it("render separa o `---` do parágrafo; export desse doc é equivalente e apply não grava", () => {
    const md = renderDocMarkdown({ edition: "261012", files: files(SETEXT) });
    assert.ok(md.includes("manter rodando.\n\n---"), "linha em branco inserida antes do ---");
    const section = parseDocExport(md)["02-reviewed.md"];
    assert.ok(docEquivalent(SETEXT, section));
    withEdition((dir) => {
      const doc = createDoc(dir);
      const report = runApply({ editionDir: dir, docExport: writeExport(dir, doc) });
      assert.deepEqual(
        report.files.map((f) => f.action),
        ["unchanged", "unchanged"],
      );
      assert.equal(read(dir, "02-reviewed.md"), SETEXT);
    }, SETEXT);
  });

  it("check-roundtrip: doc que devolve `## parágrafo` sem `---` desativa o sync; apply então recusa", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const mangled = doc.replace("Agentes ficam mais baratos de manter rodando.\n\n---", "## Agentes ficam mais baratos de manter rodando.");
      const exp = writeExport(dir, mangled);
      const r = runCheckRoundtrip({ editionDir: dir, docExport: exp });
      assert.equal(r.ok, false);
      assert.ok(readState(dir)?.sync_disabled?.reason);
      assert.throws(() => runApply({ editionDir: dir, docExport: exp }), /sync desativado/);
      assert.equal(read(dir, "02-reviewed.md"), SETEXT);
      assert.equal(runCheck({ editionDir: dir }).ok, true);
    }, SETEXT);
  });

  it("check-roundtrip ok com export agressivo intocado", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      assert.equal(runCheckRoundtrip({ editionDir: dir, docExport: writeExport(dir, aggressiveExport(doc)) }).ok, true);
      assert.equal(readState(dir)?.sync_disabled, undefined);
    });
  });

  it("remoção de linha com comentário HTML (rich-text descarta) é unsafe → conflito", () => {
    const base = "a\n\n<!-- marcador -->\n\nb\n";
    const o = decideFile("02-reviewed.md", base, base, "a\n\nb");
    assert.equal(o.action, "conflict");
    if (o.action === "conflict") assert.match(o.unsafe[0].reason, /HTML/);
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

  it("quebra dura com barra invertida final é cosmética", () => {
    assert.equal(normalizeLine("linha com quebra\\"), normalizeLine("linha com quebra  "));
    assert.ok(docEquivalent("a  \nb\n", "a\\\nb"));
  });

  it("snake_case e URLs com `_` não viram ênfase", () => {
    assert.equal(normalizeLine("arquivo_de_teste.ts"), "arquivo_de_teste.ts");
    assert.equal(normalizeLine("https://github.com/x/y/blob/main/__init__.py"), "https://github.com/x/y/blob/main/__init__.py");
    assert.equal(normalizeLine("[código](https://a.com/_x_/b)"), "[código](https://a.com/_x_/b)");
    assert.equal(normalizeLine("`__init__`"), "`__init__`");
  });

  it("unescapeForWrite des-escapa o seguro, recusa o ambíguo e não corrompe URL", () => {
    assert.deepEqual(unescapeForWrite("US\\$ 3 bi e \\#Tag __forte__  "), { ok: true, text: "US$ 3 bi e #Tag **forte**" });
    assert.equal(unescapeForWrite("<https://a.com/novo>").text, "[https://a.com/novo](https://a.com/novo)");
    assert.equal(unescapeForWrite("C:\\\\pasta").ok, false);
    assert.equal(unescapeForWrite("texto <u>sublinhado</u>").ok, false);
    assert.equal(unescapeForWrite("<?claude block x?>").ok, false);
    assert.equal(
      unescapeForWrite("veja https://github.com/x/__init__.py e [y](https://a.com/_x_/) agora").text,
      "veja https://github.com/x/__init__.py e [y](https://a.com/_x_/) agora",
    );
  });

  it("unescapeForWrite preserva marcador de lista, ênfase `_` e espaços finais da linha original", () => {
    assert.equal(unescapeForWrite("- item novo", "* item velho").text, "* item novo");
    assert.equal(unescapeForWrite("- item novo", "+ item velho").text, "+ item novo");
    assert.equal(unescapeForWrite("3. passo novo", "3) passo velho").text, "3) passo novo");
    assert.equal(unescapeForWrite("um _termo_ novo", "um _termo_ velho").text, "um _termo_ novo");
    assert.equal(unescapeForWrite("linha nova", "linha velha  ").text, "linha nova  ");
    // Quebra dura do doc = representação da quebra "mole" do arquivo: volta sem nada,
    // ou com o que a linha original tinha.
    assert.equal(unescapeForWrite("quebra dura\\").text, "quebra dura");
    assert.equal(unescapeForWrite("quebra dura\\", "quebra velha").text, "quebra dura");
    assert.equal(unescapeForWrite("quebra dura\\", "quebra velha\\").text, "quebra dura\\");
    assert.equal(unescapeForWrite("quebra dura\\", "quebra velha  ").text, "quebra dura  ");
  });

  it("quebra de linha mole re-arranjada dentro do parágrafo é cosmética", () => {
    const base = "linha um\nlinha dois\n\noutro parágrafo\n";
    assert.ok(docEquivalent(base, "linha um linha dois\n\noutro parágrafo"));
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

  it("diffSummary intercala por trecho", () => {
    const s = diffSummary("a\n\nb\n\nc\n\nd\n", "a\n\nB\n\nc\n\nD");
    assert.deepEqual(s.lines, ["- b", "+ B", "- d", "+ D"]);
  });
});

describe("merge3 — 3 vias de verdade", () => {
  const base = "p1\n\np2\n\np3\n\np4\n";

  it("doc e pipeline em trechos disjuntos: puxa a edição do doc e mantém a do pipeline", () => {
    const current = "p1\n\np2 pipeline\n\np3\n\np4\n";
    const doc = "p1\n\np2\n\np3\n\np4 editor";
    const o = decideFile("02-reviewed.md", base, current, doc);
    assert.equal(o.action, "pulled");
    if (o.action !== "pulled") return;
    assert.equal(o.write, "p1\n\np2 pipeline\n\np3\n\np4 editor\n");
    assert.equal(o.three_way, true);
    // Base = doc: o próximo apply não lê o pipeline como "edição do doc".
    assert.equal(o.newBase, doc);
    assert.equal(decideFile("02-reviewed.md", o.newBase, o.write, doc).action, "doc_stale");
  });

  it("mesmo trecho mudado diferente → conflito; mesma mudança dos dois lados → base_updated", () => {
    assert.equal(decideFile("02-reviewed.md", base, "p1\n\np2 A\n\np3\n\np4\n", "p1\n\np2 B\n\np3\n\np4").action, "conflict");
    assert.equal(
      decideFile("02-reviewed.md", base, "p1\n\np2 X\n\np3\n\np4\n", "p1\n\np2 X\n\np3\n\np4").action,
      "base_updated",
    );
  });

  it("resolve=doc só faz o doc vencer no trecho em conflito — mudança do pipeline em outro trecho sobrevive", () => {
    const current = "p1 pipeline\n\np2 A\n\np3\n\np4\n";
    const doc = "p1\n\np2 B\n\np3\n\np4";
    const c = decideFile("02-reviewed.md", base, current, doc);
    assert.equal(c.action, "conflict");
    const o = decideFile("02-reviewed.md", base, current, doc, { choice: "doc", token: resolveToken(current, doc) });
    assert.equal(o.action, "resolved_apply_doc");
    if (o.action === "resolved_apply_doc") assert.equal(o.write, "p1 pipeline\n\np2 B\n\np3\n\np4\n");
  });

  it("merge3 sem edição do doc devolve o arquivo atual intacto", () => {
    const current = "p1\n\np2 pipeline\n\np3\n\np4\n";
    const r = merge3(base, current, "p1\n\np2\n\np3\n\np4");
    assert.equal(r.docChanged, false);
    assert.equal(r.content, current);
  });
});

describe("decideFile — ramos e guards", () => {
  const base = "a\n\nb\n";

  it("doc == base, arquivo == base → unchanged", () => {
    assert.equal(decideFile("02-reviewed.md", base, base, "a\n\nb").action, "unchanged");
  });
  it("doc == base, arquivo mudou → doc_stale (nada gravado)", () => {
    const o = decideFile("02-reviewed.md", base, "a\n\nB2\n", "a\n\nb");
    assert.equal(o.action, "doc_stale");
  });
  it("arquivo == base, doc editado → pulled (grava e avança a base)", () => {
    const o = decideFile("02-reviewed.md", base, base, "a\n\nb editado");
    assert.equal(o.action, "pulled");
    if (o.action !== "pulled") return;
    assert.equal(o.write, "a\n\nb editado\n");
    assert.equal(o.newBase, "a\n\nb editado\n");
    assert.deepEqual(o.changes.lines, ["- b", "+ b editado"]);
  });
  it("arquivo e doc mudaram diferente → conflict com diff, shas e token", () => {
    const o = decideFile("02-reviewed.md", base, "a\n\npipeline\n", "a\n\neditor");
    assert.equal(o.action, "conflict");
    if (o.action !== "conflict") return;
    assert.deepEqual(o.editor_changes.lines, ["- b", "+ editor"]);
    assert.deepEqual(o.pipeline_changes.lines, ["- b", "+ pipeline"]);
    assert.match(o.current_sha256, /^[0-9a-f]{64}$/);
    assert.match(o.doc_sha256, /^[0-9a-f]{64}$/);
    assert.equal(o.resolve_token, resolveToken("a\n\npipeline\n", "a\n\neditor"));
  });
  it("edição não des-escapável → conflict; resolve=arquivo com arquivo intacto é honrado", () => {
    const doc = "a\n\nb <u>x</u>";
    const o = decideFile("02-reviewed.md", base, base, doc);
    assert.equal(o.action, "conflict");
    if (o.action !== "conflict") return;
    assert.equal(o.unsafe.length, 1);
    const keep = decideFile("02-reviewed.md", base, base, doc, { choice: "arquivo", token: o.resolve_token });
    assert.equal(keep.action, "resolved_keep_file");
    if (keep.action === "resolved_keep_file") assert.equal(keep.newBase, doc);
  });
  it("token de outra versão do conflito → re-levanta o conflito", () => {
    const o = decideFile("02-reviewed.md", base, "a\n\npipeline\n", "a\n\neditor", { choice: "doc", token: "000000000000" });
    assert.equal(o.action, "conflict");
    if (o.action === "conflict") assert.match(o.reason, /não corresponde/);
  });
  it("remoção em massa: seção vazia ou >50% das linhas removidas → conflito", () => {
    const big = "l1\n\nl2\n\nl3\n\nl4\n\nl5\n\nl6\n";
    const empty = decideFile("02-reviewed.md", big, big, "");
    assert.equal(empty.action, "conflict");
    if (empty.action === "conflict") assert.match(empty.reason, /remoção em massa/);
    const most = decideFile("02-reviewed.md", big, big, "l1\n\nl2");
    assert.equal(most.action, "conflict");
    if (most.action === "conflict") assert.match(most.reason, /remoção em massa/);
    assert.equal(decideFile("02-reviewed.md", big, big, "l1\n\nl2\n\nl3\n\nl4\n\nl6").action, "pulled");
  });
});

describe("runRender/runApply com arquivos (diretório temporário)", () => {
  it("render grava md + base; set-url não mexe na base; apply sem edição não toca nos arquivos", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const state = JSON.parse(readFileSync(statePath(dir), "utf8"));
      assert.equal(state.doc_url, "https://claude.ai/artifact/x");
      assert.equal(state.base["02-reviewed.md"].content, REVIEWED);
      const report = runApply({ editionDir: dir, docExport: writeExport(dir, aggressiveExport(doc)) });
      assert.equal(report.ok, true);
      assert.deepEqual(report.pulled, []);
      assert.equal(read(dir, "02-reviewed.md"), REVIEWED);
      assert.equal(read(dir, "03-social.md"), SOCIAL);
    });
  });

  it("edição só no 03-social.md: puxa social com resumo de diff, 02-reviewed intacto", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const exp = writeExport(dir, doc.replace("Texto do d2.", "Texto do d2 revisado pelo editor."));
      const report = runApply({ editionDir: dir, docExport: exp });
      assert.equal(report.ok, true);
      assert.deepEqual(report.pulled, ["03-social.md"]);
      assert.deepEqual(report.pulled_changes["03-social.md"]?.lines, ["- Texto do d2.", "+ Texto do d2 revisado pelo editor."]);
      assert.equal(read(dir, "02-reviewed.md"), REVIEWED);
      assert.equal(read(dir, "03-social.md"), SOCIAL.replace("Texto do d2.", "Texto do d2 revisado pelo editor."));
      const again = runApply({ editionDir: dir, docExport: exp });
      assert.deepEqual(again.pulled, []);
      assert.deepEqual(
        again.files.map((f) => f.action),
        ["unchanged", "unchanged"],
      );
    });
  });

  it("SEQUÊNCIA: conflito → resolve=arquivo → apply de novo com o MESMO export → arquivo intacto (doc_stale)", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const pipelineReviewed = REVIEWED.replace("Cada rodada redefine", "Cada rodada (pipeline) redefine");
      writeFileSync(join(dir, "02-reviewed.md"), pipelineReviewed);
      const exp = writeExport(dir, doc.replace("Cada rodada redefine", "Cada rodada (editor) redefine"));
      const first = runApply({ editionDir: dir, docExport: exp });
      assert.equal(first.ok, false);
      const token = conflictToken(first, "02-reviewed.md");
      const keep = runApply({ editionDir: dir, docExport: exp, resolutions: parseResolutions(`02-reviewed.md=arquivo@${token}`) });
      assert.equal(keep.ok, true);
      assert.deepEqual(keep.kept_file, ["02-reviewed.md"]);
      assert.deepEqual(keep.doc_stale, []);
      assert.equal(read(dir, "02-reviewed.md"), pipelineReviewed);
      // O apply que o playbook manda rodar em seguida NÃO pode puxar a edição rejeitada.
      const next = runApply({ editionDir: dir, docExport: exp });
      assert.equal(next.ok, true);
      assert.deepEqual(next.pulled, []);
      assert.deepEqual(next.doc_stale, ["02-reviewed.md"]);
      assert.equal(read(dir, "02-reviewed.md"), pipelineReviewed);
      // E o render que atualiza o doc aceita esse export (nada pendente).
      assert.equal(runRender({ editionDir: dir, edition: "261012", docExport: exp }).pending, true);
    });
  });

  it("conflito num arquivo não grava nele, mas puxa o outro; exit 1 via CLI; resolve=doc com token", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const pipelineReviewed = REVIEWED.replace("Cada rodada redefine", "Cada rodada (pipeline) redefine");
      writeFileSync(join(dir, "02-reviewed.md"), pipelineReviewed);
      const exp = writeExport(
        dir,
        doc.replace("Cada rodada redefine", "Cada rodada (editor) redefine").replace("Texto do d2.", "Texto do d2 novo."),
      );
      const stateBefore = readFileSync(statePath(dir), "utf8");
      const report = runApply({ editionDir: dir, docExport: exp });
      assert.equal(report.ok, false);
      assert.equal(report.conflicts.length, 1);
      assert.equal(report.conflicts[0].file, "02-reviewed.md");
      assert.equal(read(dir, "02-reviewed.md"), pipelineReviewed);
      assert.deepEqual(report.pulled, ["03-social.md"]);
      const stateAfter = JSON.parse(readFileSync(statePath(dir), "utf8"));
      assert.equal(stateAfter.base["02-reviewed.md"].content, JSON.parse(stateBefore).base["02-reviewed.md"].content);
      assert.deepEqual(stateAfter.pending_conflict, ["02-reviewed.md"]);
      assert.equal(runCheck({ editionDir: dir }).ok, false);

      const cli = runCli(["apply", "--edition-dir", dir, "--doc-export", exp]);
      assert.equal(cli.status, 1, cli.stderr);
      assert.equal(JSON.parse(cli.stdout).conflicts[0].file, "02-reviewed.md");
      assert.equal(read(dir, "02-reviewed.md"), pipelineReviewed);

      const token = conflictToken(report, "02-reviewed.md");
      const resolved = runApply({ editionDir: dir, docExport: exp, resolutions: parseResolutions(`02-reviewed.md=doc@${token}`) });
      assert.equal(resolved.ok, true);
      assert.ok(read(dir, "02-reviewed.md").includes("Cada rodada (editor) redefine"));
      // Pipeline tinha mexido no mesmo trecho, que o doc sobrescreveu: o doc NÃO está para trás.
      assert.deepEqual(resolved.doc_stale, []);
      assert.equal(runCheck({ editionDir: dir }).ok, false, "apply não-final não satisfaz o check");
      assert.equal(runApply({ editionDir: dir, docExport: exp, final: true }).ok, true);
      assert.equal(runCheck({ editionDir: dir }).ok, true);
    });
  });

  it("sentinela corrompida: exit 2 e nada gravado (nem o arquivo íntegro)", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const exp = writeExport(dir, doc.replace("Texto do d2.", "Texto do d2 novo.").replace(endSentinel("02-reviewed.md"), "(apagado)"));
      assert.throws(() => runApply({ editionDir: dir, docExport: exp }), DocsSyncFormatError);
      assert.equal(read(dir, "03-social.md"), SOCIAL);
      const cli = runCli(["apply", "--edition-dir", dir, "--doc-export", exp]);
      assert.equal(cli.status, 2, cli.stderr);
      assert.equal(read(dir, "03-social.md"), SOCIAL);
    });
  });

  it("#10116: export com U+FFFD (cópia corrompida) → apply --final recusa com exit 2, nada gravado", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      // Erro de cópia fora das sentinelas: byte UTF-8 inválido vira U+FFFD na decodificação.
      const corrupted = Buffer.concat([
        Buffer.from(doc.replace("Cada rodada redefine", "Cada rodada XX redefine").split("XX")[0], "utf8"),
        Buffer.from([0xc3]),
        Buffer.from(doc.replace("Cada rodada redefine", "Cada rodada XX redefine").split("XX")[1], "utf8"),
      ]);
      const exp = join(dir, "_internal", "export-fffd.md");
      writeFileSync(exp, corrupted);
      assert.ok(readFileSync(exp, "utf8").includes("�"));
      const stateBefore = readFileSync(statePath(dir), "utf8");
      assert.throws(() => runApply({ editionDir: dir, docExport: exp, final: true }), /U\+FFFD.*02-reviewed\.md/);
      assert.equal(read(dir, "02-reviewed.md"), REVIEWED);
      assert.equal(readFileSync(statePath(dir), "utf8"), stateBefore, "estado intocado");
      const cli = runCli(["apply", "--edition-dir", dir, "--doc-export", exp, "--final"]);
      assert.equal(cli.status, 2, cli.stderr);
      assert.match(JSON.parse(cli.stdout).error, /refaça a cópia/);
      assert.equal(read(dir, "02-reviewed.md"), REVIEWED);
      assert.equal(runCheck({ editionDir: dir }).ok, false, "sem final_apply");
      // Export limpo segue passando.
      const clean = writeExport(dir, doc.replace("Cada rodada redefine", "Cada rodada sempre redefine"));
      const ok = runApply({ editionDir: dir, docExport: clean, final: true });
      assert.equal(ok.ok, true);
      assert.deepEqual(ok.pulled, ["02-reviewed.md"]);
      assert.equal(runCheck({ editionDir: dir }).ok, true);
    });
  });

  it("#10116: U+FFFD que já estava no arquivo não bloqueia o apply", () => {
    const withFffd = REVIEWED.replace("Cada rodada", "Cada � rodada");
    withEdition((dir) => {
      const doc = createDoc(dir);
      const report = runApply({ editionDir: dir, docExport: writeExport(dir, doc.replace("Texto do d2.", "Texto novo.")), final: true });
      assert.equal(report.ok, true);
      assert.deepEqual(report.pulled, ["03-social.md"]);
    }, withFffd);
  });

  it("#10116: --expected-bytes divergente → exit 2, nada gravado; igual → segue", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const edited = doc.replace("Texto do d2.", "Texto do d2 novo.");
      const exp = writeExport(dir, edited);
      const size = Buffer.byteLength(edited, "utf8");
      assert.throws(() => runApply({ editionDir: dir, docExport: exp, final: true, expectedBytes: size + 3 }), /bytes/);
      assert.equal(read(dir, "03-social.md"), SOCIAL);
      const cli = runCli(["apply", "--edition-dir", dir, "--doc-export", exp, "--final", "--expected-bytes", String(size - 1)]);
      assert.equal(cli.status, 2, cli.stderr);
      assert.equal(read(dir, "03-social.md"), SOCIAL);
      assert.equal(runCli(["apply", "--edition-dir", dir, "--doc-export", exp, "--expected-bytes", "abc"]).status, 2);
      const ok = runCli(["apply", "--edition-dir", dir, "--doc-export", exp, "--final", "--expected-bytes", String(size)]);
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(read(dir, "03-social.md"), SOCIAL.replace("Texto do d2.", "Texto do d2 novo."));
    });
  });

  it("TOCTOU: arquivo muda entre a decisão e a escrita → conflito, nada gravado", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const exp = writeExport(dir, doc.replace("Texto do d2.", "Texto do d2 novo."));
      const concurrent = SOCIAL.replace("Texto do d2.", "Texto do d2 (pipeline concorrente).");
      const report = runApply({
        editionDir: dir,
        docExport: exp,
        beforeWrite: (f) => writeFileSync(join(dir, f), concurrent),
      });
      assert.equal(report.ok, false);
      assert.match(report.conflicts[0].reason, /durante o apply/);
      assert.equal(read(dir, "03-social.md"), concurrent);
    });
  });

  it("apply sem render prévio → erro de pré-condição", () => {
    withEdition((dir) => {
      assert.throws(() => runApply({ editionDir: dir, docExport: writeExport(dir, "nada") }), /render/);
    });
  });
});

describe("render com doc existente: base pendente + confirm", () => {
  it("exige --doc-export, recusa edição não puxada e não mexe na base", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const before = readFileSync(statePath(dir), "utf8");
      assert.throws(() => runRender({ editionDir: dir, edition: "261012" }), /--doc-export/);
      const edited = writeExport(dir, doc.replace("Texto do d2.", "Texto do d2 só no doc."));
      assert.throws(() => runRender({ editionDir: dir, edition: "261012", docExport: edited }), /não puxada/);
      assert.equal(readFileSync(statePath(dir), "utf8"), before);
      const cli = runCli(["render", "--edition-dir", dir, "--edition", "261012", "--doc-export", edited]);
      assert.equal(cli.status, 2, cli.stderr);
    });
  });

  it("render grava base PENDENTE; sem confirm a base antiga vale; confirm efetiva", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const exp = writeExport(dir, doc);
      const changed = REVIEWED.replace("Cada rodada redefine", "Cada rodada (pipeline) redefine");
      writeFileSync(join(dir, "02-reviewed.md"), changed);
      const r = runRender({ editionDir: dir, edition: "261012", docExport: exp });
      assert.equal(r.pending, true);
      // Substituição do doc falhou: o doc segue com o conteúdo antigo — apply dá doc_stale, nunca reverte.
      const stale = runApply({ editionDir: dir, docExport: exp });
      assert.deepEqual(stale.doc_stale, ["02-reviewed.md"]);
      assert.equal(read(dir, "02-reviewed.md"), changed);
      // Substituição ok: confirm com o export novo efetiva.
      const newDoc = writeExport(dir, readFileSync(r.out, "utf8"), "export-novo.md");
      assert.throws(() => runConfirm({ editionDir: dir, docExport: exp }), /NÃO efetivada/);
      runConfirm({ editionDir: dir, docExport: newDoc });
      const st = readState(dir)!;
      assert.equal(st.pending, undefined);
      assert.equal(st.base["02-reviewed.md"].content, changed);
      assert.deepEqual(runApply({ editionDir: dir, docExport: newDoc }).files.map((f) => f.action), ["unchanged", "unchanged"]);
    });
  });

  it("state corrompido → render falha (exit 2), nunca descarta doc_url em silêncio", () => {
    withEdition((dir) => {
      createDoc(dir);
      const st = JSON.parse(readFileSync(statePath(dir), "utf8"));
      st.base["02-reviewed.md"].content += "adulterado";
      writeFileSync(statePath(dir), JSON.stringify(st));
      assert.throws(() => runRender({ editionDir: dir, edition: "261012" }), /sha256/);
      writeFileSync(statePath(dir), "{não é json");
      const cli = runCli(["render", "--edition-dir", dir, "--edition", "261012"]);
      assert.equal(cli.status, 2, cli.stderr);
    });
  });
});

describe("check (antes do sentinel)", () => {
  it("sem doc → ok; sem apply final → falha; apply final → ok; apply comum depois → falha; arquivo mudou → falha", () => {
    withEdition((dir) => {
      assert.equal(runCheck({ editionDir: dir }).ok, true);
      const doc = createDoc(dir);
      assert.equal(runCheck({ editionDir: dir }).ok, false);
      const exp = writeExport(dir, doc);
      runApply({ editionDir: dir, docExport: exp });
      assert.equal(runCheck({ editionDir: dir }).ok, false, "apply de apresentação não é o final");
      runApply({ editionDir: dir, docExport: exp, final: true });
      assert.equal(runCheck({ editionDir: dir }).ok, true);
      assert.equal(readState(dir)?.final_apply?.export_sha256.length, 64);
      // Nova apresentação (apply comum) depois do final: final não vale mais.
      runApply({ editionDir: dir, docExport: exp });
      assert.equal(runCheck({ editionDir: dir }).ok, false);
      const cliFinal = runCli(["apply", "--edition-dir", dir, "--doc-export", exp, "--final"]);
      assert.equal(cliFinal.status, 0, cliFinal.stderr);
      assert.equal(runCheck({ editionDir: dir }).ok, true);
      writeFileSync(join(dir, "03-social.md"), SOCIAL + "\nmais\n");
      assert.equal(runCheck({ editionDir: dir }).ok, false);
      assert.equal(runCli(["check", "--edition-dir", dir]).status, 1);
      // Editor aprova "sem as edições do doc": disable → check ok, apply recusa.
      runDisable({ editionDir: dir, reason: "editor aprovou sem as edições do doc" });
      assert.equal(runCheck({ editionDir: dir }).ok, true);
      assert.throws(() => runApply({ editionDir: dir, docExport: writeExport(dir, doc) }), /sync desativado/);
    });
  });
});

describe("CLI — exit codes", () => {
  it("falha inesperada (ENOENT do --summary-file) → exit 3 com JSON, nunca o exit 1 do conflito", () => {
    withEdition((dir) => {
      const cli = runCli(["render", "--edition-dir", dir, "--edition", "261012", "--summary-file", join(dir, "nao-existe.md")]);
      assert.equal(cli.status, 3, cli.stderr);
      const out = JSON.parse(cli.stdout);
      assert.equal(out.ok, false);
      assert.deepEqual(out.written, []);
    });
  });

  it("uso inválido → exit 2", () => {
    assert.equal(runCli(["apply"]).status, 2);
  });
});

describe("parseResolutions", () => {
  it("exige token, aceita com e sem .md, recusa valor inválido e chave repetida", () => {
    assert.deepEqual(parseResolutions("02-reviewed=arquivo@0123456789ab,03-social.md=doc@ba9876543210"), {
      "02-reviewed.md": { choice: "arquivo", token: "0123456789ab" },
      "03-social.md": { choice: "doc", token: "ba9876543210" },
    });
    assert.throws(() => parseResolutions("02-reviewed.md=doc"), DocsSyncFormatError);
    assert.throws(() => parseResolutions("02-reviewed.md=talvez@0123456789ab"), DocsSyncFormatError);
    assert.throws(
      () => parseResolutions("02-reviewed.md=doc@0123456789ab,02-reviewed=arquivo@0123456789ab"),
      /repete/,
    );
  });
});

describe("re-review #10075 — quebra mole, keep_file parcial, version, URLs, setext", () => {
  // Casos reais: 02-reviewed da 261007 (`Por que isso importa:` colado no texto)
  // e 03-social da 261008 (`Mais em <url>` colado nas #hashtags).
  const REVIEWED_SOFT = [
    "DESTAQUE 1 | SEGURANÇA",
    "",
    "Por que isso importa:",
    "Equipes de segurança deixam de depender da política de recusa de um fornecedor.",
    "",
    "Fim.",
    "",
  ].join("\n");
  const SOCIAL_SOFT = [
    "## d1",
    "",
    "O Haiku 5.5 supera o Sonnet 5.",
    "",
    "Mais em https://diar.ia.br/p/haiku-5-5-supera-o-sonnet-5-e-custa-ate-95-menos",
    "#ClaudeHaiku #Anthropic",
    "",
  ].join("\n");

  it("render transforma a quebra mole em quebra dura (barra final; 2 espaços depois de URL)", () => {
    const md = renderDocMarkdown({ edition: "261012", files: files(REVIEWED_SOFT, SOCIAL_SOFT) });
    assert.ok(md.includes("Por que isso importa:\\\nEquipes"));
    assert.ok(md.includes("95-menos  \n#ClaudeHaiku"));
    const p = parseDocExport(md);
    assert.ok(docEquivalent(REVIEWED_SOFT, p["02-reviewed.md"]));
    assert.ok(docEquivalent(SOCIAL_SOFT, p["03-social.md"]));
  });

  it("editar a linha de baixo preserva a quebra: `Por que isso importa:` continua em linha separada", () => {
    withEdition(
      (dir) => {
        const doc = createDoc(dir);
        const exp = writeExport(
          dir,
          doc
            .replace("de um fornecedor.", "de um fornecedor no meio de um incidente.")
            .replace("#ClaudeHaiku #Anthropic", "#ClaudeHaiku #Anthropic #IA"),
        );
        const r = runApply({ editionDir: dir, docExport: exp });
        assert.equal(r.ok, true);
        assert.equal(
          read(dir, "02-reviewed.md"),
          REVIEWED_SOFT.replace("de um fornecedor.", "de um fornecedor no meio de um incidente."),
        );
        assert.equal(read(dir, "03-social.md"), SOCIAL_SOFT.replace("#Anthropic", "#Anthropic #IA"));
      },
      REVIEWED_SOFT,
      SOCIAL_SOFT,
    );
  });

  it("doc que JUNTA as linhas (com edição) → conflito unsafe, nada gravado", () => {
    withEdition(
      (dir) => {
        const doc = createDoc(dir);
        const joined = doc.replace(
          "Por que isso importa:\\\nEquipes de segurança deixam de depender da política de recusa de um fornecedor.",
          "Por que isso importa: Equipes de segurança deixam de depender da política de recusa de um fornecedor hoje.",
        );
        assert.notEqual(joined, doc);
        const r = runApply({ editionDir: dir, docExport: writeExport(dir, joined) });
        assert.equal(r.ok, false);
        assert.ok(r.conflicts[0].unsafe.some((u) => /juntou linhas/.test(u.reason)));
        assert.equal(read(dir, "02-reviewed.md"), REVIEWED_SOFT);
      },
      REVIEWED_SOFT,
      SOCIAL_SOFT,
    );
  });

  it("check-roundtrip: conector que junta a quebra (sem edição) desativa o sync", () => {
    withEdition(
      (dir) => {
        const doc = createDoc(dir);
        const joined = doc.replace("Por que isso importa:\\\nEquipes", "Por que isso importa: Equipes");
        assert.notEqual(joined, doc);
        const r = runCheckRoundtrip({ editionDir: dir, docExport: writeExport(dir, joined) });
        assert.equal(r.ok, false);
        assert.ok(readState(dir)?.sync_disabled);
      },
      REVIEWED_SOFT,
      SOCIAL_SOFT,
    );
  });

  it("resolve=arquivo mantém o arquivo só no trecho em conflito e aplica o trecho disjunto do doc", () => {
    const base = "p1\n\np2\n\np3\n\np4\n";
    const current = "p1\n\np2 pipeline\n\np3\n\np4\n";
    const doc = "p1\n\np2 editor\n\np3\n\np4 editor";
    const c = decideFile("02-reviewed.md", base, current, doc);
    assert.equal(c.action, "conflict");
    if (c.action !== "conflict") return;
    const keep = decideFile("02-reviewed.md", base, current, doc, { choice: "arquivo", token: c.resolve_token });
    assert.equal(keep.action, "resolved_keep_file");
    if (keep.action !== "resolved_keep_file") return;
    assert.equal(keep.write, "p1\n\np2 pipeline\n\np3\n\np4 editor\n");
    assert.equal(keep.newBase, doc);
    // Próximo apply com o mesmo doc: nada a repuxar.
    assert.equal(decideFile("02-reviewed.md", keep.newBase, keep.write, doc).action, "doc_stale");
  });

  it("runApply grava o trecho disjunto no resolve=arquivo e reporta em pulled + kept_file", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const pipelineReviewed = REVIEWED.replace("Cada rodada redefine", "Cada rodada (pipeline) redefine");
      writeFileSync(join(dir, "02-reviewed.md"), pipelineReviewed);
      const exp = writeExport(
        dir,
        doc
          .replace("Cada rodada redefine", "Cada rodada (editor) redefine")
          .replace("liderada por Google.", "liderada por Google e Amazon."),
      );
      const first = runApply({ editionDir: dir, docExport: exp });
      const token = conflictToken(first, "02-reviewed.md");
      const keep = runApply({
        editionDir: dir,
        docExport: exp,
        resolutions: parseResolutions(`02-reviewed.md=arquivo@${token}`),
      });
      assert.deepEqual(keep.kept_file, ["02-reviewed.md"]);
      assert.deepEqual(keep.pulled, ["02-reviewed.md"]);
      assert.equal(read(dir, "02-reviewed.md"), pipelineReviewed.replace("liderada por Google.", "liderada por Google e Amazon."));
      const again = runApply({ editionDir: dir, docExport: exp });
      assert.deepEqual(again.pulled, []);
    });
  });

  it("resolved_apply_doc com mudança do pipeline em trecho disjunto → doc_stale", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const pipelineReviewed = REVIEWED.replace("Cada rodada redefine", "Cada rodada (pipeline) redefine").replace(
        "enviei 5 artigos",
        "enviei 6 artigos",
      );
      writeFileSync(join(dir, "02-reviewed.md"), pipelineReviewed);
      const exp = writeExport(dir, doc.replace("Cada rodada redefine", "Cada rodada (editor) redefine"));
      const token = conflictToken(runApply({ editionDir: dir, docExport: exp }), "02-reviewed.md");
      const r = runApply({ editionDir: dir, docExport: exp, resolutions: parseResolutions(`02-reviewed.md=doc@${token}`) });
      assert.deepEqual(r.doc_stale, ["02-reviewed.md"]);
      assert.ok(read(dir, "02-reviewed.md").includes("enviei 6 artigos"));
    });
  });

  it("confirm exige a --doc-version gravada pelo render", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      writeFileSync(join(dir, "03-social.md"), SOCIAL + "\nnovo\n");
      const r = runRender({ editionDir: dir, edition: "261012", docExport: writeExport(dir, doc), docVersion: "v7" });
      const newDoc = writeExport(dir, readFileSync(r.out, "utf8"), "novo.md");
      assert.throws(() => runConfirm({ editionDir: dir, docExport: newDoc }), /doc-version/);
      assert.throws(() => runConfirm({ editionDir: dir, docExport: newDoc, docVersion: "v8" }), /NÃO efetivada/);
      assert.ok(readState(dir)?.pending);
      runConfirm({ editionDir: dir, docExport: newDoc, docVersion: "v7" });
      assert.equal(readState(dir)?.pending, undefined);
    });
  });

  it("URL sem esquema não sofre normalização de ênfase", () => {
    assert.equal(normalizeLine("veja www.c.com/__init__.py"), "veja www.c.com/__init__.py");
    assert.equal(normalizeLine("veja c.com/_x_/y"), "veja c.com/_x_/y");
    assert.equal(unescapeForWrite("veja www.c.com/__init__.py").text, "veja www.c.com/__init__.py");
    assert.equal(normalizeLine("um _termo_ aqui"), "um *termo* aqui");
  });

  it("sublinhados setext `--` e `===` colados em texto ganham linha em branco no doc", () => {
    const content = "Título A\n===\n\nTítulo B\n--\n\nfim\n";
    const md = renderDocMarkdown({ edition: "261012", files: files(content) });
    assert.ok(md.includes("Título A\n\n==="));
    assert.ok(md.includes("Título B\n\n--"));
    assert.ok(docEquivalent(content, parseDocExport(md)["02-reviewed.md"]));
  });
});

describe("#10078 — enable e export único na finalização", () => {
  it("enable: round-trip verde religa o sync (apaga final_apply antigo); apply volta a puxar", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const exp = writeExport(dir, doc);
      runApply({ editionDir: dir, docExport: exp, final: true });
      runDisable({ editionDir: dir, reason: "export não chegou ao disco" });
      assert.equal(runStatus({ editionDir: dir }).sync_enabled, false);
      assert.throws(() => runApply({ editionDir: dir, docExport: exp }), /sync desativado/);

      const cli = runCli(["enable", "--edition-dir", dir, "--doc-export", writeExport(dir, aggressiveExport(doc), "rt.md")]);
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(JSON.parse(cli.stdout).ok, true);
      const state = readState(dir)!;
      assert.equal(state.sync_disabled, undefined);
      assert.equal(state.final_apply, undefined, "final_apply de antes do disable não vale mais");
      assert.equal(runCheck({ editionDir: dir }).ok, false, "check exige um apply --final novo depois do enable");
      assert.equal(runStatus({ editionDir: dir }).sync_enabled, true);

      const edited = writeExport(dir, doc.replace("Texto do d2.", "Texto do d2 editado."), "ed.md");
      assert.deepEqual(runApply({ editionDir: dir, docExport: edited, final: true }).pulled, ["03-social.md"]);
      assert.equal(runCheck({ editionDir: dir }).ok, true);
    });
  });

  it("enable reprovado (export alterado/editado ou sentinela perdida): segue desligado com o motivo original, nada gravado", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      runDisable({ editionDir: dir, reason: "motivo original" });
      const before = readFileSync(statePath(dir), "utf8");
      const edited = writeExport(dir, doc.replace("Texto do d2.", "Texto do d2 editado."));
      const r = runEnable({ editionDir: dir, docExport: edited });
      assert.equal(r.ok, false);
      assert.match(r.reason ?? "", /continua desativado/);
      assert.equal(readFileSync(statePath(dir), "utf8"), before);
      const cli = runCli(["enable", "--edition-dir", dir, "--doc-export", writeExport(dir, "sem sentinela", "bad.md")]);
      assert.equal(cli.status, 1, cli.stderr);
      assert.equal(readState(dir)?.sync_disabled?.reason, "motivo original");
      assert.equal(read(dir, "03-social.md"), SOCIAL);
    });
  });

  it("enable: já ativo → no-op; sem doc_url → exit 2; sem --doc-export → exit 2", () => {
    withEdition((dir) => {
      runRender({ editionDir: dir, edition: "261012" });
      assert.equal(runCli(["enable", "--edition-dir", dir, "--doc-export", writeExport(dir, "x")]).status, 2);
      const doc = createDoc(dir);
      assert.equal(runEnable({ editionDir: dir, docExport: writeExport(dir, doc) }).already_enabled, true);
      assert.equal(runCli(["enable", "--edition-dir", dir]).status, 2);
    });
  });

  it("FLUXO PADRÃO: sem export durante o gate; status acusa o que o pipeline mudou; UM export no final mescla doc + pipeline", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      assert.deepEqual(runStatus({ editionDir: dir }).files_changed_since_doc, []);
      // ajustar pelo terminal durante o gate (o doc não é atualizado).
      const pipelineReviewed = REVIEWED.replace("Cada rodada redefine", "Cada rodada (pipeline) redefine");
      writeFileSync(join(dir, "02-reviewed.md"), pipelineReviewed);
      const st = runCli(["status", "--edition-dir", dir]);
      assert.equal(st.status, 0, st.stderr);
      assert.deepEqual(JSON.parse(st.stdout).files_changed_since_doc, ["02-reviewed.md"]);
      // O editor editou no doc o tempo todo, em trechos disjuntos; export único no `sim`.
      const exp = writeExport(
        dir,
        doc.replace("liderada por Google.", "liderada pelo Google.").replace("Texto do d2.", "Texto do d2 do editor."),
      );
      const fin = runApply({ editionDir: dir, docExport: exp, final: true });
      assert.equal(fin.ok, true);
      assert.deepEqual(fin.pulled, ["02-reviewed.md", "03-social.md"]);
      const merged = read(dir, "02-reviewed.md");
      assert.ok(merged.includes("Cada rodada (pipeline) redefine"), "mudança do pipeline preservada");
      assert.ok(merged.includes("liderada pelo Google."), "edição do doc puxada");
      assert.equal(runCheck({ editionDir: dir }).ok, true);
    });
  });

  it("FLUXO PADRÃO com conflito: acusado, nada sobrescrito; --resolve reusa o MESMO export (sem export novo)", () => {
    withEdition((dir) => {
      const doc = createDoc(dir);
      const pipelineReviewed = REVIEWED.replace("Cada rodada redefine", "Cada rodada (pipeline) redefine");
      writeFileSync(join(dir, "02-reviewed.md"), pipelineReviewed);
      const exp = writeExport(dir, doc.replace("Cada rodada redefine", "Cada rodada (editor) redefine"));
      const fin = runCli(["apply", "--edition-dir", dir, "--doc-export", exp, "--final"]);
      assert.equal(fin.status, 1, fin.stderr);
      const report = JSON.parse(fin.stdout) as ReturnType<typeof runApply>;
      assert.equal(read(dir, "02-reviewed.md"), pipelineReviewed, "conflito nunca sobrescreve");
      assert.equal(runCheck({ editionDir: dir }).ok, false);
      assert.deepEqual(runStatus({ editionDir: dir }).pending_conflict, ["02-reviewed.md"]);
      const token = conflictToken(report, "02-reviewed.md");
      const resolved = runApply({
        editionDir: dir,
        docExport: exp,
        final: true,
        resolutions: parseResolutions(`02-reviewed.md=doc@${token}`),
      });
      assert.equal(resolved.ok, true);
      assert.ok(read(dir, "02-reviewed.md").includes("Cada rodada (editor) redefine"));
      assert.equal(runCheck({ editionDir: dir }).ok, true);
    });
  });

  it("status sem doc → has_doc false", () => {
    withEdition((dir) => {
      assert.equal(runStatus({ editionDir: dir }).has_doc, false);
      runRender({ editionDir: dir, edition: "261012" });
      assert.equal(runStatus({ editionDir: dir }).has_doc, false);
    });
  });
});

describe("#10177 — apply --no-edits: pula o export quando a version do doc não mudou desde a criação", () => {
  /** Cria o doc registrando a version devolvida pela criação (mock — nunca o conector real). */
  function createDocV(dir: string, version = "1"): string {
    const { out } = runRender({ editionDir: dir, edition: "261014" });
    runSetUrl({ editionDir: dir, docUrl: "https://claude.ai/artifact/x", docVersion: version });
    return readFileSync(out, "utf8");
  }

  it("version igual (caso 261014, rev 1 = rev 1): apply --final --no-edits sem export grava final_apply e o check passa", () => {
    withEdition((dir) => {
      createDocV(dir, "1");
      assert.equal(readState(dir)?.base_doc_version, "1");
      assert.equal(runStatus({ editionDir: dir }).base_doc_version, "1");
      const cli = runCli(["apply", "--edition-dir", dir, "--no-edits", "--doc-version", "1", "--final"]);
      assert.equal(cli.status, 0, cli.stderr);
      const r = JSON.parse(cli.stdout);
      assert.equal(r.ok, true);
      assert.equal(r.no_edits, true);
      assert.deepEqual(r.pulled, []);
      assert.equal(read(dir, "02-reviewed.md"), REVIEWED);
      assert.equal(read(dir, "03-social.md"), SOCIAL);
      assert.ok(readState(dir)?.final_apply, "final_apply gravado");
      assert.equal(runCheck({ editionDir: dir }).ok, true);
    });
  });

  it("version igual com mudança do pipeline durante o gate: arquivo do pipeline preservado (doc_stale), check passa", () => {
    withEdition((dir) => {
      createDocV(dir, "3");
      const pipelineReviewed = REVIEWED.replace("Cada rodada redefine", "Cada rodada (pipeline) redefine");
      writeFileSync(join(dir, "02-reviewed.md"), pipelineReviewed);
      const r = runApply({ editionDir: dir, noEdits: { docVersion: "3" }, final: true });
      assert.equal(r.ok, true);
      assert.deepEqual(r.doc_stale, ["02-reviewed.md"]);
      assert.equal(read(dir, "02-reviewed.md"), pipelineReviewed, "nunca reverte o pipeline para a base");
      assert.equal(runCheck({ editionDir: dir }).ok, true);
    });
  });

  it("version diferente (editor editou): exit 4, needs_export, NADA gravado — e o export normal segue funcionando", () => {
    withEdition((dir) => {
      const doc = createDocV(dir, "1");
      const before = readFileSync(statePath(dir), "utf8");
      const cli = runCli(["apply", "--edition-dir", dir, "--no-edits", "--doc-version", "2", "--final"]);
      assert.equal(cli.status, 4, cli.stderr);
      assert.equal(JSON.parse(cli.stdout).needs_export, true);
      assert.equal(readFileSync(statePath(dir), "utf8"), before, "estado intocado");
      assert.equal(runCheck({ editionDir: dir }).ok, false, "sem final_apply");
      const exp = writeExport(dir, doc.replace("Texto do d2.", "Texto do d2 editado."));
      assert.deepEqual(runApply({ editionDir: dir, docExport: exp, final: true }).pulled, ["03-social.md"]);
      assert.equal(runCheck({ editionDir: dir }).ok, true);
    });
  });

  it("sem version registrada (set-url sem --doc-version) → exit 4", () => {
    withEdition((dir) => {
      createDoc(dir);
      assert.equal(readState(dir)?.base_doc_version, undefined);
      assert.equal(runCli(["apply", "--edition-dir", dir, "--no-edits", "--doc-version", "1", "--final"]).status, 4);
    });
  });

  it("apply com export apaga a version (base pode ter avançado); render com doc e confirm também", () => {
    withEdition((dir) => {
      const doc = createDocV(dir, "1");
      const exp = writeExport(dir, doc.replace("Texto do d2.", "Texto do d2 editado."));
      runApply({ editionDir: dir, docExport: exp });
      assert.equal(readState(dir)?.base_doc_version, undefined);
      // Mesmo que a version "volte" a bater por coincidência, o fast path não vale mais.
      assert.throws(() => runApply({ editionDir: dir, noEdits: { docVersion: "1" }, final: true }), /export normal/);
    });
    withEdition((dir) => {
      const doc = createDocV(dir, "1");
      runRender({ editionDir: dir, edition: "261014", docExport: writeExport(dir, doc), docVersion: "1" });
      assert.equal(readState(dir)?.base_doc_version, undefined, "render com doc existente apaga");
      assert.throws(() => runApply({ editionDir: dir, noEdits: { docVersion: "1" } }), /export normal/);
    });
  });

  it("set-url sem version em cima de um estado com version apaga a antiga; sync desligado → exit 2; flags incompatíveis → exit 2", () => {
    withEdition((dir) => {
      createDocV(dir, "1");
      runSetUrl({ editionDir: dir, docUrl: "https://claude.ai/artifact/y" });
      assert.equal(readState(dir)?.base_doc_version, undefined);
      runSetUrl({ editionDir: dir, docUrl: "https://claude.ai/artifact/y", docVersion: "5" });
      const exp = writeExport(dir, "x");
      assert.equal(runCli(["apply", "--edition-dir", dir, "--no-edits", "--doc-version", "5", "--doc-export", exp]).status, 2);
      assert.equal(runCli(["apply", "--edition-dir", dir, "--no-edits"]).status, 2);
      runDisable({ editionDir: dir, reason: "teste" });
      assert.equal(runCli(["apply", "--edition-dir", dir, "--no-edits", "--doc-version", "5", "--final"]).status, 2);
    });
  });
});

describe("#10112 — destaque movido/trocado pelo pipeline: 'aplicar doc' recusado", () => {
  const block = (n: number, cat: string, title: string, body: string) =>
    [
      `DESTAQUE ${n} | ${cat}`,
      "",
      title,
      "",
      body,
      "",
      "Por que isso importa:",
      "",
      `Impacto do ${title.toLowerCase()} no mercado brasileiro de IA.`,
    ].join("\n");
  const A = (n: number, body = "A Anthropic fechou uma rodada de US$ 2 bilhões liderada por Google.") =>
    block(n, "💰 MERCADO", "Anthropic levanta rodada série E", body);
  const B = (n: number) =>
    block(n, "⚖️ REGULAÇÃO", "Europa aprova regra para deepfakes", "O Parlamento Europeu aprovou a regra de rotulagem de vídeo sintético.");
  const C = (n: number) =>
    block(n, "🔬 PESQUISA", "Modelo aberto bate fechado em matemática", "Um laboratório publicou pesos que superam o modelo fechado no benchmark.");
  const ed = (...blocks: string[]) => ["Intro da edição.", "", "---", "", blocks.join("\n\n---\n\n"), ""].join("\n");
  const EDITED = "A Anthropic fechou uma rodada de US$ 2,5 bilhões liderada por Google.";
  const countDestaques = (s: string) => (s.match(/^DESTAQUE \d+ \|/gm) ?? []).length;

  it("REPRO: reorder [A,B]→[B,A] + edição de A no doc + resolve=doc é recusado (o merge linha a linha corromperia o arquivo)", () => {
    const base = ed(A(1), B(2));
    const current = ed(B(1), A(2));
    const doc = ed(A(1, EDITED), B(2));
    const c = decideFile("02-reviewed.md", base, current, doc);
    assert.equal(c.action, "conflict");
    if (c.action !== "conflict") return;
    assert.ok(c.apply_doc_blocked, "conflito tem de avisar que 'aplicar doc' está bloqueado");
    assert.ok(c.overlaps.some((o) => o.moved_block));
    // Premissa do bug: sem o guard, o merge "doc vence" linha a linha grava a
    // linha de A dentro do bloco de B (o corpo de B some) — arquivo corrompido.
    const raw = merge3(base, current, doc, "doc").content;
    assert.ok(raw.includes(EDITED));
    assert.ok(!raw.includes("O Parlamento Europeu aprovou"), "premissa: o doc vencer sobrescreve o corpo de B");
    const o = decideFile("02-reviewed.md", base, current, doc, { choice: "doc", token: c.resolve_token });
    assert.equal(o.action, "conflict");
    if (o.action === "conflict") assert.match(o.reason, /resolução 'doc' recusada.*duplicaria ou reverteria/);
    // `arquivo` segue disponível e mantém a ordem do pipeline, sem duplicar.
    const keep = decideFile("02-reviewed.md", base, current, doc, { choice: "arquivo", token: c.resolve_token });
    assert.equal(keep.action, "resolved_keep_file");
    if (keep.action === "resolved_keep_file") assert.equal(countDestaques(keep.write), 2);
  });

  it("promote (insere novo D1 e desloca): edição longe do cabeçalho é puxada no destaque deslocado, sem duplicar", () => {
    const base = ed(A(1), B(2));
    const current = ed(C(1), A(2), B(3));
    const doc = ed(A(1, EDITED), B(2));
    const o = decideFile("02-reviewed.md", base, current, doc);
    assert.equal(o.action, "pulled");
    if (o.action !== "pulled") return;
    assert.equal(o.write, ed(C(1), A(2, EDITED), B(3)));
  });

  it("promote + edição colada no cabeçalho deslocado (título) → conflito com doc recusado", () => {
    const base = ed(A(1), B(2));
    const current = ed(C(1), A(2), B(3));
    const doc = ed(A(1).replace("Anthropic levanta rodada série E", "Anthropic capta US$ 2 bi"), B(2));
    const c = decideFile("02-reviewed.md", base, current, doc);
    assert.equal(c.action, "conflict");
    if (c.action === "conflict") assert.match(c.apply_doc_blocked ?? "", /cabeçalho de destaque/);
  });

  it("swap (bloco vira placeholder) + edição do destaque velho no doc → doc recusado (não reverte o swap)", () => {
    const base = ed(A(1), B(2));
    const placeholder = [
      "**DESTAQUE 2 | [RASCUNHO PENDENTE — swap-destaque]**",
      "",
      "**[Novo](https://x.com/novo)**",
      "",
      "[TEXTO PENDENTE — re-rodar writer-destaque para DESTAQUE 2]",
    ].join("\n");
    const current = ed(A(1), placeholder);
    const doc = ed(A(1), B(2).replace("aprovou a regra", "aprovou ontem a regra"));
    const c = decideFile("02-reviewed.md", base, current, doc);
    assert.equal(c.action, "conflict");
    if (c.action !== "conflict") return;
    assert.ok(c.apply_doc_blocked);
    const o = decideFile("02-reviewed.md", base, current, doc, { choice: "doc", token: c.resolve_token });
    assert.equal(o.action, "conflict");
  });

  it("bloco sem cabeçalho movido (parágrafos trocados) → doc recusado pela detecção de movimento", () => {
    const p1 = "Primeiro parágrafo longo o bastante para ter identidade própria no arquivo.";
    const p2 = "Segundo parágrafo também longo, descrevendo outro assunto da edição de hoje.";
    const base = `# Social\n\n${p1}\n\n${p2}\n`;
    const current = `# Social\n\n${p2}\n\n${p1}\n`;
    const doc = `# Social\n\n${p1.replace("Primeiro", "Primeiríssimo")}\n\n${p2}`;
    const c = decideFile("03-social.md", base, current, doc);
    assert.equal(c.action, "conflict");
    if (c.action !== "conflict") return;
    assert.match(c.apply_doc_blocked ?? "", /moveu este bloco/);
  });

  it("conflito comum dentro de um destaque (nada movido) → doc continua aceito", () => {
    const base = ed(A(1), B(2));
    const current = ed(A(1, "A Anthropic fechou rodada de US$ 2 bi (pipeline)."), B(2));
    const doc = ed(A(1, EDITED), B(2));
    const c = decideFile("02-reviewed.md", base, current, doc);
    assert.equal(c.action, "conflict");
    if (c.action !== "conflict") return;
    assert.equal(c.apply_doc_blocked, undefined);
    const o = decideFile("02-reviewed.md", base, current, doc, { choice: "doc", token: c.resolve_token });
    assert.equal(o.action, "resolved_apply_doc");
    if (o.action === "resolved_apply_doc") assert.ok(o.write.includes(EDITED));
  });

  it("runApply: o conflito reportado carrega apply_doc_blocked e --resolve doc não grava nada", () => {
    const base = ed(A(1), B(2));
    withEdition(
      (dir) => {
        const docMd = createDoc(dir);
        writeFileSync(join(dir, "02-reviewed.md"), ed(B(1), A(2))); // reorder do pipeline
        const exp = writeExport(dir, docMd.replace("US$ 2 bilhões", "US$ 2,5 bilhões"));
        const r1 = runApply({ editionDir: dir, docExport: exp });
        const c = r1.conflicts.find((x) => x.file === "02-reviewed.md");
        assert.ok(c && c.action === "conflict" && c.apply_doc_blocked);
        const before = read(dir, "02-reviewed.md");
        const r2 = runApply({
          editionDir: dir,
          docExport: exp,
          resolutions: { "02-reviewed.md": { choice: "doc", token: conflictToken(r1, "02-reviewed.md") } },
        });
        assert.equal(r2.ok, false);
        assert.equal(read(dir, "02-reviewed.md"), before);
        assert.equal(countDestaques(before), 2);
      },
      base,
    );
  });
});
