import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDefaultArtigoEspecialBox,
  applyArtigoEspecialBoxUpdate,
  renderArtigoEspecialBox,
  applyBoxPin,
  ArtigoEspecialBoxFormatError,
  ARTIGO_ESPECIAL_BOX_HEADER,
  runUpdateArtigoEspecialBox,
  type BoxesDivulgacaoConfig,
} from "../scripts/update-artigo-especial-box.ts";
import { artigoEspecialStatePath, readArtigoEspecialState } from "../scripts/lib/artigo-especial-state.ts";
import { stitchNewsletter } from "../scripts/stitch-newsletter.ts";
import { extractBoxDivulgacao2 } from "../scripts/lib/newsletter-parse.ts";

const INPUT = {
  titulo: "Engenharia de ilusão: jailbreak de IA não arromba, encena",
  gancho: "O atacante assume um papel, e o modelo responde fiel à cena",
  mesLabel: "Agosto",
};

describe("buildDefaultArtigoEspecialBox (#5979)", () => {
  it("#6014 item 4: ctaUrl troca o link do CTA no bootstrap", () => {
    const box = buildDefaultArtigoEspecialBox({
      ...INPUT,
      ctaUrl: "https://apoia.se/diaria/contents/view/Artigo-especial-de-agosto-0QCFIXKq3",
    });
    assert.ok(
      box.includes("[Quero apoiar](https://apoia.se/diaria/contents/view/Artigo-especial-de-agosto-0QCFIXKq3)"),
    );
    assert.ok(!box.includes("[Quero apoiar](https://apoia.se/diaria)"));
  });

  it("#6014 item 4: sem ctaUrl, CTA segue generico (comportamento anterior)", () => {
    const box = buildDefaultArtigoEspecialBox(INPUT);
    assert.ok(box.includes("[Quero apoiar](https://apoia.se/diaria)"));
  });
  it("inclui header, titulo, frase-padrao e paragrafo do tier", () => {
    const box = buildDefaultArtigoEspecialBox(INPUT);
    assert.ok(box.startsWith(ARTIGO_ESPECIAL_BOX_HEADER));
    assert.ok(box.includes("**Artigo Especial de Agosto**"));
    assert.ok(box.includes('O Artigo Especial desse mês é: **"Engenharia de ilusão: jailbreak de IA não arromba, encena"**.'));
    assert.ok(box.includes("O atacante assume um papel, e o modelo responde fiel à cena."));
    assert.ok(box.includes("[Quero apoiar](https://apoia.se/diaria)"));
  });

  it("NUNCA envolve o bloco/frase inteira em ** (so o titulo do artigo, #3373)", () => {
    const box = buildDefaultArtigoEspecialBox(INPUT);
    const quoteLine = box.split("\n").find((l) => l.startsWith("O Artigo Especial"))!;
    // So 1 par de ** dentro da linha (em volta do titulo), nao a linha inteira.
    const boldMatches = quoteLine.match(/\*\*/g) ?? [];
    assert.equal(boldMatches.length, 2);
    assert.ok(!quoteLine.startsWith("**"));
  });

  it("gancho ja terminado em ponto nao vira ponto duplo", () => {
    const box = buildDefaultArtigoEspecialBox({ ...INPUT, gancho: "Frase com ponto." });
    assert.ok(box.includes("Frase com ponto.\n"));
    assert.ok(!box.includes("Frase com ponto..\n"));
  });
});

