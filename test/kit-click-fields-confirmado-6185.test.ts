/**
 * test/kit-click-fields-confirmado-6185.test.ts (#6185)
 *
 * Trava o formato de `GET /v4/broadcasts/{id}/clicks` contra a **amostra
 * real** medida em 26/08/2026 — não contra uma inventada.
 *
 * Essa distinção não é estilo. O fleet review do #6202 mostrou o custo de
 * fixture sintética: um HTML de teste minúsculo escondeu que toda edição
 * real carrega merge tag crua, e o bug só apareceu quando alguém foi olhar o
 * arquivo de verdade. Aqui a fixture é literalmente o que a API devolveu.
 *
 * O que estes testes protegem: se o Kit mudar o formato (renomear campo,
 * trocar tipo, parar de devolver `id`), os 23 consumidores de clique da
 * curadoria — Use Melhor/Radar do mensal, boxes por clique, CTR
 * comportamental — passariam a ler `undefined` e **degradariam em silêncio**,
 * ranqueando por nada. Este arquivo é o alarme.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  interpretClicksResponse,
  CAMPOS_DECLARADOS,
  CAMPOS_DECLARADOS_COM_TIPO,
} from "../scripts/lib/kit-click-fields.ts";
import type { KitBroadcastClick } from "../scripts/lib/kit-client.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AMOSTRA_REAL = JSON.parse(
  readFileSync(resolve(ROOT, "test/fixtures/kit-broadcast-click-6185.json"), "utf8"),
) as Record<string, unknown>;

/** Só os campos de dado — os `_origem`/`_por_que` são documentação da fixture. */
function semMeta(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));
}

describe("#6185 amostra real do Kit — formato travado", () => {
  it("a fixture satisfaz o tipo KitBroadcastClick", () => {
    const c = semMeta(AMOSTRA_REAL) as unknown as KitBroadcastClick;
    assert.equal(typeof c.id, "number");
    assert.equal(typeof c.url, "string");
    assert.equal(typeof c.unique_clicks, "number");
    assert.equal(typeof c.click_to_delivery_rate, "number");
    assert.equal(typeof c.click_to_open_rate, "number");
  });

  it("a sonda CONFIRMA a amostra real, sem campo ausente nem divergente", () => {
    const v = interpretClicksResponse({ clicks: [semMeta(AMOSTRA_REAL)] });
    assert.equal(v.status, "confirmado");
    if (v.status === "confirmado") {
      assert.deepEqual(v.ausentes, [], "nenhum campo declarado pode faltar na amostra real");
      assert.deepEqual(v.tipoDivergente, [], "nenhum campo declarado pode vir com tipo errado");
      assert.deepEqual(v.presentes.sort(), [...CAMPOS_DECLARADOS].sort());
    }
  });

  it("REGRESSÃO: `id` está na fixture E no tipo — os dois amarrados", () => {
    // Descoberto pela sonda, que reporta campos inesperados justamente pra
    // tipo e realidade não divergirem em silêncio.
    assert.equal(typeof AMOSTRA_REAL.id, "number");

    // E o vínculo com a DECLARAÇÃO. Não dá pra amarrar via compilador aqui:
    // `tsconfig.json` inclui só `scripts/**/*.ts`, então NENHUM arquivo de
    // teste é type-checked (descoberto ao tentar exatamente isso — um erro
    // de tipo proposital neste arquivo não produziu erro de build).
    //
    // Por isso o vínculo é em runtime, contra `CAMPOS_DECLARADOS_COM_TIPO`,
    // que vive em `scripts/` e É checado. Remover `id` de lá quebra aqui.
    assert.ok("id" in CAMPOS_DECLARADOS_COM_TIPO, "`id` precisa estar declarado no mapa de campos");
  });

  it("as taxas são fração (0–1), não porcentagem — a confusão custa 100×", () => {
    const c = semMeta(AMOSTRA_REAL) as unknown as KitBroadcastClick;
    for (const [nome, v] of [
      ["click_to_delivery_rate", c.click_to_delivery_rate],
      ["click_to_open_rate", c.click_to_open_rate],
    ] as const) {
      assert.ok(v >= 0 && v <= 1, `${nome}=${v} fora de 0–1: virou porcentagem?`);
    }
  });

  it("`unique_clicks` é contagem inteira, não taxa", () => {
    const c = semMeta(AMOSTRA_REAL) as unknown as KitBroadcastClick;
    assert.ok(Number.isInteger(c.unique_clicks), "contagem tem de ser inteira");
  });

  it("REGRESSÃO: um campo renomeado pelo Kit é DETECTADO, não ignorado", () => {
    // O modo de falha real: o Kit renomeia `unique_clicks`, os consumidores
    // leem `undefined`, a curadoria passa a ranquear por nada — sem erro.
    const renomeado = { ...semMeta(AMOSTRA_REAL), clicks: 1 };
    delete (renomeado as Record<string, unknown>).unique_clicks;
    const v = interpretClicksResponse({ clicks: [renomeado] });
    assert.equal(v.status, "confirmado");
    if (v.status === "confirmado") {
      assert.ok(v.ausentes.includes("unique_clicks"), "o campo sumido precisa ser acusado");
      assert.ok(v.inesperados.includes("clicks"), "o nome novo precisa aparecer");
    }
  });
});
