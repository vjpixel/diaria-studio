/**
 * test/apoio-promise-store.test.ts (#4490 causa 4)
 *
 * Regressão pra `scripts/lib/apoio-promise-store.ts` — I/O isolado em tmpdir,
 * nunca toca `data/apoia-se/` real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  pendingPromisesPath,
  loadPendingPromises,
  savePendingPromises,
  mergeNewPromises,
  mergePendingPromisesPreferRecent,
  type PendingPromise,
} from "../scripts/lib/apoio-promise-store.ts";
import type { DrainedPromessa } from "../scripts/lib/apoia-se-gmail-drain.ts";

describe("pendingPromisesPath", () => {
  it("namespaced por campanha sob data/apoia-se/{campaign}/pending-promises.jsonl", () => {
    const p = pendingPromisesPath("/root", "diaria");
    assert.match(p.replace(/\\/g, "/"), /data\/apoia-se\/diaria\/pending-promises\.jsonl$/);
  });
});

describe("loadPendingPromises / savePendingPromises", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "apoio-promise-store-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> [] (fail-soft)", () => {
    assert.deepEqual(loadPendingPromises(resolve(tmpDir, "pending-promises.jsonl")), []);
  });

  it("roundtrip: save + load preserva o conteúdo", () => {
    const path = resolve(tmpDir, "sub", "pending-promises.jsonl");
    const promises: PendingPromise[] = [
      { name: "Fabiana", email: "fabiana@example.com", value: 50, receivedAtIso: "2026-08-02T21:45:00.000Z" },
      { name: "Ivan", email: "ivan@example.com", value: 10, receivedAtIso: "2026-07-22T10:00:00.000Z" },
    ];
    savePendingPromises(path, promises);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadPendingPromises(path), promises);
  });

  it("save com array vazio grava arquivo vazio (nunca lista JSON '[]')", () => {
    const path = resolve(tmpDir, "pending-promises.jsonl");
    savePendingPromises(path, []);
    assert.equal(readFileSync(path, "utf-8"), "");
    assert.deepEqual(loadPendingPromises(path), []);
  });

  it("linha corrompida é ignorada, linhas válidas seguem sendo lidas (fail-soft por linha)", () => {
    const path = resolve(tmpDir, "pending-promises.jsonl");
    mkdirSync(tmpDir, { recursive: true });
    const good: PendingPromise = { name: "Ok", email: "ok@x.com", value: 5, receivedAtIso: "2026-08-01T00:00:00.000Z" };
    writeFileSync(path, `{ nao é json válido\n${JSON.stringify(good)}\n`);
    assert.deepEqual(loadPendingPromises(path), [good]);
  });

  it("linha com shape incompleto (faltando campo) é descartada", () => {
    const path = resolve(tmpDir, "pending-promises.jsonl");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ name: "Sem email" })}\n`);
    assert.deepEqual(loadPendingPromises(path), []);
  });

  it("#4506 item 4: re-normaliza email (lowercase/trim) na LEITURA, não só no merge", () => {
    const path = resolve(tmpDir, "pending-promises.jsonl");
    mkdirSync(tmpDir, { recursive: true });
    // Entrada gravada manualmente/por código antigo com email não-normalizado.
    writeFileSync(
      path,
      `${JSON.stringify({ name: "Fabiana", email: "  FABIANA@Example.com  ", value: 50, receivedAtIso: "2026-08-02T21:45:00.000Z" })}\n`,
    );
    const loaded = loadPendingPromises(path);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].email, "fabiana@example.com");
  });
});

describe("mergePendingPromisesPreferRecent (#4506 item 1/3)", () => {
  it("mesmo e-mail em ambas as listas — a de receivedAtIso MAIS RECENTE vence, não a da 2ª lista por padrão", () => {
    const a: PendingPromise[] = [
      { name: "Fabiana", email: "fabiana@example.com", value: 50, receivedAtIso: "2026-08-02T21:45:00.000Z" },
    ];
    const b: PendingPromise[] = [
      { name: "Fabiana", email: "fabiana@example.com", value: 30, receivedAtIso: "2026-08-01T00:00:00.000Z" },
    ];
    // b (2ª lista) é MAIS ANTIGA que a — a deve vencer, provando que a
    // comparação é por timestamp e não por "quem entrou por último".
    const merged = mergePendingPromisesPreferRecent(a, b);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].value, 50, "a entrada mais recente (a) deve vencer mesmo estando na 1ª lista");
  });

  it("une entradas de e-mails diferentes sem perder nenhuma", () => {
    const a: PendingPromise[] = [{ name: "A", email: "a@x.com", value: 1, receivedAtIso: "2026-08-01T00:00:00.000Z" }];
    const b: PendingPromise[] = [{ name: "B", email: "b@x.com", value: 2, receivedAtIso: "2026-08-02T00:00:00.000Z" }];
    const merged = mergePendingPromisesPreferRecent(a, b);
    assert.deepEqual(merged.map((p) => p.email).sort(), ["a@x.com", "b@x.com"]);
  });
});

describe("mergeNewPromises", () => {
  it("adiciona promessas novas ao store existente", () => {
    const existing: PendingPromise[] = [{ name: "A", email: "a@x.com", value: 10, receivedAtIso: "2026-08-01T00:00:00.000Z" }];
    const drained: DrainedPromessa[] = [{ name: "B", email: "b@x.com", value: 20, receivedAtIso: "2026-08-02T00:00:00.000Z" }];
    const merged = mergeNewPromises(existing, drained);
    assert.equal(merged.length, 2);
    assert.deepEqual(
      merged.map((p) => p.email).sort(),
      ["a@x.com", "b@x.com"],
    );
  });

  it("dedup por e-mail normalizado — a promessa mais recente vence", () => {
    const existing: PendingPromise[] = [{ name: "Fabiana", email: "fabiana@example.com", value: 30, receivedAtIso: "2026-08-01T00:00:00.000Z" }];
    const drained: DrainedPromessa[] = [{ name: "Fabiana", email: "FABIANA@Example.com", value: 50, receivedAtIso: "2026-08-02T21:45:00.000Z" }];
    const merged = mergeNewPromises(existing, drained);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].email, "fabiana@example.com");
    assert.equal(merged[0].value, 50, "a mais recente (drenada agora) vence sobre a antiga do store");
  });

  it("e-mail vazio no drain é descartado (defensivo)", () => {
    const merged = mergeNewPromises([], [{ name: "X", email: "  ", value: 1, receivedAtIso: "2026-08-01T00:00:00.000Z" }]);
    assert.deepEqual(merged, []);
  });

  it("sem novas promessas — store existente preservado intacto", () => {
    const existing: PendingPromise[] = [{ name: "A", email: "a@x.com", value: 10, receivedAtIso: "2026-08-01T00:00:00.000Z" }];
    assert.deepEqual(mergeNewPromises(existing, []), existing);
  });

  it("#4506 item 3: quando o drain traz uma entrada MAIS ANTIGA (out-of-order), a existente vence de verdade", () => {
    // Antes do #4506, mergeNewPromises sempre deixava `drained` vencer
    // (dependia de ordem de iteração, não de receivedAtIso) — mesmo quando o
    // drain trazia uma entrada com timestamp MAIS ANTIGO que a já no store.
    const existing: PendingPromise[] = [
      { name: "Fabiana", email: "fabiana@example.com", value: 50, receivedAtIso: "2026-08-02T21:45:00.000Z" },
    ];
    const drained: DrainedPromessa[] = [
      { name: "Fabiana", email: "fabiana@example.com", value: 10, receivedAtIso: "2026-07-01T00:00:00.000Z" },
    ];
    const merged = mergeNewPromises(existing, drained);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].value, 50, "a entrada existente (mais recente) deve vencer sobre a drenada (mais antiga)");
  });
});
