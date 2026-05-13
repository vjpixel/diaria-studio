/**
 * test/maintain-valid-editions-window.test.ts (#1233)
 *
 * Cobre `editionsInWindow` + `diffSets` (pure functions). `run()` faz
 * I/O com KV remoto e não é testado aqui — smoke test live é o teste.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editionsInWindow,
  diffSets,
  run,
} from "../scripts/maintain-valid-editions-window.ts";

describe("editionsInWindow (#1233)", () => {
  const NOW = new Date("2026-05-13T00:00:00Z");

  function writeRaw(editions: { published_at: string }[]): string {
    const dir = mkdtempSync(join(tmpdir(), "maintain-window-"));
    const path = join(dir, "past-editions-raw.json");
    writeFileSync(path, JSON.stringify(editions), "utf8");
    return path;
  }

  it("retorna [] quando arquivo não existe", () => {
    const r = editionsInWindow({
      pastEditionsRawPath: "/tmp/nonexistent-path-12345.json",
      windowDays: 7,
      now: NOW,
    });
    assert.deepEqual(r, []);
  });

  it("retorna [] quando JSON inválido", () => {
    const dir = mkdtempSync(join(tmpdir(), "maintain-bad-"));
    const path = join(dir, "past-editions-raw.json");
    writeFileSync(path, "{not valid json", "utf8");
    try {
      const r = editionsInWindow({ pastEditionsRawPath: path, windowDays: 7, now: NOW });
      assert.deepEqual(r, []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("inclui edições dentro da janela de 7 dias", () => {
    const path = writeRaw([
      { published_at: "2026-05-12T08:00:00Z" }, // -1 day → include
      { published_at: "2026-05-09T08:00:00Z" }, // -4 days → include
      { published_at: "2026-05-06T08:00:00Z" }, // -7 days → include (boundary)
      { published_at: "2026-05-05T08:00:00Z" }, // -8 days → exclude
      { published_at: "2026-04-01T08:00:00Z" }, // way older → exclude
    ]);
    const r = editionsInWindow({ pastEditionsRawPath: path, windowDays: 7, now: NOW });
    assert.deepEqual(r.sort(), ["260506", "260509", "260512"]);
  });

  it("respeita window-days = 14", () => {
    const path = writeRaw([
      { published_at: "2026-05-12T08:00:00Z" }, // -1 day
      { published_at: "2026-04-30T08:00:00Z" }, // -13 days → include
      { published_at: "2026-04-28T08:00:00Z" }, // -15 days → exclude
    ]);
    const r = editionsInWindow({ pastEditionsRawPath: path, windowDays: 14, now: NOW });
    assert.deepEqual(r.sort(), ["260430", "260512"]);
  });

  it("ignora entries sem published_at ou com data inválida", () => {
    const path = writeRaw([
      { published_at: "2026-05-12T08:00:00Z" },
      { published_at: "" },
      { published_at: "not-a-date" },
      // @ts-expect-error testing malformed
      { other: "field" },
    ]);
    const r = editionsInWindow({ pastEditionsRawPath: path, windowDays: 7, now: NOW });
    assert.deepEqual(r, ["260512"]);
  });
});

describe("diffSets (#1233)", () => {
  it("identifica adds + removes", () => {
    const r = diffSets(["a", "b", "c"], ["b", "c", "d"]);
    assert.deepEqual(r.added, ["d"]);
    assert.deepEqual(r.removed, ["a"]);
    assert.equal(r.unchanged, false);
  });

  it("unchanged quando arrays iguais", () => {
    const r = diffSets(["a", "b"], ["b", "a"]); // ordem não importa
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.removed, []);
    assert.equal(r.unchanged, true);
  });

  it("empty previous + non-empty target → tudo added", () => {
    const r = diffSets([], ["a", "b"]);
    assert.deepEqual(r.added, ["a", "b"]);
    assert.deepEqual(r.removed, []);
    assert.equal(r.unchanged, false);
  });

  it("non-empty previous + empty target → tudo removed", () => {
    const r = diffSets(["a", "b"], []);
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.removed, ["a", "b"]);
    assert.equal(r.unchanged, false);
  });
});

describe("run (#1234 review — DI + read_failed + out_of_window)", () => {
  const NOW = new Date("2026-05-13T00:00:00Z");

  function writeRaw(editions: { published_at: string }[]): string {
    const dir = mkdtempSync(join(tmpdir(), "maintain-run-"));
    const path = join(dir, "past-editions-raw.json");
    writeFileSync(path, JSON.stringify(editions), "utf8");
    return path;
  }

  it("read_failed=true → aborta sem escrever (preserva KV)", () => {
    let writeCalls = 0;
    const r = run(
      {
        currentEdition: "260517",
        windowDays: 7,
        pastEditionsRawPath: writeRaw([{ published_at: "2026-05-12T08:00:00Z" }]),
        now: NOW,
      },
      {
        readEditions: () => ({ editions: [], read_failed: true }),
        writeEditions: () => { writeCalls++; },
      },
    );
    assert.equal(r.read_failed, true);
    assert.equal(writeCalls, 0, "NÃO deve escrever quando read falha (preserva KV)");
    assert.equal(r.unchanged, true);
  });

  it("janela ok + current → adiciona o que falta, NÃO remove out-of-window", () => {
    let written: string[] | null = null;
    const r = run(
      {
        currentEdition: "260517",
        windowDays: 7,
        pastEditionsRawPath: writeRaw([
          { published_at: "2026-05-12T08:00:00Z" }, // 260512 in window
          { published_at: "2026-05-09T08:00:00Z" }, // 260509 in window
        ]),
        now: NOW,
      },
      {
        // Previous tem 260400 (manual, FORA da janela) + 260512 (in window)
        readEditions: () => ({ editions: ["260400", "260512"], read_failed: false }),
        writeEditions: (eds) => { written = eds; },
      },
    );

    // 260400 fica preservado (política #1233)
    assert.deepEqual(r.current.sort(), ["260400", "260509", "260512", "260517"]);
    // added: o que estava na janela/current mas faltava em previous
    assert.deepEqual(r.added.sort(), ["260509", "260517"]);
    // out_of_window: o que estava em previous mas fora da janela (mantido!)
    assert.deepEqual(r.out_of_window, ["260400"]);
    assert.equal(r.unchanged, false);
    assert.deepEqual(written!.sort(), ["260400", "260509", "260512", "260517"]);
  });

  it("noop quando janela já completa", () => {
    let writeCalls = 0;
    const r = run(
      {
        currentEdition: "260517",
        windowDays: 7,
        pastEditionsRawPath: writeRaw([{ published_at: "2026-05-12T08:00:00Z" }]),
        now: NOW,
      },
      {
        readEditions: () => ({ editions: ["260512", "260517"], read_failed: false }),
        writeEditions: () => { writeCalls++; },
      },
    );
    assert.equal(r.unchanged, true);
    assert.equal(writeCalls, 0, "noop não escreve");
    assert.deepEqual(r.added, []);
  });

  it("currentEdition inválido → throw", () => {
    assert.throws(
      () =>
        run(
          {
            currentEdition: "invalid",
            windowDays: 7,
            pastEditionsRawPath: writeRaw([]),
            now: NOW,
          },
          {
            readEditions: () => ({ editions: [], read_failed: false }),
            writeEditions: () => {},
          },
        ),
      /AAMMDD \(6 dígitos\)/,
    );
  });
});
