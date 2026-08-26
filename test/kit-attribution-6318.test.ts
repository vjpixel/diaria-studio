/**
 * test/kit-attribution-6318.test.ts (#6318)
 *
 * Regressão do backfill de atribuição da base Kit. O bug original: todo
 * cadastro entrou no Kit sem UTM porque nada escrevia atribuição — nem os
 * funis (env vars nunca ligadas), nem o import da Beehiiv.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildAttributionFields,
  jaBackfillado,
  montarPlano,
  ATRIBUICAO_FONTE_BEEHIIV,
  ATTRIBUTION_FIELD_KEYS,
} from "../scripts/lib/kit-attribution.ts";
import { extractUrl, isAssetRequest, snapshotDirName } from "../scripts/dump-worker-logs.ts";
import { escolherSnapshot } from "../scripts/backfill-kit-attribution.ts";

describe("buildAttributionFields", () => {
  test("mapeia os 7 campos da Beehiiv e marca a procedencia", () => {
    const fields = buildAttributionFields({
      email: "a@b.com",
      utm_source: "linkedin",
      utm_medium: "organic_social",
      utm_campaign: "eia-post",
      utm_channel: "website",
      utm_term: "t",
      utm_content: "c",
      referring_site: "https://linkedin.com",
    });
    assert.deepEqual(fields, {
      utm_source: "linkedin",
      utm_medium: "organic_social",
      utm_campaign: "eia-post",
      utm_channel: "website",
      utm_term: "t",
      utm_content: "c",
      referring_site: "https://linkedin.com",
      atribuicao_fonte: ATRIBUICAO_FONTE_BEEHIIV,
    });
  });

  test("campo vazio e OMITIDO, nunca gravado como string vazia", () => {
    // Gravar "" tornaria "a Beehiiv nao sabia" indistinguivel de "ninguem
    // preencheu ainda" — a ambiguidade que o backfill existe pra desfazer.
    const fields = buildAttributionFields({
      email: "a@b.com",
      utm_source: "direct",
      utm_medium: "",
      utm_campaign: "   ",
      utm_channel: "website",
    });
    assert.deepEqual(fields, {
      utm_source: "direct",
      utm_channel: "website",
      atribuicao_fonte: ATRIBUICAO_FONTE_BEEHIIV,
    });
  });

  test("sem atribuicao nenhuma devolve null (nao gera chamada so pro marcador)", () => {
    assert.equal(buildAttributionFields({ email: "a@b.com" }), null);
    assert.equal(buildAttributionFields({ email: "a@b.com", utm_source: "", referring_site: "" }), null);
  });

  test("utm_channel esta no conjunto — e o que separa organico de boost pago", () => {
    assert.ok(ATTRIBUTION_FIELD_KEYS.includes("utm_channel"));
    assert.equal(ATTRIBUTION_FIELD_KEYS.length, 7);
  });
});

describe("jaBackfillado", () => {
  test("olha atribuicao_fonte, nao os campos de UTM", () => {
    // Um assinante cuja origem tinha so utm_source ficaria com 6 campos
    // vazios pra sempre; checar "algum UTM preenchido" o reprocessaria
    // a cada rodada.
    assert.equal(jaBackfillado({ atribuicao_fonte: ATRIBUICAO_FONTE_BEEHIIV }), true);
    assert.equal(jaBackfillado({ utm_source: "linkedin", atribuicao_fonte: null }), false);
    assert.equal(jaBackfillado({}), false);
    assert.equal(jaBackfillado(undefined), false);
  });
});

describe("montarPlano", () => {
  const beehiiv = new Map([
    ["casa@x.com", { email: "casa@x.com", utm_source: "linkedin", utm_channel: "website" }],
    ["vazio@x.com", { email: "vazio@x.com", utm_source: "", utm_medium: "" }],
    ["feito@x.com", { email: "feito@x.com", utm_source: "google.com" }],
  ]);

  test("separa as 4 populacoes, inclusive as que nao serao tocadas", () => {
    const plano = montarPlano(
      [
        { id: 1, email_address: "casa@x.com" },
        { id: 2, email_address: "vazio@x.com" },
        { id: 3, email_address: "nasceu-no-kit@x.com" },
        { id: 4, email_address: "feito@x.com", fields: { atribuicao_fonte: ATRIBUICAO_FONTE_BEEHIIV } },
      ],
      beehiiv,
    );
    assert.equal(plano.aplicar.length, 1);
    assert.equal(plano.aplicar[0].subscriberId, 1);
    assert.equal(plano.jaFeitos, 1);
    assert.deepEqual(plano.semOrigem, ["nasceu-no-kit@x.com"]);
    assert.deepEqual(plano.origemVazia, ["vazio@x.com"]);
  });

  test("casa e-mail sem depender de caixa", () => {
    const plano = montarPlano([{ id: 1, email_address: "CASA@X.com" }], beehiiv);
    assert.equal(plano.aplicar.length, 1);
  });

  test("--force reprocessa quem ja tinha o marcador", () => {
    const plano = montarPlano(
      [{ id: 4, email_address: "feito@x.com", fields: { atribuicao_fonte: ATRIBUICAO_FONTE_BEEHIIV } }],
      beehiiv,
      { force: true },
    );
    assert.equal(plano.aplicar.length, 1);
    assert.equal(plano.jaFeitos, 0);
  });
});

describe("dump-worker-logs (helpers puros)", () => {
  test("extrai a URL da mensagem do evento", () => {
    assert.equal(
      extractUrl({ source: { message: "GET https://eia.diar.ia.br/jogar?utm_source=facebook" } }),
      "https://eia.diar.ia.br/jogar?utm_source=facebook",
    );
    assert.equal(extractUrl({ source: { message: "sem url" } }), null);
    assert.equal(extractUrl({}), null);
  });

  test("descarta asset, preserva request com atribuicao", () => {
    assert.equal(isAssetRequest({ source: { message: "GET https://eia.diar.ia.br/img/x.jpg" } }), true);
    assert.equal(isAssetRequest({ source: { message: "GET https://eia.diar.ia.br/favicon.ico" } }), true);
    assert.equal(
      isAssetRequest({ source: { message: "GET https://eia.diar.ia.br/jogar?utm_source=facebook" } }),
      false,
    );
    assert.equal(isAssetRequest({ source: { message: "POST https://cursos.diar.ia.br/gate/subscribe" } }), false);
  });

  test("nome do diretorio do snapshot e a data ISO", () => {
    assert.equal(snapshotDirName(new Date("2026-08-26T18:38:00Z")), "2026-08-26");
  });
});

describe("escolherSnapshot", () => {
  test("sem pedido, pega o mais recente e ignora entradas fora do padrao", () => {
    assert.equal(escolherSnapshot(["2026-08-23", "2026-06-17", "lixo", "2026-08-26"]), "2026-08-26");
  });

  test("com pedido, exige que exista — nao cai em fallback silencioso", () => {
    assert.equal(escolherSnapshot(["2026-08-23", "2026-08-26"], "2026-08-23"), "2026-08-23");
    assert.equal(escolherSnapshot(["2026-08-23"], "2026-08-26"), null);
  });

  test("diretorio sem snapshot nenhum devolve null", () => {
    assert.equal(escolherSnapshot([]), null);
    assert.equal(escolherSnapshot(["lixo"]), null);
  });
});
