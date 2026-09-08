/**
 * test/click-window-resolution.test.ts (#7637)
 *
 * Regressão do defeito de fusão Beehiiv×Kit na resolução "qual post do cache
 * é a edição do dia X" — a peça que `/diaria-linkedin-semanal` e
 * `/diaria-instagram-semanal` compartilham desde o #7637 (antes disso, duas
 * cópias byte-a-byte, e o defeito estava nas duas).
 *
 * Sem rede, sem disco — fixtures em memória, mesmo padrão de
 * `test/weekly-linkedin-clicks.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  matchPostsToWindow,
  detectPostCutoverBeehiivDates,
  detectDualOriginDates,
  KIT_SEND_CUTOVER_AAMMDD,
  MIN_REAL_DELIVERY_RECIPIENTS,
  type ClickWindowPostBase,
} from "../scripts/lib/shared/click-window-resolution.ts";
import { matchPostsToWindow as matchFromLinkedin } from "../scripts/lib/weekly-linkedin-clicks.ts";
import { matchPostsToWindow as matchFromInstagram } from "../scripts/lib/weekly-instagram-select.ts";

/** epoch seconds pra `AAMMDD` numa hora local específica (default 09:00). */
function epochAt(aammdd: string, hour = 9, minute = 0): number {
  const yy = Number(aammdd.slice(0, 2));
  const mm = Number(aammdd.slice(2, 4));
  const dd = Number(aammdd.slice(4, 6));
  return Math.floor(new Date(2000 + yy, mm - 1, dd, hour, minute, 0).getTime() / 1000);
}

interface TestPost extends ClickWindowPostBase {
  label: string;
}

/** Entrega real por default (630 = a edição de 260904 medida ao vivo). */
function post(label: string, over: Partial<TestPost> = {}): TestPost {
  return { label, status: "confirmed", stats: { email: { recipients: 630 } }, ...over };
}

/** Test-send do `review-test-email`: 1 destinatário (medido em 260904). */
function testSend(label: string, over: Partial<TestPost> = {}): TestPost {
  return { ...post(label, over), stats: { email: { recipients: 1 } } };
}

describe("matchPostsToWindow — desempate por origem (#7637)", () => {
  it("Kit vence Beehiiv na mesma data MESMO com publish_date menor", () => {
    // O ponto do teste: se o critério ainda fosse `publish_date`, a Beehiiv
    // (09:02) venceria o Kit (04:08). Pós-#7637 a origem decide primeiro.
    const beehiiv = post("beehiiv", { origin: "beehiiv", publish_date: epochAt("260904", 9, 2) });
    const kit = post("kit", { origin: "kit", publish_date: epochAt("260904", 4, 8), public: true });

    for (const ordem of [
      [beehiiv, kit],
      [kit, beehiiv],
    ]) {
      const out = matchPostsToWindow(ordem, ["260904"]);
      assert.equal(out.get("260904")?.label, "kit", "Kit tem que vencer independente da ordem de chegada");
    }
  });

  it("test-send do Kit nunca ganha a vaga, nem sendo o mais recente", () => {
    const real = post("real", { origin: "kit", publish_date: epochAt("260904", 9, 2) });
    const teste = testSend("teste", { origin: "kit", publish_date: epochAt("260904", 23, 59) });

    const out = matchPostsToWindow([real, teste], ["260904"]);
    assert.equal(out.get("260904")?.label, "real");
  });

  it("test-send sozinho na data não vira a edição — a data fica ausente", () => {
    // Fail-loud: melhor a data sumir (e o warning de "sem dados de clique"
    // disparar) do que ranquear a semana pelos cliques de um teste.
    const teste = testSend("teste", { origin: "kit", publish_date: epochAt("260904") });
    const out = matchPostsToWindow([teste], ["260904"]);
    assert.equal(out.has("260904"), false);
  });

  it("edição REAL com public:false (cohort da rampa Kit) continua entrando — o campo não discrimina teste", () => {
    // Regressão do erro que a medição derrubou: filtrar por `public` apagava
    // 260831-260903 inteiras (reais, 280 destinatários, `public:false`).
    const rampa = post("rampa", {
      origin: "kit",
      publish_date: epochAt("260903"),
      stats: { email: { recipients: 280 } },
    });
    assert.equal(matchPostsToWindow([rampa], ["260903"]).get("260903")?.label, "rampa");
  });

  it("recipients ausente nunca é lido como test-send", () => {
    const semCampo: TestPost = { label: "sem-campo", status: "confirmed", origin: "beehiiv", publish_date: epochAt("260904") };
    assert.equal(semCampo.stats, undefined);
    assert.equal(matchPostsToWindow([semCampo], ["260904"]).get("260904")?.label, "sem-campo");
  });

  it("o piso de entrega real é uma faixa vazia, não uma fronteira apertada", () => {
    assert.equal(MIN_REAL_DELIVERY_RECIPIENTS, 10);
  });

  it("Beehiiv ainda resolve a data quando o Kit não tem post nenhum", () => {
    const beehiiv = post("beehiiv", { origin: "beehiiv", publish_date: epochAt("260904") });
    const out = matchPostsToWindow([beehiiv], ["260904"]);
    assert.equal(out.get("260904")?.label, "beehiiv");
  });

  it("sem origem (caminho Beehiiv-only) o desempate continua sendo publish_date — pré-#7637 preservado", () => {
    const cedo = post("cedo", { publish_date: epochAt("260904", 4, 0) });
    const tarde = post("tarde", { publish_date: epochAt("260904", 9, 0) });
    const out = matchPostsToWindow([cedo, tarde], ["260904"]);
    assert.equal(out.get("260904")?.label, "tarde");
  });

  it("origem desconhecida não vence Kit nem Beehiiv por acidente", () => {
    const kit = post("kit", { origin: "kit", publish_date: epochAt("260904", 4, 0) });
    const alien = post("alien", { origin: "substack", publish_date: epochAt("260904", 23, 0) });
    assert.equal(matchPostsToWindow([kit, alien], ["260904"]).get("260904")?.label, "kit");
  });

  it("status != confirmed continua fora, em qualquer origem", () => {
    const scheduled = post("scheduled", { origin: "kit", status: "scheduled", publish_date: epochAt("260904") });
    assert.equal(matchPostsToWindow([scheduled], ["260904"]).has("260904"), false);
  });
});

