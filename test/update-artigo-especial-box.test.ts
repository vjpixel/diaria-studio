import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDefaultArtigoEspecialBox,
  applyArtigoEspecialBoxUpdate,
  renderArtigoEspecialBox,
  applyBoxPin,
  ArtigoEspecialBoxFormatError,
  ARTIGO_ESPECIAL_BOX_HEADER,
  type BoxesDivulgacaoConfig,
} from "../scripts/update-artigo-especial-box.ts";

const INPUT = {
  titulo: "Engenharia de ilusão: jailbreak de IA não arromba, encena",
  gancho: "O atacante assume um papel, e o modelo responde fiel à cena",
  mesLabel: "Agosto",
};

describe("buildDefaultArtigoEspecialBox (#5979)", () => {
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
    assert.equal(configAfter.boxes_divulgacao.slot3, "artigo-especial-apoiadores.md");
    assert.deepEqual(configAfter.boxes_divulgacao_auto.pinned_slots, [3]);
  });
});
