/**
 * lint-newsletter-md-snippet-staleness.test.ts (#4076)
 *
 * Regressão: se um snippet USADO por `stitch-newsletter.ts` (Stage 2) — ou
 * `platform.config.json > boxes_divulgacao` quando ao menos um slot está
 * engajado — foi editado DEPOIS do mtime de `02-reviewed.md`, o check
 * `--check snippet-staleness` deve acusar (WARN-only, nunca gate-blocking).
 * Caso negativo: arquivo mais ANTIGO que o MD → silêncio. Um snippet fora do
 * conjunto "usado" (arquivo não referenciado por nenhum slot/config desta
 * edição) NUNCA deve disparar aviso, mesmo mais novo — essa é a parte
 * não-trivial da issue (evitar falso-positivo em massa).
 *
 * Caso real (edição 260727): o editor editou
 * `encerramento-social-apoio.md` no Studio DEPOIS do Stage 2 já ter rodado —
 * a mudança nunca chegou em `02-reviewed.md`, e nada sinalizava a
 * divergência (orchestrator concluiu incorretamente que o save falhou).
 *
 * Fixtures SEMPRE em diretório temporário (`mkdtempSync`) — nunca toca
 * `context/snippets/` nem `platform.config.json` reais (regra desta rodada
 * de overnight).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveUsedSnippets,
  evaluateSnippetStaleness,
  readBoxesDivulgacaoConfig,
  isAgradecimentoSnippetUsed,
  runSnippetStalenessCheck,
  writeSnippetBodyHashManifest,
  type BoxesDivulgacaoConfigLike,
} from "../scripts/lib/lint-checks/snippet-staleness.ts";
import { snippetBodyHash } from "../scripts/lib/shared/snippet-header.ts";

// ─── Fixture de 02-reviewed.md com box no slot1 (gap D1/D2) ────────────────
const REVIEWED_MD_WITH_SLOT1_BOX = [
  "Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 7 artigos. Selecionamos os 3 mais relevantes para as pessoas que assinam a newsletter.",
  "",
  "---",
  "",
  "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
  "",
  "[**Título 1**](https://example.com/d1)",
  "",
  "Corpo do destaque 1.",
  "",
  "Por que isso importa: impacto direto no dia a dia.",
  "",
  "---",
  "",
  "**📚 CURADORIA DE LIVROS**",
  "",
  "Conteúdo do box de divulgação do slot 1.",
  "",
  "---",
  "",
  "**DESTAQUE 2 | 🔬 PESQUISA**",
  "",
  "[**Título 2**](https://example.com/d2)",
  "",
  "Corpo do destaque 2.",
  "",
  "Por que isso importa: relevância para pesquisadores.",
  "",
].join("\n");

// Fixture SEM nenhum box de divulgação em nenhum slot (2 destaques, colados
// direto, sem `---`-isolado extra entre eles).
const REVIEWED_MD_NO_BOXES = [
  "Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 7 artigos. Selecionamos os 3 mais relevantes para as pessoas que assinam a newsletter.",
  "",
  "---",
  "",
  "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
  "",
  "[**Título 1**](https://example.com/d1)",
  "",
  "Corpo do destaque 1.",
  "",
  "---",
  "",
  "**DESTAQUE 2 | 🔬 PESQUISA**",
  "",
  "[**Título 2**](https://example.com/d2)",
  "",
  "Corpo do destaque 2.",
  "",
].join("\n");

describe("resolveUsedSnippets (#4076) — determinar candidatos SEM falso-positivo em massa", () => {
  const cfgAllSlots: BoxesDivulgacaoConfigLike = {
    slot1: "livros-divulgacao.md",
    slot2: "clarice-divulgacao.md",
    slot3: "apoio-divulgacao.md",
  };
  const cfgNoSlots: BoxesDivulgacaoConfigLike = { slot1: null, slot2: null, slot3: null };

  it("encerramento-social-apoio.md é SEMPRE candidato (lido incondicionalmente pelo stitch)", () => {
    const used = resolveUsedSnippets(REVIEWED_MD_NO_BOXES, cfgNoSlots, false);
    assert.ok(used.some((u) => u.file === "encerramento-social-apoio.md" && u.slot === "encerramento"));
  });

  it("agradecimento-apoiadores.md só é candidato quando o placeholder já foi substituído", () => {
    const usedWithout = resolveUsedSnippets(REVIEWED_MD_NO_BOXES, cfgNoSlots, false);
    assert.ok(!usedWithout.some((u) => u.file === "agradecimento-apoiadores.md"));

    const usedWith = resolveUsedSnippets(REVIEWED_MD_NO_BOXES, cfgNoSlots, true);
    assert.ok(usedWith.some((u) => u.file === "agradecimento-apoiadores.md" && u.slot === "agradecimento"));
  });

  it("slot1 é candidato quando configurado E o box aparece de fato no gap D1/D2", () => {
    const used = resolveUsedSnippets(REVIEWED_MD_WITH_SLOT1_BOX, cfgAllSlots, false);
    assert.ok(used.some((u) => u.file === "livros-divulgacao.md" && u.slot === "slot1"));
  });

  it("slot1 NÃO é candidato quando configurado mas o box NÃO aparece no MD (idempotência/edição de 2 destaques)", () => {
    const used = resolveUsedSnippets(REVIEWED_MD_NO_BOXES, cfgAllSlots, false);
    assert.ok(!used.some((u) => u.slot === "slot1"));
    assert.ok(!used.some((u) => u.slot === "slot2"));
    assert.ok(!used.some((u) => u.slot === "slot3"));
  });

  it("slot1 NÃO é candidato quando o box aparece mas o slot está configurado como null (kill-switch/sem sponsor)", () => {
    const used = resolveUsedSnippets(REVIEWED_MD_WITH_SLOT1_BOX, cfgNoSlots, false);
    assert.ok(!used.some((u) => u.slot === "slot1"));
  });
});

describe("readBoxesDivulgacaoConfig (#4076)", () => {
  let dir: string;
  it("lê boxes_divulgacao de um platform.config.json de fixture", () => {
    dir = mkdtempSync(join(tmpdir(), "diaria-snippet-staleness-cfg-"));
    const configPath = join(dir, "platform.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ boxes_divulgacao: { slot1: "a.md", slot2: null, slot3: "c.md" } }),
    );
    const cfg = readBoxesDivulgacaoConfig(configPath);
    assert.deepEqual(cfg, { slot1: "a.md", slot2: null, slot3: "c.md" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("default legado quando a chave boxes_divulgacao está ausente", () => {
    dir = mkdtempSync(join(tmpdir(), "diaria-snippet-staleness-cfg-"));
    const configPath = join(dir, "platform.config.json");
    writeFileSync(configPath, JSON.stringify({ newsletter: "beehiiv" }));
    const cfg = readBoxesDivulgacaoConfig(configPath);
    assert.deepEqual(cfg, { slot1: "livros-divulgacao.md", slot2: null, slot3: null });
    rmSync(dir, { recursive: true, force: true });
  });

  it("default legado quando o config não existe/é ilegível", () => {
    const cfg = readBoxesDivulgacaoConfig(join(tmpdir(), "arquivo-que-nao-existe-4076.json"));
    assert.deepEqual(cfg, { slot1: "livros-divulgacao.md", slot2: null, slot3: null });
  });
});

describe("isAgradecimentoSnippetUsed (#4076)", () => {
  it("false quando o snippet ainda tem o placeholder {apoiadores}", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-snippet-staleness-agr-"));
    writeFileSync(join(dir, "agradecimento-apoiadores.md"), "Agradecemos a {apoiadores} por apoiar!");
    assert.equal(isAgradecimentoSnippetUsed(dir), false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("true quando o placeholder já foi substituído por um nome real", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-snippet-staleness-agr-"));
    writeFileSync(join(dir, "agradecimento-apoiadores.md"), "Agradecemos a Fulano por apoiar!");
    assert.equal(isAgradecimentoSnippetUsed(dir), true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("false quando o arquivo não existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-snippet-staleness-agr-"));
    assert.equal(isAgradecimentoSnippetUsed(dir), false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("evaluateSnippetStaleness (#4076) — comparação pura de mtimes", () => {
  const REVIEWED_MS = 1_700_000_000_000; // âncora arbitrária

  it("CASO POSITIVO: snippet usado mais NOVO que 02-reviewed.md → warning", () => {
    const report = evaluateSnippetStaleness(
      REVIEWED_MS,
      [{ file: "encerramento-social-apoio.md", slot: "encerramento", mtimeMs: REVIEWED_MS + 60_000 }],
      { engaged: false, mtimeMs: null },
    );
    assert.equal(report.ok, false);
    assert.equal(report.warnings.length, 1);
    assert.equal(report.warnings[0].file, "encerramento-social-apoio.md");
    assert.equal(report.warnings[0].kind, "snippet");
    assert.equal(report.warnings[0].lag_minutes, 1);
  });

  it("CASO NEGATIVO: snippet mais ANTIGO que 02-reviewed.md → silêncio", () => {
    const report = evaluateSnippetStaleness(
      REVIEWED_MS,
      [{ file: "encerramento-social-apoio.md", slot: "encerramento", mtimeMs: REVIEWED_MS - 60_000 }],
      { engaged: false, mtimeMs: null },
    );
    assert.equal(report.ok, true);
    assert.equal(report.warnings.length, 0);
  });

  it("snippet ausente (mtimeMs null) não gera warning (graceful)", () => {
    const report = evaluateSnippetStaleness(
      REVIEWED_MS,
      [{ file: "sumiu.md", slot: "slot1", mtimeMs: null }],
      { engaged: false, mtimeMs: null },
    );
    assert.equal(report.ok, true);
  });

  it("diferença dentro da tolerância (<1s) não conta como stale", () => {
    const report = evaluateSnippetStaleness(
      REVIEWED_MS,
      [{ file: "encerramento-social-apoio.md", slot: "encerramento", mtimeMs: REVIEWED_MS + 500 }],
      { engaged: false, mtimeMs: null },
    );
    assert.equal(report.ok, true);
  });

  it("platform.config.json mais novo + boxes ENGAJADOS → warning (kind: config)", () => {
    const report = evaluateSnippetStaleness(
      REVIEWED_MS,
      [],
      { engaged: true, mtimeMs: REVIEWED_MS + 120_000 },
    );
    assert.equal(report.ok, false);
    assert.equal(report.warnings[0].kind, "config");
    assert.equal(report.warnings[0].file, "platform.config.json");
    assert.equal(report.warnings[0].lag_minutes, 2);
  });

  it("platform.config.json mais novo MAS boxes NÃO engajados → silêncio (evita ruído de mudança não-relacionada)", () => {
    const report = evaluateSnippetStaleness(
      REVIEWED_MS,
      [],
      { engaged: false, mtimeMs: REVIEWED_MS + 120_000 },
    );
    assert.equal(report.ok, true);
  });

  it("#4150: mtime mais novo MAS bodyHash IGUAL (recorded === current) → silêncio (edição de metadado)", () => {
    const report = evaluateSnippetStaleness(
      REVIEWED_MS,
      [{
        file: "clarice-divulgacao.md",
        slot: "slot3",
        mtimeMs: REVIEWED_MS + 60_000,
        recordedBodyHash: "abc123",
        currentBodyHash: "abc123",
      }],
      { engaged: false, mtimeMs: null },
    );
    assert.equal(report.ok, true);
    assert.equal(report.warnings.length, 0);
  });

  it("#4150: mtime mais novo E bodyHash DIFERENTE → warning (comportamento antigo preservado)", () => {
    const report = evaluateSnippetStaleness(
      REVIEWED_MS,
      [{
        file: "clarice-divulgacao.md",
        slot: "slot3",
        mtimeMs: REVIEWED_MS + 60_000,
        recordedBodyHash: "abc123",
        currentBodyHash: "def456",
      }],
      { engaged: false, mtimeMs: null },
    );
    assert.equal(report.ok, false);
    assert.equal(report.warnings.length, 1);
    assert.equal(report.warnings[0].file, "clarice-divulgacao.md");
  });

  it("#4150: mtime mais novo MAS recordedBodyHash/currentBodyHash ausentes (edição pré-#4150, sem manifest) → warning (fallback mtime-puro)", () => {
    const report = evaluateSnippetStaleness(
      REVIEWED_MS,
      [{ file: "clarice-divulgacao.md", slot: "slot3", mtimeMs: REVIEWED_MS + 60_000 }],
      { engaged: false, mtimeMs: null },
    );
    assert.equal(report.ok, false, "sem hash disponível, deve preservar o comportamento mtime-puro (nunca deixar de avisar por falta de dado novo)");
  });
});

describe("runSnippetStalenessCheck (#4076) — end-to-end com fixture em diretório TEMPORÁRIO", () => {
  function setupFixture(): { root: string; editionDir: string; snippetsDir: string; configPath: string; mdPath: string } {
    const root = mkdtempSync(join(tmpdir(), "diaria-snippet-staleness-e2e-"));
    const snippetsDir = join(root, "context", "snippets");
    mkdirSync(snippetsDir, { recursive: true });
    const editionDir = join(root, "data", "editions", "990101");
    mkdirSync(editionDir, { recursive: true });
    const configPath = join(root, "platform.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ boxes_divulgacao: { slot1: "livros-divulgacao.md", slot2: null, slot3: null } }),
    );
    writeFileSync(join(snippetsDir, "encerramento-social-apoio.md"), "Quem quiser apoiar, {{OPENING}}visite apoia.se/diaria.\n\nSiga no LinkedIn e Facebook.");
    writeFileSync(join(snippetsDir, "livros-divulgacao.md"), "**📚 CURADORIA DE LIVROS**\n\nConteúdo do box de divulgação do slot 1.");
    const mdPath = join(editionDir, "02-reviewed.md");
    writeFileSync(mdPath, REVIEWED_MD_WITH_SLOT1_BOX);
    // Normaliza TODOS os arquivos de fixture pra um baseline antigo comum —
    // sem isso, arquivos escritos em sequência (writeFileSync) ficam com
    // mtimes reais ligeiramente diferentes (ordem de criação), contaminando
    // qualquer teste que espere "só o arquivo X é mais novo que o MD". Cada
    // teste ajusta individualmente (via utimesSync) só o(s) arquivo(s) que
    // quer testar, a partir deste baseline uniforme.
    const baseline = new Date(Date.now() - 24 * 60 * 60_000); // 1 dia atrás
    for (const p of [configPath, join(snippetsDir, "encerramento-social-apoio.md"), join(snippetsDir, "livros-divulgacao.md"), mdPath]) {
      utimesSync(p, baseline, baseline);
    }
    return { root, editionDir, snippetsDir, configPath, mdPath };
  }

  it("#633 CENÁRIO REAL: tocar o mtime de um snippet USADO (slot1) → guard detecta", () => {
    const { root, snippetsDir, mdPath } = setupFixture();
    try {
      // 02-reviewed.md "escrito" primeiro (mtime mais antigo)...
      const oldTime = new Date(Date.now() - 10 * 60_000);
      utimesSync(mdPath, oldTime, oldTime);
      // ...editor edita o snippet DEPOIS (mtime mais novo, "tocado" agora).
      const snippetPath = join(snippetsDir, "livros-divulgacao.md");
      const newTime = new Date();
      utimesSync(snippetPath, newTime, newTime);

      const result = runSnippetStalenessCheck(mdPath, root);
      assert.equal(result.ok, false);
      assert.ok(
        result.warnings.some((w) => w.file === "livros-divulgacao.md" && w.kind === "snippet"),
        `esperava warning para livros-divulgacao.md, achou: ${JSON.stringify(result.warnings)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CASO NEGATIVO (#633): snippet mais ANTIGO que 02-reviewed.md → silêncio total", () => {
    const { root, snippetsDir, mdPath } = setupFixture();
    try {
      // snippets escritos primeiro (mais antigos)...
      const oldTime = new Date(Date.now() - 60 * 60_000);
      utimesSync(join(snippetsDir, "livros-divulgacao.md"), oldTime, oldTime);
      utimesSync(join(snippetsDir, "encerramento-social-apoio.md"), oldTime, oldTime);
      // ...02-reviewed.md "escrito" DEPOIS (mtime mais novo — stitch rodou por último).
      const newTime = new Date();
      utimesSync(mdPath, newTime, newTime);

      const result = runSnippetStalenessCheck(mdPath, root);
      assert.equal(result.ok, true);
      assert.equal(result.warnings.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("snippet NÃO usado (arquivo solto em context/snippets/, não referenciado por nenhum slot) editado mais novo → NUNCA dispara aviso", () => {
    const { root, snippetsDir, mdPath } = setupFixture();
    try {
      const oldTime = new Date(Date.now() - 10 * 60_000);
      utimesSync(mdPath, oldTime, oldTime);
      // Snippet arquivado/não-referenciado por boxes_divulgacao nesta config.
      writeFileSync(join(snippetsDir, "clarice-divulgacao.md"), "**📣 Clarice** — conteúdo não usado nesta edição.");
      const newTime = new Date();
      utimesSync(join(snippetsDir, "clarice-divulgacao.md"), newTime, newTime);

      const result = runSnippetStalenessCheck(mdPath, root);
      assert.equal(result.ok, true, `não deveria acusar clarice-divulgacao.md (não usado): ${JSON.stringify(result.warnings)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("platform.config.json (boxes_divulgacao) tocado DEPOIS do stitch, com slot já presente no MD → guard detecta", () => {
    const { root, configPath, mdPath } = setupFixture();
    try {
      const oldTime = new Date(Date.now() - 10 * 60_000);
      utimesSync(mdPath, oldTime, oldTime);
      const newTime = new Date();
      utimesSync(configPath, newTime, newTime);

      const result = runSnippetStalenessCheck(mdPath, root);
      assert.ok(
        result.warnings.some((w) => w.file === "platform.config.json" && w.kind === "config"),
        `esperava warning de platform.config.json, achou: ${JSON.stringify(result.warnings)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#4140 finding 3 — SLOT RENOMEADO: boxesCfg.slot1 passa a apontar pra um snippet DIFERENTE do que gerou o box já presente no MD → guard ainda detecta (kind: config)", () => {
    // Cenário literal da issue #4076 ("os slots foram trocados"): o MD já
    // tem o box do slot1 gerado a partir de `livros-divulgacao.md` (fixture
    // padrão). Pós-stitch, o editor troca `platform.config.json` pra apontar
    // slot1 pra um snippet DIFERENTE (`novo-parceiro-divulgacao.md`) — não
    // apenas toca o mtime do mesmo arquivo (isso já era coberto pelo teste
    // anterior). O box antigo continua fisicamente presente em
    // `02-reviewed.md`, então `extractBoxDivulgacao1` ainda o encontra e o
    // slot conta como engajado — a comparação de mtime do
    // `platform.config.json` (que mudou de valor E de mtime) deve disparar
    // normalmente, mesmo com o VALOR do slot diferente do que gerou o box.
    const { root, snippetsDir, configPath, mdPath } = setupFixture();
    try {
      const oldTime = new Date(Date.now() - 10 * 60_000);
      utimesSync(mdPath, oldTime, oldTime);

      // Snippet novo existe (o config vai apontar pra ele), mas o box em
      // 02-reviewed.md ainda é o do snippet ANTIGO (livros-divulgacao.md) —
      // ninguém re-stitchou depois da troca do slot.
      writeFileSync(
        join(snippetsDir, "novo-parceiro-divulgacao.md"),
        "**📚 NOVO PARCEIRO**\n\nConteúdo do box de divulgação do novo parceiro.",
      );

      // Slot RENOMEADO: platform.config.json passa a apontar slot1 pro
      // snippet novo — mudança de VALOR, não só de mtime do mesmo arquivo.
      writeFileSync(
        configPath,
        JSON.stringify({ boxes_divulgacao: { slot1: "novo-parceiro-divulgacao.md", slot2: null, slot3: null } }),
      );
      const newTime = new Date();
      utimesSync(configPath, newTime, newTime);

      const result = runSnippetStalenessCheck(mdPath, root);
      assert.equal(result.ok, false, `esperava warning pro slot renomeado, achou: ${JSON.stringify(result.warnings)}`);
      assert.ok(
        result.warnings.some((w) => w.file === "platform.config.json" && w.kind === "config"),
        `esperava warning kind:config de platform.config.json, achou: ${JSON.stringify(result.warnings)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("02-reviewed.md ausente → sem crash, report ok (skip gracioso)", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-snippet-staleness-missing-"));
    try {
      const result = runSnippetStalenessCheck(join(root, "nao-existe.md"), root);
      assert.equal(result.ok, true);
      assert.equal(result.warnings.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runSnippetStalenessCheck (#4150) — hash do corpo distingue edição de METADADO de edição de CONTEÚDO", () => {
  // Snippet com cabeçalho de comentário real (nome/categoria) — o cenário do
  // #4143 que originou o achado: 7 snippets editados só pra acrescentar
  // `alt:` no header, incluindo clarice-divulgacao.md (slot3 no #4143).
  const ORIGINAL_HEADER = "<!--\nnome: Curadoria de Livros\ncategoria: Divulgação\n-->\n\n";
  const ORIGINAL_BODY = "**📚 CURADORIA DE LIVROS**\n\nConteúdo do box de divulgação do slot 1.";
  const ORIGINAL_CONTENT = ORIGINAL_HEADER + ORIGINAL_BODY;

  /**
   * Fixture igual à de `runSnippetStalenessCheck (#4076)` acima, mas com
   * `livros-divulgacao.md` já trazendo um cabeçalho de comentário real (as
   * fixtures anteriores usam um snippet SEM header, o que não exercita a
   * distinção metadado/corpo) + o manifest `_internal/.snippet-body-hashes.json`
   * já gravado com o hash do CORPO original — simulando o que
   * `stitch-newsletter.ts` grava no momento do stitch (#4150).
   */
  function setupFixtureWithManifest(): { root: string; editionDir: string; snippetsDir: string; mdPath: string } {
    const root = mkdtempSync(join(tmpdir(), "diaria-snippet-staleness-hash-"));
    const snippetsDir = join(root, "context", "snippets");
    mkdirSync(snippetsDir, { recursive: true });
    const editionDir = join(root, "data", "editions", "990101");
    mkdirSync(editionDir, { recursive: true });
    const configPath = join(root, "platform.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ boxes_divulgacao: { slot1: "livros-divulgacao.md", slot2: null, slot3: null } }),
    );
    writeFileSync(join(snippetsDir, "encerramento-social-apoio.md"), "Quem quiser apoiar, visite apoia.se/diaria.\n\nSiga no LinkedIn e Facebook.");
    writeFileSync(join(snippetsDir, "livros-divulgacao.md"), ORIGINAL_CONTENT);
    const mdPath = join(editionDir, "02-reviewed.md");
    writeFileSync(mdPath, REVIEWED_MD_WITH_SLOT1_BOX);

    // Baseline: tudo "escrito" há 1 dia, igual à fixture #4076.
    const baseline = new Date(Date.now() - 24 * 60 * 60_000);
    for (const p of [configPath, join(snippetsDir, "encerramento-social-apoio.md"), join(snippetsDir, "livros-divulgacao.md"), mdPath]) {
      utimesSync(p, baseline, baseline);
    }

    // Manifest gravado no momento do stitch (#4150) — hash do CORPO original
    // (pós-cabeçalho) de livros-divulgacao.md, como `buildSnippetBodyHashManifest`
    // computaria a partir do `used` real. `_internal/` normalmente já existe
    // (stitch grava `02-draft.md` ali antes) — a fixture de teste precisa
    // criar explicitamente.
    mkdirSync(join(editionDir, "_internal"), { recursive: true });
    writeSnippetBodyHashManifest(editionDir, {
      "livros-divulgacao.md": snippetBodyHash(ORIGINAL_CONTENT),
    });

    return { root, editionDir, snippetsDir, mdPath };
  }

  it("edição restrita ao CABEÇALHO (acrescenta alt:) pós-stitch → silêncio (achado #4150/#4143)", () => {
    const { root, snippetsDir, mdPath } = setupFixtureWithManifest();
    try {
      const oldTime = new Date(Date.now() - 10 * 60_000);
      utimesSync(mdPath, oldTime, oldTime);

      // Editor acrescenta `alt:` ao cabeçalho — o CORPO (o que o stitch
      // injeta na newsletter) permanece byte-a-byte idêntico.
      const newHeader = "<!--\nnome: Curadoria de Livros\ncategoria: Divulgação\nalt: Prévia da página de curadoria de livros\n-->\n\n";
      const snippetPath = join(snippetsDir, "livros-divulgacao.md");
      writeFileSync(snippetPath, newHeader + ORIGINAL_BODY);
      const newTime = new Date();
      utimesSync(snippetPath, newTime, newTime);

      const result = runSnippetStalenessCheck(mdPath, root);
      assert.equal(
        result.ok,
        true,
        `esperava silêncio (só o cabeçalho mudou, corpo idêntico), achou: ${JSON.stringify(result.warnings)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edição do CORPO pós-stitch → warning (comportamento atual NÃO regride)", () => {
    const { root, snippetsDir, mdPath } = setupFixtureWithManifest();
    try {
      const oldTime = new Date(Date.now() - 10 * 60_000);
      utimesSync(mdPath, oldTime, oldTime);

      // Editor muda o CORPO (cabeçalho intacto) — divergência real de
      // conteúdo, o guard deve continuar acusando.
      const snippetPath = join(snippetsDir, "livros-divulgacao.md");
      writeFileSync(
        snippetPath,
        ORIGINAL_HEADER + "**📚 CURADORIA DE LIVROS**\n\nConteúdo COMPLETAMENTE diferente do original.",
      );
      const newTime = new Date();
      utimesSync(snippetPath, newTime, newTime);

      const result = runSnippetStalenessCheck(mdPath, root);
      assert.equal(result.ok, false, `esperava warning (corpo mudou), achou silêncio`);
      assert.ok(
        result.warnings.some((w) => w.file === "livros-divulgacao.md" && w.kind === "snippet"),
        `esperava warning kind:snippet para livros-divulgacao.md, achou: ${JSON.stringify(result.warnings)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CASO MISTO: cabeçalho E corpo alterados pós-stitch → warning", () => {
    const { root, snippetsDir, mdPath } = setupFixtureWithManifest();
    try {
      const oldTime = new Date(Date.now() - 10 * 60_000);
      utimesSync(mdPath, oldTime, oldTime);

      const newHeader = "<!--\nnome: Curadoria de Livros\ncategoria: Divulgação\nalt: Prévia nova\n-->\n\n";
      const snippetPath = join(snippetsDir, "livros-divulgacao.md");
      writeFileSync(
        snippetPath,
        newHeader + "**📚 CURADORIA DE LIVROS**\n\nConteúdo COMPLETAMENTE diferente do original.",
      );
      const newTime = new Date();
      utimesSync(snippetPath, newTime, newTime);

      const result = runSnippetStalenessCheck(mdPath, root);
      assert.equal(result.ok, false, `esperava warning (cabeçalho E corpo mudaram), achou silêncio`);
      assert.ok(
        result.warnings.some((w) => w.file === "livros-divulgacao.md" && w.kind === "snippet"),
        `esperava warning kind:snippet para livros-divulgacao.md, achou: ${JSON.stringify(result.warnings)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("manifest AUSENTE (edição pré-#4150) → fallback mtime-puro, guard continua funcionando", () => {
    // Mesma fixture do #4076 original (sem writeSnippetBodyHashManifest) —
    // header-only edit deveria, nesse caso SEM manifest, ainda disparar
    // warning (degrada pro comportamento antigo, não silencia por engano).
    const root = mkdtempSync(join(tmpdir(), "diaria-snippet-staleness-hash-nomanifest-"));
    try {
      const snippetsDir = join(root, "context", "snippets");
      mkdirSync(snippetsDir, { recursive: true });
      const editionDir = join(root, "data", "editions", "990101");
      mkdirSync(editionDir, { recursive: true });
      writeFileSync(
        join(root, "platform.config.json"),
        JSON.stringify({ boxes_divulgacao: { slot1: "livros-divulgacao.md", slot2: null, slot3: null } }),
      );
      writeFileSync(join(snippetsDir, "encerramento-social-apoio.md"), "apoio");
      writeFileSync(join(snippetsDir, "livros-divulgacao.md"), ORIGINAL_CONTENT);
      const mdPath = join(editionDir, "02-reviewed.md");
      writeFileSync(mdPath, REVIEWED_MD_WITH_SLOT1_BOX);
      const oldTime = new Date(Date.now() - 10 * 60_000);
      utimesSync(mdPath, oldTime, oldTime);

      // Header-only edit, SEM manifest gravado (nenhum stitch #4150 rodou).
      const newHeader = "<!--\nnome: Curadoria de Livros\ncategoria: Divulgação\nalt: Prévia\n-->\n\n";
      const snippetPath = join(snippetsDir, "livros-divulgacao.md");
      writeFileSync(snippetPath, newHeader + ORIGINAL_BODY);
      const newTime = new Date();
      utimesSync(snippetPath, newTime, newTime);

      const result = runSnippetStalenessCheck(mdPath, root);
      assert.equal(
        result.ok,
        false,
        "sem manifest, o guard deve preservar o comportamento mtime-puro pré-#4150 (nunca deixar de avisar por falta de dado novo)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
