/**
 * #8548 — relatório de confirmação DOI por CANAL PAGO (`utm_source` do Kit) com
 * métrica primária = tempo até confirmar (p50/p90) em coorte fechada de 7d+.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildConfirmationReport,
  renderConfirmationReportText,
  classifyCanalPago,
  PAID_UTM_SOURCES,
  CANAL_PAGO_ORGANICO_LABEL,
  CANAL_PAGO_UNKNOWN_LABEL,
} from "../scripts/lib/subscriber-confirmation-report.ts";
import {
  parseSubscriberStateJsonl,
  serializeSubscriberStateRecords,
  snapshotJsonlPath,
  toSubscriberStateRecord,
  type SubscriberStateRecord,
} from "../scripts/lib/subscriber-state-snapshot.ts";
import { CHANNEL_KEY_SPECS } from "../scripts/lib/shared/channel-key-specs.ts";
import { openDiariaSubscribersDb } from "../scripts/lib/diaria-subscribers-db.ts";
import { loadKitUtmSourceMap, defaultSubscribersDbPath } from "../scripts/subscriber-confirmation-report.ts";

/** created_at ao meio-dia BRT do dia (UTC-3). */
const at = (day: string): string => `${day}T15:00:00.000Z`;
const rec = (id: number, state: string, day: string, extra: Partial<SubscriberStateRecord> = {}): SubscriberStateRecord => ({
  id,
  state,
  created_at: at(day),
  ...extra,
});

describe("classifyCanalPago", () => {
  it("chaves pagas exatas (normalizadas), resto orgânico, sem dado = desconhecido", () => {
    assert.equal(classifyCanalPago("google-ads", true), "google-ads");
    assert.equal(classifyCanalPago(" Meta-Ads ", true), "meta-ads");
    assert.equal(classifyCanalPago("microsoft-ads", true), "microsoft-ads");
    assert.equal(classifyCanalPago("linkedin", true), CANAL_PAGO_ORGANICO_LABEL);
    assert.equal(classifyCanalPago(null, true), CANAL_PAGO_ORGANICO_LABEL);
    assert.equal(classifyCanalPago("", true), CANAL_PAGO_ORGANICO_LABEL);
    assert.equal(classifyCanalPago("google-ads", false), CANAL_PAGO_UNKNOWN_LABEL);
  });

  it("PAID_UTM_SOURCES casa com as specs 'teste 2608' de CHANNEL_KEY_SPECS (drift)", () => {
    const teste2608 = CHANNEL_KEY_SPECS.filter((s) => s.canal.includes("teste 2608")).flatMap((s) => s.keys);
    assert.deepEqual([...PAID_UTM_SOURCES].sort(), [...teste2608].sort());
  });
});

describe("snapshot grava/lê utm_source (#8548)", () => {
  it("toSubscriberStateRecord pega fields.utm_source e o parse preserva", () => {
    const r = toSubscriberStateRecord({ id: 9, state: "inactive", created_at: at("2026-10-01"), fields: { utm_source: "meta-ads" } });
    assert.equal(r.utm_source, "meta-ads");
    const [back] = parseSubscriberStateJsonl(serializeSubscriberStateRecords([r]));
    assert.equal(back.utm_source, "meta-ads");
  });

  it("#10507: fields presente com utm_source vazio grava \"\" (prova de campo vazio) e o parse preserva", () => {
    const vazio = toSubscriberStateRecord({ id: 9, state: "inactive", created_at: at("2026-10-01"), fields: { utm_source: "" } });
    assert.equal(vazio.utm_source, "");
    const semChave = toSubscriberStateRecord({ id: 9, state: "inactive", created_at: at("2026-10-01"), fields: {} });
    assert.equal(semChave.utm_source, "");
    const [back] = parseSubscriberStateJsonl(serializeSubscriberStateRecords([vazio]));
    assert.equal(back.utm_source, "");
  });

  it("#10507: sem fields (cobertura desconhecida) e linha antiga sem o campo seguem ausentes", () => {
    const semFields = toSubscriberStateRecord({ id: 9, state: "inactive", created_at: at("2026-10-01") });
    assert.equal("utm_source" in semFields, false);
    const [antigo] = parseSubscriberStateJsonl(JSON.stringify({ id: 9, state: "inactive", created_at: at("2026-10-01") }) + "\n");
    assert.equal("utm_source" in antigo, false);
  });
});

