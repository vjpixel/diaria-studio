/**
 * store-excludes-clarice.test.ts (#7196 — fatia 1 do épico #7163)
 *
 * Guard mecânico: o store da diária (`data/diaria-subscribers/*`) e a base
 * da Clarice News (`clarice_users`, `scripts/lib/clarice-db.ts`) são bancos
 * IRMÃOS que nunca se cruzam. Dois eixos, ambos travados aqui:
 *
 *   1. `brevo_clarice` nunca reaparece como valor de `Platform` — nem no
 *      array `PLATFORMS`, nem como substring solta em qualquer arquivo do
 *      "caminho da diária" (a lista `DIARIA_PATH_FILES` abaixo).
 *   2. Nenhum arquivo do caminho da diária importa `clarice-db.ts` — a
 *      Clarice tem ingestão/dashboard próprios e este guard garante que
 *      eles continuam desconectados do store novo.
 *
 * `scripts/studio-ui/studio-integrations.ts` (probe de env vars pra exibir
 * no painel de integrações) e os scripts `clarice-*` (pipeline PRÓPRIO da
 * Clarice) ficam DE FORA de propósito — citar "brevo_clarice"/importar
 * `clarice-db.ts` ali é legítimo, não é o caminho da diária.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PLATFORMS } from "../scripts/lib/diaria-subscribers-db.ts";

const ROOT = resolve(import.meta.dirname, "..");

/** Arquivos que compõem o caminho da diária pro store unificado (#6464) —
 *  nenhum deles pode citar "brevo_clarice" nem importar `clarice-db.ts`. */
const DIARIA_PATH_FILES = [
  "scripts/lib/diaria-subscribers-db.ts",
  "scripts/lib/diaria-subscribers-ingest-manifest.ts",
  "scripts/lib/diaria-subscribers-identity-resolve.ts",
  "scripts/lib/brevo-subscribers-ingest.ts",
  "scripts/lib/leitor-store.ts",
  "scripts/lib/leitor.ts",
  "scripts/lib/diaria-subscribers-recency.ts",
  "scripts/diaria-subscribers-ingest-brevo.ts",
  "scripts/studio-ui/studio-subscribers.ts",
];

describe("PLATFORMS nunca inclui brevo_clarice", () => {
  it("brevo_clarice fora do array — exclusão estrutural, não filtro em runtime", () => {
    assert.ok(!(PLATFORMS as readonly string[]).includes("brevo_clarice"));
  });

  it("PLATFORMS só tem as 3 plataformas da diária", () => {
    assert.deepEqual([...PLATFORMS].sort(), ["beehiiv", "brevo_diaria", "kit"].sort());
  });
});

describe("caminho da diária nunca cita brevo_clarice", () => {
  for (const relPath of DIARIA_PATH_FILES) {
    it(`${relPath}: grep por "brevo_clarice" só em prosa que EXPLICA a exclusão`, () => {
      const content = readFileSync(resolve(ROOT, relPath), "utf8");
      const lines = content.split("\n");
      const hits = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => line.includes("brevo_clarice"));
      // Toda ocorrência precisa estar dentro de um comentário/docstring —
      // nunca em código executável (string literal, valor de tipo, chave de
      // objeto real). Heurística barata: a linha, além de "brevo_clarice",
      // precisa carregar marca de comentário (`*`, `//`) — suficiente pro
      // estilo deste repo, sem parser de TS completo.
      for (const { line, n } of hits) {
        assert.match(
          line,
          /^\s*(\/\/|\*|\/\*)/,
          `${relPath}:${n} cita "brevo_clarice" fora de comentário — reintroduziu a Clarice no caminho da diária? linha: ${line.trim()}`,
        );
      }
    });
  }
});

describe("caminho da diária nunca importa clarice-db.ts", () => {
  // Só pega IMPORT/REQUIRE de verdade (`from "...clarice-db.ts"` ou
  // `require("...clarice-db")`) — citar "clarice-db.ts" em prosa
  // explicando por que os dois bancos são irmãos (como este próprio arquivo
  // e a docstring de PLATFORMS fazem) não é um import e não deve disparar
  // o guard.
  const IMPORT_PATTERN = /(from\s+["'][^"']*clarice-db(\.ts)?["']|require\(\s*["'][^"']*clarice-db(\.ts)?["']\s*\))/;
  for (const relPath of DIARIA_PATH_FILES) {
    it(`${relPath}: sem import de clarice-db.ts`, () => {
      const content = readFileSync(resolve(ROOT, relPath), "utf8");
      assert.ok(
        !IMPORT_PATTERN.test(content),
        `${relPath} IMPORTA clarice-db.ts — os dois bancos precisam continuar irmãos, nunca importados um pelo outro (ver docstring de PLATFORMS)`,
      );
    });
  }
});
