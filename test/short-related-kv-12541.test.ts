/**
 * test/short-related-kv-12541.test.ts (#12541 item 2)
 *
 * Registro do vínculo do vídeo relacionado do Short no KV da Cloudflare:
 * formato da chave/valor, leitura com incerteza explícita, publicação com
 * releitura, e as três ramificações do alarme do `300` (KV com registro,
 * KV e arquivo sem registro, KV ilegível). Nenhum teste fala com a
 * Cloudflare real: o `KvOps` é um Map em memória.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHORT_RELATED_KV_PREFIX,
  publishShortRelatedKv,
  readShortRelatedKv,
  resolveOpsStateKvConfig,
  serializeShortRelatedKvValue,
  shortRelatedKvKey,
} from "../scripts/lib/diaria/short-related-kv.ts";
import {
  evaluateShortRelatedMissed,
  isAlarmingShortRelatedVerdict,
  shortRelatedMissedSeverity,
  buildShortRelatedMissedAlarm,
  type FileRead,
  type ShortRelatedMissedInput,
} from "../scripts/lib/diaria/short-related-missed-alarm.ts";
import {
  brtInstant,
  buildShortRelatedRecord,
  markAlerted,
  parseShortRelatedRecord,
  type ShortRelatedRecord,
} from "../scripts/lib/diaria/youtube-short-related.ts";
import type { ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";

const ROOT = join(import.meta.dirname, "..");
// 261105 é quinta (a edição do #12315).
const ED = "261105";
const SHORT_AT = brtInstant(ED, "06:30");
const AFTER_DEADLINE = brtInstant(ED, "13:30");

function memKv(init: Record<string, string> = {}) {
  const store = new Map(Object.entries(init));
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
  };
}

const linked: ShortRelatedRecord = buildShortRelatedRecord({
  aammdd: ED,
  status: "linked",
  horizontalId: "hhhhhhhhhhh",
  shortId: "sssssssssss",
  note: "Alterações salvas; relido no Studio",
  now: new Date("2026-11-05T09:20:00.000Z"),
  previous: null,
});

describe("#12541 KV: chave e valor", () => {
  it("chave é short-related:{AAMMDD}", () => {
    assert.equal(SHORT_RELATED_KV_PREFIX, "short-related:");
    assert.equal(shortRelatedKvKey(ED), "short-related:261105");
  });

  it("chave recusa AAMMDD inválido", () => {
    assert.throws(() => shortRelatedKvKey("2611"), /AAMMDD inválido/);
    assert.throws(() => shortRelatedKvKey("26110a"), /AAMMDD inválido/);
  });

  it("valor é o registro do arquivo, legível pelo mesmo parser", () => {
    const raw = serializeShortRelatedKvValue(linked);
    assert.deepEqual(JSON.parse(raw), linked);
    assert.deepEqual(parseShortRelatedRecord(raw, ED), linked);
  });
});

describe("#12541 KV: config", () => {
  const cfg = { ops_state_kv: { namespace_id: "ns1" } };
  it("resolve namespace + conta + token do Workers", () => {
    const r = resolveOpsStateKvConfig(cfg, { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_WORKERS_TOKEN: "tok" });
    assert.deepEqual(r, { ok: true, config: { accountId: "acc", token: "tok", namespaceId: "ns1" } });
  });
  it("cai no CLOUDFLARE_API_TOKEN como reserva", () => {
    const r = resolveOpsStateKvConfig(cfg, { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "api" });
    assert.equal(r.ok && r.config.token, "api");
  });
  it("lista o que falta, sem valores", () => {
    const r = resolveOpsStateKvConfig({}, {});
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.missing.length, 3);
  });
  it("platform.config.json tem o namespace do diaria-ops-state", () => {
    const pc = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    assert.match(pc.ops_state_kv.namespace_id, /^[0-9a-f]{32}$/);
  });
});

describe("#12541 KV: leitura e publicação", () => {
  it("chave ausente → absent", async () => {
    assert.deepEqual(await readShortRelatedKv(memKv(), ED), { kind: "absent" });
  });

  it("erro de rede → error (nunca absent)", async () => {
    const r = await readShortRelatedKv({ get: async () => { throw new Error("HTTP 503"); } }, ED);
    assert.equal(r.kind, "error");
  });

  it("valor de outra edição ou corrompido → error", async () => {
    const other = { ...linked, aammdd: "261104" };
    assert.equal((await readShortRelatedKv(memKv({ "short-related:261105": JSON.stringify(other) }), ED)).kind, "error");
    assert.equal((await readShortRelatedKv(memKv({ "short-related:261105": "{" }), ED)).kind, "error");
  });

  it("publica e relê o registro", async () => {
    const kv = memKv();
    assert.equal(await publishShortRelatedKv(kv, linked), "short-related:261105");
    const back = await readShortRelatedKv(kv, ED);
    assert.deepEqual(back, { kind: "ok", value: linked });
  });

  it("registro de alerta sem anterior (ordem de chaves diferente) publica e relê", async () => {
    const rec = markAlerted({ aammdd: ED, previous: null, horizontalId: null, shortId: null, note: "x", now: new Date("2026-11-05T10:00:00Z") });
    await publishShortRelatedKv(memKv(), rec);
  });

  it("releitura divergente lança (PUT 2xx não é prova)", async () => {
    const kv = { get: async () => null, put: async () => {} };
    await assert.rejects(() => publishShortRelatedKv(kv, linked), /releitura/);
  });
});

describe("#12541 alarme: KV antes do arquivo replicado", () => {
  const registry: FileRead<ShortsPublishedFile> = {
    kind: "ok",
    value: {
      aammdd: ED,
      entries: [{ destination: "youtube_shorts", status: "published", id: "sssssssssss", at: "2026-11-05T09:30:00.000Z" }],
    },
  };
  const input = (over: Partial<ShortRelatedMissedInput>): ShortRelatedMissedInput => ({
    aammdd: ED,
    now: AFTER_DEADLINE,
    editionExists: true,
    noVideo: false,
    shortsRegistry: registry,
    record: { kind: "absent" },
    shortAt: SHORT_AT,
    ...over,
  });

  it("caso 261105: arquivo ausente no 300, registro no KV → não alarma", () => {
    const ev = evaluateShortRelatedMissed(input({ kvRecord: { kind: "ok", value: linked } }));
    assert.equal(ev.verdict, "linked");
    assert.equal(ev.recordSource, "kv");
    assert.equal(isAlarmingShortRelatedVerdict(ev.verdict), false);
  });

  it("KV com alerta já enviado → task-alerted (não alarma)", () => {
    const rec = markAlerted({ aammdd: ED, previous: null, horizontalId: null, shortId: null, note: "x", now: new Date("2026-11-05T10:00:00Z") });
    const ev = evaluateShortRelatedMissed(input({ kvRecord: { kind: "ok", value: rec } }));
    assert.equal(ev.verdict, "task-alerted");
    assert.equal(isAlarmingShortRelatedVerdict(ev.verdict), false);
  });

  it("KV vence o arquivo replicado defasado", () => {
    const failed = buildShortRelatedRecord({ aammdd: ED, status: "failed", horizontalId: null, shortId: null, note: "x", now: new Date("2026-11-05T09:10:00Z"), previous: null });
    const ev = evaluateShortRelatedMissed(input({ kvRecord: { kind: "ok", value: linked }, record: { kind: "ok", value: failed } }));
    assert.equal(ev.verdict, "linked");
  });

  it("KV sem registro E arquivo sem registro → missing-record, como antes", () => {
    const ev = evaluateShortRelatedMissed(input({ kvRecord: { kind: "absent" } }));
    assert.equal(ev.verdict, "missing-record");
    assert.equal(isAlarmingShortRelatedVerdict(ev.verdict), true);
    assert.equal(shortRelatedMissedSeverity(ev.verdict), "acao");
  });

  it("KV sem registro, arquivo com registro → o arquivo decide", () => {
    const ev = evaluateShortRelatedMissed(input({ kvRecord: { kind: "absent" }, record: { kind: "ok", value: linked } }));
    assert.equal(ev.verdict, "linked");
    assert.equal(ev.recordSource, "file");
  });

  it("KV com erro e arquivo sem registro → record-unconfirmed: alarma como incerteza, nunca silêncio", () => {
    const ev = evaluateShortRelatedMissed(input({ kvRecord: { kind: "error", error: "HTTP 503" } }));
    assert.equal(ev.verdict, "record-unconfirmed");
    assert.equal(ev.kvError, "HTTP 503");
    assert.equal(isAlarmingShortRelatedVerdict(ev.verdict), true);
    assert.equal(shortRelatedMissedSeverity(ev.verdict), "acao");
    const { body } = buildShortRelatedMissedAlarm(ev, "https://studio");
    assert.match(body, /NÃO afirma que a task falhou/);
    assert.match(body, /leitura do KV falhou: HTTP 503/);
  });

  it("KV com erro e arquivo com registro → o arquivo decide, erro do KV fica registrado", () => {
    const ev = evaluateShortRelatedMissed(input({ kvRecord: { kind: "error", error: "timeout" }, record: { kind: "ok", value: linked } }));
    assert.equal(ev.verdict, "linked");
    assert.equal(ev.kvError, "timeout");
  });

  it("antes do prazo o KV não muda nada", () => {
    const ev = evaluateShortRelatedMissed(input({ now: SHORT_AT, kvRecord: { kind: "error", error: "x" } }));
    assert.equal(ev.verdict, "before-deadline");
  });
});
