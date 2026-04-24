import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findPendingDrafts,
  isDraftProcessed,
} from "../scripts/find-pending-issue-drafts.ts";

interface Fixture {
  name: string;
  signals?: Array<{ kind: string }>;
  reported?: { reported?: Array<{ signal_kind: string }>; skipped?: Array<{ signal_kind: string }> };
  /** Se true, cria edição com apenas diretório, sem drafts. */
  empty?: boolean;
}

function setupEditions(editions: Fixture[]): string {
  const tmp = mkdtempSync(join(tmpdir(), "diaria-drafts-"));
  for (const e of editions) {
    const internal = join(tmp, e.name, "_internal");
    mkdirSync(internal, { recursive: true });
    if (e.empty) continue;
    if (e.signals !== undefined) {
      writeFileSync(
        join(internal, "issues-draft.json"),
        JSON.stringify({ edition: e.name, signals: e.signals }),
      );
    }
    if (e.reported) {
      writeFileSync(
        join(internal, "issues-reported.json"),
        JSON.stringify(e.reported),
      );
    }
  }
  return tmp;
}

describe("isDraftProcessed", () => {
  it("reported null → false (não processado)", () => {
    assert.equal(isDraftProcessed([{ kind: "x" }], null), false);
  });

  it("reported total cobre signals → true", () => {
    const signals = [{ kind: "a" }, { kind: "b" }];
    const reported = { reported: [{ signal_kind: "a" }], skipped: [{ signal_kind: "b" }] };
    assert.equal(isDraftProcessed(signals, reported), true);
  });

  it("reported parcial → false", () => {
    const signals = [{ kind: "a" }, { kind: "b" }, { kind: "c" }];
    const reported = { reported: [{ signal_kind: "a" }] };
    assert.equal(isDraftProcessed(signals, reported), false);
  });

  it("só skipped sem reported → true se cobrir", () => {
    const signals = [{ kind: "a" }];
    const reported = { skipped: [{ signal_kind: "a" }] };
    assert.equal(isDraftProcessed(signals, reported), true);
  });

  it("reported vazio → false se há signals", () => {
    const reported = { reported: [], skipped: [] };
    assert.equal(isDraftProcessed([{ kind: "x" }], reported), false);
  });
});

describe("findPendingDrafts", () => {
  it("detecta draft com signals sem report", () => {
    const dir = setupEditions([
      { name: "260421", signals: [{ kind: "source_streak" }] },
      { name: "260424", empty: true },
    ]);
    try {
      const pending = findPendingDrafts(dir, "260424", 3);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].edition, "260421");
      assert.equal(pending[0].signal_count, 1);
      assert.equal(pending[0].has_report, false);
      assert.equal(pending[0].summary, "1 source_streak");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pula drafts já processados (reported cobre signals)", () => {
    const dir = setupEditions([
      {
        name: "260421",
        signals: [{ kind: "a" }, { kind: "b" }],
        reported: { reported: [{ signal_kind: "a" }, { signal_kind: "b" }] },
      },
      { name: "260424", empty: true },
    ]);
    try {
      const pending = findPendingDrafts(dir, "260424", 3);
      assert.equal(pending.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detecta drafts parcialmente processados", () => {
    const dir = setupEditions([
      {
        name: "260421",
        signals: [{ kind: "a" }, { kind: "b" }],
        reported: { reported: [{ signal_kind: "a" }] }, // só 1 de 2
      },
      { name: "260424", empty: true },
    ]);
    try {
      const pending = findPendingDrafts(dir, "260424", 3);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].has_report, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drafts com signals vazios são ignorados", () => {
    const dir = setupEditions([
      { name: "260421", signals: [] },
      { name: "260424", empty: true },
    ]);
    try {
      assert.equal(findPendingDrafts(dir, "260424", 3).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respeita window — edições mais antigas que N pulam", () => {
    const dir = setupEditions([
      { name: "260418", signals: [{ kind: "a" }] }, // 6 dias atrás, fora da janela de 3
      { name: "260421", signals: [{ kind: "b" }] }, // 3 dias atrás
      { name: "260422", signals: [{ kind: "c" }] },
      { name: "260423", signals: [{ kind: "d" }] },
      { name: "260424", empty: true },
    ]);
    try {
      const pending = findPendingDrafts(dir, "260424", 3);
      const editions = pending.map((p) => p.edition).sort();
      assert.deepEqual(editions, ["260421", "260422", "260423"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("não inclui a edição atual ou futuras", () => {
    const dir = setupEditions([
      { name: "260423", signals: [{ kind: "a" }] },
      { name: "260424", signals: [{ kind: "b" }] }, // current
      { name: "260425", signals: [{ kind: "c" }] }, // futura
    ]);
    try {
      const pending = findPendingDrafts(dir, "260424", 3);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].edition, "260423");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumo agrega kinds corretamente", () => {
    const dir = setupEditions([
      {
        name: "260423",
        signals: [
          { kind: "source_streak" },
          { kind: "chrome_disconnects" },
          { kind: "chrome_disconnects" },
          { kind: "unfixed_issue" },
        ],
      },
      { name: "260424", empty: true },
    ]);
    try {
      const pending = findPendingDrafts(dir, "260424", 3);
      const s = pending[0].summary;
      assert.ok(s.includes("1 source_streak"));
      assert.ok(s.includes("2 chrome_disconnects"));
      assert.ok(s.includes("1 unfixed_issue"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição sem _internal/ ignorada", () => {
    const dir = setupEditions([{ name: "260423", empty: true }]);
    try {
      assert.equal(findPendingDrafts(dir, "260424", 3).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("editions dir inexistente retorna vazio", () => {
    assert.deepEqual(findPendingDrafts("/nonexistent", "260424", 3), []);
  });

  it("draft com JSON malformado é pulado (não quebra)", () => {
    const dir = setupEditions([{ name: "260423", empty: true }]);
    // Escrever draft malformado manualmente
    const internal = join(dir, "260423", "_internal");
    writeFileSync(join(internal, "issues-draft.json"), "{garbage");
    try {
      assert.equal(findPendingDrafts(dir, "260424", 3).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