describe("detectDualOriginDates (#7637)", () => {
  it("acusa a data em que as duas origens entregaram de verdade", () => {
    const posts = [
      post("bh", { origin: "beehiiv", publish_date: epochAt("260903") }),
      post("kit", { origin: "kit", publish_date: epochAt("260903"), stats: { email: { recipients: 280 } } }),
      post("so-kit", { origin: "kit", publish_date: epochAt("260904") }),
    ];
    assert.deepEqual(detectDualOriginDates(posts, ["260903", "260904"]), ["260903"]);
  });

  it("test-send não conta como segunda origem", () => {
    const posts = [
      post("kit", { origin: "kit", publish_date: epochAt("260904", 9) }),
      testSend("teste", { origin: "beehiiv", publish_date: epochAt("260904", 10) }),
    ];
    assert.deepEqual(detectDualOriginDates(posts, ["260904"]), []);
  });

  it("janela pós-cutover (Kit sozinho) não gera warning", () => {
    const posts = [post("kit", { origin: "kit", publish_date: epochAt("260907") })];
    assert.deepEqual(detectDualOriginDates(posts, ["260907"]), []);
  });
});

describe("detectPostCutoverBeehiivDates (#7637)", () => {
  it("acusa data pós-cutover que resolveu pro cache Beehiiv", () => {
    const win = new Map<string, ClickWindowPostBase>([
      ["260903", { origin: "beehiiv" }], // pré-cutover: legítimo, não acusa
      ["260904", { origin: "beehiiv" }], // no cutover: acusa
      ["260907", { origin: "beehiiv" }], // pós-cutover: acusa
      ["260908", { origin: "kit" }], // Kit: nunca acusa
    ]);
    assert.deepEqual(detectPostCutoverBeehiivDates(win), ["260904", "260907"]);
  });

  it("janela toda em Kit não gera warning nenhum", () => {
    const win = new Map<string, ClickWindowPostBase>([
      ["260907", { origin: "kit" }],
      ["260908", { origin: "kit" }],
    ]);
    assert.deepEqual(detectPostCutoverBeehiivDates(win), []);
  });

  it("origem ausente (caminho Beehiiv-only) não gera warning — não há o que comparar", () => {
    const win = new Map<string, ClickWindowPostBase>([["260907", {}]]);
    assert.deepEqual(detectPostCutoverBeehiivDates(win), []);
  });

  it("o cutover é a data da 1ª edição só-Kit (#7388/#7386)", () => {
    assert.equal(KIT_SEND_CUTOVER_AAMMDD, "260904");
  });
});

describe("re-export único (#7637)", () => {
  it("LinkedIn e Instagram semanais compartilham a MESMA função, não cópias", () => {
    // O defeito do #7637 existia em duplicata porque cada módulo tinha a sua
    // cópia. Identidade referencial é o guard contra a duplicação voltar.
    assert.equal(matchFromLinkedin, matchPostsToWindow);
    assert.equal(matchFromInstagram, matchPostsToWindow);
  });
});
