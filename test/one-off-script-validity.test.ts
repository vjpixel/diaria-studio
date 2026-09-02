/**
 * test/one-off-script-validity.test.ts (#7114)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkOneOffScriptValidity,
  isExpiredMarker,
  isOneOffScriptFilename,
  malformedMarkerMessage,
  missingMarkerMessage,
} from "../scripts/lib/one-off-script-validity.ts";
import { findOneOffValidityViolations, getAddedScriptRootFiles } from "../scripts/check-one-off-script-validity.ts";
import { findExpiredOneOffScripts } from "../scripts/list-expired-one-off-scripts.ts";

describe("isOneOffScriptFilename", () => {
  it("casa os 5 prefixos citados na issue", () => {
    for (const name of ["analyze-foo.ts", "diagnose-bar.ts", "probe-baz.ts", "measure-qux.ts", "compare-a-b.ts"]) {
      assert.equal(isOneOffScriptFilename(name), true, name);
    }
  });

  it("não casa scripts fora do padrão", () => {
    for (const name of ["check-foo.ts", "publish-newsletter.ts", "measure.ts", "analyzefoo.ts"]) {
      assert.equal(isOneOffScriptFilename(name), false, name);
    }
  });
});

describe("checkOneOffScriptValidity", () => {
  it("not-applicable pra script fora do padrão de nome", () => {
    assert.deepEqual(checkOneOffScriptValidity("check-foo.ts", ""), { status: "not-applicable" });
  });

  it("missing quando o padrão casa mas não há marcador", () => {
    assert.deepEqual(checkOneOffScriptValidity("probe-foo.ts", "/** sem marcador aqui */"), { status: "missing" });
  });

  it("valid (expires) com pergunta + data", () => {
    const src = `/**\n * @one-off-validity: expira=2026-12-01 pergunta="a razão bate?"\n */`;
    const result = checkOneOffScriptValidity("measure-foo.ts", src);
    assert.deepEqual(result, {
      status: "valid",
      marker: { kind: "expires", expiresAt: "2026-12-01", question: "a razão bate?" },
    });
  });

  it("valid (permanente) com motivo", () => {
    const src = `/**\n * @one-off-validity: permanente motivo="roda toda rodada, não é sonda"\n */`;
    const result = checkOneOffScriptValidity("measure-foo.ts", src);
    assert.deepEqual(result, { status: "valid", marker: { kind: "permanent", reason: "roda toda rodada, não é sonda" } });
  });

  it("malformed quando o marcador está presente mas sem forma reconhecida", () => {
    const src = `// @one-off-validity: alguma coisa qualquer`;
    const result = checkOneOffScriptValidity("probe-foo.ts", src);
    assert.equal(result.status, "malformed");
  });

  it("malformed quando expira= está presente mas falta pergunta=", () => {
    const src = `// @one-off-validity: expira=2026-12-01`;
    const result = checkOneOffScriptValidity("probe-foo.ts", src);
    assert.equal(result.status, "malformed");
  });
});

describe("isExpiredMarker", () => {
  it("expires no passado é vencido", () => {
    const marker = { kind: "expires" as const, expiresAt: "2020-01-01", question: "q" };
    assert.equal(isExpiredMarker(marker, new Date("2026-09-02")), true);
  });

  it("expires no futuro não é vencido", () => {
    const marker = { kind: "expires" as const, expiresAt: "2099-01-01", question: "q" };
    assert.equal(isExpiredMarker(marker, new Date("2026-09-02")), false);
  });

  it("permanent nunca vence", () => {
    const marker = { kind: "permanent" as const, reason: "r" };
    assert.equal(isExpiredMarker(marker, new Date("2099-01-01")), false);
  });
});

describe("missingMarkerMessage / malformedMarkerMessage", () => {
  it("mensagens citam o path e são acionáveis", () => {
    assert.match(missingMarkerMessage("scripts/probe-x.ts"), /scripts\/probe-x\.ts/);
    assert.match(missingMarkerMessage("scripts/probe-x.ts"), /@one-off-validity/);
    assert.match(malformedMarkerMessage("scripts/probe-x.ts", "lixo"), /lixo/);
  });
});

describe("findOneOffValidityViolations (guard de criação)", () => {
  it("passa quando arquivo novo declara marcador válido", () => {
    const violations = findOneOffValidityViolations(
      ["scripts/probe-x.ts"],
      () => `// @one-off-validity: expira=2099-01-01 pergunta="q"`,
    );
    assert.deepEqual(violations, []);
  });

  it("reprova arquivo novo sem marcador", () => {
    const violations = findOneOffValidityViolations(["scripts/probe-x.ts"], () => `// nada aqui`);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].path, "scripts/probe-x.ts");
  });

  it("ignora arquivo fora do padrão de nome", () => {
    const violations = findOneOffValidityViolations(["scripts/check-x.ts"], () => `// nada`);
    assert.deepEqual(violations, []);
  });

  it("reprova quando o arquivo não pode ser lido", () => {
    const violations = findOneOffValidityViolations(["scripts/probe-x.ts"], () => {
      throw new Error("ENOENT");
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /ENOENT/);
  });
});

describe("getAddedScriptRootFiles", () => {
  it("filtra só status A dentro de scripts/ nível-raiz", () => {
    const fakeSpawn = (() => ({
      status: 0,
      stdout: [
        "A\tscripts/probe-new.ts",
        "M\tscripts/existing.ts",
        "A\tscripts/lib/probe-new.ts",
        "A\ttest/probe-new.test.ts",
        "D\tscripts/removed.ts",
      ].join("\n"),
      stderr: "",
    })) as unknown as typeof import("node:child_process").spawnSync;
    const paths = getAddedScriptRootFiles("base", "head", fakeSpawn);
    assert.deepEqual(paths, ["scripts/probe-new.ts"]);
  });

  it("lança quando git diff falha", () => {
    const fakeSpawn = (() => ({ status: 1, stdout: "", stderr: "boom" })) as unknown as typeof import("node:child_process").spawnSync;
    assert.throws(() => getAddedScriptRootFiles("base", "head", fakeSpawn), /git diff failed/);
  });
});

describe("findExpiredOneOffScripts", () => {
  it("lista só os expirados, ordenados por data", () => {
    const now = new Date("2026-09-02");
    const files = {
      "probe-old.ts": `// @one-off-validity: expira=2026-01-01 pergunta="velho"`,
      "probe-newer-expired.ts": `// @one-off-validity: expira=2026-06-01 pergunta="mais novo mas ainda vencido"`,
      "probe-future.ts": `// @one-off-validity: expira=2099-01-01 pergunta="no futuro"`,
      "probe-permanent.ts": `// @one-off-validity: permanente motivo="não vence"`,
      "check-not-applicable.ts": `sem marcador, fora do padrão`,
    };
    const expired = findExpiredOneOffScripts(files, now);
    assert.deepEqual(
      expired.map((e) => e.path),
      ["scripts/probe-old.ts", "scripts/probe-newer-expired.ts"],
    );
  });

  it("vazio quando nada vencido", () => {
    assert.deepEqual(findExpiredOneOffScripts({}, new Date()), []);
  });
});
