/**
 * #11413 — cópia off-site, compactada e criptografada, dos snapshots da
 * Beehiiv e dos votos do É IA? no bucket R2 privado `diaria-backup`.
 * Nenhum teste fala com rede real: `fetch` e o KV são stubs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { backupKeyId, BACKUP_HEADER_LEN, decryptBackup, encryptBackup, parseBackupKey } from "../scripts/lib/backup-offsite-crypto.ts";
import {
  BACKUP_OFFSITE_BUCKET,
  checkRemoteOffsiteBackup,
  dateFromOffsiteKey,
  dumpKvPrefixes,
  kvRestDumpSource,
  loadOffsiteAccess,
  loadOffsiteConfig,
  offsiteObjectKey,
  remoteOffsiteFingerprint,
  tarGzDirectory,
  type KvDumpSource,
  type TarRunner,
} from "../scripts/lib/backup-offsite.ts";
import { kvRestBulkGet } from "../scripts/lib/cloudflare-kv-rest.ts";
import { runOffsiteBackup, offsiteFailureFingerprint } from "../scripts/backup-offsite.ts";
import { kindFromKey, restoreBlob } from "../scripts/restore-backup-offsite.ts";
import { buildRemoteOffsiteAlarmEmail } from "../scripts/lib/beehiiv-backup-staleness-alarm.ts";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const KEY = parseBackupKey(KEY_B64);
const ENV = {
  R2_ACCOUNT_ID: "acc123",
  R2_BACKUP_ACCESS_KEY_ID: "bk-id",
  R2_BACKUP_SECRET_ACCESS_KEY: "bk-secret",
  BACKUP_ENCRYPTION_KEY: KEY_B64,
};
const NOW = new Date("2026-11-08T06:05:00Z");

// ---------------------------------------------------------------------------

describe("#11413 cifra AES-256-GCM", () => {
  it("encrypt→decrypt devolve os mesmos bytes (inclusive vazio e grande)", () => {
    for (const plain of [Buffer.alloc(0), Buffer.from("olá, backup"), randomBytes(1_000_003)]) {
      const enc = encryptBackup(plain, KEY);
      assert.equal(enc.subarray(0, 8).toString("ascii"), "DIARIABK");
      assert.equal(enc[8], 1, "versão do formato");
      assert.equal(enc.length, BACKUP_HEADER_LEN + plain.length);
      assert.ok(decryptBackup(enc, KEY).equals(plain));
    }
  });

  it("IV aleatório: o mesmo conteúdo cifra diferente a cada vez", () => {
    const p = Buffer.from("x".repeat(100));
    assert.ok(!encryptBackup(p, KEY).equals(encryptBackup(p, KEY)));
  });

  it("chave errada falha alto, apontando o keyId (nunca a chave)", () => {
    const enc = encryptBackup(Buffer.from("segredo"), KEY);
    const other = Buffer.alloc(32, 9);
    assert.throws(() => decryptBackup(enc, other), (e: Error) => {
      assert.match(e.message, /outra chave/);
      assert.ok(e.message.includes(backupKeyId(KEY).toString("hex")));
      assert.ok(!e.message.includes(KEY_B64));
      return true;
    });
  });

  it("qualquer byte adulterado (corpo, tag, IV, keyId) falha", () => {
    const enc = encryptBackup(Buffer.from("conteúdo de assinantes"), KEY);
    for (const pos of [enc.length - 1, BACKUP_HEADER_LEN - 1, 20 /* IV */]) {
      const bad = Buffer.from(enc);
      bad[pos] ^= 0x01;
      assert.throws(() => decryptBackup(bad, KEY), /autenticação/);
    }
    const badKid = Buffer.from(enc);
    badKid[10] ^= 0x01;
    assert.throws(() => decryptBackup(badKid, KEY), /outra chave/);
  });

  it("magic, versão e tamanho mínimo são conferidos", () => {
    const enc = encryptBackup(Buffer.from("a"), KEY);
    const badMagic = Buffer.from(enc);
    badMagic[0] = 0x41 + 25;
    assert.throws(() => decryptBackup(badMagic, KEY), /magic/);
    const badVer = Buffer.from(enc);
    badVer[8] = 2;
    assert.throws(() => decryptBackup(badVer, KEY), /versão/);
    assert.throws(() => decryptBackup(enc.subarray(0, 20), KEY), /curto/);
  });

  it("parseBackupKey recusa ausente, não-base64 e tamanho errado sem ecoar o valor", () => {
    assert.throws(() => parseBackupKey(undefined), /BACKUP_ENCRYPTION_KEY ausente/);
    assert.throws(() => parseBackupKey("não é base64!"), /base64/);
    const short = Buffer.alloc(16, 1).toString("base64");
    assert.throws(
      () => parseBackupKey(short),
      (e: Error) => /32 bytes/.test(e.message) && !e.message.includes(short),
    );
    assert.equal(parseBackupKey(KEY_B64).length, 32);
  });
});