describe("applyArtigoEspecialBoxUpdate (#5979) — edicao cirurgica", () => {
  it("#6014 item 4: ctaUrl substitui so a URL do CTA, resto intocado", () => {
    const original = buildDefaultArtigoEspecialBox(INPUT);
    const updated = applyArtigoEspecialBoxUpdate(original, {
      ...INPUT,
      ctaUrl: "https://apoia.se/diaria/contents/view/post-setembro",
    });
    assert.ok(updated.includes("[Quero apoiar](https://apoia.se/diaria/contents/view/post-setembro)"));
    assert.ok(!updated.includes("[Quero apoiar](https://apoia.se/diaria)"));
    // Titulo e frase-padrao continuam os do input (nao da chamada anterior).
    assert.ok(updated.includes("**Artigo Especial de Agosto**"));
  });

  const original = buildDefaultArtigoEspecialBox(INPUT);

  it("troca titulo e frase-padrao, preserva paragrafo do tier + CTA", () => {
    const updated = applyArtigoEspecialBoxUpdate(original, {
      titulo: "Outro artigo",
      gancho: "Outro gancho",
      mesLabel: "Setembro",
    });
    assert.ok(updated.includes("**Artigo Especial de Setembro**"));
    assert.ok(updated.includes('O Artigo Especial desse mês é: **"Outro artigo"**. Outro gancho.'));
    assert.ok(!updated.includes("Engenharia de ilusão"));
    // Tier + CTA inalterados.
    assert.ok(updated.includes("Apoiadores Mantenedor e Patrono (R$10+/mês)"));
    assert.ok(updated.includes("[Quero apoiar](https://apoia.se/diaria)"));
    // Header preservado.
    assert.ok(updated.startsWith(ARTIGO_ESPECIAL_BOX_HEADER));
  });

  it("preserva conteudo extra que o editor tenha adicionado manualmente ao redor", () => {
    const withExtra = original + "\n<!-- nota manual do editor -->\n";
    const updated = applyArtigoEspecialBoxUpdate(withExtra, { titulo: "X", gancho: "Y", mesLabel: "Z" });
    assert.ok(updated.includes("<!-- nota manual do editor -->"));
  });

  it("aceita tanto 'desse mes' quanto 'deste mes' na deteccao", () => {
    const desteVariant = original.replace("desse mês", "deste mês");
    const updated = applyArtigoEspecialBoxUpdate(desteVariant, { titulo: "X", gancho: "Y", mesLabel: "Z" });
    assert.ok(updated.includes('O Artigo Especial desse mês é: **"X"**. Y.'));
  });

  it("lanca ArtigoEspecialBoxFormatError se a linha de titulo sumiu (formato divergiu)", () => {
    const broken = original.replace("**Artigo Especial de Agosto**", "Título mudou de formato");
    assert.throws(() => applyArtigoEspecialBoxUpdate(broken, INPUT), ArtigoEspecialBoxFormatError);
  });

  it("lanca ArtigoEspecialBoxFormatError se a frase-padrao sumiu", () => {
    const broken = original.replace(/O Artigo Especial desse mês é:.*$/m, "Texto totalmente diferente.");
    assert.throws(() => applyArtigoEspecialBoxUpdate(broken, INPUT), ArtigoEspecialBoxFormatError);
  });
});

describe("renderArtigoEspecialBox (#5979) — bootstrap vs update", () => {
  it("existingContent null -> usa o template default (bootstrap)", () => {
    const box = renderArtigoEspecialBox(null, INPUT);
    assert.equal(box, buildDefaultArtigoEspecialBox(INPUT));
  });

  it("existingContent presente -> edicao cirurgica", () => {
    const original = buildDefaultArtigoEspecialBox(INPUT);
    const updated = renderArtigoEspecialBox(original, { titulo: "Novo", gancho: "G", mesLabel: "Out" });
    assert.ok(updated.includes("**Artigo Especial de Out**"));
  });
});