describe("#10507 — orgânico recente fora do store não cai em desconhecido", () => {
  it("nascimento com utm_source \"\" e sem store = orgânico; snapshot antigo sem o campo = desconhecido", () => {
    const s = new Map<string, SubscriberStateRecord[]>([
      ["2026-10-01", [rec(1, "inactive", "2026-10-01", { utm_source: "" }), rec(2, "inactive", "2026-10-01")]],
      ["2026-10-02", [rec(1, "active", "2026-10-01", { utm_source: "" }), rec(2, "active", "2026-10-01")]],
    ]);
    const r = buildConfirmationReport(s);
    assert.equal(r.por_canal_pago[CANAL_PAGO_ORGANICO_LABEL].n, 1); // #1
    assert.equal(r.por_canal_pago[CANAL_PAGO_UNKNOWN_LABEL].n, 1); // #2
    assert.deepEqual(r.utm_cobertura, { snapshot: 1, store: 0, desconhecido: 1 });
  });

  it("\"\" no nascimento perde pro store e pro valor posterior (lag de fields do endpoint de lista)", () => {
    const s = new Map<string, SubscriberStateRecord[]>([
      ["2026-10-01", [rec(1, "inactive", "2026-10-01", { utm_source: "" }), rec(2, "inactive", "2026-10-01", { utm_source: "" })]],
      ["2026-10-02", [rec(1, "active", "2026-10-01", { utm_source: "google-ads" }), rec(2, "active", "2026-10-01", { utm_source: "" })]],
    ]);
    const r = buildConfirmationReport(s, { utmSourceByKitId: new Map([[2, "meta-ads"]]) });
    assert.equal(r.por_canal_pago["google-ads"].n, 1); // #1: valor posterior
    assert.equal(r.por_canal_pago["meta-ads"].n, 1); // #2: store
    assert.equal(r.por_canal_pago[CANAL_PAGO_ORGANICO_LABEL], undefined);
    assert.deepEqual(r.utm_cobertura, { snapshot: 1, store: 1, desconhecido: 0 });
  });
});