// ---------------------------------------------------------------------------

describe("#11413 chave do objeto e config", () => {
  it("monta beehiiv/{data}.tar.gz.enc e eia-votes/{data}.jsonl.gz.enc", () => {
    assert.equal(offsiteObjectKey("beehiiv", "2026-11-08"), "beehiiv/2026-11-08.tar.gz.enc");
    assert.equal(offsiteObjectKey("eia-votes", "2026-11-08"), "eia-votes/2026-11-08.jsonl.gz.enc");
    assert.throws(() => offsiteObjectKey("beehiiv", "261108"), /data inválida/);
    assert.throws(() => offsiteObjectKey("beehiiv", "../x"), /data inválida/);
    assert.equal(dateFromOffsiteKey("beehiiv/2026-11-08.tar.gz.enc"), "2026-11-08");
    assert.equal(dateFromOffsiteKey("2026-11-08.jsonl.gz.enc"), "2026-11-08");
    assert.equal(kindFromKey("beehiiv/2026-11-08.tar.gz.enc"), "beehiiv");
    assert.equal(kindFromKey("/tmp/eia-votes-x/2026-11-08.jsonl.gz.enc"), "eia-votes");
    assert.equal(kindFromKey("foo.bin"), null);
  });

  it("bucket fixo diaria-backup, credencial R2_BACKUP_* — nunca a dos shorts", () => {
    const shortsOnly = { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "shorts", R2_SECRET_ACCESS_KEY: "shorts-s", BACKUP_ENCRYPTION_KEY: KEY_B64 };
    const r = loadOffsiteConfig(shortsOnly);
    assert.equal(r.ready, false);
    assert.deepEqual(!r.ready && r.missing, ["R2_BACKUP_ACCESS_KEY_ID", "R2_BACKUP_SECRET_ACCESS_KEY"]);
    const ok = loadOffsiteConfig({ ...shortsOnly, ...ENV });
    assert.ok(ok.ready);
    assert.equal(ok.ready && ok.access.bucket, BACKUP_OFFSITE_BUCKET);
    assert.equal(ok.ready && ok.access.accessKeyId, "bk-id");
  });

  it("chave de cifra inválida entra em missing com o motivo", () => {
    const r = loadOffsiteConfig({ ...ENV, BACKUP_ENCRYPTION_KEY: "AAAA" });
    assert.equal(r.ready, false);
    assert.match((!r.ready && r.missing.join(";")) || "", /32 bytes/);
  });
});

// ---------------------------------------------------------------------------

interface Call {
  method: string;
  url: string;
  body?: Buffer;
  auth?: string;
}

/** Stub do R2: guarda PUTs e responde HEAD com o tamanho/ETag gravados (ou o que o teste mandar). */
function r2Stub(opts: { headOverride?: (stored: Buffer) => Response; putStatus?: number } = {}) {
  const calls: Call[] = [];
  const store = new Map<string, Buffer>();
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : undefined;
    calls.push({ method, url, body, auth: headers.Authorization });
    const path = new URL(url).pathname;
    if (method === "PUT") {
      if (opts.putStatus && opts.putStatus !== 200) return new Response("nope", { status: opts.putStatus });
      store.set(path, body!);
      return new Response("", { status: 200 });
    }
    if (method === "HEAD") {
      const stored = store.get(path);
      if (!stored) return new Response(null, { status: 404 });
      if (opts.headOverride) return opts.headOverride(stored);
      return new Response(null, {
        status: 200,
        headers: { "content-length": String(stored.length), etag: `"${createHash("md5").update(stored).digest("hex")}"` },
      });
    }
    return new Response("", { status: 500 });
  };
  return { calls, store, deps: { fetch: fetchFn, now: () => NOW } };
}