describe("applyBoxPin (#5979)", () => {
  const base: BoxesDivulgacaoConfig = {
    boxes_divulgacao: { slot1: "recomendacao-leitura.md", slot2: "livros-divulgacao.md", slot3: "apoio-divulgacao.md" },
    boxes_divulgacao_auto: { enabled: true, pinned_slots: [] },
  };

  it("pin: seta slot3 e adiciona 3 a pinned_slots", () => {
    const next = applyBoxPin(base, { slot: 3, filename: "artigo-especial-apoiadores.md", pin: true });
    assert.equal(next.boxes_divulgacao!.slot3, "artigo-especial-apoiadores.md");
    assert.deepEqual(next.boxes_divulgacao_auto!.pinned_slots, [3]);
    // slot1/slot2 preservados.
    assert.equal(next.boxes_divulgacao!.slot1, "recomendacao-leitura.md");
  });

  it("pin e idempotente (rodar 2x nao duplica em pinned_slots)", () => {
    const once = applyBoxPin(base, { slot: 3, filename: "artigo-especial-apoiadores.md", pin: true });
    const twice = applyBoxPin(once, { slot: 3, filename: "artigo-especial-apoiadores.md", pin: true });
    assert.deepEqual(twice.boxes_divulgacao_auto!.pinned_slots, [3]);
  });

  it("pin preserva outros slots ja pinados (ex: slot1)", () => {
    const withSlot1Pinned: BoxesDivulgacaoConfig = {
      ...base,
      boxes_divulgacao_auto: { enabled: true, pinned_slots: [1] },
    };
    const next = applyBoxPin(withSlot1Pinned, { slot: 3, filename: "artigo-especial-apoiadores.md", pin: true });
    assert.deepEqual(next.boxes_divulgacao_auto!.pinned_slots, [1, 3]);
  });

  it("--unpin remove so o slot informado de pinned_slots, sem tocar boxes_divulgacao.slot3", () => {
    const pinned: BoxesDivulgacaoConfig = {
      boxes_divulgacao: { slot3: "artigo-especial-apoiadores.md" },
      boxes_divulgacao_auto: { enabled: true, pinned_slots: [1, 3] },
    };
    const next = applyBoxPin(pinned, { slot: 3, filename: "artigo-especial-apoiadores.md", pin: false });
    assert.deepEqual(next.boxes_divulgacao_auto!.pinned_slots, [1]);
    assert.equal(next.boxes_divulgacao!.slot3, "artigo-especial-apoiadores.md");
  });

  it("unpin de slot ja nao-pinado e no-op seguro", () => {
    const next = applyBoxPin(base, { slot: 3, filename: "artigo-especial-apoiadores.md", pin: false });
    assert.deepEqual(next.boxes_divulgacao_auto!.pinned_slots, []);
  });

  it("nao muta o config original (imutavel)", () => {
    const before = JSON.stringify(base);
    applyBoxPin(base, { slot: 3, filename: "artigo-especial-apoiadores.md", pin: true });
    assert.equal(JSON.stringify(base), before);
  });

  it("config sem boxes_divulgacao_auto previo -> pin cria a estrutura", () => {
    const bare: BoxesDivulgacaoConfig = {};
    const next = applyBoxPin(bare, { slot: 3, filename: "artigo-especial-apoiadores.md", pin: true });
    assert.deepEqual(next.boxes_divulgacao_auto!.pinned_slots, [3]);
    assert.equal(next.boxes_divulgacao!.slot3, "artigo-especial-apoiadores.md");
  });
});

