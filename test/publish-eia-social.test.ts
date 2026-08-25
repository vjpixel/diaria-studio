/**
 * publish-eia-social.test.ts
 *
 * Cobre o miolo PURE de `scripts/publish-eia-social.ts`. As chamadas de rede
 * (KV, fila do Worker, Graph API) ficam de fora — o que dá pra travar aqui é
 * a leitura dos textos por canal, a escolha de arte e a validação do `--at`,
 * que é onde um erro publica na hora errada em conta pública.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractChannelText,
  imagesForChannel,
  parseScheduledAt,
  buildPlans,
  pendingChannels,
  EIA_CHANNELS,
  type EiaPublishedState,
} from "../scripts/publish-eia-social.ts";

const ART = { composite: "/ab.jpg", a: "/A.jpg", b: "/B.jpg" };

const MD = `# É IA? social

> Comentário do arquivo, não é corpo de post.

## linkedin

Texto do LinkedIn.

Segunda linha.

## facebook

Texto do Facebook.

## instagram

Texto do Instagram.

## threads

Texto do Threads.

## twitter

Texto do X.
`;

describe("extractChannelText", () => {
  it("lê cada canal sem vazar o vizinho", () => {
    assert.equal(extractChannelText(MD, "linkedin"), "Texto do LinkedIn.\n\nSegunda linha.");
    assert.equal(extractChannelText(MD, "facebook"), "Texto do Facebook.");
    assert.equal(extractChannelText(MD, "twitter"), "Texto do X.");
  });

  it("devolve null pra canal ausente", () => {
    assert.equal(extractChannelText(MD, "bluesky"), null);
  });

  it("não trunca o corpo numa linha que começa com '# '", () => {
    // Só `## ` (ou o fim do arquivo) encerra a seção: uma linha de markdown
    // editada à mão que comece com "# " cortaria o post em silêncio, e o que
    // sairia publicado seria menos do que o editor escreveu.
    const comCerquilha = "# É IA? social\n\n## linkedin\n\nPrimeira linha.\n\n# 5 minutos por dia\n\nÚltima linha.\n\n## facebook\n\nOutro.\n";
    const body = extractChannelText(comCerquilha, "linkedin");
    assert.ok(body?.includes("Última linha."), "corpo truncado no '# '");
    assert.ok(!body?.includes("Outro."), "vazou a seção vizinha");
  });

  it("não confunde o comentário do topo com corpo de post", () => {
    const semSecao = "# É IA? social\n\n> Só o comentário.\n";
    assert.equal(extractChannelText(semSecao, "linkedin"), null);
  });
});

describe("imagesForChannel", () => {
  it("dá carrossel A→B só pro Instagram", () => {
    assert.deepEqual(imagesForChannel("instagram", ART), ["/A.jpg", "/B.jpg"]);
    for (const ch of EIA_CHANNELS) {
      if (ch === "instagram") continue;
      assert.deepEqual(imagesForChannel(ch, ART), ["/ab.jpg"], `${ch} devia levar o composto`);
    }
  });
});

describe("buildPlans", () => {
  it("monta um plano por canal não pulado", () => {
    const plans = buildPlans(MD, ART, new Set(["twitter"]));
    assert.deepEqual(plans.map((p) => p.channel), ["linkedin", "facebook", "instagram", "threads"]);
  });

  it("aborta quando falta texto de um canal não pulado", () => {
    const semThreads = MD.replace(/## threads\n\nTexto do Threads\.\n\n/, "");
    assert.throws(() => buildPlans(semThreads, ART, new Set()), /## threads/);
  });
});

describe("parseScheduledAt", () => {
  const now = new Date("2026-08-25T20:00:00-03:00");

  it("aceita ISO com offset no futuro", () => {
    assert.equal(
      parseScheduledAt("2026-08-26T09:50:00-03:00", now),
      new Date("2026-08-26T09:50:00-03:00").toISOString(),
    );
  });

  it("recusa data sem offset — o fuso de quem dispara não é o do editor", () => {
    assert.throws(() => parseScheduledAt("2026-08-26T09:50:00", now), /ISO com offset/);
    assert.throws(() => parseScheduledAt("amanhã 9h50", now), /ISO com offset/);
    assert.throws(() => parseScheduledAt("", now), /ISO com offset/);
  });

  it("recusa data no passado", () => {
    assert.throws(() => parseScheduledAt("2026-08-25T09:50:00-03:00", now), /passado/);
  });

  it("recusa dia que não existe no mês em vez de rolar pra frente", () => {
    // Regressão: `new Date("2026-02-30...")` NÃO é Invalid Date — o JS
    // normaliza pra 2 de março em silêncio. Um typo de dia agendava pro dia
    // errado numa conta pública sem nenhum aviso.
    assert.throws(() => parseScheduledAt("2026-02-30T09:50:00-03:00", now), /dia inexistente/);
    assert.throws(() => parseScheduledAt("2026-04-31T09:50:00-03:00", now), /dia inexistente/);
    // Dia 00 já cai antes, em Invalid Date — importa que seja recusado, não por qual caminho.
    assert.throws(() => parseScheduledAt("2026-09-00T09:50:00-03:00", now));
  });

  it("aceita os limites reais do calendário", () => {
    for (const raw of ["2026-08-31T09:50:00-03:00", "2028-02-29T09:50:00-03:00", "2026-09-30T09:50:00-03:00"]) {
      assert.doesNotThrow(() => parseScheduledAt(raw, now), `${raw} é data válida`);
    }
  });
});

describe("pendingChannels", () => {
  const plans = buildPlans(MD, ART, new Set());
  const state: EiaPublishedState = {
    edition: "260824",
    scheduled_at: "2026-08-26T12:50:00.000Z",
    channels: { linkedin: { ref: "queue:x", scheduled_at: "2026-08-26T12:50:00.000Z" } },
  };

  it("pula canal já agendado — a fila do Worker não deduplica", () => {
    const { todo, alreadyDone } = pendingChannels(plans, state, false);
    assert.deepEqual(alreadyDone, ["linkedin"]);
    assert.ok(!todo.some((p) => p.channel === "linkedin"));
    assert.equal(todo.length, plans.length - 1);
  });

  it("sem estado, tudo é pendente", () => {
    assert.equal(pendingChannels(plans, null, false).todo.length, plans.length);
  });

  it("--force ignora o registro", () => {
    const { todo, alreadyDone } = pendingChannels(plans, state, true);
    assert.equal(todo.length, plans.length);
    assert.deepEqual(alreadyDone, []);
  });
});
