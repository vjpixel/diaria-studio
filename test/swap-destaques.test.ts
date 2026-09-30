/**
 * test/swap-destaques.test.ts (#8995)
 *
 * Cobre o cenário real da issue: o editor pede a troca de destaque(s) por
 * URL NOVA (fora de qualquer bucket de `01-approved.json`) — o gap que
 * `swap-destaque.ts` (#2499) não cobre, porque exige `bucket:idx` de um
 * item já presente no pool.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManualHighlight,
  swapManualInApprovedJson,
  parseSwapDestaquesArgs,
  buildSwapNextSteps,
} from "../scripts/swap-destaques.ts";
import { checkSocialHashFresh } from "../scripts/lib/invariant-checks/stage-4.ts";
import { hashFromApprovedFile, writeSocialSourceHash } from "../scripts/lib/social-source-hash.ts";
import { refreshSocialHash } from "../scripts/refresh-social-hash.ts";

const HIGHLIGHT_D1 = {
  rank: 1,
  score: 90,
  bucket: "lancamento",
  url: "https://example.com/d1",
  title_options: ["Título D1"],
};
const HIGHLIGHT_D2 = {
  rank: 2,
  score: 80,
  bucket: "radar",
  url: "https://example.com/d2",
  title_options: ["Título D2"],
};
const HIGHLIGHT_D3 = {
  rank: 3,
  score: 70,
  bucket: "radar",
  url: "https://example.com/d3",
  title_options: ["Título D3"],
};

function baseApproved(): Record<string, unknown> {
  return {
    highlights: [
      { ...HIGHLIGHT_D1 },
      { ...HIGHLIGHT_D2 },
      { ...HIGHLIGHT_D3 },
    ],
    radar: [{ url: "https://example.com/radar-0", title: "Item RADAR 0" }],
    lancamento: [],
    use_melhor: [],
    video: [],
    runners_up: [],
  };
}

function makeReviewedMd(): string {
  return `---
intentional_error:
  location: "DESTAQUE 2, parágrafo 1"
  category: factual
  description: "Erro de teste"
  correct_value: "valor correto"
---

Intro texto.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Artigo D1](https://example.com/d1)**

Texto do destaque 1. Por que isso importa: relevância 1.

---

**DESTAQUE 2 | 📡 RADAR**

**[Artigo D2](https://example.com/d2)**

Texto do destaque 2. Por que isso importa: relevância 2.

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[Artigo D3](https://example.com/d3)**

Texto do destaque 3. Por que isso importa: relevância 3.

---

**📡 RADAR**

[Link radar](https://example.com/r)

Descrição radar.
`;
}

function makeTempEdition(opts: {
  withMd?: boolean;
  withImages?: boolean;
  withPrompts?: boolean;
  withCapped?: boolean;
  customApproved?: Record<string, unknown>;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "swap-destaques-"));
  const internalDir = join(dir, "_internal");
  mkdirSync(internalDir, { recursive: true });

  const approved = opts.customApproved ?? baseApproved();
  writeFileSync(join(internalDir, "01-approved.json"), JSON.stringify(approved, null, 2));

  if (opts.withCapped !== false) {
    const capped = { ...approved, highlights: (approved.highlights as unknown[]).slice() };
    writeFileSync(join(internalDir, "01-approved-capped.json"), JSON.stringify(capped, null, 2));
  }

  if (opts.withMd) {
    writeFileSync(join(dir, "02-reviewed.md"), makeReviewedMd());
  }

  if (opts.withImages) {
    writeFileSync(join(dir, "04-d1-2x1.jpg"), "img-d1-2x1");
    writeFileSync(join(dir, "04-d2-1x1.jpg"), "img-d2-1x1");
    writeFileSync(join(dir, "04-d3-1x1.jpg"), "img-d3-1x1");
  }

  if (opts.withPrompts) {
    writeFileSync(join(internalDir, "02-d1-prompt.md"), "Prompt d1.");
    writeFileSync(join(internalDir, "02-d2-prompt.md"), "Prompt d2.");
  }

  return dir;
}

// ---------------------------------------------------------------------------
// buildManualHighlight
// ---------------------------------------------------------------------------

describe("buildManualHighlight (#8995)", () => {
  it("produz um highlight mínimo com o shape esperado", () => {
    const h = buildManualHighlight("https://x.com/a", "Título X", 1);
    assert.equal(h.rank, 1);
    assert.equal(h.score, null);
    assert.equal(h.bucket, "manual");
    assert.equal(h.url, "https://x.com/a");
    assert.deepEqual(h.article, {
      url: "https://x.com/a",
      title: "Título X",
      title_options: ["Título X"],
      score: null,
    });
  });
});

// ---------------------------------------------------------------------------
// swapManualInApprovedJson
// ---------------------------------------------------------------------------

describe("swapManualInApprovedJson (#8995)", () => {
  it("troca 1 destaque por URL nova e devolve o antigo ao radar[0]", () => {
    const data = baseApproved();
    const result = swapManualInApprovedJson(
      data,
      [{ position: 1, url: "https://novo.com/x", title: "Título Novo" }],
      false,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.demoted[0].url, "https://example.com/d1");

    const highlights = data.highlights as Record<string, unknown>[];
    assert.equal(highlights[0].url, "https://novo.com/x");
    assert.equal(highlights[1].url, "https://example.com/d2"); // intocado
    assert.equal(highlights[2].url, "https://example.com/d3"); // intocado

    const radar = data.radar as Record<string, unknown>[];
    assert.equal(radar[0].url, "https://example.com/d1");
    assert.equal(radar.length, 2); // item original + demovido
  });

  it("troca 2 destaques na mesma chamada", () => {
    const data = baseApproved();
    const result = swapManualInApprovedJson(
      data,
      [
        { position: 1, url: "https://novo.com/x", title: "X" },
        { position: 2, url: "https://novo.com/y", title: "Y" },
      ],
      false,
    );
    assert.equal(result.ok, true);
    const highlights = data.highlights as Record<string, unknown>[];
    assert.equal(highlights[0].url, "https://novo.com/x");
    assert.equal(highlights[1].url, "https://novo.com/y");
    assert.equal(highlights[2].url, "https://example.com/d3");
  });

  it("--drop descarta o destaque substituído em vez de devolver ao radar", () => {
    const data = baseApproved();
    swapManualInApprovedJson(
      data,
      [{ position: 3, url: "https://novo.com/z", title: "Z" }],
      true,
    );
    const radar = data.radar as Record<string, unknown>[];
    assert.equal(radar.length, 1); // só o item original, nada adicionado
  });

  it("aceita posição válida (edição com 3 destaques, slot 3 pedido)", () => {
    const data = baseApproved();
    const result = swapManualInApprovedJson(
      data,
      [{ position: 3, url: "https://novo.com/z", title: "Z" }],
      false,
    );
    assert.equal(result.ok, true);
  });

  it("rejeita posição além do tamanho de highlights[]", () => {
    const data2: Record<string, unknown> = { highlights: [HIGHLIGHT_D1] };
    const result2 = swapManualInApprovedJson(
      data2,
      [{ position: 2, url: "https://novo.com/z", title: "Z" }],
      false,
    );
    assert.equal(result2.ok, false);
  });

  it("rejeita quando highlights[] está ausente", () => {
    const result = swapManualInApprovedJson(
      { highlights: undefined },
      [{ position: 1, url: "https://novo.com/z", title: "Z" }],
      false,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /highlights\[\] ausente/);
  });

  it("rejeita título vazio", () => {
    const data = baseApproved();
    const result = swapManualInApprovedJson(
      data,
      [{ position: 1, url: "https://novo.com/x", title: "" }],
      false,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /--title vazio/);
  });

  it("rejeita a mesma URL nova pedida em 2 slots diferentes", () => {
    const data = baseApproved();
    const result = swapManualInApprovedJson(
      data,
      [
        { position: 1, url: "https://novo.com/mesma", title: "X" },
        { position: 2, url: "https://novo.com/mesma", title: "Y" },
      ],
      false,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /mais de um slot/);
  });

  it("troca os 3 destaques na mesma chamada", () => {
    const data = baseApproved();
    const result = swapManualInApprovedJson(
      data,
      [
        { position: 1, url: "https://novo.com/a", title: "A" },
        { position: 2, url: "https://novo.com/b", title: "B" },
        { position: 3, url: "https://novo.com/c", title: "C" },
      ],
      false,
    );
    assert.equal(result.ok, true);
    const highlights = data.highlights as Record<string, unknown>[];
    assert.deepEqual(
      highlights.map((h) => h.url),
      ["https://novo.com/a", "https://novo.com/b", "https://novo.com/c"],
    );
    const radar = data.radar as Record<string, unknown>[];
    assert.equal(radar.length, 1 + 3); // original + 3 demovidos
  });

  it("rejeita URL que já é destaque na edição", () => {
    const data = baseApproved();
    const result = swapManualInApprovedJson(
      data,
      [{ position: 1, url: "https://example.com/d2", title: "Duplicado" }],
      false,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /já é destaque/);
  });

  it("rejeita posições repetidas entre slots", () => {
    const data = baseApproved();
    const result = swapManualInApprovedJson(
      data,
      [
        { position: 1, url: "https://novo.com/x", title: "X" },
        { position: 1, url: "https://novo.com/w", title: "W" },
      ],
      false,
    );
    assert.equal(result.ok, false);
  });

  it("não muta highlights[] quando a validação falha (nenhum efeito parcial)", () => {
    const data = baseApproved();
    const before = JSON.stringify(data.highlights);
    swapManualInApprovedJson(
      data,
      [{ position: 1, url: "https://example.com/d2", title: "Duplicado" }],
      false,
    );
    assert.equal(JSON.stringify(data.highlights), before);
  });
});

// ---------------------------------------------------------------------------
// parseSwapDestaquesArgs
// ---------------------------------------------------------------------------

describe("parseSwapDestaquesArgs (#8995)", () => {
  it("parseia 1 slot", () => {
    const args = parseSwapDestaquesArgs([
      "--edition",
      "260929",
      "--edition-dir",
      "/tmp/fake",
      "--d1-url",
      "https://x.com",
      "--d1-title",
      "Título",
    ]);
    assert.equal(args.edition, "260929");
    assert.deepEqual(args.slots, [{ position: 1, url: "https://x.com", title: "Título" }]);
    assert.equal(args.drop, false);
  });

  it("parseia 2 slots + --drop", () => {
    const args = parseSwapDestaquesArgs([
      "--edition",
      "260929",
      "--edition-dir",
      "/tmp/fake",
      "--d1-url",
      "https://x.com",
      "--d1-title",
      "X",
      "--d2-url",
      "https://y.com",
      "--d2-title",
      "Y",
      "--drop",
    ]);
    assert.equal(args.slots.length, 2);
    assert.equal(args.drop, true);
  });
});

// ---------------------------------------------------------------------------
// Integração: CLI end-to-end (dry-run e execução real) via subprocess
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = pathResolve(ROOT, "scripts", "swap-destaques.ts");

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", SCRIPT, ...args], {
      encoding: "utf8",
      cwd: ROOT,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", status: err.status ?? 1 };
  }
}

describe("swap-destaques.ts CLI (#8995)", () => {
  it("dry-run não escreve nada em disco", () => {
    const dir = makeTempEdition({ withMd: true, withImages: true, withPrompts: true });
    try {
      const approvedBefore = readFileSync(join(dir, "_internal", "01-approved.json"), "utf8");
      const { status, stdout } = runCli([
        "--edition",
        "260929",
        "--edition-dir",
        dir,
        "--d1-url",
        "https://novo.com/x",
        "--d1-title",
        "Título Novo",
        "--dry-run",
      ]);
      assert.equal(status, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.dry_run, true);
      assert.equal(parsed.swapped[0].promoted.url, "https://novo.com/x");
      assert.equal(parsed.swapped[0].demoted.url, "https://example.com/d1");
      const approvedAfter = readFileSync(join(dir, "_internal", "01-approved.json"), "utf8");
      assert.equal(approvedAfter, approvedBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("execução real aplica o swap em 01-approved.json, capped, md e limpa imagens/prompts", () => {
    const dir = makeTempEdition({ withMd: true, withImages: true, withPrompts: true });
    try {
      const { status } = runCli([
        "--edition",
        "260929",
        "--edition-dir",
        dir,
        "--d2-url",
        "https://novo.com/y",
        "--d2-title",
        "Título Y",
      ]);
      assert.equal(status, 0);

      const approved = JSON.parse(
        readFileSync(join(dir, "_internal", "01-approved.json"), "utf8"),
      );
      assert.equal(approved.highlights[1].url, "https://novo.com/y");
      assert.equal(approved.highlights[1].bucket, "manual");
      assert.equal(approved.highlights[0].url, "https://example.com/d1"); // intocado
      assert.ok(
        (approved.radar as Record<string, unknown>[]).some(
          (r) => r.url === "https://example.com/d2",
        ),
        "destaque substituído deve voltar ao radar",
      );

      const capped = JSON.parse(
        readFileSync(join(dir, "_internal", "01-approved-capped.json"), "utf8"),
      );
      assert.equal(capped.highlights[1].url, "https://novo.com/y");

      // #9149: o swap NÃO grava .social-source-hash.json (o social ainda é o antigo).
      assert.ok(!existsSync(join(dir, "_internal", ".social-source-hash.json")));

      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.match(md, /RASCUNHO PENDENTE — swap-destaque/);
      assert.match(md, /Título Y/);

      // imagens/prompts do slot trocado (d2) removidos; d1/d3 intocados
      assert.ok(!existsSync(join(dir, "04-d2-1x1.jpg")));
      assert.ok(existsSync(join(dir, "04-d1-2x1.jpg")));
      assert.ok(existsSync(join(dir, "04-d3-1x1.jpg")));
      assert.ok(!existsSync(join(dir, "_internal", "02-d2-prompt.md")));
      assert.ok(existsSync(join(dir, "_internal", "02-d1-prompt.md")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa quando a URL já é destaque na edição (exit != 0, nada escrito)", () => {
    const dir = makeTempEdition({});
    try {
      const before = readFileSync(join(dir, "_internal", "01-approved.json"), "utf8");
      const { status } = runCli([
        "--edition",
        "260929",
        "--edition-dir",
        dir,
        "--d1-url",
        "https://example.com/d2",
        "--d1-title",
        "Duplicado",
      ]);
      assert.notEqual(status, 0);
      const after = readFileSync(join(dir, "_internal", "01-approved.json"), "utf8");
      assert.equal(after, before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa quando --edition-dir não existe", () => {
    const { status, stderr } = runCli([
      "--edition",
      "260929",
      "--edition-dir",
      "/tmp/nao-existe-swap-destaques-8995",
      "--d1-url",
      "https://novo.com/x",
      "--d1-title",
      "X",
    ]);
    assert.notEqual(status, 0);
    assert.match(stderr, /não encontrado/);
  });

  it("recusa quando 01-approved.json está ausente", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-destaques-noapproved-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const { status, stderr } = runCli([
        "--edition",
        "260929",
        "--edition-dir",
        dir,
        "--d1-url",
        "https://novo.com/x",
        "--d1-title",
        "X",
      ]);
      assert.notEqual(status, 0);
      assert.match(stderr, /01-approved\.json não encontrado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa quando 01-approved.json está malformado (JSON inválido)", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-destaques-badjson-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "01-approved.json"), "{ isto não é json");
      const { status, stderr } = runCli([
        "--edition",
        "260929",
        "--edition-dir",
        dir,
        "--d1-url",
        "https://novo.com/x",
        "--d1-title",
        "X",
      ]);
      assert.notEqual(status, 0);
      assert.match(stderr, /Erro ao parsear/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("01-approved-capped.json ausente: swap aplica normalmente, sem tentar reescrevê-lo", () => {
    const dir = makeTempEdition({ withCapped: false });
    try {
      const { status, stdout } = runCli([
        "--edition",
        "260929",
        "--edition-dir",
        dir,
        "--d1-url",
        "https://novo.com/x",
        "--d1-title",
        "X",
      ]);
      assert.equal(status, 0);
      const parsed = JSON.parse(stdout);
      assert.ok(!existsSync(join(dir, "_internal", "01-approved-capped.json")));
      assert.ok(
        !parsed.modified.rewritten.some((p: string) => p.includes("01-approved-capped.json")),
      );
      assert.deepEqual(parsed.warnings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("01-approved-capped.json com highlights[] curto demais: warning estruturado, aprovado.json ainda aplicado", () => {
    const dir = makeTempEdition({ withCapped: false });
    try {
      // capped com só 1 highlight — slot 2 pedido não cabe lá
      writeFileSync(
        join(dir, "_internal", "01-approved-capped.json"),
        JSON.stringify({ highlights: [HIGHLIGHT_D1], radar: [] }, null, 2),
      );
      const { status, stdout } = runCli([
        "--edition",
        "260929",
        "--edition-dir",
        dir,
        "--d2-url",
        "https://novo.com/y",
        "--d2-title",
        "Y",
      ]);
      assert.equal(status, 0);
      const parsed = JSON.parse(stdout);
      assert.ok(
        parsed.warnings.some((w: string) => w.includes("01-approved-capped.json não sincronizado")),
      );
      const approved = JSON.parse(readFileSync(join(dir, "_internal", "01-approved.json"), "utf8"));
      assert.equal(approved.highlights[1].url, "https://novo.com/y");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("02-reviewed.md ausente: swap aplica normalmente, sem tentar reescrevê-lo", () => {
    const dir = makeTempEdition({ withMd: false });
    try {
      const { status, stdout } = runCli([
        "--edition",
        "260929",
        "--edition-dir",
        dir,
        "--d1-url",
        "https://novo.com/x",
        "--d1-title",
        "X",
      ]);
      assert.equal(status, 0);
      const parsed = JSON.parse(stdout);
      assert.ok(!existsSync(join(dir, "02-reviewed.md")));
      assert.ok(!parsed.modified.rewritten.some((p: string) => p.endsWith("02-reviewed.md")));
      assert.deepEqual(parsed.warnings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("02-reviewed.md sem os separadores esperados: warning estruturado, JSONs ainda aplicados", () => {
    const dir = makeTempEdition({ withMd: false });
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "Texto qualquer sem blocos DESTAQUE.");
      const { status, stdout } = runCli([
        "--edition",
        "260929",
        "--edition-dir",
        dir,
        "--d1-url",
        "https://novo.com/x",
        "--d1-title",
        "X",
      ]);
      assert.equal(status, 0);
      const parsed = JSON.parse(stdout);
      assert.ok(
        parsed.warnings.some((w: string) => w.includes("bloco DESTAQUE 1 não encontrado")),
      );
      assert.ok(!parsed.modified.rewritten.some((p: string) => p.endsWith("02-reviewed.md")));
      const approved = JSON.parse(readFileSync(join(dir, "_internal", "01-approved.json"), "utf8"));
      assert.equal(approved.highlights[0].url, "https://novo.com/x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--d1-url sem --d1-title correspondente é rejeitado", () => {
    const dir = makeTempEdition({});
    try {
      const { status, stderr } = runCli([
        "--edition",
        "260929",
        "--edition-dir",
        dir,
        "--d1-url",
        "https://novo.com/x",
      ]);
      assert.notEqual(status, 0);
      assert.match(stderr, /precisam vir juntos/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("troca os 3 slots numa chamada CLI só", () => {
    const dir = makeTempEdition({});
    try {
      const { status } = runCli([
        "--edition",
        "260929",
        "--edition-dir",
        dir,
        "--d1-url",
        "https://novo.com/a",
        "--d1-title",
        "A",
        "--d2-url",
        "https://novo.com/b",
        "--d2-title",
        "B",
        "--d3-url",
        "https://novo.com/c",
        "--d3-title",
        "C",
      ]);
      assert.equal(status, 0);
      const approved = JSON.parse(readFileSync(join(dir, "_internal", "01-approved.json"), "utf8"));
      assert.deepEqual(
        (approved.highlights as Record<string, unknown>[]).map((h) => h.url),
        ["https://novo.com/a", "https://novo.com/b", "https://novo.com/c"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #9149: hash social compatível com o check do Stage 4 + refresh de fontes
// ---------------------------------------------------------------------------

describe("swap-destaques.ts × social-hash-fresh (#9149)", () => {
  it("não recarimba o hash no swap (guard do #1413 segue armado) e refresh-social-hash depois do splice faz o check passar", () => {
    const dir = makeTempEdition({ withMd: true });
    const internalDir = join(dir, "_internal");
    try {
      // Estado pré-swap: social gerado e carimbado pela lib (como o merge-social-md faz).
      writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\nTexto d1 antigo.\n");
      writeSocialSourceHash(internalDir, hashFromApprovedFile(join(internalDir, "01-approved.json")));
      const hashBefore = readFileSync(join(internalDir, ".social-source-hash.json"), "utf8");
      assert.deepEqual(checkSocialHashFresh(dir), []);

      const { status } = runCli([
        "--edition", "260929", "--edition-dir", dir,
        "--d1-url", "https://novo.com/x", "--d1-title", "Título Novo",
      ]);
      assert.equal(status, 0);

      // Hash intocado: o 03-social.md ainda descreve o D1 antigo, o check TEM que acusar.
      assert.equal(readFileSync(join(internalDir, ".social-source-hash.json"), "utf8"), hashBefore);
      const stale = checkSocialHashFresh(dir);
      assert.equal(stale.length, 1);
      assert.equal(stale[0].rule, "social-hash-fresh");
      assert.equal(stale[0].severity, "error");

      // Após o splice do social, o recarimbo do next_steps destrava o check.
      refreshSocialHash(dir);
      assert.deepEqual(checkSocialHashFresh(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("next_steps começa pelo refresh-destaque-sources (#9102) e recarimba o hash só depois do splice do social", () => {
    const steps = buildSwapNextSteps("/ed/260929", [
      { position: 1, url: "https://novo.com/x", title: "X" },
      { position: 3, url: "https://novo.com/z", title: "Z" },
    ]);
    assert.match(steps[0], /refresh-destaque-sources\.ts --edition-dir \/ed\/260929\//);
    const iWriter = steps.findIndex((s) => /writer-destaque/.test(s) && /DESTAQUE 1/.test(s));
    const iSocial = steps.findIndex((s) => /social-writer/.test(s));
    const iHash = steps.findIndex((s) => /refresh-social-hash\.ts/.test(s));
    assert.ok(iWriter > 0, "writer-destaque vem depois do refresh de fontes");
    assert.ok(iSocial > iWriter);
    assert.ok(iHash > iSocial, "recarimbo do hash vem depois do splice do social");
    assert.ok(steps.some((s) => /DESTAQUE 3/.test(s) && /source_text_path/.test(s)));
  });

  it("CLI imprime o next_steps com o refresh de fontes em 1º", () => {
    const dir = makeTempEdition({});
    try {
      const { status, stdout } = runCli([
        "--edition", "260929", "--edition-dir", dir,
        "--d2-url", "https://novo.com/y", "--d2-title", "Y",
      ]);
      assert.equal(status, 0);
      const parsed = JSON.parse(stdout);
      assert.match(parsed.next_steps[0], /refresh-destaque-sources\.ts/);
      assert.ok(!parsed.modified.rewritten.some((p: string) => p.endsWith(".social-source-hash.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
