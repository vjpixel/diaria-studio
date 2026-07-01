/**
 * known-dash-publishers-sources-sync.test.ts (#2693 item 2)
 *
 * `KNOWN_DASH_PUBLISHERS` (scripts/lib/strip-publisher-suffix.ts) é uma lista
 * hardcoded de veículos usada pra decidir se um sufixo ` - Veículo` /
 * ` — Veículo` deve ser strippado do título de um artigo. `seed/sources.csv`
 * é a fonte canônica de veículos cadastrados no pipeline — as duas listas
 * podem divergir quando uma fonte `Tipo=Brasil` (veículo de imprensa) é
 * cadastrada em `sources.csv` sem o correspondente ser adicionado a
 * `KNOWN_DASH_PUBLISHERS`.
 *
 * Full auto-sync foi avaliado e descartado (#2693): os nomes em `sources.csv`
 * carregam qualificadores que NÃO aparecem no og:title real do artigo (ex:
 * "G1 Tecnologia (IA)" cataloga a fonte, mas o sufixo real na página é só
 * "G1"; "MIT Technology Review Brasil (IA)" vs sufixo real "MIT Technology
 * Review"). Derivar automaticamente geraria falsos-negativos (não some) e
 * falsos-positivos (strip de qualificador que não deveria). Em vez disso,
 * este teste faz o papel de guard-rail: computa a divergência real hoje e
 * FALHA se ela mudar sem que alguém atualize a lista de gaps documentados
 * abaixo — força uma decisão consciente (adicionar a KNOWN_DASH_PUBLISHERS,
 * adicionar alias, ou reconhecer o gap) em vez de deixar passar em silêncio.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_DASH_PUBLISHERS } from "../scripts/lib/strip-publisher-suffix.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_CSV = resolve(ROOT, "seed", "sources.csv");

/**
 * Aliases pra fontes cujo nome cadastrado em sources.csv carrega
 * qualificador que não aparece no sufixo real do og:title do artigo.
 * Cada entrada documenta o porquê.
 */
const KNOWN_ALIASES: Record<string, string> = {
  // Cataloga a vertical "Tecnologia"; sufixo real na página é só "G1".
  "g1 tecnologia": "g1",
  // Edição brasileira do MIT Tech Review; sufixo real usa o brand genérico
  // (já coberto por "mit technology review"/"mit tech review" no set).
  "mit technology review brasil": "mit technology review",
};

/**
 * Fontes `Tipo=Brasil` cujo nome (normalizado) NÃO tem correspondente em
 * `KNOWN_DASH_PUBLISHERS` nem em `KNOWN_ALIASES` — gap conhecido e aceito
 * nesta passada (#2693 item 2). Se `sources.csv` mudar de forma que esta
 * lista precise mudar, o teste abaixo falha e força atualização consciente
 * (endereçar o gap ou documentar o novo).
 */
const ACKNOWLEDGED_GAPS = ["Tecnoblog (IA)", "CNN", "StartSe (IA)", "Brazil Journal (IA)"].sort();

interface SourceRow {
  nome: string;
  tipo: string;
}

/** Parser mínimo de sources.csv — só precisa das 2 primeiras colunas (Nome, Tipo). */
function parseSourcesCsv(csv: string): SourceRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows: SourceRow[] = [];
  for (const line of lines.slice(1)) {
    // Nome e Tipo nunca contêm vírgula nos dados reais — split simples basta
    // (colunas subsequentes com CSV quoted não afetam as 2 primeiras).
    const firstComma = line.indexOf(",");
    if (firstComma === -1) continue;
    const nome = line.slice(0, firstComma).trim();
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(",");
    const tipo = (secondComma === -1 ? rest : rest.slice(0, secondComma)).trim();
    rows.push({ nome, tipo });
  }
  return rows;
}

/** Remove qualificador `(IA)`/`(AI)` e normaliza pra lowercase. */
function normalizeSourceName(nome: string): string {
  return nome.replace(/\s*\((IA|AI)\)\s*$/i, "").trim().toLowerCase();
}

describe("KNOWN_DASH_PUBLISHERS vs seed/sources.csv (#2693 item 2)", () => {
  it("toda fonte Tipo=Brasil está coberta por KNOWN_DASH_PUBLISHERS, alias, ou gap reconhecido", () => {
    const csv = readFileSync(SOURCES_CSV, "utf8");
    const rows = parseSourcesCsv(csv);
    const brasilRows = rows.filter((r) => r.tipo === "Brasil");
    assert.ok(brasilRows.length > 0, "sanity: sources.csv deve ter fontes Tipo=Brasil");

    const gaps: string[] = [];
    for (const row of brasilRows) {
      const normalized = normalizeSourceName(row.nome);
      const aliased = KNOWN_ALIASES[normalized] ?? normalized;
      if (!KNOWN_DASH_PUBLISHERS.has(aliased)) {
        gaps.push(row.nome);
      }
    }
    gaps.sort();

    assert.deepEqual(
      gaps,
      ACKNOWLEDGED_GAPS,
      `Divergência entre seed/sources.csv (Tipo=Brasil) e KNOWN_DASH_PUBLISHERS mudou. ` +
        `Gaps computados: [${gaps.join(", ")}]. ` +
        `Se uma fonte NOVA apareceu aqui: adicionar a KNOWN_DASH_PUBLISHERS (strip-publisher-suffix.ts) ` +
        `ou a KNOWN_ALIASES neste teste, e/ou atualizar ACKNOWLEDGED_GAPS. ` +
        `Se um gap ANTIGO sumiu (foi corrigido): remover de ACKNOWLEDGED_GAPS.`,
    );
  });

  it("fontes Brasil cobertas hoje continuam cobertas (canaltech, exame, g1, mit tech review)", () => {
    // Regressão direta — não depende do parse do CSV, trava o caso feliz.
    assert.ok(KNOWN_DASH_PUBLISHERS.has("canaltech"));
    assert.ok(KNOWN_DASH_PUBLISHERS.has("exame"));
    assert.ok(KNOWN_DASH_PUBLISHERS.has("g1"));
    assert.ok(KNOWN_DASH_PUBLISHERS.has("mit technology review"));
  });
});
