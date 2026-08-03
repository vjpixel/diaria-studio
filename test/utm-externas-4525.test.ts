/**
 * test/utm-externas-4525.test.ts (#4525) — superfícies externas de UTM.
 *
 * Contexto: `UTM_EMITTERS` só cataloga o que o CÓDIGO emite. Os links que
 * moram em campo de bio/site de perfil (Instagram, Facebook, Threads, X,
 * Apoia.se) ficavam fora de qualquer inventário — e a varredura ao vivo do
 * #4525 achou três convenções incompatíveis vivas ao mesmo tempo, duas delas
 * apontando pra uma campanha encerrada.
 *
 * HARD CONSTRAINT (mesma disciplina de `studio-utms-4041.test.ts`): nunca bate
 * em rede real — Beehiiv/Brevo sempre injetados, `env` sempre objeto controlado.
 *
 * O que este arquivo trava (regressão #633):
 *   1. **`knownUtmSources()` inclui as superfícies externas.** É O invariante
 *      da fatia: `apoiase` só existe do lado externo, e sem a união seria
 *      acusado de "não catalogado" pelo detector de drift no exato momento em
 *      que começasse a converter — falso positivo da mesma família do #4312.
 *   2. **Convenção única** — `utm_medium`/`utm_campaign` iguais em todas, e
 *      `utm_source` sem o sufixo `-diaria` que fatiava o canal em duas linhas
 *      que nunca somam.
 *   3. **URL montada por `new URL`**, não concatenada (exigência do #4295).
 *   4. **Drift de superfície externa é por `utm_campaign`, não por
 *      `utm_source`** — e só depois de `appliedAt`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXTERNAL_SURFACE_BASE_URL,
  EXTERNAL_SURFACE_CAMPAIGN,
  EXTERNAL_SURFACE_MEDIUM,
  EXTERNAL_UTM_SURFACES,
  UTM_EMITTERS,
  buildExternalSurfaceUrl,
  findExternalUtmSurface,
  knownUtmSources,
  type ExternalUtmSurface,
} from "../scripts/lib/shared/utm-registry.ts";
import { buildUtmsData, clearUtmsCache, computeDrift } from "../scripts/studio-ui/studio-utms.ts";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "utm-ext-4525-"));
  mkdirSync(join(root, "data", "editions"), { recursive: true });
  return root;
}

function fakeSubscriptions(counts: Record<string, number>, campaignCounts: Record<string, number> = {}) {
  return (async () => ({
    counts,
    campaignCounts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    fetched_at: new Date().toISOString(),
  })) as never;
}

const noClicks = async () => ({ clicksByCampaign: {}, campaignsRead: 0 });

describe("#4525 — inventário das superfícies externas", () => {
  it("tem pelo menos as 5 superfícies da varredura de 260803", () => {
    const ids = EXTERNAL_UTM_SURFACES.map((s) => s.id);
    for (const expected of [
      "perfil-instagram",
      "perfil-facebook",
      "perfil-threads",
      "perfil-twitter",
      "perfil-apoiase",
    ]) {
      assert.ok(ids.includes(expected), `superfície ausente do inventário: ${expected}`);
    }
  });

  it("ids são únicos e não colidem com os de UTM_EMITTERS", () => {
    const ids = EXTERNAL_UTM_SURFACES.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, "id duplicado entre superfícies externas");
    const emitterIds = new Set(UTM_EMITTERS.map((e) => e.id));
    for (const id of ids) {
      assert.ok(!emitterIds.has(id), `id "${id}" colide com um emissor de código`);
    }
  });

  it("usa medium e campaign únicos — a leitura da página depende disso", () => {
    for (const s of EXTERNAL_UTM_SURFACES) {
      assert.equal(s.medium, EXTERNAL_SURFACE_MEDIUM, `${s.id}: utm_medium fora da convenção`);
      assert.equal(s.campaign, EXTERNAL_SURFACE_CAMPAIGN, `${s.id}: utm_campaign fora da convenção`);
    }
  });

  it("utm_source é o nome NU da plataforma — sem o sufixo que fatiava o canal", () => {
    for (const s of EXTERNAL_UTM_SURFACES) {
      assert.equal(s.source, s.source.toLowerCase(), `${s.id}: utm_source não está em minúsculas`);
      assert.ok(
        !s.source.endsWith("-diaria"),
        `${s.id}: utm_source="${s.source}" reintroduz o sufixo que separa o mesmo canal em duas linhas ` +
          `que nunca somam (o valor achado ao vivo no #4525 era instagram-diaria/facebook-diaria)`,
      );
      assert.ok(/^[a-z0-9-]+$/.test(s.source), `${s.id}: utm_source com caractere inesperado`);
    }
  });

  it("toda superfície diz onde se edita — sem isso a reconferência não existe", () => {
    for (const s of EXTERNAL_UTM_SURFACES) {
      assert.ok(s.panelUrl.startsWith("https://"), `${s.id}: panelUrl não é URL absoluta`);
      assert.ok(s.field.trim().length > 0, `${s.id}: field vazio`);
      assert.ok(s.description.trim().length > 0, `${s.id}: description vazia`);
      assert.ok(
        s.status === "ativo" || s.status === "aposentado",
        `${s.id}: status inválido`,
      );
    }
  });

  it("findExternalUtmSurface acha por id e devolve undefined pro que não existe", () => {
    assert.equal(findExternalUtmSurface("perfil-threads")?.source, "threads");
    assert.equal(findExternalUtmSurface("perfil-orkut"), undefined);
  });
});

describe("#4525 — knownUtmSources inclui as superfícies externas", () => {
  it("todo utm_source externo está em knownUtmSources()", () => {
    const known = new Set(knownUtmSources());
    for (const s of EXTERNAL_UTM_SURFACES) {
      assert.ok(
        known.has(s.source.toLowerCase()),
        `utm_source="${s.source}" (${s.id}) fora de knownUtmSources() — o detector de drift do /utms ` +
          `vai acusar "origem não catalogada" assim que essa superfície converter (bug do #4312)`,
      );
    }
  });

  it("apoiase entra — é o source que só existe do lado externo", () => {
    assert.ok(
      !UTM_EMITTERS.some((e) => e.source.toLowerCase() === "apoiase"),
      "premissa do teste mudou: apoiase virou emissor de código",
    );
    assert.ok(knownUtmSources().includes("apoiase"));
  });

  it("continua sem duplicata e ordenado, mesmo com sources compartilhados", () => {
    const sources = knownUtmSources();
    assert.deepEqual(sources, [...new Set(sources)].sort(), "knownUtmSources com duplicata ou fora de ordem");
    // `twitter`/`facebook`/`threads` existem dos DOIS lados (CTA de post e bio).
    assert.equal(sources.filter((s) => s === "twitter").length, 1);
    assert.equal(sources.filter((s) => s === "facebook").length, 1);
  });
});

describe("#4525 — buildExternalSurfaceUrl", () => {
  const surface: ExternalUtmSurface = {
    id: "t",
    label: "T",
    source: "threads",
    medium: EXTERNAL_SURFACE_MEDIUM,
    campaign: EXTERNAL_SURFACE_CAMPAIGN,
    panelUrl: "https://example.test",
    field: "campo",
    description: "d",
    status: "ativo",
  };

  it("monta os 3 parâmetros sobre a base canônica", () => {
    const url = new URL(buildExternalSurfaceUrl(surface));
    assert.equal(url.origin + url.pathname, "https://diar.ia.br/");
    assert.equal(url.searchParams.get("utm_source"), "threads");
    assert.equal(url.searchParams.get("utm_medium"), "bio");
    assert.equal(url.searchParams.get("utm_campaign"), "perfil");
  });

  it("não duplica parâmetro quando a base já traz query", () => {
    const url = new URL(
      buildExternalSurfaceUrl(surface, "https://diar.ia.br/?utm_source=antigo&ref=x"),
    );
    assert.deepEqual(url.searchParams.getAll("utm_source"), ["threads"]);
    assert.equal(url.searchParams.get("ref"), "x", "parâmetro alheio foi descartado");
  });

  it("a base canônica é https e do domínio da marca", () => {
    const base = new URL(EXTERNAL_SURFACE_BASE_URL);
    assert.equal(base.protocol, "https:");
    assert.equal(base.hostname, "diar.ia.br");
  });

  it("cada superfície do inventário produz uma URL distinta e válida", () => {
    const urls = EXTERNAL_UTM_SURFACES.map((s) => buildExternalSurfaceUrl(s));
    assert.equal(new Set(urls).size, urls.length, "duas superfícies produzem a mesma URL");
    for (const u of urls) assert.doesNotThrow(() => new URL(u));
  });
});

describe("#4525 — drift de superfície externa", () => {
  const applied: ExternalUtmSurface = {
    id: "perfil-x",
    label: "X — bio",
    source: "twitter",
    medium: EXTERNAL_SURFACE_MEDIUM,
    campaign: EXTERNAL_SURFACE_CAMPAIGN,
    panelUrl: "https://x.com/settings/profile",
    field: "Website",
    description: "d",
    status: "ativo",
    appliedAt: "2026-08-03",
  };

  it("aplicada e sem conversão vira sem_conversao", () => {
    const findings = computeDrift([], {}, { externals: [applied], campaignCounts: {} });
    const f = findings.find((x) => x.key === "perfil-x");
    assert.ok(f, "superfície aplicada sem conversão devia virar drift");
    assert.equal(f.kind, "sem_conversao");
    assert.match(f.detail, /x\.com\/settings\/profile/, "detail devia dizer onde reconferir");
  });

  it("aplicada e convertendo não vira drift", () => {
    const findings = computeDrift([], {}, { externals: [applied], campaignCounts: { perfil: 3 } });
    assert.equal(findings.find((x) => x.key === "perfil-x"), undefined);
  });

  it("AINDA NÃO aplicada nunca vira drift — não converter é o estado correto", () => {
    const pendente = { ...applied, appliedAt: undefined };
    const findings = computeDrift([], {}, { externals: [pendente], campaignCounts: {} });
    assert.equal(
      findings.find((x) => x.key === "perfil-x"),
      undefined,
      "superfície declarada mas não colada no painel não é drift, é backlog",
    );
  });

  it("checa por campaign, não por source — o source vem positivo pelo CTA do post", () => {
    // `twitter` tem 40 assinantes vindos do CTA de post; a BIO não trouxe nenhum.
    // Um check por source diria "tudo certo" e esconderia o campo que não salvou.
    const findings = computeDrift(
      [],
      { twitter: 40 },
      { externals: [applied], campaignCounts: { "edicao-diaria": 40 } },
    );
    assert.ok(
      findings.some((x) => x.key === "perfil-x" && x.kind === "sem_conversao"),
      "drift por source mascararia a bio morta atrás do tráfego do post",
    );
  });

  it("superfície aposentada é ignorada, como emissor aposentado já era", () => {
    const off = { ...applied, status: "aposentado" as const };
    const findings = computeDrift([], {}, { externals: [off], campaignCounts: {} });
    assert.equal(findings.find((x) => x.key === "perfil-x"), undefined);
  });

  it("chamada sem o 3º argumento segue funcionando (compat #4041)", () => {
    assert.doesNotThrow(() => computeDrift([], { sendinblue: 5 }));
    const findings = computeDrift([], { sendinblue: 5 });
    assert.ok(findings.some((f) => f.kind === "nao_catalogado" && f.key === "sendinblue"));
  });
});

describe("#4525 — snapshot de /api/utms", () => {
  it("expõe externalSurfaces com URL pronta e contagem por campanha", async () => {
    clearUtmsCache();
    const data = await buildUtmsData(tempRoot(), {
      env: {},
      fetchSubscriptions: fakeSubscriptions({ instagram: 7, apoiase: 2 }, { perfil: 9 }),
      fetchClicks: noClicks as never,
    });
    assert.equal(data.externalSurfaces.length, EXTERNAL_UTM_SURFACES.length);
    const ig = data.externalSurfaces.find((s) => s.id === "perfil-instagram");
    assert.ok(ig);
    assert.equal(ig.subscribers, 7);
    assert.equal(ig.campaignSubscribers, 9, "campanha compartilhada por todas as superfícies");
    assert.match(ig.url, /utm_source=instagram&utm_medium=bio&utm_campaign=perfil/);
    assert.equal(ig.clicks, 0);
  });

  it("Beehiiv fora do ar não derruba a seção — vira null, não exceção", async () => {
    clearUtmsCache();
    const data = await buildUtmsData(tempRoot(), {
      env: {},
      fetchSubscriptions: (async () => {
        throw new Error("beehiiv 500");
      }) as never,
      fetchClicks: noClicks as never,
    });
    assert.ok(data.beehiivError);
    assert.equal(data.externalSurfaces.length, EXTERNAL_UTM_SURFACES.length);
    for (const s of data.externalSurfaces) {
      assert.equal(s.subscribers, null);
      assert.equal(s.campaignSubscribers, null);
      assert.ok(s.url.startsWith("https://diar.ia.br/"), "URL vem do registry, não do Beehiiv");
    }
  });
});