describe("update-artigo-especial-box.ts CLI (--dry-run, integração leve)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "artigo-especial-box-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("--dry-run nao escreve nenhum arquivo", async () => {
    const snippetsFile = join(dir, "artigo-especial-apoiadores.md");
    const configPath = join(dir, "platform.config.json");
    writeFileSync(configPath, JSON.stringify({ boxes_divulgacao_auto: { pinned_slots: [] } }), "utf8");

    const { spawnSync } = await import("node:child_process");
    const scriptPath = join(import.meta.dirname, "..", "scripts", "update-artigo-especial-box.ts");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--titulo",
        "T",
        "--gancho",
        "G",
        "--mes",
        "Agosto",
        "--snippets-file",
        snippetsFile,
        "--config",
        configPath,
        "--dry-run",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(snippetsFile));
    const configAfter = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(configAfter, { boxes_divulgacao_auto: { pinned_slots: [] } });
  });

  it("sem --dry-run: escreve o snippet (bootstrap) e atualiza o config", async () => {
    const snippetsFile = join(dir, "artigo-especial-apoiadores.md");
    const configPath = join(dir, "platform.config.json");
    writeFileSync(configPath, JSON.stringify({ boxes_divulgacao_auto: { pinned_slots: [] } }), "utf8");

    const { spawnSync } = await import("node:child_process");
    const scriptPath = join(import.meta.dirname, "..", "scripts", "update-artigo-especial-box.ts");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--titulo",
        "T",
        "--gancho",
        "G",
        "--mes",
        "Agosto",
        "--snippets-file",
        snippetsFile,
        "--config",
        configPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(snippetsFile));
    assert.ok(readFileSync(snippetsFile, "utf8").includes("**Artigo Especial de Agosto**"));
    const configAfter = JSON.parse(readFileSync(configPath, "utf8"));
    // #6748: default de --slot mudou de 3 (eliminado) para 2.
    assert.equal(configAfter.boxes_divulgacao.slot2, "artigo-especial-apoiadores.md");
    assert.deepEqual(configAfter.boxes_divulgacao_auto.pinned_slots, [2]);
  });
});

