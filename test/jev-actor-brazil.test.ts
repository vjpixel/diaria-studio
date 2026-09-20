/**
 * test/jev-actor-brazil.test.ts (#8504 — implementação a partir do veredito
 * adotar de #8416)
 *
 * Cobre `scripts/lib/jev-actor-brazil.ts` (config + classificação fail-soft)
 * e as funções puras de `scripts/annotate-actor-brazil.ts` (coleta/aplicação
 * de anotações, sem I/O de rede). NENHUM teste chama a rede real — todos
 * injetam `fetchImpl`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readJevFeaturesConfig,
  isActorBrazilEnabled,
  classifyActorBrazil,
  annotateActorBrazil,
} from "../scripts/lib/jev-actor-brazil.ts";
import { collectAnnotatableItems, applyAnnotations } from "../scripts/annotate-actor-brazil.ts";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "jev-actor-brazil-test-"));
  delete process.env.JEV_FORCE_ACTOR_BRAZIL;
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.JEV_FORCE_ACTOR_BRAZIL;
});

function writeConfig(obj: unknown): string {
  const path = join(tmpDir, "platform.config.json");
  writeFileSync(path, JSON.stringify(obj), "utf8");
  return path;
}

// ---------------------------------------------------------------------------
// Config — fail-soft, default OFF
// ---------------------------------------------------------------------------

describe("readJevFeaturesConfig / isActorBrazilEnabled", () => {
  it("arquivo ausente -> {} / false", () => {
    const path = join(tmpDir, "nao-existe.json");
    assert.deepEqual(readJevFeaturesConfig(path), {});
    assert.equal(isActorBrazilEnabled(path), false);
  });

  it("JSON malformado -> {} / false (nunca lança)", () => {
    const path = join(tmpDir, "platform.config.json");
    writeFileSync(path, "{ not valid json", "utf8");
    assert.deepEqual(readJevFeaturesConfig(path), {});
    assert.equal(isActorBrazilEnabled(path), false);
  });

  it("jev.features ausente -> {} / false", () => {
    const path = writeConfig({ outra_chave: true });
    assert.deepEqual(readJevFeaturesConfig(path), {});
    assert.equal(isActorBrazilEnabled(path), false);
  });

  it("jev.features.actor_brazil: false (default committed) -> false", () => {
    const path = writeConfig({ jev: { features: { actor_brazil: false } } });
    assert.equal(isActorBrazilEnabled(path), false);
  });

  it("jev.features.actor_brazil: true -> true", () => {
    const path = writeConfig({ jev: { features: { actor_brazil: true } } });
    assert.equal(isActorBrazilEnabled(path), true);
  });

  it("#8504 item 5: JEV_FORCE_ACTOR_BRAZIL=1 liga mesmo com config false (perfil --diaria-edicao-jev)", () => {
    const path = writeConfig({ jev: { features: { actor_brazil: false } } });
    process.env.JEV_FORCE_ACTOR_BRAZIL = "1";
    assert.equal(isActorBrazilEnabled(path), true);
  });

  it("JEV_FORCE_ACTOR_BRAZIL ausente/diferente de '1' nunca desliga um config já true", () => {
    const path = writeConfig({ jev: { features: { actor_brazil: true } } });
    process.env.JEV_FORCE_ACTOR_BRAZIL = "0";
    assert.equal(isActorBrazilEnabled(path), true);
  });
});

// ---------------------------------------------------------------------------
// classifyActorBrazil — transporte fail-soft (fetch injetado)
// ---------------------------------------------------------------------------

function jevResponseFor(actor: string, brazilP: number): Response {
  return new Response(
    JSON.stringify({
      answers: {
        actor: { type: "choice", choice: actor, confidence: 0.9, probabilities: { [actor]: 0.9 } },
        brazil: { type: "noul", noul: brazilP, confidence: 0.95 },
      },
    }),
    { status: 200 },
  );
}

describe("classifyActorBrazil", () => {
  it("anota actor/actor_p/brazil_p a partir da resposta real (chave `noul`, #8414/#8416)", async () => {
    const fetchImpl = (async () => jevResponseFor("big_tech_lab", 0.12)) as unknown as typeof fetch;
    const { annotations, applied } = await classifyActorBrazil(
      [{ id: "https://a.example/1", url: "https://a.example/1", title: "t", summary: "s" }],
      { apiKey: "fake-key", fetchImpl },
    );
    assert.equal(applied, true);
    const ann = annotations.get("https://a.example/1");
    assert.ok(ann);
    assert.equal(ann?.actor, "big_tech_lab");
    assert.equal(ann?.actor_p, 0.9);
    assert.equal(ann?.brazil_p, 0.12);
  });

  it("falha total de transporte -> applied:false, annotations vazio (fail-soft, nunca lança)", async () => {
    const fetchImpl = (async () => new Response("erro", { status: 500 })) as unknown as typeof fetch;
    const { annotations, applied } = await classifyActorBrazil(
      [{ id: "u1", url: "https://a.example/1", title: "t", summary: "s" }],
      { apiKey: "fake-key", fetchImpl },
    );
    assert.equal(applied, false);
    assert.equal(annotations.size, 0);
  });

  it("actor fora do vocabulário de 6 vias é descartado (nunca contamina com valor inválido)", async () => {
    const fetchImpl = (async () => jevResponseFor("categoria_invalida", 0.5)) as unknown as typeof fetch;
    const { annotations, applied } = await classifyActorBrazil(
      [{ id: "u1", url: "https://a.example/1", title: "t", summary: "s" }],
      { apiKey: "fake-key", fetchImpl },
    );
    assert.equal(applied, true);
    assert.equal(annotations.size, 0);
  });

  it("lista vazia -> applied:true, sem chamar a rede", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jevResponseFor("outro", 0.1);
    }) as unknown as typeof fetch;
    const { annotations, applied } = await classifyActorBrazil([], { apiKey: "fake-key", fetchImpl });
    assert.equal(applied, true);
    assert.equal(annotations.size, 0);
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// annotateActorBrazil — ponto de entrada fail-soft (flag + key + transporte)
// ---------------------------------------------------------------------------

describe("annotateActorBrazil — off ⇒ idêntico (#8412 método comum, teste de regresso)", () => {
  it("flag desligada (default) -> no-op, sem warn, sem chamar a rede", async () => {
    const path = writeConfig({ jev: { features: { actor_brazil: false } } });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return jevResponseFor("outro", 0.1);
    }) as unknown as typeof fetch;
    const { annotations, applied } = await annotateActorBrazil(
      [{ id: "u1", url: "https://a.example/1", title: "t", summary: "s" }],
      { configPath: path, apiKey: "fake-key", fetchImpl, rootDir: tmpDir },
    );
    assert.equal(applied, false);
    assert.equal(annotations.size, 0);
    assert.equal(called, false, "flag off nunca deveria chamar a rede");
  });

  it("flag ligada mas TYPESAFE_API_KEY ausente -> no-op fail-soft, warn no run-log", async () => {
    const path = writeConfig({ jev: { features: { actor_brazil: true } } });
    const prevKey = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const { annotations, applied } = await annotateActorBrazil(
        [{ id: "u1", url: "https://a.example/1", title: "t", summary: "s" }],
        { configPath: path, rootDir: tmpDir },
      );
      assert.equal(applied, false);
      assert.equal(annotations.size, 0);
    } finally {
      if (prevKey !== undefined) process.env.TYPESAFE_API_KEY = prevKey;
    }
  });

  it("flag ligada + key presente + transporte ok -> anota", async () => {
    const path = writeConfig({ jev: { features: { actor_brazil: true } } });
    const fetchImpl = (async () => jevResponseFor("startup", 0.87)) as unknown as typeof fetch;
    const { annotations, applied } = await annotateActorBrazil(
      [{ id: "https://a.example/1", url: "https://a.example/1", title: "t", summary: "s" }],
      { configPath: path, apiKey: "fake-key", fetchImpl, rootDir: tmpDir },
    );
    assert.equal(applied, true);
    assert.equal(annotations.get("https://a.example/1")?.actor, "startup");
    assert.equal(annotations.get("https://a.example/1")?.brazil_p, 0.87);
  });
});

// ---------------------------------------------------------------------------
// annotate-actor-brazil.ts — funções puras (coleta + aplicação, sem rede)
// ---------------------------------------------------------------------------

describe("collectAnnotatableItems", () => {
  it("dedupa por URL entre highlights/runners_up/buckets secundários", () => {
    const input = {
      highlights: [{ rank: 1, article: { url: "https://a.example/1", title: "A" } }],
      runners_up: [{ rank: 4, article: { url: "https://a.example/1", title: "A (dup)" } }],
      lancamento: [{ url: "https://a.example/2", title: "B" }],
      radar: [{ url: "https://a.example/1", title: "A (dup 2)" }],
    };
    const items = collectAnnotatableItems(input);
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((i) => i.url).sort(),
      ["https://a.example/1", "https://a.example/2"],
    );
  });

  it("suporta highlight flat (pré-#229) e nested (pós-#229)", () => {
    const input = {
      highlights: [
        { url: "https://a.example/flat", title: "Flat" },
        { rank: 2, article: { url: "https://a.example/nested", title: "Nested" } },
      ],
    };
    const items = collectAnnotatableItems(input);
    assert.deepEqual(
      items.map((i) => i.url).sort(),
      ["https://a.example/flat", "https://a.example/nested"],
    );
  });

  it("documento vazio -> lista vazia", () => {
    assert.deepEqual(collectAnnotatableItems({}), []);
  });
});

describe("applyAnnotations", () => {
  it("aplica actor/actor_p/brazil_p em highlight nested e artigo de bucket secundário", () => {
    const input = {
      highlights: [{ rank: 1, article: { url: "https://a.example/1", title: "A" } }],
      radar: [{ url: "https://a.example/2", title: "B" }],
    };
    const annotations = new Map([
      ["https://a.example/1", { actor: "big_tech_lab", actor_p: 0.9, brazil_p: 0.1 }],
      ["https://a.example/2", { actor: "startup", actor_p: 0.8, brazil_p: 0.95 }],
    ]);
    const out = applyAnnotations(input, annotations);
    assert.equal((out.highlights?.[0].article as { actor?: string })?.actor, "big_tech_lab");
    assert.equal((out.radar?.[0] as { brazil_p?: number }).brazil_p, 0.95);
  });

  it("sem anotações (Map vazio) -> devolve o input inalterado (mesma referência) — off ⇒ idêntico", () => {
    const input = { highlights: [{ rank: 1, article: { url: "https://a.example/1", title: "A" } }] };
    const out = applyAnnotations(input, new Map());
    assert.equal(out, input);
  });

  it("artigo sem anotação correspondente fica inalterado", () => {
    const input = { radar: [{ url: "https://a.example/nao-anotado", title: "X" }] };
    const out = applyAnnotations(input, new Map([["https://outra.example/1", { actor: "outro", actor_p: 0.5, brazil_p: 0.5 }]]));
    assert.deepEqual(out.radar, input.radar);
  });
});
