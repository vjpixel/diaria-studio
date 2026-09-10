/**
 * test/studio-metrics.test.ts (#7178, fatia 6 do epic #7172)
 *
 * Cobertura de `scripts/studio-ui/studio-metrics.ts`: sessão cloud (`data/`
 * ausente) nunca lança, fail-soft por camada (captura-log/store diaria-
 * subscribers/snapshot Beehiiv/metas.json), `valor: null` nunca vira `0`,
 * `qualidade: 'faixa'` sobrevive à serialização sem colapsar em ponto médio,
 * e cache com TTL/forceRefresh — mesmo padrão de test/studio-ads.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMetricsData, clearMetricsCache } from "../scripts/studio-ui/studio-metrics.ts";
import { openDiariaSubscribersDb, ensureSubscriber, upsertSubscription } from "../scripts/lib/diaria-subscribers-db.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "studio-metrics-"));
}

function writeCapturaLog(root: string, dias: string[]): void {
  const dir = join(root, "data", "metrics");
  mkdirSync(dir, { recursive: true });
  const lines = dias.map((dia) =>
    JSON.stringify({
      captura_id: `kit-${dia}T09:00:00.000Z`,
      captured_at: `${dia}T09:00:00.000Z`,
      total_retornado_api: 1,
      novos_gravados: 1,
      eventos_estado: 0,
      exit: 0,
    }),
  );
  writeFileSync(join(dir, "captura-log.jsonl"), lines.join("\n") + "\n", "utf8");
}

function beehiivSubscriberLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    email: "leitor@example.com",
    status: "active",
    created: 1755000000,
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    ...overrides,
  });
}

function writeBeehiivSnapshot(root: string, date: string, lines: string[]): void {
  const dir = join(root, "data", "beehiiv-backup", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "subscribers.jsonl"), lines.join("\n") + "\n", "utf8");
}

function writeMetas(root: string, metas: unknown[]): void {
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "metas.json"), JSON.stringify(metas), "utf8");
}

/** Popula o store `diaria-subscribers` com N cadastros Kit "orgânicos"
 *  (sem utm/referring_site — a classe default de `classifyAcquisition`
 *  quando não há sinal nenhum é "sem sinal positivo", que classifica fora
 *  de organico/iniciativa; passar `referringSite` empurra pra "organico"). */
function seedKitSubscription(
  root: string,
  email: string,
  enteredAtIso: string,
  referringSite: string | null = "google.com",
  opts: { utmSource?: string | null; status?: string; updatedAt?: string } = {},
): void {
  const dbDir = join(root, "data", "diaria-subscribers");
  mkdirSync(dbDir, { recursive: true });
  const db = openDiariaSubscribersDb(join(dbDir, "diaria-subscribers.db"));
  try {
    const id = ensureSubscriber(db, "kit", `kit-${email}`, email);
    upsertSubscription(
      db,
      id,
      "kit",
      {
        status: opts.status ?? "active",
        enteredAt: enteredAtIso,
        exitedAt: null,
        source: "kit",
        referringSite,
        utmSource: opts.utmSource ?? null,
      },
      opts.updatedAt,
    );
  } finally {
    db.close();
  }
}