// #5979 review, PR #6000 (silent-failure-hunter finding #7): o canal "box"
// estava listado em ARTIGO_ESPECIAL_CHANNELS e documentado como coberto,
// mas nada no script chamava o state module — o guard só existia no papel.
describe("runUpdateArtigoEspecialBox — guard de idempotencia do canal 'box' (#5979 review, PR #6000)", () => {
  let dir: string;
  let dataDir: string;
  let snippetsFile: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "artigo-especial-box-state-"));
    dataDir = join(dir, "data");
    snippetsFile = join(dir, "artigo-especial-apoiadores.md");
    configPath = join(dir, "platform.config.json");
    writeFileSync(configPath, JSON.stringify({ boxes_divulgacao_auto: { pinned_slots: [] } }), "utf8");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("com --ano/--slug: 1a execucao grava canal 'box' como done em published.json", () => {
    const result = runUpdateArtigoEspecialBox({
      ...INPUT,
      snippetsFile,
      configPath,
      dataDir,
      slot: 3,
      pin: true,
      dryRun: false,
      force: false,
      ano: "2026",
      slug: "x",
    });
    assert.equal(result.action, "updated");
    const statePath = artigoEspecialStatePath(dataDir, "2026", "x");
    const state = readArtigoEspecialState(statePath, "2026", "x");
    assert.equal(state.channels.box?.status, "done");
  });

  it("2a execucao sem --force: pula (skipped), nao reescreve snippet/config", () => {
    runUpdateArtigoEspecialBox({ ...INPUT, snippetsFile, configPath, dataDir, slot: 3, pin: true, dryRun: false, force: false, ano: "2026", slug: "x" });
    const snippetAfterFirst = readFileSync(snippetsFile, "utf8");
    const configAfterFirst = readFileSync(configPath, "utf8");

    const result = runUpdateArtigoEspecialBox({
      ...INPUT,
      titulo: "Outro titulo — nao deveria aparecer",
      snippetsFile,
      configPath,
      dataDir,
      slot: 3,
      pin: true,
      dryRun: false,
      force: false,
      ano: "2026",
      slug: "x",
    });
    assert.equal(result.action, "skipped");
    assert.equal(readFileSync(snippetsFile, "utf8"), snippetAfterFirst);
    assert.equal(readFileSync(configPath, "utf8"), configAfterFirst);
  });

  it("--force reexecuta um canal 'box' ja done", () => {
    runUpdateArtigoEspecialBox({ ...INPUT, snippetsFile, configPath, dataDir, slot: 3, pin: true, dryRun: false, force: false, ano: "2026", slug: "x" });
    const result = runUpdateArtigoEspecialBox({
      ...INPUT,
      titulo: "Titulo atualizado",
      snippetsFile,
      configPath,
      dataDir,
      slot: 3,
      pin: true,
      dryRun: false,
      force: true,
      ano: "2026",
      slug: "x",
    });
    assert.equal(result.action, "updated");
    assert.ok(readFileSync(snippetsFile, "utf8").includes("Titulo atualizado"));
  });

  it("#6000 fleet review: só --ano OU só --slug (não os 2) -> lança, não desliga o guard em silêncio", () => {
    assert.throws(
      () => runUpdateArtigoEspecialBox({ ...INPUT, snippetsFile, configPath, dataDir, slot: 3, pin: true, dryRun: false, force: false, ano: "2026" }),
      /devem ser passados JUNTOS/,
    );
    assert.throws(
      () => runUpdateArtigoEspecialBox({ ...INPUT, snippetsFile, configPath, dataDir, slot: 3, pin: true, dryRun: false, force: false, slug: "x" }),
      /devem ser passados JUNTOS/,
    );
  });

  it("sem --ano/--slug: guard inteiro desligado, sempre executa, sem tocar published.json (compat com --unpin standalone)", () => {
    const r1 = runUpdateArtigoEspecialBox({ ...INPUT, snippetsFile, configPath, dataDir, slot: 3, pin: true, dryRun: false, force: false });
    const r2 = runUpdateArtigoEspecialBox({ ...INPUT, snippetsFile, configPath, dataDir, slot: 3, pin: true, dryRun: false, force: false });
    assert.equal(r1.action, "updated");
    assert.equal(r2.action, "updated"); // nunca "skipped" sem ano/slug
    assert.ok(!existsSync(join(dataDir, "artigo-especial")));
  });

  it("--dry-run com --ano/--slug: NAO grava published.json mesmo quando o canal ainda nao foi tentado", () => {
    const result = runUpdateArtigoEspecialBox({ ...INPUT, snippetsFile, configPath, dataDir, slot: 3, pin: true, dryRun: true, force: false, ano: "2026", slug: "x" });
    assert.equal(result.action, "dry-run");
    assert.ok(!existsSync(join(dataDir, "artigo-especial")));
  });

  it("formato divergido: applyArtigoEspecialBoxUpdate lanca -> canal grava 'failed', erro propaga (nao engole)", () => {
    // Bootstrap valido primeiro, depois corrompe o arquivo pra forcar o
    // ArtigoEspecialBoxFormatError no 2o reuso (com --force, canal ja done).
    runUpdateArtigoEspecialBox({ ...INPUT, snippetsFile, configPath, dataDir, slot: 3, pin: true, dryRun: false, force: false, ano: "2026", slug: "y" });
    writeFileSync(snippetsFile, "conteudo totalmente fora da convencao, sem titulo nem frase-padrao", "utf8");

    assert.throws(
      () =>
        runUpdateArtigoEspecialBox({
          ...INPUT,
          snippetsFile,
          configPath,
          dataDir,
          slot: 3,
          pin: true,
          dryRun: false,
          force: true,
          ano: "2026",
          slug: "y",
        }),
      ArtigoEspecialBoxFormatError,
    );

    const statePath = artigoEspecialStatePath(dataDir, "2026", "y");
    const state = readArtigoEspecialState(statePath, "2026", "y");
    assert.equal(state.channels.box?.status, "failed");
  });
});

