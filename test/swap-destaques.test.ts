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
} from "../scripts/swap-destaques.ts";

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

  it("rejeita posição fora de range", () => {
    const data = baseApproved();
    const result = swapManualInApprovedJson(
      data,
      [{ position: 3, url: "https://novo.com/z", title: "Z" }] as never,
      false,
    );
    assert.equal(result.ok, true); // 3 destaques existem, válido — controle
    const data2: Record<string, unknown> = { highlights: [HIGHLIGHT_D1] };
    const result2 = swapManualInApprovedJson(
      data2,
      [{ position: 2, url: "https://novo.com/z", title: "Z" }],
      false,
    );
    assert.equal(result2.ok, false);
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

      const hash = JSON.parse(
        readFileSync(join(dir, "_internal", ".social-source-hash.json"), "utf8"),
      );
      assert.ok(typeof hash.hash === "string" && hash.hash.length > 0);

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
});