function snapshotFixture(date = "2026-11-08"): string {
  const root = mkdtempSync(join(tmpdir(), "offsite-11413-"));
  const dir = join(root, date);
  mkdirSync(join(dir, "posts"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ endpoints: [{ key: "subscribers", file: "subscribers.jsonl", status: "ok", count: 1 }] }));
  writeFileSync(join(dir, "subscribers.jsonl"), JSON.stringify({ email: "a@exemplo.com", status: "active" }) + "\n");
  writeFileSync(join(dir, "posts", "p1.json"), JSON.stringify({ id: "p1" }));
  return root;
}

const FAKE_TAR = Buffer.from("tar.gz falso do snapshot");
const tarStub: TarRunner = () => ({ status: 0, stdout: FAKE_TAR, stderr: "" });

const votesSource = (n = 2): KvDumpSource => ({
  async list(prefix) {
    if (prefix === "vote:") return Array.from({ length: n }, (_, i) => `vote:261108:u${i}@x.com`);
    if (prefix === "score:") return ["score:u0@x.com"];
    return [];
  },
  async getMany(keys) {
    return new Map(keys.map((k) => [k, JSON.stringify({ v: k })]));
  },
});

describe("#11413 runOffsiteBackup", () => {
  it("cifra, envia pro bucket privado pela API S3 e confere por HEAD assinado", async () => {
    const root = snapshotFixture();
    const s = r2Stub();
    const logs: string[] = [];
    const res = await runOffsiteBackup(
      { date: "2026-11-08", only: null, dryRun: false, backupRoot: root },
      { env: ENV, r2: s.deps, tar: tarStub, kvSource: () => votesSource(), log: (m) => logs.push(m) },
    );
    assert.deepEqual(
      res.map((r) => [r.kind, r.status, r.key, r.etagVerified]),
      [
        ["beehiiv", "uploaded", "beehiiv/2026-11-08.tar.gz.enc", true],
        ["eia-votes", "uploaded", "eia-votes/2026-11-08.jsonl.gz.enc", true],
      ],
    );
    // Endpoint S3 da conta, bucket diaria-backup; nada de URL pública.
    for (const c of s.calls) {
      assert.ok(c.url.startsWith("https://acc123.r2.cloudflarestorage.com/diaria-backup/"), c.url);
      assert.match(c.auth ?? "", /^AWS4-HMAC-SHA256 Credential=bk-id\//);
    }
    assert.deepEqual(s.calls.map((c) => c.method), ["PUT", "HEAD", "PUT", "HEAD"]);
    // O que subiu decifra pro tar.gz exato e pro JSONL dos votos.
    const bh = s.store.get("/diaria-backup/beehiiv/2026-11-08.tar.gz.enc")!;
    assert.ok(decryptBackup(bh, KEY).equals(FAKE_TAR));
    const votes = gunzipSync(decryptBackup(s.store.get("/diaria-backup/eia-votes/2026-11-08.jsonl.gz.enc")!, KEY)).toString("utf8");
    assert.equal(votes.trim().split("\n").length, 3);
    // Tamanho de cada upload vai pro log (faixa grátis do R2).
    assert.ok(logs.some((l) => /beehiiv: enviado .* bytes/.test(l)));
    assert.ok(logs.some((l) => /eia-votes: enviado .* bytes/.test(l)));
  });

  it("sem credencial: recusa os dois passos e não chama a rede", async () => {
    const s = r2Stub();
    const { BACKUP_ENCRYPTION_KEY: _k, ...noBackupCreds } = ENV;
    for (const env of [{ BACKUP_ENCRYPTION_KEY: KEY_B64 }, noBackupCreds]) {
      const res = await runOffsiteBackup(
        { date: "2026-11-08", only: null, dryRun: false, backupRoot: snapshotFixture() },
        { env, r2: s.deps, tar: tarStub, kvSource: () => votesSource(), log: () => {} },
      );
      assert.deepEqual(res.map((r) => r.status), ["failed", "failed"]);
      assert.match(res[0].detail!, /configuração ausente/);
    }
    assert.equal(s.calls.length, 0);
  });

  it("HEAD com tamanho diferente do enviado = falha (nunca 'ok' silencioso)", async () => {
    const s = r2Stub({ headOverride: (b) => new Response(null, { status: 200, headers: { "content-length": String(b.length - 1) } }) });
    const res = await runOffsiteBackup(
      { date: "2026-11-08", only: "beehiiv", dryRun: false, backupRoot: snapshotFixture() },
      { env: ENV, r2: s.deps, tar: tarStub, log: () => {} },
    );
    assert.equal(res[0].status, "failed");
    assert.match(res[0].detail!, /HEAD informa/);
  });

  it("ETag que não é o MD5 do corpo = falha", async () => {
    const s = r2Stub({
      headOverride: (b) => new Response(null, { status: 200, headers: { "content-length": String(b.length), etag: `"${"0".repeat(32)}"` } }),
    });
    const res = await runOffsiteBackup(
      { date: "2026-11-08", only: "beehiiv", dryRun: false, backupRoot: snapshotFixture() },
      { env: ENV, r2: s.deps, tar: tarStub, log: () => {} },
    );
    assert.equal(res[0].status, "failed");
    assert.match(res[0].detail!, /ETag/);
  });

  it("PUT recusado = falha com o status", async () => {
    const s = r2Stub({ putStatus: 403 });
    const res = await runOffsiteBackup(
      { date: "2026-11-08", only: "beehiiv", dryRun: false, backupRoot: snapshotFixture() },
      { env: ENV, r2: s.deps, tar: tarStub, log: () => {} },
    );
    assert.equal(res[0].status, "failed");
    assert.match(res[0].detail!, /HTTP 403/);
  });

  it("snapshot do dia ausente ou inutilizável: pula o Beehiiv, segue com os votos", async () => {
    const root = snapshotFixture("2026-11-01");
    const s = r2Stub();
    const res = await runOffsiteBackup(
      { date: "2026-11-08", only: null, dryRun: false, backupRoot: root },
      { env: ENV, r2: s.deps, tar: tarStub, kvSource: () => votesSource(), log: () => {} },
    );
    assert.deepEqual(res.map((r) => r.status), ["skipped", "uploaded"]);
    assert.match(res[0].detail!, /não existe/);

    writeFileSync(join(root, "2026-11-01", "manifest.json"), JSON.stringify({ endpoints: [{ key: "subscribers", file: "subscribers.jsonl", status: "error", error: "boom" }] }));
    const res2 = await runOffsiteBackup(
      { date: "2026-11-01", only: "beehiiv", dryRun: false, backupRoot: root },
      { env: ENV, r2: s.deps, tar: tarStub, log: () => {} },
    );
    assert.equal(res2[0].status, "skipped");
    assert.match(res2[0].detail!, /inutilizável/);
  });

  it("--dry-run empacota e cifra, mas não faz request nenhuma", async () => {
    const s = r2Stub();
    const res = await runOffsiteBackup(
      { date: "2026-11-08", only: null, dryRun: true, backupRoot: snapshotFixture() },
      { env: ENV, r2: s.deps, tar: tarStub, kvSource: () => votesSource(), log: () => {} },
    );
    assert.deepEqual(res.map((r) => r.status), ["dry-run", "dry-run"]);
    assert.equal(s.calls.length, 0);
  });

  it("fingerprint do alarme de falha é estável por tipo (reaproveita a issue)", () => {
    assert.equal(offsiteFailureFingerprint("beehiiv"), "backup-offsite-failed:beehiiv");
  });
});

// ---------------------------------------------------------------------------

describe("#11413 dump dos votos do KV", () => {
  it("só os prefixos de voto, JSONL ordenado, em lotes de até 100", async () => {
    const batches: number[] = [];
    const listed: string[] = [];
    const src: KvDumpSource = {
      async list(prefix) {
        listed.push(prefix);
        if (prefix === "vote:") return Array.from({ length: 250 }, (_, i) => `vote:261108:u${String(i).padStart(3, "0")}@x.com`).reverse();
        if (prefix === "correct:") return ["correct:261108", "img-260101-01-eia-A.jpg"];
        return [];
      },
      async getMany(keys) {
        batches.push(keys.length);
        return new Map(keys.map((k) => [k, k.endsWith("u007@x.com") ? null : `{"k":"${k}"}`]));
      },
    };
    const d = await dumpKvPrefixes(src);
    assert.deepEqual(listed, ["vote:", "score:", "correct:"]);
    assert.deepEqual(batches, [100, 100, 50, 1]);
    assert.deepEqual(d.counts, { "vote:": 249, "score:": 0, "correct:": 1 });
    const lines = d.jsonl.trim().split("\n").map((l) => JSON.parse(l) as { key: string; value: string });
    assert.equal(lines.length, 250);
    assert.ok(lines.every((l) => !l.key.startsWith("img")), "imagens fora do dump");
    const keys = lines.map((l) => l.key);
    assert.deepEqual(keys, [...keys].sort());
  });

  it("zero chaves vote: lança (token/namespace errado não vira backup 'ok')", async () => {
    await assert.rejects(dumpKvPrefixes(votesSource(0)), /nenhuma chave vote:/);
  });

  it("kvRestBulkGet: POST bulk/get e mapa com null pra chave ausente", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetchFn = async (url: string, init?: RequestInit) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ success: true, result: { values: { a: "1", b: null } } }), { status: 200 });
    };
    const m = await kvRestBulkGet({ accountId: "acc", token: "t", namespaceId: "ns", fetchFn }, ["a", "b", "c"]);
    assert.deepEqual([...m.entries()], [["a", "1"], ["b", null], ["c", null]]);
    assert.match(seen!.url, /\/accounts\/acc\/storage\/kv\/namespaces\/ns\/bulk\/get$/);
    assert.deepEqual(seen!.body, { keys: ["a", "b", "c"], type: "text" });
  });

  it("bulk get quebrado cai no GET por chave, com aviso", async () => {
    const fetchFn = async () => new Response("no", { status: 405 });
    const warns: string[] = [];
    const src = kvRestDumpSource(
      { accountId: "acc", token: "t", namespaceId: "ns", fetchFn },
      { list: async () => ["vote:1:a"], get: async (k) => `v-${k}` },
      (m) => warns.push(m),
    );
    const d = await dumpKvPrefixes(src, ["vote:"]);
    assert.equal(d.jsonl, JSON.stringify({ key: "vote:1:a", value: "v-vote:1:a" }) + "\n");
    assert.equal(warns.length, 1);
  });
});

