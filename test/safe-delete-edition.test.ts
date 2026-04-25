import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidEditionName,
  validateConfirmToken,
  summarizeEdition,
  formatBytes,
  buildConfirmInstructions,
} from "../scripts/safe-delete-edition.ts";

describe("isValidEditionName (#101)", () => {
  it("aceita 6 dígitos", () => {
    assert.equal(isValidEditionName("260424"), true);
    assert.equal(isValidEditionName("261231"), true);
  });

  it("rejeita formatos inválidos", () => {
    assert.equal(isValidEditionName(""), false);
    assert.equal(isValidEditionName("26042"), false);
    assert.equal(isValidEditionName("2604244"), false);
    assert.equal(isValidEditionName("26-04-24"), false);
    assert.equal(isValidEditionName("260424a"), false);
    assert.equal(isValidEditionName(" 260424"), false);
  });
});

describe("validateConfirmToken — strict equality with trim (#101)", () => {
  it("aceita match exato", () => {
    assert.equal(validateConfirmToken("260424", "260424"), true);
  });

  it("aceita com whitespace ao redor (trim)", () => {
    assert.equal(validateConfirmToken("260424", "  260424  "), true);
    assert.equal(validateConfirmToken("260424", "260424\n"), true);
  });

  it("rejeita 'yes' / 'sim' / 'confirmar' (não pode ser 'qualquer afirmação')", () => {
    assert.equal(validateConfirmToken("260424", "yes"), false);
    assert.equal(validateConfirmToken("260424", "sim"), false);
    assert.equal(validateConfirmToken("260424", "confirmar"), false);
  });

  it("rejeita edição diferente (typo)", () => {
    assert.equal(validateConfirmToken("260424", "260425"), false);
    assert.equal(validateConfirmToken("260424", "240426"), false);
  });

  it("rejeita string vazia", () => {
    assert.equal(validateConfirmToken("260424", ""), false);
    assert.equal(validateConfirmToken("260424", "   "), false);
  });
});

describe("formatBytes", () => {
  it("formata bytes (< 1KB)", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
  });

  it("formata KB (>= 1KB, < 1MB)", () => {
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(1024 * 1023), "1023.0 KB");
  });

  it("formata MB (>= 1MB)", () => {
    assert.equal(formatBytes(1024 * 1024), "1.0 MB");
    assert.equal(formatBytes(12 * 1024 * 1024 + 100 * 1024), "12.1 MB");
  });
});

describe("buildConfirmInstructions", () => {
  it("inclui nome da edição na linha de comando", () => {
    const out = buildConfirmInstructions("260424", "scripts/safe-delete-edition.ts");
    assert.ok(out.includes("260424"));
    assert.ok(out.includes("--confirm 260424"));
    assert.ok(out.includes("scripts/safe-delete-edition.ts"));
  });

  it("explica que --confirm precisa casar exatamente", () => {
    const out = buildConfirmInstructions("260424", "x");
    assert.ok(out.toLowerCase().includes("must equal"));
    assert.ok(out.toLowerCase().includes("aborts"));
  });
});

// ---------------------------------------------------------------------------
// summarizeEdition — pure but exercised with mocked fs
// ---------------------------------------------------------------------------

describe("summarizeEdition — mocked fs", () => {
  it("retorna missing quando path não existe", () => {
    const summary = summarizeEdition("/x/260424", {
      exists: () => false,
      listEntries: () => [],
      statSize: () => 0,
      isDirectory: () => false,
      readJson: () => ({}),
    });
    assert.equal(summary.exists, false);
    assert.equal(summary.file_count, 0);
    assert.equal(summary.status, "missing");
  });

  it("conta arquivos e bytes recursivamente", () => {
    const tree: Record<string, { isDir: boolean; entries?: string[]; size?: number }> = {
      "/x/260424": { isDir: true, entries: ["a.md", "sub"] },
      "/x/260424/a.md": { isDir: false, size: 100 },
      "/x/260424/sub": { isDir: true, entries: ["b.jpg"] },
      "/x/260424/sub/b.jpg": { isDir: false, size: 5000 },
    };
    const summary = summarizeEdition("/x/260424", {
      exists: (p) => p === "/x/260424" || p === "/x/260424/05-published.json" ? p in tree : true,
      listEntries: (p) => tree[p]?.entries ?? [],
      statSize: (p) => tree[p]?.size ?? 0,
      isDirectory: (p) => tree[p]?.isDir ?? false,
      readJson: () => ({}),
    });
    assert.equal(summary.exists, true);
    assert.equal(summary.file_count, 2);
    assert.equal(summary.total_bytes, 5100);
  });

  it("status='published' quando 05-published.json tem status published", () => {
    const summary = summarizeEdition("/x/260424", {
      exists: (p) => p === "/x/260424" || p === "/x/260424/05-published.json",
      listEntries: () => [],
      statSize: () => 0,
      isDirectory: () => false,
      readJson: () => ({ status: "published" }),
    });
    assert.equal(summary.status, "published");
  });

  it("status='missing' quando edition existe mas 05-published.json não", () => {
    const summary = summarizeEdition("/x/260424", {
      exists: (p) => p === "/x/260424",
      listEntries: () => [],
      statSize: () => 0,
      isDirectory: () => false,
      readJson: () => ({}),
    });
    assert.equal(summary.status, "missing");
  });

  it("status='malformed' quando 05-published.json é JSON inválido", () => {
    const summary = summarizeEdition("/x/260424", {
      exists: () => true,
      listEntries: () => [],
      statSize: () => 0,
      isDirectory: () => false,
      readJson: () => {
        throw new Error("invalid");
      },
    });
    assert.equal(summary.status, "malformed");
  });
});

// ---------------------------------------------------------------------------
// Integration — full filesystem
// ---------------------------------------------------------------------------

describe("safe-delete-edition — integration with real fs", () => {
  function setup(): { root: string; editionPath: string } {
    const root = mkdtempSync(join(tmpdir(), "diaria-safe-delete-"));
    const editionPath = join(root, "data/editions/260424");
    mkdirSync(editionPath, { recursive: true });
    writeFileSync(join(editionPath, "02-reviewed.md"), "# Edition\n");
    writeFileSync(
      join(editionPath, "05-published.json"),
      JSON.stringify({ status: "published" }),
    );
    mkdirSync(join(editionPath, "_internal"));
    writeFileSync(join(editionPath, "_internal/cost.md"), "# Cost\n");
    return { root, editionPath };
  }

  function realFs() {
    return {
      exists: (p: string) => existsSync(p),
      listEntries: (p: string) => readdirSync(p),
      statSize: (p: string) => statSync(p).size,
      isDirectory: (p: string) => statSync(p).isDirectory(),
      readJson: (p: string) => JSON.parse(readFileSync(p, "utf8")),
    };
  }

  it("summarizeEdition com fs real conta corretamente", () => {
    const { root, editionPath } = setup();
    try {
      const summary = summarizeEdition(editionPath, realFs());
      assert.equal(summary.exists, true);
      assert.equal(summary.file_count, 3); // 02-reviewed, 05-published, cost.md
      assert.ok(summary.total_bytes > 0);
      assert.equal(summary.status, "published");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