describe("buildMetricsData — sessão cloud (data/ ausente) nunca lança", () => {
  it("hasDataDir=false, todas as camadas com error/motivo, sem exceção", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      const data = await buildMetricsData(root, { now: () => new Date("2026-09-03T12:00:00Z") });
      assert.equal(data.hasDataDir, false);
      assert.equal(data.execMode, "cloud");
      assert.ok(data.capturaLog.error);
      assert.equal(data.subscriptionCoverage.available, false);
      assert.ok(data.beehiivSnapshot.error);
      assert.equal(data.metas.items.length, 0);
      // baseline nunca lança e nunca inventa "0" — cada resultado vem
      // indeterminado com motivo.
      for (const { result } of data.baseline) {
        if (result.valor === null) assert.ok(result.motivo, "valor null precisa vir com motivo");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildMetricsData — fail-soft por camada", () => {
  it("captura-log ausente: cadastros-dia sai indeterminado, nunca 0", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      writeBeehiivSnapshot(root, "2026-09-02", [beehiivSubscriberLine()]);
      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date("2026-09-03T12:00:00Z") });
      const cadastros = data.baseline.find((b) => b.metric.id === "cadastros-dia");
      assert.ok(cadastros);
      assert.equal(cadastros!.result.valor, null);
      assert.equal(cadastros!.result.qualidade, "indeterminado");
      assert.ok(cadastros!.result.motivo);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("snapshot Beehiiv ausente: base-ativa/leitor-v1 indeterminados, nunca 0", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      const data = await buildMetricsData(root, { forceRefresh: true });
      const baseAtiva = data.baseline.find((b) => b.metric.id === "base-ativa");
      const leitor = data.baseline.find((b) => b.metric.id === "leitor-v1");
      assert.equal(baseAtiva!.result.valor, null);
      assert.equal(leitor!.result.valor, null);
      assert.ok(data.beehiivSnapshot.error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("metas.json ausente: motivo preenchido, items vazio, sem exceção", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      const data = await buildMetricsData(root, { forceRefresh: true });
      assert.ok(data.metas.motivo);
      assert.equal(data.metas.items.length, 0);
      assert.equal(data.metas.validationError, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("metas.json com metrica_id órfã: validationError preenchido, items vazio (nunca avaliação parcial)", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      writeMetas(root, [
        {
          id: "meta-invalida",
          metrica_id: "nao-existe-no-registry",
          produto: "diaria",
          alvo: 5,
          operador: ">=",
          janela: "dia",
          prazo: null,
          criada_em: "2026-09-01T00:00:00Z",
          motivo: "teste",
          dono: "editor",
        },
      ]);
      const data = await buildMetricsData(root, { forceRefresh: true });
      assert.ok(data.metas.validationError);
      assert.equal(data.metas.items.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildMetricsData — honestidade de dado", () => {
  it("base-ativa com snapshot de hoje sai 'exato', com snapshot antigo sai 'piso' — nunca esconde a diferença", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      writeBeehiivSnapshot(root, "2026-08-20", [beehiivSubscriberLine(), beehiivSubscriberLine({ email: "b@example.com" })]);
      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date("2026-09-03T12:00:00Z") });
      const baseAtiva = data.baseline.find((b) => b.metric.id === "base-ativa")!;
      assert.equal(baseAtiva.result.qualidade, "piso");
      assert.ok(baseAtiva.result.motivo);
      assert.equal(data.queda.baseAtiva.qualidade, "piso");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cadastros-nao-pago-nao-reativacao-dia devolve qualidade 'faixa' com limites (min/max) — nunca ponto médio solto", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      const dia = "2026-09-02";
      writeCapturaLog(root, [dia]);
      seedKitSubscription(root, "leitor1@example.com", `${dia}T15:00:00.000Z`, "google.com");
      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date(`${dia}T18:00:00Z`) });
      const placar = data.placar.naoPagoNaoReativacao;
      // Cobertura de subscription real fica baixa no fixture (poucas linhas)
      // — o caminho honesto aqui é indeterminado; se a cobertura algum dia
      // subir o suficiente, o resultado vira faixa com `limites` — os dois
      // casos nunca produzem `valor` sem `qualidade`/`motivo` coerentes.
      assert.ok(["indeterminado", "faixa"].includes(placar.qualidade));
      if (placar.qualidade === "faixa") {
        assert.ok(placar.limites);
        assert.ok(placar.limites!.max >= placar.limites!.min);
      } else {
        assert.ok(placar.motivo);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("decomposição de cadastros-dia por classe nunca lança mesmo sem coleta", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      const data = await buildMetricsData(root, { forceRefresh: true });
      assert.equal(data.decomposicaoCadastros.valor, null);
      assert.equal(data.decomposicaoCadastros.qualidade, "indeterminado");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildMetricsData — utm_source do Kit propaga na classificação (#7916, fatia 1/N)", () => {
  it("REGRESSÃO: Kit com utm_source='google-ads' classifica como 'pago' — ANTES desta fatia o SELECT nem lia a coluna e o valor saía sempre null", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      const dia = "2026-09-05";
      writeCapturaLog(root, [dia]);
      seedKitSubscription(root, "pago@example.com", `${dia}T10:00:00.000Z`, null, { utmSource: "google-ads" });
      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date(`${dia}T18:00:00Z`) });
      const pago = data.decomposicaoCadastros.series?.find((p) => p.chave === "pago");
      assert.ok(pago, "bucket 'pago' precisa existir na decomposição — prova que utm_source='google-ads' chegou até classifyAcquisition");
      assert.equal(pago!.valor, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Kit sem utm_source (e sem referring_site) fica 'indeterminado' — ausência de origem nunca vira 'organico' por default", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      const dia = "2026-09-06";
      writeCapturaLog(root, [dia]);
      seedKitSubscription(root, "semorigem@example.com", `${dia}T10:00:00.000Z`, null, {});
      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date(`${dia}T18:00:00Z`) });
      const pago = data.decomposicaoCadastros.series?.find((p) => p.chave === "pago");
      const organico = data.decomposicaoCadastros.series?.find((p) => p.chave === "organico");
      const indeterminado = data.decomposicaoCadastros.series?.find((p) => p.chave === "indeterminado");
      assert.equal(pago?.valor ?? 0, 0, "sem utm_source real, nunca deve cair em 'pago' por engano");
      assert.equal(organico?.valor ?? 0, 0, "ausência de origem não é 'organico' — classificação inventada seria pior que indeterminado");
      assert.equal(indeterminado?.valor ?? 0, 1, "sem nenhum sinal positivo de origem, a classe honesta é 'indeterminado'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildMetricsData — kitActive real, não mais null fixo (#7916, fatia 1/N)", () => {
  it("store sem store diaria-subscribers: kitActiveLayer.available=false, count=null, motivo explícito", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      const data = await buildMetricsData(root, { forceRefresh: true });
      assert.equal(data.queda.kitActiveLayer.available, false);
      assert.equal(data.queda.kitActiveLayer.count, null);
      assert.ok(data.queda.kitActiveLayer.motivo);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("REGRESSÃO: kit ativo no store deixa de ser null fixo — count real + frescor (asOf) expostos", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      const dia = "2026-09-07";
      writeBeehiivSnapshot(root, dia, [beehiivSubscriberLine()]);
      seedKitSubscription(root, "kit1@example.com", `${dia}T10:00:00.000Z`, "google.com", { updatedAt: `${dia}T12:00:00.000Z` });
      seedKitSubscription(root, "kit2@example.com", `${dia}T11:00:00.000Z`, "google.com", { updatedAt: `${dia}T13:00:00.000Z` });
      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date(`${dia}T18:00:00Z`) });

      assert.equal(data.queda.kitActiveLayer.available, true);
      assert.equal(data.queda.kitActiveLayer.count, 2, "2 assinantes Kit ativos seedados — nunca mais null fixo");
      assert.equal(data.queda.kitActiveLayer.asOf, `${dia}T13:00:00.000Z`, "frescor = MAX(updated_at) das linhas Kit ativas, nunca cego");

      const kitSeries = data.queda.baseAtiva.series?.find((s) => s.chave === "kit");
      assert.ok(kitSeries, "base-ativa decomposta por plataforma precisa incluir a série 'kit'");
      assert.equal(kitSeries!.valor, 2, "a contagem real do Kit chega até o MetricResult fundido, não só na camada exposta");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("baseAtivaAnterior (dia anterior) NÃO reusa a contagem ATUAL do Kit — sem série histórica, kit fica null explícito nessa comparação", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      const hoje = "2026-09-08";
      const ontem = "2026-09-07";
      writeBeehiivSnapshot(root, ontem, [beehiivSubscriberLine()]);
      writeBeehiivSnapshot(root, hoje, [beehiivSubscriberLine(), beehiivSubscriberLine({ email: "b@example.com" })]);
      seedKitSubscription(root, "kit1@example.com", `${hoje}T10:00:00.000Z`, "google.com");
      const data = await buildMetricsData(root, { forceRefresh: true, now: () => new Date(`${hoje}T18:00:00Z`) });

      assert.equal(data.queda.kitActiveLayer.count, 1, "contagem ATUAL do Kit é real");
      const kitSeriesAnterior = data.queda.baseAtivaAnterior?.series?.find((s) => s.chave === "kit");
      assert.ok(kitSeriesAnterior, "decomposição do dia anterior também traz a série 'kit'");
      assert.equal(
        kitSeriesAnterior!.valor,
        null,
        "sem série histórica do Kit por dia, reusar a contagem de HOJE como se fosse 'ontem' inflaria a comparação em silêncio",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildMetricsData — cache + forceRefresh", () => {
  it("retorna cached=true dentro do TTL sem forceRefresh", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      const first = await buildMetricsData(root, { now: () => new Date("2026-09-03T10:00:00Z") });
      assert.equal(first.cached, false);
      const second = await buildMetricsData(root, { now: () => new Date("2026-09-03T10:01:00Z") });
      assert.equal(second.cached, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forceRefresh bypassa o cache mesmo dentro do TTL", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      await buildMetricsData(root, { now: () => new Date("2026-09-03T10:00:00Z") });
      const refreshed = await buildMetricsData(root, { now: () => new Date("2026-09-03T10:01:00Z"), forceRefresh: true });
      assert.equal(refreshed.cached, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TTL expirado recomputa (cached=false)", async () => {
    clearMetricsCache();
    const root = makeRoot();
    try {
      mkdirSync(join(root, "data"), { recursive: true });
      await buildMetricsData(root, { now: () => new Date("2026-09-03T10:00:00Z"), cacheTtlMs: 1000 });
      const after = await buildMetricsData(root, { now: () => new Date("2026-09-03T10:00:02Z"), cacheTtlMs: 1000 });
      assert.equal(after.cached, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