// ---------------------------------------------------------------------------

const listXml = (objs: { key: string; lm: string }[]) =>
  `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${objs
    .map((o) => `<Contents><Key>${o.key}</Key><LastModified>${o.lm}</LastModified><Size>10</Size></Contents>`)
    .join("")}</ListBucketResult>`;

function listStub(byPrefix: Record<string, Response | (() => Response)>) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    const prefix = new URL(url).searchParams.get("prefix") ?? "";
    const r = byPrefix[prefix];
    return typeof r === "function" ? r() : r ?? new Response(listXml([]), { status: 200 });
  };
  return { calls, deps: { fetch: fetchFn, now: () => NOW } };
}

describe("#11413 alarme da cópia remota (ListObjectsV2)", () => {
  it("objeto recente nos dois prefixos = ok", async () => {
    const s = listStub({
      "beehiiv/": new Response(listXml([{ key: "beehiiv/2026-11-01.tar.gz.enc", lm: "2026-11-01T06:10:00Z" }, { key: "beehiiv/2026-11-08.tar.gz.enc", lm: "2026-11-08T06:03:00Z" }])),
      "eia-votes/": new Response(listXml([{ key: "eia-votes/2026-11-08.jsonl.gz.enc", lm: "2026-11-08T06:04:00Z" }])),
    });
    const ev = await checkRemoteOffsiteBackup(s.deps, ENV, 7);
    assert.ok(ev.configured && ev.ok);
    assert.equal(ev.fingerprint, null);
    assert.equal(ev.configured && ev.prefixes[0].latestKey, "beehiiv/2026-11-08.tar.gz.enc");
    assert.ok(s.calls.every((u) => u.startsWith("https://acc123.r2.cloudflarestorage.com/diaria-backup?")));
  });

  it("objeto velho = stale; prefixo vazio = missing; HTTP 403 = error", async () => {
    const s = listStub({
      "beehiiv/": new Response(listXml([{ key: "beehiiv/2026-10-25.tar.gz.enc", lm: "2026-10-25T06:03:00Z" }])),
      "eia-votes/": () => new Response("<Error>AccessDenied</Error>", { status: 403 }),
    });
    const ev = await checkRemoteOffsiteBackup(s.deps, ENV, 7);
    assert.ok(ev.configured && !ev.ok);
    assert.deepEqual(ev.configured && ev.prefixes.map((p) => p.verdict), ["stale", "error"]);
    assert.equal(ev.fingerprint, "remote:beehiiv=stale@beehiiv/2026-10-25.tar.gz.enc,eia-votes=error@none");

    const empty = await checkRemoteOffsiteBackup(listStub({}).deps, ENV, 7);
    assert.deepEqual(empty.configured && empty.prefixes.map((p) => p.verdict), ["missing", "missing"]);
  });

  it("credencial ausente = achado (configured false), nunca ok, e sem request", async () => {
    const s = listStub({});
    const ev = await checkRemoteOffsiteBackup(s.deps, { R2_ACCOUNT_ID: "acc" }, 7);
    assert.equal(ev.configured, false);
    assert.equal(ev.ok, false);
    assert.equal(ev.fingerprint, "remote:no-credentials:R2_BACKUP_ACCESS_KEY_ID,R2_BACKUP_SECRET_ACCESS_KEY");
    assert.equal(s.calls.length, 0);
    const mail = buildRemoteOffsiteAlarmEmail({ missingCredentials: ev.configured ? null : ev.missing, lines: [], maxAgeDays: 7 });
    assert.match(mail.subject, /credencial do bucket ausente/);
    assert.match(mail.body, /não um ok/);
  });

  it("fingerprint ignora a idade (não reenvia a cada execução)", () => {
    const a = remoteOffsiteFingerprint([{ kind: "beehiiv", verdict: "stale", latestKey: "beehiiv/x", ageDays: 8 }]);
    const b = remoteOffsiteFingerprint([{ kind: "beehiiv", verdict: "stale", latestKey: "beehiiv/x", ageDays: 9.5 }]);
    assert.equal(a, b);
  });

  it("loadOffsiteAccess não exige a chave de cifra (o alarme só lista)", () => {
    assert.ok(loadOffsiteAccess({ R2_ACCOUNT_ID: "a", R2_BACKUP_ACCESS_KEY_ID: "b", R2_BACKUP_SECRET_ACCESS_KEY: "c" }).ready);
  });
});