describe("#6748 self-review (alta confiança): pin do box de fato RENDERIZA na newsletter, cross-módulo com stitch-newsletter.ts", () => {
  // O gap que motivou este describe: os testes de `applyBoxPin` acima só
  // provam que a ESCRITA em platform.config.json está correta — nunca que o
  // valor escrito produz efeito real na edição. Antes do #6748, pinar em
  // slot3 (default antigo) já não teria efeito nenhum (slot3 eliminado), e
  // nenhum teste pegava isso porque nenhum teste ia até `stitchNewsletter`.
  // readSnippetFile (scripts/lib/shared/snippet-loader.ts) resolve
  // `{rootDir}/data/snippets/{filename}` — `snippetsRootDir` do stitch é a
  // RAIZ (equivalente a `ROOT`), não o diretório de snippets em si.
  function setupSnippet(dir: string): string {
    const snippetsDir = join(dir, "data", "snippets");
    mkdirSync(snippetsDir, { recursive: true });
    const box = buildDefaultArtigoEspecialBox({ ...INPUT, ctaUrl: "https://apoia.se/diaria" });
    writeFileSync(join(snippetsDir, "artigo-especial-apoiadores.md"), box, "utf8");
    return dir;
  }

  function setup3Destaques(dir: string) {
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(join(internalDir, "02-d1-draft.md"), "**DESTAQUE 1 | 🚀**\n\n[**T1**](https://e.com/d1)\n\nbody1");
    writeFileSync(join(internalDir, "02-d2-draft.md"), "**DESTAQUE 2 | 🔬**\n\n[**T2**](https://e.com/d2)\n\nbody2");
    writeFileSync(join(internalDir, "02-d3-draft.md"), "**DESTAQUE 3 | ⚖️**\n\n[**T3**](https://e.com/d3)\n\nbody3");
    writeFileSync(join(internalDir, "01-approved-capped.json"), JSON.stringify({ coverage: { line: "cov" } }));
    return internalDir;
  }

  it("default do CLI (--slot omitido = 2, #6748) pinado via applyBoxPin: o box do Artigo Especial aparece de fato no output de stitchNewsletter (edição de 3 destaques)", () => {
    const dir = mkdtempSync(join(tmpdir(), "artigo-especial-render-"));
    try {
      const snippetsDir = setupSnippet(dir);
      const internalDir = setup3Destaques(dir);

      const pinnedConfig = applyBoxPin(
        { boxes_divulgacao: { slot1: null, slot2: null }, boxes_divulgacao_auto: { enabled: true, pinned_slots: [] } },
        { slot: 2, filename: "artigo-especial-apoiadores.md", pin: true },
      );

      const out = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
        snippetsRootDir: snippetsDir,
        boxesDivulgacao: {
          slot1: pinnedConfig.boxes_divulgacao!.slot1 ?? null,
          slot2: pinnedConfig.boxes_divulgacao!.slot2 ?? null,
        },
      });

      const box = extractBoxDivulgacao2(out);
      assert.ok(box, "o box do Artigo Especial deve aparecer no slot2 (D2/D3) quando pinado, edição de 3 destaques");
      assert.match(box!, /Engenharia de ilusão/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("documenta o trade-off aceito no #6748: em edição de 2 destaques (sem D3), o box pinado em slot2 NÃO aparece — diferente do antigo slot3", () => {
    const dir = mkdtempSync(join(tmpdir(), "artigo-especial-render-2d-"));
    try {
      const snippetsDir = setupSnippet(dir);
      const internalDir = join(dir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(internalDir, "02-d1-draft.md"), "**DESTAQUE 1 | 🚀**\n\n[**T1**](https://e.com/d1)\n\nbody1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "**DESTAQUE 2 | 🔬**\n\n[**T2**](https://e.com/d2)\n\nbody2");
      writeFileSync(join(internalDir, "01-approved-capped.json"), JSON.stringify({ coverage: { line: "cov" }, highlights: [{}, {}] }));

      const pinnedConfig = applyBoxPin(
        { boxes_divulgacao: { slot1: null, slot2: null }, boxes_divulgacao_auto: { enabled: true, pinned_slots: [] } },
        { slot: 2, filename: "artigo-especial-apoiadores.md", pin: true },
      );

      const out = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: null,
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
        snippetsRootDir: snippetsDir,
        boxesDivulgacao: {
          slot1: pinnedConfig.boxes_divulgacao!.slot1 ?? null,
          slot2: pinnedConfig.boxes_divulgacao!.slot2 ?? null,
        },
      });

      assert.equal(extractBoxDivulgacao2(out), null, "slot2 exige D3 — trade-off documentado no #6748/SKILL.md");
      assert.doesNotMatch(out, /Engenharia de ilusão/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
