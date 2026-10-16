/**
 * test/box-imersao-removida-8895.test.ts (#8895)
 *
 * A imersão "Crie seu agente de IA sem programar" foi no sábado 17/10/2026; o
 * último envio com a caixa foi a diária de 16/10. Depois disso, um CTA do
 * evento é anúncio de algo que já aconteceu. Trava a remoção nos três lugares
 * versionados que a carregavam:
 *
 *   1. `platform.config.json` → nenhum slot de `boxes_divulgacao` aponta pra
 *      uma caixa do evento (`agente-ia-*`, `workshop-agente-ia-*`,
 *      `diaria-imersao*`);
 *   2. template mensal e prompt do `writer-monthly` → sem o box DIVULGAÇÃO da
 *      imersão (link `utm_campaign=agente-ia` / imagem `caixa-agente`).
 *
 * A remoção do HTML do ciclo da Clarice em envio vive em `data/` (gitignored)
 * e não é testável aqui — registrada no PR.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, ROOT), "utf8");

const EVENT_BOX_RE = /^(agente-ia-|workshop-agente-ia|diaria-imersao|clarice-agente-ia|clarice-imersao)/;
const EVENT_LINK_RE = /diar\.ia\.br\/evento\/agente-ia|caixa-agente/;

describe("#8895 — caixa da imersão agente-ia fora da diária e da mensal", () => {
  it("platform.config.json: nenhum slot de boxes_divulgacao aponta pra caixa do evento", () => {
    const cfg = JSON.parse(read("platform.config.json"));
    for (const [key, value] of Object.entries(cfg.boxes_divulgacao ?? {})) {
      if (!/^slot\d$/.test(key) || typeof value !== "string") continue;
      assert.doesNotMatch(value, EVENT_BOX_RE, `boxes_divulgacao.${key} ainda aponta pra caixa da imersão (${value})`);
    }
  });

  for (const rel of ["context/templates/newsletter-monthly.md", ".claude/agents/writer-monthly.md"]) {
    it(`${rel}: sem o box DIVULGAÇÃO da imersão`, () => {
      assert.doesNotMatch(read(rel), EVENT_LINK_RE, `${rel} ainda divulga a imersão de 17/10`);
    });
  }

  it("controle: o detector pega o box que motivou a issue", () => {
    const old = "→ [Saiba mais](https://diar.ia.br/evento/agente-ia?utm_source=clarice&utm_medium=email&utm_campaign=agente-ia&utm_content=caixa-voz)";
    assert.match(old, EVENT_LINK_RE);
    assert.match("agente-ia-um-mes-em-uma-hora.md", EVENT_BOX_RE);
    assert.doesNotMatch("amazon-loja-divulgacao.md", EVENT_BOX_RE);
  });
});
