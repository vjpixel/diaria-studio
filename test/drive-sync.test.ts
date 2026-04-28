import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRetryableStatus, backoffMs, splitFilePath } from "../scripts/drive-sync.ts";

describe("isRetryableStatus (#121)", () => {
  it("aceita transient HTTP errors comuns do Drive API", () => {
    assert.equal(isRetryableStatus(429), true); // rate limit
    assert.equal(isRetryableStatus(502), true); // bad gateway
    assert.equal(isRetryableStatus(503), true); // service unavailable
    assert.equal(isRetryableStatus(504), true); // gateway timeout
  });

  it("rejeita erros não-transientes — não retentar", () => {
    assert.equal(isRetryableStatus(200), false);
    assert.equal(isRetryableStatus(201), false);
    assert.equal(isRetryableStatus(400), false); // bad request — config bug, retry não resolve
    assert.equal(isRetryableStatus(401), false); // auth — gFetch base trata refresh
    assert.equal(isRetryableStatus(403), false); // forbidden — permissão fixa
    assert.equal(isRetryableStatus(404), false); // not found
    assert.equal(isRetryableStatus(500), false); // internal — geralmente bug do Drive, não transient
  });

  it("aceita 0 e negativos sem crashar", () => {
    assert.equal(isRetryableStatus(0), false);
    assert.equal(isRetryableStatus(-1), false);
  });
});

describe("backoffMs — exponential com jitter (#121)", () => {
  it("primeira tentativa: 1000ms + jitter (0-250ms)", () => {
    // Random source = 0 → sem jitter
    assert.equal(backoffMs(0, () => 0), 1000);
    // Random source = 1 → jitter máximo
    assert.equal(backoffMs(0, () => 1), 1250);
  });

  it("segunda tentativa: 2000ms + jitter", () => {
    assert.equal(backoffMs(1, () => 0), 2000);
    assert.equal(backoffMs(1, () => 1), 2250);
  });

  it("terceira tentativa: 4000ms + jitter", () => {
    assert.equal(backoffMs(2, () => 0), 4000);
    assert.equal(backoffMs(2, () => 0.5), 4125);
  });

  it("escala exponencialmente (8s, 16s, 32s) — caso extremo", () => {
    assert.equal(backoffMs(3, () => 0), 8000);
    assert.equal(backoffMs(4, () => 0), 16000);
    assert.equal(backoffMs(5, () => 0), 32000);
  });

  it("Math.random é o default", () => {
    // Não deve crashar sem injection
    const result = backoffMs(0);
    assert.ok(result >= 1000 && result <= 1250);
  });
});

describe("splitFilePath (#253)", () => {
  it("filename sem `/`: subpath vazio, basename = filename", () => {
    assert.deepEqual(splitFilePath("02-reviewed.md"), {
      subpath: "",
      basename: "02-reviewed.md",
    });
  });

  it("`_internal/foo.md`: subpath e basename", () => {
    assert.deepEqual(splitFilePath("_internal/02-clarice-diff.md"), {
      subpath: "_internal",
      basename: "02-clarice-diff.md",
    });
  });

  it("subpasta aninhada: split na última barra", () => {
    assert.deepEqual(splitFilePath("_internal/sub/foo.json"), {
      subpath: "_internal/sub",
      basename: "foo.json",
    });
  });

  it("backslashes do Windows são normalizados pra forward slashes", () => {
    assert.deepEqual(splitFilePath("_internal\\foo.md"), {
      subpath: "_internal",
      basename: "foo.md",
    });
  });

  it("filename só com basename + extensão complexa", () => {
    assert.deepEqual(splitFilePath("04-d1-2x1.jpg"), {
      subpath: "",
      basename: "04-d1-2x1.jpg",
    });
  });

  it("não esquenta com filename vazio", () => {
    assert.deepEqual(splitFilePath(""), { subpath: "", basename: "" });
  });
});