describe("buildConfirmationReport — por_canal_pago e tempo até confirmar 7d+", () => {
  // Coorte 2026-09-01 (fechada em as_of 2026-09-15):
  //   google-ads: #1 confirma D+1, #2 D+3, #3 D+10 (fora do horizonte de 7d), #4 nunca.
  //   meta-ads:   #5 confirma D+5, #6 nunca.
  // Coorte 2026-09-12 (aberta): google-ads #7 confirma D+1 — não entra na 7d+.
  const days: Record<number, number | null> = { 1: 1, 2: 3, 3: 10, 4: null, 5: 5, 6: null };
  const utm: Record<number, string> = { 1: "google-ads", 2: "google-ads", 3: "google-ads", 4: "google-ads", 5: "meta-ads", 6: "meta-ads" };
  const dates = ["2026-09-01", "2026-09-02", "2026-09-04", "2026-09-06", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-15"];
  const offset = (d: string) => Math.round((Date.parse(d) - Date.parse("2026-09-01")) / 86_400_000);
  const snapshots = new Map<string, SubscriberStateRecord[]>();
  for (const d of dates) {
    const recs: SubscriberStateRecord[] = [];
    for (const id of [1, 2, 3, 4, 5, 6]) {
      const dc = days[id];
      recs.push(rec(id, dc !== null && offset(d) >= dc ? "active" : "inactive", "2026-09-01", { utm_source: utm[id] }));
    }
    if (d >= "2026-09-12") recs.push(rec(7, d >= "2026-09-13" ? "active" : "inactive", "2026-09-12", { utm_source: "google-ads" }));
    snapshots.set(d, recs);
  }

  it("agrupa por utm_source e calcula p50/p90 entre os confirmados até D+7 da coorte fechada", () => {
    const r = buildConfirmationReport(snapshots);
    assert.deepEqual(Object.keys(r.por_canal_pago).sort(), ["google-ads", "meta-ads"]);
    const g = r.por_canal_pago["google-ads"];
    assert.equal(g.n, 5); // inclui o #7 da coorte aberta
    const c = g.tempo_ate_confirmar_7d;
    assert.equal(c.horizonte_dias, 7);
    assert.equal(c.base_coorte_fechada, 4); // #7 fora (coorte aberta)
    assert.equal(c.confirmados, 2); // #1 (1d) e #2 (3d); #3 confirmou em 10d, fora do horizonte
    assert.equal(c.taxa, 0.5);
    assert.equal(c.p50_dias, 1);
    assert.equal(c.p90_dias, 3);
    const m = r.por_canal_pago["meta-ads"].tempo_ate_confirmar_7d;
    assert.deepEqual([m.base_coorte_fechada, m.confirmados, m.p50_dias, m.p90_dias], [2, 1, 5, 5]);
    assert.deepEqual(r.utm_cobertura, { snapshot: 7, store: 0, desconhecido: 0 });
  });

  it("usa o PRIMEIRO utm_source visto (reativar sobrescreve depois, #8235)", () => {
    const s = new Map<string, SubscriberStateRecord[]>([
      ["2026-09-01", [rec(1, "inactive", "2026-09-01", { utm_source: "google-ads" })]],
      ["2026-09-09", [rec(1, "active", "2026-09-01", { utm_source: "reativar" })]],
    ]);
    const r = buildConfirmationReport(s);
    assert.deepEqual(Object.keys(r.por_canal_pago), ["google-ads"]);
  });

  it("coorte anterior ao campo: store vence utm_source de snapshot posterior (pode ser pós-reativar)", () => {
    const s = new Map<string, SubscriberStateRecord[]>([
      ["2026-09-01", [rec(1, "inactive", "2026-09-01"), rec(2, "inactive", "2026-09-01")]],
      ["2026-09-09", [rec(1, "active", "2026-09-01", { utm_source: "reativar" }), rec(2, "active", "2026-09-01", { utm_source: "meta-ads" })]],
    ]);
    const r = buildConfirmationReport(s, { utmSourceByKitId: new Map([[1, "google-ads"]]) });
    // #1: store (google-ads) vence o "reativar" posterior; #2: fora do store, usa o posterior.
    assert.deepEqual(Object.keys(r.por_canal_pago).sort(), ["google-ads", "meta-ads"]);
    assert.deepEqual(r.utm_cobertura, { snapshot: 1, store: 1, desconhecido: 0 });
  });

  it("snapshot sem utm_source cai no store; fora dos dois = desconhecido, nunca orgânico", () => {
    const s = new Map<string, SubscriberStateRecord[]>([
      ["2026-09-01", [rec(1, "inactive", "2026-09-01"), rec(2, "inactive", "2026-09-01"), rec(3, "inactive", "2026-09-01"), rec(4, "active", "2026-09-01")]],
      ["2026-09-08", [rec(1, "active", "2026-09-01"), rec(2, "inactive", "2026-09-01"), rec(3, "active", "2026-09-01"), rec(4, "active", "2026-09-01")]],
    ]);
    const store = new Map<number, string | null>([
      [1, "meta-ads"],
      [2, null],
      [4, "meta-ads"],
    ]);
    const r = buildConfirmationReport(s, { utmSourceByKitId: store });
    assert.equal(r.por_canal_pago["meta-ads"].n, 1);
    assert.equal(r.por_canal_pago["meta-ads"].ambiguos_active, 1); // #4, ambíguo também aparece no grupo
    assert.equal(r.por_canal_pago[CANAL_PAGO_ORGANICO_LABEL].n, 1); // #2: no store, sem utm
    assert.equal(r.por_canal_pago[CANAL_PAGO_UNKNOWN_LABEL].n, 1); // #3
    assert.deepEqual(r.utm_cobertura, { snapshot: 0, store: 3, desconhecido: 1 });
    assert.ok(r.avisos.some((a) => a.includes("sem utm_source em nenhuma fonte")));
  });

  it("render texto traz a seção de canal pago com a métrica primária", () => {
    const txt = renderConfirmationReportText(buildConfirmationReport(snapshots));
    assert.match(txt, /POR CANAL PAGO \(utm_source, #8548\)/);
    assert.match(txt, /google-ads\s+coorte fechada 7d\+: p50=1d p90=3d confirmou até 7d 50\.0% \(2\/4\)/);
  });

  it("relatório vazio inclui por_canal_pago vazio", () => {
    const r = buildConfirmationReport(new Map());
    assert.deepEqual(r.por_canal_pago, {});
    assert.match(renderConfirmationReportText(r), /POR CANAL PAGO[\s\S]*\(vazio\)/);
  });
});

describe("store de assinantes (somente leitura) → mapa de utm_source", () => {
  function makeStore(): string {
    const dir = mkdtempSync(resolve(tmpdir(), "conf-8548-db-"));
    const path = resolve(dir, "diaria-subscribers.db");
    const db = openDiariaSubscribersDb(path);
    const now = "2026-10-01T00:00:00.000Z";
    const add = (sid: number, extId: string | null, email: string, platform: string, utm: string | null) => {
      db.prepare("INSERT INTO subscriber (id, created_at, updated_at) VALUES (?, ?, ?)").run(sid, now, now);
      db.prepare("INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, ?, ?, ?, ?)").run(
        sid,
        platform,
        extId,
        email,
        now,
      );
      db.prepare("INSERT INTO subscription (subscriber_id, platform, utm_source, updated_at) VALUES (?, ?, ?, ?)").run(sid, platform, utm, now);
    };
    add(1, "101", "a@x", "kit", "google-ads");
    add(2, "102", "b@x", "kit", null);
    add(3, "103", "c@x", "brevo", "meta-ads"); // outra plataforma: ignorado
    add(4, null, "d@x", "kit", "meta-ads"); // sem external_id: ignorado
    db.close();
    return path;
  }

  it("lê id Kit → utm_source (null = orgânico conhecido) só da plataforma kit", () => {
    const { map, aviso } = loadKitUtmSourceMap(makeStore());
    assert.equal(aviso, undefined);
    assert.deepEqual([...map!.entries()].sort(), [
      [101, "google-ads"],
      [102, null],
    ]);
  });

  it("store ausente: map null + aviso, sem lançar", () => {
    const { map, aviso } = loadKitUtmSourceMap(resolve(tmpdir(), "nao-existe-8548", "x.db"));
    assert.equal(map, null);
    assert.match(aviso!, /store de assinantes ausente/);
  });

  it("default do store deriva do --root (data/diaria-subscribers/)", () => {
    assert.equal(
      defaultSubscribersDbPath("/d/data/subscriber-state-snapshots/kit"),
      resolve("/d/data/diaria-subscribers/diaria-subscribers.db"),
    );
  });
});

describe("CLI --subscribers-db (#8548)", () => {
  const cli = resolve(import.meta.dirname, "..", "scripts", "subscriber-confirmation-report.ts");
  it("cruza snapshot sem utm com o store e emite por_canal_pago no JSON", () => {
    const root = mkdtempSync(resolve(tmpdir(), "conf-8548-cli-"));
    const write = (date: string, recs: SubscriberStateRecord[]) => {
      mkdirSync(resolve(root, date), { recursive: true });
      writeFileSync(snapshotJsonlPath(root, date), serializeSubscriberStateRecords(recs));
    };
    write("2026-09-01", [rec(101, "inactive", "2026-09-01")]);
    write("2026-09-09", [rec(101, "active", "2026-09-01")]);
    const dbDir = mkdtempSync(resolve(tmpdir(), "conf-8548-cli-db-"));
    const dbPath = resolve(dbDir, "s.db");
    const db = openDiariaSubscribersDb(dbPath);
    const now = "2026-10-01T00:00:00.000Z";
    db.prepare("INSERT INTO subscriber (id, created_at, updated_at) VALUES (1, ?, ?)").run(now, now);
    db.prepare("INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (1, 'kit', '101', 'a@x', ?)").run(now);
    db.prepare("INSERT INTO subscription (subscriber_id, platform, utm_source, updated_at) VALUES (1, 'kit', 'meta-ads', ?)").run(now);
    db.close();
    const res = spawnSync(process.execPath, ["--import", "tsx", cli, "--root", root, "--subscribers-db", dbPath, "--format", "json"], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(out.por_canal_pago), ["meta-ads"]);
    assert.equal(out.por_canal_pago["meta-ads"].tempo_ate_confirmar_7d.base_coorte_fechada, 1);
    assert.equal(out.utm_cobertura.store, 1);
  });

  it("sem store: segue com aviso e canal desconhecido", () => {
    const root = mkdtempSync(resolve(tmpdir(), "conf-8548-cli-nodb-"));
    mkdirSync(resolve(root, "2026-09-01"), { recursive: true });
    writeFileSync(snapshotJsonlPath(root, "2026-09-01"), serializeSubscriberStateRecords([rec(1, "inactive", "2026-09-01")]));
    const res = spawnSync(process.execPath, ["--import", "tsx", cli, "--root", root], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /store de assinantes ausente/);
    assert.match(res.stdout, /\(utm_source desconhecido\)/);
  });
});
