/**
 * test/hub-registry-completeness.test.ts (#4558 Parte A)
 *
 * Cruza os 2 registries de hub, deliberadamente separados (ver docstring de
 * `scripts/build-hub-page.ts`): `HUB_LOADERS` (builder, Node-side) e
 * `HUB_REGISTRY` (Worker, escrito à mão, `workers/arquivo/src/hubs/registry.ts`).
 * O caso que este teste pega — achado do fleet review da PR #4558 Parte A —
 * é "hub novo entrou em `HUB_LOADERS` e o `.generated.ts` foi commitado, mas
 * ninguém adicionou a linha correspondente em `HUB_REGISTRY`": o build
 * continua passando silenciosamente, e só falha em produção como 404 em
 * `GET /temas/{slug}`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HUB_LOADERS } from "../scripts/build-hub-page.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";
import { HUB_REGISTRY } from "../workers/arquivo/src/hubs/registry.ts";

describe("completude entre HUB_LOADERS (builder) e HUB_REGISTRY (Worker) (#4558 Parte A)", () => {
  it("todo slug de HUB_LOADERS tem uma entrada correspondente em HUB_REGISTRY", () => {
    const missing = Object.keys(HUB_LOADERS).filter((slug) => !(slug in HUB_REGISTRY));
    assert.deepEqual(
      missing,
      [],
      `slug(s) em HUB_LOADERS sem entrada em workers/arquivo/src/hubs/registry.ts: ${missing.join(", ")}`,
    );
  });

  it("todo slug de HUB_REGISTRY tem um loader correspondente em HUB_LOADERS (nenhum hub órfão servido sem builder)", () => {
    const orphaned = Object.keys(HUB_REGISTRY).filter((slug) => !(slug in HUB_LOADERS));
    assert.deepEqual(
      orphaned,
      [],
      `slug(s) em HUB_REGISTRY sem loader em HUB_LOADERS: ${orphaned.join(", ")}`,
    );
  });

  // 3º registry (#4558 Parte A): `HUB_META` alimenta a navegação "Por tema" da
  // página de arquivo. Sem estes dois casos, um hub novo entra no ar servido em
  // `/temas/{slug}` mas SEM nenhum link interno apontando pra ele — que é
  // exatamente o defeito que a navegação foi criada pra corrigir, e que passou
  // despercebido no primeiro hub.
  it("todo slug de HUB_REGISTRY tem rótulo em HUB_META (nenhum hub servido sem link no arquivo)", () => {
    const semRotulo = Object.keys(HUB_REGISTRY).filter(
      (slug) => !HUB_META.some((h) => h.slug === slug),
    );
    assert.deepEqual(
      semRotulo,
      [],
      `slug(s) em HUB_REGISTRY sem entrada em workers/arquivo/src/hubs/meta.ts — ` +
        `o hub sobe no ar órfão de link interno: ${semRotulo.join(", ")}`,
    );
  });

  it("todo slug de HUB_META existe em HUB_REGISTRY (nenhum link apontando pra 404)", () => {
    const apontandoPraNada = HUB_META.map((h) => h.slug).filter(
      (slug) => !(slug in HUB_REGISTRY),
    );
    assert.deepEqual(
      apontandoPraNada,
      [],
      `slug(s) em HUB_META sem entrada em HUB_REGISTRY — a navegação "Por tema" ` +
        `linkaria pra 404: ${apontandoPraNada.join(", ")}`,
    );
  });

  it("HUB_META não tem slug duplicado nem rótulo vazio", () => {
    const slugs = HUB_META.map((h) => h.slug);
    assert.equal(new Set(slugs).size, slugs.length, `slug duplicado em HUB_META: ${slugs.join(", ")}`);
    const semLabel = HUB_META.filter((h) => h.label.trim() === "").map((h) => h.slug);
    assert.deepEqual(semLabel, [], `rótulo vazio em HUB_META: ${semLabel.join(", ")}`);
  });
});
