/**
 * test/blind-label-sample.test.ts (#5995)
 *
 * Guard das partes PURAS de `scripts/blind-label-sample.ts` — a ferramenta de
 * rotulagem às cegas que produz gabarito limpo para medir o categorizador.
 *
 * Só as funções sem I/O são testadas: o corpus (`data/editions/`) é uma
 * junction local do OneDrive, ausente em clone fresco e no CI (CLAUDE.md 2b),
 * então qualquer teste que dependesse dele passaria vazio e não guardaria nada.
 *
 * O que estas duas propriedades protegem, e por quê:
 *
 *   1. `stableRank` determinístico — a amostra é sorteada por hash do URL, não
 *      por RNG, justamente para que re-rodar `--generate` NÃO reembaralhe o
 *      conjunto e invalide rótulos já dados pelo editor. Trocar por
 *      `Math.random()` quebraria isso em silêncio: a amostra continuaria
 *      "funcionando", só deixaria de ser a mesma entre rodadas.
 *   2. `bucketQuota` respeita piso E teto — o piso (8) existe pra bucket raro
 *      render precisão própria; o teto (tamanho do bucket) existe porque pedir
 *      mais itens do que o bucket tem devolveria menos itens que o esperado e
 *      enviesaria a estratificação sem erro visível.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stableRank, bucketQuota, MIN_PER_BUCKET } from "../scripts/blind-label-sample.ts";

describe("stableRank", () => {
  it("é determinístico para o mesmo URL", () => {
    const u = "https://blog.google/products/ads-commerce/ads-decoded-finale/";
    assert.equal(stableRank(u), stableRank(u));
  });

  it("separa URLs diferentes (ordem estável, não agrupada por prefixo)", () => {
    const a = stableRank("https://example.com/a");
    const b = stableRank("https://example.com/b");
    assert.notEqual(a, b);
  });

  it("produz ordenação idêntica em duas passadas — rótulos já dados sobrevivem a --generate", () => {
    const urls = [
      "https://openai.com/index/stargate-michigan-data-center",
      "https://huggingface.co/blog/openenv-agentic-rl",
      "https://blogs.nvidia.com/blog/ai-cloud-ecosystem/",
      "https://www.latent.space/p/ainews-gpt-55-and-openai-codex-superapp",
    ];
    const once = [...urls].sort((x, y) => stableRank(x) - stableRank(y));
    const twice = [...urls].sort((x, y) => stableRank(x) - stableRank(y));
    assert.deepEqual(once, twice);
  });
});

describe("bucketQuota", () => {
  it("é proporcional quando o bucket é grande", () => {
    // 3000 de 4000 itens, alvo 60 → 45
    assert.equal(bucketQuota(3000, 4000, 60), 45);
  });

  it("aplica o piso quando a proporção daria menos", () => {
    // 100 de 4000, alvo 60 → proporcional 2, piso 8 vence
    assert.equal(bucketQuota(100, 4000, 60), MIN_PER_BUCKET);
  });

  it("nunca pede mais itens do que o bucket tem, mesmo abaixo do piso", () => {
    assert.equal(bucketQuota(3, 4000, 60), 3);
  });

  it("devolve 0 para bucket ou pool vazios em vez de NaN/Infinity", () => {
    assert.equal(bucketQuota(0, 4000, 60), 0);
    assert.equal(bucketQuota(10, 0, 60), 0);
  });
});
