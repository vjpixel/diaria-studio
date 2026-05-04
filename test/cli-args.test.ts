import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, getArg, hasFlag } from "../scripts/lib/cli-args.ts";

describe("parseArgs — pares key-value", () => {
  it("extrai um par --key value", () => {
    const { values } = parseArgs(["--edition-dir", "data/editions/260418/"]);
    assert.equal(values["edition-dir"], "data/editions/260418/");
  });

  it("extrai múltiplos pares", () => {
    const { values } = parseArgs(["--mode", "push", "--stage", "2", "--files", "a.md,b.jpg"]);
    assert.equal(values["mode"], "push");
    assert.equal(values["stage"], "2");
    assert.equal(values["files"], "a.md,b.jpg");
  });
});

describe("parseArgs — flags booleanas", () => {
  it("registra --flag como boolean quando não seguido de valor", () => {
    const { flags } = parseArgs(["--health-check"]);
    assert.equal(flags.has("health-check"), true);
  });

  it("registra --dry-run e --force como booleanas", () => {
    const { flags } = parseArgs(["--dry-run", "--force"]);
    assert.equal(flags.has("dry-run"), true);
    assert.equal(flags.has("force"), true);
  });

  it("flag entre pares key-value não é confundida como valor", () => {
    const { flags, values } = parseArgs(["--mode", "push", "--force", "--stage", "1"]);
    assert.equal(values["mode"], "push");
    assert.equal(values["stage"], "1");
    assert.equal(flags.has("force"), true);
  });
});

describe("parseArgs — mix de posicionais, flags e valores", () => {
  it("separa posicionais, valores e flags corretamente", () => {
    const { positional, values, flags } = parseArgs([
      "data/editions/260418/",
      "--format",
      "html",
      "--out",
      "out.html",
      "--verbose",
    ]);
    assert.deepEqual(positional, ["data/editions/260418/"]);
    assert.equal(values["format"], "html");
    assert.equal(values["out"], "out.html");
    assert.equal(flags.has("verbose"), true);
  });

  it("positional antes de flag; valor de flag não vira positional", () => {
    // ["foo", "--flag", "bar"]: "foo" é positional, "bar" é valor de --flag
    const { positional, values } = parseArgs(["foo", "--flag", "bar"]);
    assert.deepEqual(positional, ["foo"]);
    assert.equal(values["flag"], "bar");
  });
});

describe("parseArgs — key ausente não retorna args[0]", () => {
  it("values não contém chave ausente", () => {
    const { values } = parseArgs(["--mode", "push"]);
    assert.equal(values["edition-dir"], undefined);
  });

  it("values vazio quando argv vazio", () => {
    const { values, flags, positional } = parseArgs([]);
    assert.equal(Object.keys(values).length, 0);
    assert.equal(flags.size, 0);
    assert.deepEqual(positional, []);
  });

  it("key ausente retorna undefined, não primeiro arg", () => {
    // Bug #535: args[args.indexOf(flag)+1] retorna args[0] quando indexOf=-1 → -1+1=0
    const { values } = parseArgs(["primeiro-arg", "--outro", "valor"]);
    // "ausente" não está no argv → deve ser undefined, nunca "primeiro-arg"
    assert.equal(values["ausente"], undefined);
  });
});

describe("getArg — atalho com fallback para string vazia", () => {
  it("retorna o valor quando chave presente", () => {
    assert.equal(getArg(["--articles", "foo.json"], "articles"), "foo.json");
  });

  it('retorna "" quando chave ausente (nunca args[0])', () => {
    // Bug #535: garante que nunca devolve "foo.json" (args[0]) quando --out ausente
    assert.equal(getArg(["foo.json", "--articles", "bar.json"], "out"), "");
  });

  it('retorna "" em argv vazio', () => {
    assert.equal(getArg([], "qualquer"), "");
  });
});

describe("hasFlag — atalho booleano", () => {
  it("retorna true quando flag presente", () => {
    assert.equal(hasFlag(["--health-check"], "health-check"), true);
  });

  it("retorna false quando flag ausente", () => {
    assert.equal(hasFlag(["--mode", "push"], "health-check"), false);
  });

  it("retorna false em argv vazio", () => {
    assert.equal(hasFlag([], "force"), false);
  });

  it("não confunde valor de par key-value como flag", () => {
    // --mode push: "push" não é flag, é valor de --mode
    assert.equal(hasFlag(["--mode", "push"], "push"), false);
  });
});