// ---------------------------------------------------------------------------

const hasTar = spawnSync("tar", ["--version"]).status === 0;

describe("#11413 restauração (tar real do sistema)", { skip: !hasTar && "tar ausente" }, () => {
  it("tar.gz → cifra → restoreBlob devolve os mesmos arquivos byte a byte", () => {
    const root = snapshotFixture();
    const src = join(root, "2026-11-08");
    const enc = encryptBackup(tarGzDirectory(src), KEY);
    const out = join(mkdtempSync(join(tmpdir(), "restore-11413-")), "bh");
    restoreBlob(enc, KEY, "beehiiv", "beehiiv/2026-11-08.tar.gz.enc", out);
    for (const f of ["manifest.json", "subscribers.jsonl", join("posts", "p1.json")]) {
      assert.ok(readFileSync(join(out, f)).equals(readFileSync(join(src, f))), f);
    }
    // Pasta não vazia é recusada (nunca sobrescreve um restore anterior).
    assert.throws(() => restoreBlob(enc, KEY, "beehiiv", "x.tar.gz.enc", out), /não está vazia/);
  });

  it("votos: restaura o JSONL; chave errada não escreve nada", async () => {
    const d = await dumpKvPrefixes(votesSource(3));
    const enc = encryptBackup(gzipSync(Buffer.from(d.jsonl, "utf8")), KEY);
    const out = join(mkdtempSync(join(tmpdir(), "restore-11413-")), "votes");
    const file = restoreBlob(enc, KEY, "eia-votes", "eia-votes/2026-11-08.jsonl.gz.enc", out);
    assert.equal(file, join(out, "eia-votes-2026-11-08.jsonl"));
    assert.equal(readFileSync(file, "utf8"), d.jsonl);

    const out2 = join(mkdtempSync(join(tmpdir(), "restore-11413-")), "votes");
    assert.throws(() => restoreBlob(enc, Buffer.alloc(32, 1), "eia-votes", "eia-votes/2026-11-08.jsonl.gz.enc", out2), /outra chave/);
    assert.deepEqual(readdirSyncSafe(out2), []);
  });
});

function readdirSyncSafe(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}
