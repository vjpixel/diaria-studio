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

  it("recipients ausente no lado BEEHIIV nunca é lido como test-send", () => {
    // Lá "ausente" = cache velho, escrito antes do campo existir. Não há
    // corrida de agregação a perder (medido: presente em 265/265 posts).
    const semCampo: TestPost = { label: "sem-campo", status: "confirmed", origin: "beehiiv", publish_date: epochAt("260904") };
    assert.equal(semCampo.stats, undefined);
    assert.equal(matchPostsToWindow([semCampo], ["260904"]).get("260904")?.label, "sem-campo");
  });

  it("recipients ausente sem origem (caminho Beehiiv-only) também entra", () => {
    const semOrigem: TestPost = { label: "manifest", status: "confirmed", publish_date: epochAt("260904") };
    assert.equal(matchPostsToWindow([semOrigem], ["260904"]).get("260904")?.label, "manifest");
  });

  it("Kit COM agregação mas sem recipients entra — há evidência de stats fechadas", () => {
    // Distingue "lacuna de campo" de "corrida de agregação". Fixture do
    // #6185 (`weekly-instagram-select.test.ts`) depende deste caminho.
    const comOpens: TestPost = {
      label: "com-opens",
      status: "confirmed",
      origin: "kit",
      publish_date: epochAt("260904"),
      stats: { email: {} },
    };
    assert.equal(matchPostsToWindow([comOpens], ["260904"]).get("260904")?.label, "com-opens");
  });

  it("Kit sem NENHUMA agregação fica de fora — 'não sei' não é 'entrega real'", () => {
    // `normalizeKitBroadcast` só popula `recipients` junto com
    // `emails_opened`: se o kit-sync roda antes de a Kit agregar, `stats`
    // sai undefined. Deixar entrar reabriria o buraco do #7637 — um
    // test-send nessa janela competiria pela vaga da data.
    const statsNaoAgregadas: TestPost = { label: "kit-cru", status: "confirmed", origin: "kit", publish_date: epochAt("260904") };
    assert.equal(matchPostsToWindow([statsNaoAgregadas], ["260904"]).has("260904"), false);
  });

  it("Kit sem stats não rouba a vaga de um Beehiiv com entrega comprovada", () => {
    const kitCru: TestPost = { label: "kit-cru", status: "confirmed", origin: "kit", publish_date: epochAt("260904", 23) };
    const beehiiv = post("beehiiv", { origin: "beehiiv", publish_date: epochAt("260904", 9) });
    assert.equal(matchPostsToWindow([kitCru, beehiiv], ["260904"]).get("260904")?.label, "beehiiv");
  });

  it("recipients EXATAMENTE no piso conta como entrega real (>=, não >)", () => {
    const noPiso = post("no-piso", {
      origin: "kit",
      publish_date: epochAt("260904"),
      stats: { email: { recipients: MIN_REAL_DELIVERY_RECIPIENTS } },
    });
    assert.equal(matchPostsToWindow([noPiso], ["260904"]).get("260904")?.label, "no-piso");
  });

  it("um destinatário abaixo do piso já fica de fora", () => {
    const abaixo = post("abaixo", {
      origin: "kit",
      publish_date: epochAt("260904"),
      stats: { email: { recipients: MIN_REAL_DELIVERY_RECIPIENTS - 1 } },
    });
    assert.equal(matchPostsToWindow([abaixo], ["260904"]).has("260904"), false);
  });

  it("o piso de entrega real é uma faixa vazia, não uma fronteira apertada", () => {
    assert.equal(MIN_REAL_DELIVERY_RECIPIENTS, 10);
  });

  it("janela vazia devolve mapa vazio", () => {
    assert.equal(matchPostsToWindow([post("x", { origin: "kit", publish_date: epochAt("260904") })], []).size, 0);
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

  // NOTA: "origem desconhecida" deixou de ser testável em runtime depois do
  // review da PR #7638 — `origin` passou de `string` pra `EditionOrigin`
  // (union fechado) e `ORIGIN_PRECEDENCE` pra `Record<EditionOrigin, number>`,
  // então uma origem fora do union vira erro de COMPILAÇÃO, não fallback
  // silencioso pro piso. O guard migrou do teste pro compilador, que é onde
  // ele deveria estar — e o dia em que `EditionOrigin` ganhar um 3º valor,
  // `ORIGIN_PRECEDENCE` não compila até alguém decidir a precedência dele.

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
