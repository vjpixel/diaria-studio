/**
 * test/site-home-hub-links-6411.test.ts (#6411)
 *
 * Trava o bloco "Por tema" da home contra o eixo `hub-link-missing` do
 * alarme `Diaria-Beehiiv-Home-Meta-Check`.
 *
 * O teste central aqui NÃO conta links nem casa strings: ele roda o PRÓPRIO
 * detector do alarme (`detectMissingHubLinks`) sobre o HTML que o gerador
 * produz e exige lista vazia. É o que fecha o loop — antes do #6411 o link
 * de cada hub na home era um passo MANUAL de painel Beehiiv (ver o "4º
 * passo" na docstring de `workers/arquivo/src/hubs/meta.ts`), e por isso os
 * 7 hubs publicados ficaram sem porta de entrada na home até 28/08/2026,
 * com o alarme reabrindo a mesma issue todo dia às 09:35 BRT.
 *
 * Como `renderTopicLinks` deriva de `HUB_META` — a mesma fonte que
 * `detectMissingHubLinks` cruza —, um hub novo entrando em `HUB_META` já
 * nasce linkado. Este teste existe pra garantir que uma refatoração futura
 * não volte a listar os slugs à mão (o que reintroduziria o drift em
 * silêncio) e pra travar o arquivo COMMITTED, que é o que de fato vai pro ar
 * (deploy automático em push de `workers/site/**`) — gerador certo com
 * `index.html` desatualizado no repo serviria a home velha.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndexHtml } from "../scripts/lib/site-home-page.ts";
import { detectMissingHubLinks } from "../scripts/lib/beehiiv-home-meta-check.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = resolve(ROOT, "workers", "site", "public", "index.html");

const FEATURE = {
  slug: "exemplo",
  title: "Título de exemplo",
  description: "Descrição de exemplo",
  url: "https://diar.ia.br/p/exemplo",
  date: "2026-08-28",
};

describe("home — bloco Por tema (#6411)", () => {
  it("o HTML gerado satisfaz o eixo hub-link-missing do alarme", () => {
    const html = buildIndexHtml({ feature: FEATURE, archive: [] });
    assert.deepEqual(detectMissingHubLinks(html), []);
  });

  it("o index.html COMMITTED satisfaz o mesmo eixo", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    assert.deepEqual(detectMissingHubLinks(html), []);
  });

  it("cada hub aponta pro host que de fato serve /temas/{slug}", () => {
    // O apex devolve 404 em /temas/{slug} — quem serve os hubs é o Worker
    // arquivo. `detectMissingHubLinks` casa o path independente de host, então
    // um link relativo passaria o eixo e quebraria pro leitor.
    const html = readFileSync(INDEX_PATH, "utf8");
    for (const hub of HUB_META) {
      assert.ok(
        html.includes(`https://arquivo.diar.ia.br/temas/${hub.slug}`),
        `hub ${hub.slug} sem link absoluto pro host arquivo`,
      );
      assert.ok(html.includes(hub.label), `hub ${hub.slug} sem o rótulo humano de HUB_META`);
    }
  });

  it("não linka nenhum /temas/ órfão — hub despublicado some da home", () => {
    // Cobre o sentido que `detectMissingHubLinks` NÃO cobre: ele só acha hub
    // de HUB_META FALTANDO na home, nunca um link SOBRANDO. Se o bloco
    // voltar a ser lista fixa, remover um hub de HUB_META (despublicar)
    // deixaria o link para trás — 404 pro leitor, e os testes acima
    // continuariam verdes. Derivar da fonte torna os dois sentidos verdade;
    // este teste é quem trava isso.
    const html = buildIndexHtml({ feature: FEATURE, archive: [] });
    const linked = [...html.matchAll(/\/temas\/([a-z0-9-]+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(linked)].sort(), HUB_META.map((h) => h.slug).sort());
  });
});
