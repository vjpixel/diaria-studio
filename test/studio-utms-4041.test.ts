/**
 * test/studio-utms-4041.test.ts (#4041) — cobertura de
 * `scripts/studio-ui/studio-utms.ts` + rotas `/utms` e `/api/utms`.
 *
 * HARD CONSTRAINT (mesma disciplina de `studio-integrations.test.ts`, #3848):
 * NUNCA bate em rede real. Beehiiv e Brevo são SEMPRE injetados
 * (`fetchSubscriptions` / `fetchClicks`), e `env` é objeto controlado — nunca
 * o `process.env` da máquina, que pode ter credencial real persistida.
 *
 * O que este arquivo trava (regressão #633):
 *   1. **Fronteira de edição** — `saveUtmMetadata` aceita
 *      description/status/note e REJEITA qualquer tentativa de editar
 *      source/medium/campaignPattern pela UI. É o invariante central da
 *      decisão de escopo do #4041; sem teste, uma UI "generosa" no futuro
 *      abriria o campo e a página passaria a mentir sobre a produção.
 *   2. **Drift nos dois sentidos** — `sem_conversao` e `nao_catalogado`
 *      (incluindo o caso real `sendinblue`, #2975).
 *   3. **Match de campanha por padrão** — o sufixo de posição do #4040 tem
 *      que casar o emissor certo e só ele.
 *   4. **Fail-soft** — Beehiiv fora do ar não derruba a página.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EDITABLE_METADATA_FIELDS,
  applyMetadata,
  aggregateClicksByCampaign,
  buildUtmsData,
  campaignFromUrl,
  clearUtmsCache,
  computeDrift,
  fetchBrevoClicks,
  loadUtmMetadata,
  matchCampaigns,
  saveUtmMetadata,
  utmMetadataPath,
} from "../scripts/studio-ui/studio-utms.ts";
import { UTM_EMITTERS } from "../scripts/lib/shared/utm-registry.ts";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "data", "editions"), { recursive: true });
  return root;
}

/** Beehiiv fake — nunca toca rede. */
function fakeSubscriptions(counts: Record<string, number>, campaignCounts: Record<string, number> = {}) {
  return (async () => ({
    counts,
    campaignCounts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    fetched_at: new Date().toISOString(),
  })) as never;
}

/** Brevo fake — nunca toca rede. */
function fakeClicks(clicksByCampaign: Record<string, number>, error?: string) {
  return (async () => ({ clicksByCampaign, campaignsRead: 1, error })) as never;
}

