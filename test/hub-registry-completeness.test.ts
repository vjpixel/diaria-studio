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
});