describe("#4041 — fronteira de edição (só metadados, nunca valores)", () => {
  it("EDITABLE_METADATA_FIELDS é exatamente description/status/note", () => {
    assert.deepEqual([...EDITABLE_METADATA_FIELDS], ["description", "status", "note"]);
  });

  it("REGRESSÃO: editar utm_source pela UI é REJEITADO e nada é escrito em disco", () => {
    const root = tempRoot("studio-utms-boundary-");
    try {
      const r = saveUtmMetadata(root, "mensal-clarice", { source: "hackeado" });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /não-editável/);
      assert.equal(existsSync(utmMetadataPath(root)), false, "nada pode ser escrito numa rejeição");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO: campaignPattern e medium também são rejeitados", () => {
    const root = tempRoot("studio-utms-boundary2-");
    try {
      assert.equal(saveUtmMetadata(root, "mensal-clarice", { campaignPattern: "x" }).ok, false);
      assert.equal(saveUtmMetadata(root, "mensal-clarice", { medium: "x" }).ok, false);
      // Campo válido MISTURADO com inválido também aborta inteiro — nunca
      // grava metade da intenção do editor.
      const misto = saveUtmMetadata(root, "mensal-clarice", { note: "ok", source: "nao" });
      assert.equal(misto.ok, false);
      assert.equal(existsSync(utmMetadataPath(root)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("description/status/note são aceitos e persistidos", () => {
    const root = tempRoot("studio-utms-save-");
    try {
      const r = saveUtmMetadata(
        root,
        "clarice-cta-ab",
        { description: "nova descrição", status: "aposentado", note: "round encerrado" },
        () => "2026-07-27T00:00:00.000Z",
      );
      assert.equal(r.ok, true);
      const persisted = loadUtmMetadata(root);
      assert.equal(persisted["clarice-cta-ab"].description, "nova descrição");
      assert.equal(persisted["clarice-cta-ab"].status, "aposentado");
      assert.equal(persisted["clarice-cta-ab"].updatedAt, "2026-07-27T00:00:00.000Z");
      assert.ok(readFileSync(utmMetadataPath(root), "utf8").includes("round encerrado"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("id desconhecido é rejeitado (a UI não inventa emissor)", () => {
    const root = tempRoot("studio-utms-unknown-");
    try {
      assert.equal(saveUtmMetadata(root, "nao-existe", { note: "x" }).ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("status fora do vocabulário é rejeitado", () => {
    const root = tempRoot("studio-utms-status-");
    try {
      assert.equal(saveUtmMetadata(root, "mensal-clarice", { status: "talvez" }).ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applyMetadata nunca deixa o overlay sobrescrever os VALORES", () => {
    const base = UTM_EMITTERS.find((e) => e.id === "mensal-clarice")!;
    const out = applyMetadata(base, {
      description: "outra",
      status: "aposentado",
      // campos de valor injetados de má-fé no JSON — têm que ser ignorados
      ...({ source: "hack", medium: "hack", campaignPattern: "hack" } as never),
    });
    assert.equal(out.source, base.source);
    assert.equal(out.medium, base.medium);
    assert.equal(out.campaignPattern, base.campaignPattern);
    assert.equal(out.description, "outra");
    assert.equal(out.status, "aposentado");
  });

  it("loadUtmMetadata é fail-soft com arquivo ausente", () => {
    const root = tempRoot("studio-utms-missing-");
    try {
      assert.deepEqual(loadUtmMetadata(root), {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#4041 — drift nos dois sentidos", () => {
  it("emissor ativo sem nenhuma conversão vira `sem_conversao`", () => {
    const emitter = UTM_EMITTERS.find((e) => e.id === "embed-widget")!;
    const drift = computeDrift([emitter], { clarice: 10 });
    assert.equal(drift.length, 1);
    assert.equal(drift[0].kind, "sem_conversao");
    assert.equal(drift[0].key, "embed-widget");
  });

  it("emissor APOSENTADO sem conversão NÃO é drift (é o estado declarado)", () => {
    const emitter = { ...UTM_EMITTERS.find((e) => e.id === "embed-widget")!, status: "aposentado" as const };
    assert.deepEqual(computeDrift([emitter], {}), []);
  });

  it("REGRESSÃO #2975: `sendinblue` chegando no Beehiiv vira `nao_catalogado`", () => {
    const emitter = UTM_EMITTERS.find((e) => e.id === "mensal-clarice")!;
    const drift = computeDrift([emitter], { clarice: 30, sendinblue: 12 });
    const nc = drift.filter((d) => d.kind === "nao_catalogado");
    assert.equal(nc.length, 1);
    assert.equal(nc[0].key, "sendinblue");
    assert.match(nc[0].detail, /12 assinante/);
  });

  it("`__none__` (sem UTM) não é tratado como origem não-catalogada", () => {
    const emitter = UTM_EMITTERS.find((e) => e.id === "mensal-clarice")!;
    const drift = computeDrift([emitter], { clarice: 1, __none__: 5000 });
    assert.deepEqual(drift, []);
  });
});

describe("#4041 — match de campanha pelo padrão declarado (sufixo de posição do #4040)", () => {
  const mensal = UTM_EMITTERS.find((e) => e.id === "mensal-clarice")!;

  it("casa as campanhas com sufixo de posição do ciclo", () => {
    const matched = matchCampaigns(mensal, {
      "clarice-2606-07-cta": 12,
      "clarice-2606-07-wordmark-radar": 3,
      "eia-arquivo": 99,
      __none__: 500,
    });
    assert.deepEqual(matched.map((m) => m.campaign), [
      "clarice-2606-07-cta",
      "clarice-2606-07-wordmark-radar",
    ]);
    assert.equal(matched[0].count, 12);
  });

  it("padrão FIXO não casa por prefixo (eia-arquivo != eia-arquivo-2)", () => {
    const arquivo = UTM_EMITTERS.find((e) => e.id === "eia-arquivo-newsletter")!;
    const matched = matchCampaigns(arquivo, { "eia-arquivo": 5, "eia-arquivo-2": 7 });
    assert.deepEqual(matched, [{ campaign: "eia-arquivo", count: 5 }]);
  });
});

describe("#4041 — cliques da Brevo (linksStats)", () => {
  it("campaignFromUrl extrai o utm_campaign e ignora link de sistema", () => {
    assert.equal(
      campaignFromUrl("https://diar.ia.br/?utm_source=clarice&utm_campaign=clarice-2606-07-cta"),
      "clarice-2606-07-cta",
    );
    assert.equal(campaignFromUrl("https://diar.ia.br/unsubscribe?x=1"), null);
    assert.equal(campaignFromUrl("nao-e-url"), null);
  });

  it("aggregateClicksByCampaign soma por campanha e ignora links sem UTM", () => {
    const out = aggregateClicksByCampaign({
      "https://diar.ia.br/?utm_campaign=clarice-2606-07-cta&utm_term=topo": 10,
      "https://diar.ia.br/?utm_campaign=clarice-2606-07-cta&utm_term=fim": 5,
      "https://diar.ia.br/unsubscribe": 3,
    });
    assert.deepEqual(out, { "clarice-2606-07-cta": 15 });
  });

  it("fetchBrevoClicks sem API key é fail-soft (nunca lança, nunca bate em rede)", async () => {
    const r = await fetchBrevoClicks(undefined);
    assert.deepEqual(r.clicksByCampaign, {});
    assert.match(r.error ?? "", /BREVO_CLARICE_API_KEY/);
  });

  it("fetchBrevoClicks: falha de UMA campanha não derruba as outras", async () => {
    const get = (async (_key: string, path: string) => {
      if (path.startsWith("/emailCampaigns?")) return { status: 200, body: { campaigns: [{ id: 1 }, { id: 2 }] } };
      if (path.includes("/1?")) throw new Error("429");
      return {
        status: 200,
        body: { statistics: { linksStats: { "https://diar.ia.br/?utm_campaign=x": 4 } } },
      };
    }) as never;
    const r = await fetchBrevoClicks("key", 5, get);
    assert.equal(r.campaignsRead, 1);
    assert.deepEqual(r.clicksByCampaign, { x: 4 });
    assert.equal(r.error, undefined);
  });
});

describe("#4041 — buildUtmsData (orquestração fail-soft)", () => {
  it("junta inventário + conversão + clique e calcula drift", async () => {
    const root = tempRoot("studio-utms-build-");
    clearUtmsCache();
    try {
      const data = await buildUtmsData(root, {
        env: {},
        fetchSubscriptions: fakeSubscriptions(
          { clarice: 40, newsletter: 12, sendinblue: 7 },
          { "clarice-2606-07-cta": 9, "eia-arquivo": 12 },
        ),
        fetchClicks: fakeClicks({ "clarice-2606-07-cta": 130 }),
      });
      assert.equal(data.emitters.length, UTM_EMITTERS.length);
      const mensal = data.emitters.find((e) => e.id === "mensal-clarice")!;
      assert.equal(mensal.subscribers, 40);
      assert.equal(mensal.clicks, 130);
      assert.deepEqual(mensal.campaigns, [{ campaign: "clarice-2606-07-cta", count: 9 }]);
      assert.ok(data.drift.some((d) => d.kind === "nao_catalogado" && d.key === "sendinblue"));
      assert.equal(data.totals.subscribers, 59);
      assert.deepEqual([...data.editableFields], ["description", "status", "note"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Beehiiv fora do ar não derruba a página — inventário continua, contagens viram null", async () => {
    const root = tempRoot("studio-utms-failsoft-");
    clearUtmsCache();
    try {
      const data = await buildUtmsData(root, {
        env: {},
        fetchSubscriptions: (async () => {
          throw new Error("Beehiiv API 500");
        }) as never,
        fetchClicks: fakeClicks({}, "sem key"),
      });
      assert.equal(data.emitters.length, UTM_EMITTERS.length);
      assert.match(data.beehiivError ?? "", /500|BEEHIIV/i);
      assert.equal(data.emitters[0].subscribers, null);
      assert.equal(data.emitters[0].clicks, null);
      // Sem dado de conversão, NÃO inventar drift (evita alarme falso).
      assert.deepEqual(data.drift, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("o overlay de metadados sobrescreve descrição/status na saída", async () => {
    const root = tempRoot("studio-utms-overlay-");
    clearUtmsCache();
    try {
      saveUtmMetadata(root, "embed-widget", { status: "aposentado", note: "parceria encerrada" });
      clearUtmsCache();
      const data = await buildUtmsData(root, {
        env: {},
        fetchSubscriptions: fakeSubscriptions({ clarice: 1 }),
        fetchClicks: fakeClicks({}),
      });
      const embed = data.emitters.find((e) => e.id === "embed-widget")!;
      assert.equal(embed.status, "aposentado");
      assert.equal(embed.note, "parceria encerrada");
      // valores intactos
      assert.equal(embed.source, "embed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cache: 2ª chamada devolve `cached:true` sem refetch; forceRefresh bypassa", async () => {
    const root = tempRoot("studio-utms-cache-");
    clearUtmsCache();
    let calls = 0;
    const counting = (async () => {
      calls++;
      return { counts: { clarice: 1 }, campaignCounts: {}, total: 1, fetched_at: "x" };
    }) as never;
    try {
      await buildUtmsData(root, { env: {}, fetchSubscriptions: counting, fetchClicks: fakeClicks({}) });
      const second = await buildUtmsData(root, { env: {}, fetchSubscriptions: counting, fetchClicks: fakeClicks({}) });
      assert.equal(second.cached, true);
      assert.equal(calls, 1);
      const third = await buildUtmsData(root, {
        env: {},
        forceRefresh: true,
        fetchSubscriptions: counting,
        fetchClicks: fakeClicks({}),
      });
      assert.equal(third.cached, false);
      assert.equal(calls, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#4041 — contrato HTTP (/utms e /api/utms)", () => {
  let server: StudioServer;
  let root: string;
  const savedEnv: Record<string, string | undefined> = {};
  const CLEARED = ["BEEHIIV_API_KEY", "BEEHIIV_PUBLICATION_ID", "BREVO_CLARICE_API_KEY"];

  before(async () => {
    // Mesma dupla proteção do #3848: limpa credencial real da máquina pra que
    // um GET acidental nunca alcance API de produção durante o teste.
    for (const k of CLEARED) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    clearUtmsCache();
    root = tempRoot("studio-utms-page-");
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
    for (const k of CLEARED) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("GET /utms serve a página (shell estático)", async () => {
    const res = await fetch(new URL("/utms", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('window.STUDIO_PAGE = "utms";'));
    assert.ok(body.includes('src="/utms.js"'));
  });

  it("GET /api/utms responde 200 mesmo sem credencial (fail-soft)", async () => {
    const res = await fetch(new URL("/api/utms", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.emitters.length, UTM_EMITTERS.length);
    assert.ok(Array.isArray(body.drift));
  });

  it("PUT /api/utms/:id aceita metadado editorial", async () => {
    const res = await fetch(new URL("/api/utms/mensal-clarice", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "nota do editor" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  it("REGRESSÃO: PUT /api/utms/:id com utm_source responde 400 e não grava", async () => {
    const res = await fetch(new URL("/api/utms/mensal-clarice", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "hackeado" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /não-editável/);
    assert.equal(loadUtmMetadata(root)["mensal-clarice"]?.description, undefined);
  });

  it("PUT com corpo inválido responde 400 (nunca 500)", async () => {
    const res = await fetch(new URL("/api/utms/mensal-clarice", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{nao-e-json",
    });
    assert.equal(res.status, 400);
  });
});
