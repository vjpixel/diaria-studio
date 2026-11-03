/**
 * #11413 — ramos cobertos depois do review de fleet da PR #11952: dump
 * parcial, fallback do bulk get, "mais recente" pela data da chave, folga do
 * alarme remoto, `main()` do backup e do alarme com dependências injetadas,
 * CLI de restauração, assinatura do PUT e conferência do HEAD.
 * Nenhum teste fala com rede real nem com o `gh`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { encryptBackup, parseBackupKey } from "../scripts/lib/backup-offsite-crypto.ts";
import {
  describeKvDump,
  dumpKvPrefixes,
  evaluateRemotePrefix,
  kvRestDumpSource,
  latestOffsiteObject,
  listOffsiteObjects,
  LIST_MAX_PAGES,
  putAndVerifyOffsite,
  type KvDumpSource,
  type RemoteOffsiteEvaluation,
  type TarRunner,
} from "../scripts/lib/backup-offsite.ts";
import { main as offsiteMain } from "../scripts/backup-offsite.ts";
import { main as restoreMain, restoreBlob } from "../scripts/restore-backup-offsite.ts";
import { main as alarmMain, loadState } from "../scripts/beehiiv-backup-staleness-alarm.ts";
import { BEEHIIV_BACKUP_COVERAGE_START_MONTH } from "../scripts/lib/beehiiv-backup-staleness-alarm.ts";
import type { NotifyEditorFinding, NotifyEditorResult } from "../scripts/lib/editor-notify.ts";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const KEY = parseBackupKey(KEY_B64);
const ENV = {
  R2_ACCOUNT_ID: "acc123",
  R2_BACKUP_ACCESS_KEY_ID: "bk-id",
  R2_BACKUP_SECRET_ACCESS_KEY: "bk-secret",
  BACKUP_ENCRYPTION_KEY: KEY_B64,
};
const ACCESS = { accountId: "acc123", accessKeyId: "bk-id", secretAccessKey: "bk-secret", bucket: "diaria-backup" };
const NOW = new Date("2026-11-08T06:05:00Z");
const quiet = () => {};

const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");
const obj = (key: string, lm: string) => ({ key, lastModified: new Date(lm) });
const listXml = (objs: { key: string; lm: string }[], truncated = false, token = "") =>
  `<?xml version="1.0"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${
    token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ""
  }${objs.map((o) => `<Contents><Key>${o.key}</Key><LastModified>${o.lm}</LastModified></Contents>`).join("")}</ListBucketResult>`;

const okResult = (n = 1): NotifyEditorResult =>
  ({ severity: "acao", emailPolicy: "urgent_only", emailSent: false, issue: { action: "created", issueNumber: n, url: "" } }) as unknown as NotifyEditorResult;

// ---------------------------------------------------------------------------
// 2. dump parcial

function src(map: Record<string, string[]>, missing: Set<string> = new Set()): KvDumpSource {
  return {
    list: async (p) => map[p] ?? [],
    getMany: async (keys) => new Map(keys.filter((k) => !missing.has(k)).map((k) => [k, `v:${k}`])),
  };
}

describe("#11413 review — dump parcial não sai como completo", () => {
  const votes = Array.from({ length: 2000 }, (_, i) => `vote:1:u${String(i).padStart(4, "0")}`);

  it("até max(5, 0,5%) chaves sumidas por prefixo é tolerado e aparece no resumo", async () => {
    const d = await dumpKvPrefixes(src({ "vote:": votes, "score:": ["score:a"] }, new Set(votes.slice(0, 10))));
    assert.deepEqual(d.counts["vote:"], { listed: 2000, dumped: 1990, skipped: 10 });
    assert.match(describeKvDump(d), /vote: 1990\/2000 \(10 sumiram entre list e get\)/);
  });

  it("acima da tolerância lança (bulk devolvendo mapa parcial)", async () => {
    await assert.rejects(dumpKvPrefixes(src({ "vote:": votes, "score:": ["score:a"] }, new Set(votes.slice(0, 11)))), /dump parcial: 11 de 2000/);
    const small = votes.slice(0, 50);
    await assert.rejects(dumpKvPrefixes(src({ "vote:": small, "score:": ["score:a"] }, new Set(small.slice(0, 6)))), /dump parcial: 6 de 50/);
  });

  it("vote: > 0 com score: = 0 lança", async () => {
    await assert.rejects(dumpKvPrefixes(src({ "vote:": votes.slice(0, 3) })), /nenhuma score:/);
  });
});

// ---------------------------------------------------------------------------
// 3. fallback bulk→GET

function bulkFetch(statuses: number[]) {
  let i = 0;
  const calls: number[] = [];
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const st = statuses[Math.min(i++, statuses.length - 1)];
    calls.push(st);
    if (st !== 200) return new Response(JSON.stringify({ errors: [{ code: 1, message: `st${st}` }] }), { status: st });
    const keys = JSON.parse(String(init?.body)).keys as string[];
    return new Response(JSON.stringify({ success: true, result: { values: Object.fromEntries(keys.map((k) => [k, `b:${k}`])) } }), { status: 200 });
  };
  return { calls, fetchFn };
}

describe("#11413 review — fallback do bulk get", () => {
  const cfgOf = (fetchFn: (u: string, i?: RequestInit) => Promise<Response>) => ({ accountId: "a", token: "t", namespaceId: "n", fetchFn });

  it("401/403 lança na hora, sem retry nem fallback", async () => {
    for (const st of [401, 403]) {
      const b = bulkFetch([st]);
      let gets = 0;
      const s = kvRestDumpSource(cfgOf(b.fetchFn), { list: async () => [], get: async () => (gets++, "x") }, { warn: quiet, sleep: async () => {} });
      await assert.rejects(s.getMany(["vote:1:a"]), new RegExp(`HTTP ${st}`));
      assert.equal(b.calls.length, 1);
      assert.equal(gets, 0);
    }
  });

  it("erro transitório: tenta o bulk de novo com backoff antes de cair", async () => {
    const b = bulkFetch([500, 500, 200]);
    const sleeps: number[] = [];
    const s = kvRestDumpSource(cfgOf(b.fetchFn), { list: async () => [], get: async () => "GET" }, { warn: quiet, sleep: async (ms) => void sleeps.push(ms), backoffMs: 100 });
    const m = await s.getMany(["k"]);
    assert.equal(m.get("k"), "b:k");
    assert.deepEqual(sleeps, [100, 200]);
    assert.deepEqual(s.fallbackCauses!(), []);
  });

  it("fallback vale só pro lote que falhou; o próximo volta ao bulk, e a causa vai pro resumo", async () => {
    const b = bulkFetch([500, 500, 500, 200]);
    const s = kvRestDumpSource(cfgOf(b.fetchFn), { list: async () => [], get: async (k) => `g:${k}` }, { warn: quiet, sleep: async () => {} });
    assert.equal((await s.getMany(["a"])).get("a"), "g:a");
    assert.equal((await s.getMany(["b"])).get("b"), "b:b");
    assert.equal(s.fallbackCauses!().length, 1);
    assert.match(s.fallbackCauses!()[0], /HTTP 500/);
  });

  it("GET por chave que falha leva a causa do bulk na mensagem", async () => {
    const b = bulkFetch([500]);
    const s = kvRestDumpSource(
      cfgOf(b.fetchFn),
      { list: async () => [], get: async () => { throw new Error("429 rate limited"); } },
      { warn: quiet, sleep: async () => {} },
    );
    await assert.rejects(s.getMany(["a"]), /depois do bulk falhar \(KV REST bulk get falhou: HTTP 500.*429 rate limited/);
  });
});

// ---------------------------------------------------------------------------
// 4/5. mais recente pela data da chave + folga

describe("#11413 review — frescor pela data da chave", () => {
  it("reenvio de data antiga (LastModified mais novo) não vira o mais recente", () => {
    const objs = [obj("beehiiv/2026-11-08.tar.gz.enc", "2026-11-08T06:03:00Z"), obj("beehiiv/2026-10-25.tar.gz.enc", "2026-11-08T09:00:00Z")];
    assert.equal(latestOffsiteObject(objs)!.key, "beehiiv/2026-11-08.tar.gz.enc");
    const st = evaluateRemotePrefix("beehiiv", { objects: objs }, NOW.getTime(), 7);
    assert.equal(st.latestKey, "beehiiv/2026-11-08.tar.gz.enc");
    assert.equal(st.verdict, "ok");
  });

  it("mesma data: LastModified desempata", () => {
    const objs = [obj("x/2026-11-08.tar.gz.enc", "2026-11-08T06:00:00Z"), obj("y/2026-11-08.tar.gz.enc", "2026-11-08T07:00:00Z")];
    assert.equal(latestOffsiteObject(objs)!.key, "y/2026-11-08.tar.gz.enc");
  });

  it("fronteira: 7,0 dias pela data = ok; 7 dias e 1 minuto = stale", () => {
    const objs = [obj("beehiiv/2026-11-01.tar.gz.enc", "2026-11-01T06:03:00Z")];
    assert.equal(evaluateRemotePrefix("beehiiv", { objects: objs }, Date.parse("2026-11-08T00:00:00Z"), 7).verdict, "ok");
    assert.equal(evaluateRemotePrefix("beehiiv", { objects: objs }, Date.parse("2026-11-08T00:01:00Z"), 7).verdict, "stale");
  });

  it("upload atrasado (LastModified dias depois da data) não muda a idade", () => {
    const objs = [obj("beehiiv/2026-11-08.tar.gz.enc", "2026-11-10T12:00:00Z")];
    const st = evaluateRemotePrefix("beehiiv", { objects: objs }, Date.parse("2026-11-15T00:00:00Z"), 7);
    assert.equal(st.verdict, "ok");
    assert.equal(st.ageDays, 7);
  });
});

// ---------------------------------------------------------------------------
// 11. LIST robusto

describe("#11413 review — ListObjectsV2", () => {
  const deps = (fetchFn: (u: string) => Promise<Response>) => ({ fetch: fetchFn, now: () => NOW });

  it("200 sem <ListBucketResult> lança em vez de virar 'nenhum objeto'", async () => {
    await assert.rejects(listOffsiteObjects(deps(async () => new Response("<html>login</html>", { status: 200 })), ACCESS, "beehiiv/"), /sem <ListBucketResult>/);
  });

  it("esgotar as páginas com continuação pendente lança", async () => {
    let n = 0;
    await assert.rejects(
      listOffsiteObjects(deps(async () => new Response(listXml([], true, `t${n++}`))), ACCESS, "beehiiv/"),
      new RegExp(`${LIST_MAX_PAGES} páginas`),
    );
  });

  it("erro ao ler o corpo não é engolido", async () => {
    const res = new Response("x");
    Object.defineProperty(res, "text", { value: async () => { throw new Error("socket fechado"); } });
    await assert.rejects(listOffsiteObjects(deps(async () => res), ACCESS, "beehiiv/"), /socket fechado/);
  });
});

// ---------------------------------------------------------------------------
// 14. assinatura do PUT + conferência do HEAD

describe("#11413 review — PUT assinado e HEAD", () => {
  function stub(head: (body: Buffer) => Response) {
    const seen: { method: string; headers: Record<string, string>; body?: Buffer }[] = [];
    const fetchFn = async (_u: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const body = init?.body ? Buffer.from(init.body as Uint8Array) : undefined;
      seen.push({ method: init?.method ?? "GET", headers, body });
      if (init?.method === "PUT") return new Response("", { status: 200 });
      return head(seen.find((s) => s.method === "PUT")!.body!);
    };
    return { seen, deps: { fetch: fetchFn, now: () => NOW } };
  }
  const body = Buffer.from("corpo cifrado de teste");

  it("x-amz-content-sha256 é o sha256 do corpo e content-type entra nos SignedHeaders", async () => {
    const s = stub((b) => new Response(null, { headers: { "content-length": String(b.length), etag: `"${md5(b)}"` } }));
    const r = await putAndVerifyOffsite(s.deps, ACCESS, "beehiiv/2026-11-08.tar.gz.enc", body);
    assert.equal(r.etagVerified, true);
    const put = s.seen[0];
    assert.equal(put.headers["x-amz-content-sha256"], createHash("sha256").update(body).digest("hex"));
    assert.match(put.headers.Authorization, /SignedHeaders=[^,]*content-type[^,]*,/);
    assert.ok(put.body!.equals(body));
  });

  it("HEAD 404/5xx ou sem content-length falha", async () => {
    for (const [res, re] of [
      [() => new Response(null, { status: 404 }), /HEAD .* HTTP 404/],
      [() => new Response(null, { status: 503 }), /HTTP 503/],
      [() => new Response(null, { status: 200 }), /sem content-length/],
    ] as const) {
      await assert.rejects(putAndVerifyOffsite(stub(res).deps, ACCESS, "k/2026-11-08.tar.gz.enc", body), re);
    }
  });

  it("ETag multipart (não comparável) passa só pelo tamanho, com etagVerified=false", async () => {
    const s = stub((b) => new Response(null, { headers: { "content-length": String(b.length), etag: `"${"a".repeat(32)}-2"` } }));
    const r = await putAndVerifyOffsite(s.deps, ACCESS, "k/2026-11-08.tar.gz.enc", body);
    assert.equal(r.etagVerified, false);
  });
});

// ---------------------------------------------------------------------------
// 6/7/10/12. main() do backup-offsite

function snapshotRoot(date: string, usable = true): string {
  const root = mkdtempSync(join(tmpdir(), "offsite-main-11413-"));
  mkdirSync(join(root, date), { recursive: true });
  writeFileSync(join(root, date, "manifest.json"), JSON.stringify({ endpoints: [{ key: "subscribers", file: "subscribers.jsonl", status: usable ? "ok" : "error", error: "x" }] }));
  writeFileSync(join(root, date, "subscribers.jsonl"), JSON.stringify({ email: "a@b.c" }) + "\n");
  return root;
}

function r2Ok() {
  const calls: string[] = [];
  const store = new Map<string, Buffer>();
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url}`);
    const path = new URL(url).pathname;
    if (init?.method === "PUT") {
      store.set(path, Buffer.from(init.body as Uint8Array));
      return new Response("", { status: 200 });
    }
    const b = store.get(path)!;
    return new Response(null, { headers: { "content-length": String(b.length), etag: `"${md5(b)}"` } });
  };
  return { calls, deps: { fetch: fetchFn, now: () => NOW } };
}

const tarStub: TarRunner = () => ({ status: 0, stdout: Buffer.from("tgz"), stderr: "" });
const votesSrc = (): KvDumpSource => src({ "vote:": ["vote:1:a"], "score:": ["score:a"] });

describe("#11413 review — main() do backup-offsite", () => {
  const base = (over: Partial<Parameters<typeof offsiteMain>[1]> = {}) => ({
    env: ENV,
    tar: tarStub,
    kvSource: votesSrc,
    now: () => NOW,
    log: quiet,
    skipEnvLoad: true,
    ...over,
  });

  it("--date diferente de hoje sem --only beehiiv é recusado (exit 2), sem rede", async () => {
    const r2 = r2Ok();
    assert.equal(await offsiteMain(["--date", "2026-11-01"], base({ r2: r2.deps })), 2);
    assert.equal(await offsiteMain(["--date", "2026-11-01", "--only", "eia-votes"], base({ r2: r2.deps })), 2);
    assert.equal(r2.calls.length, 0);
    const root = snapshotRoot("2026-11-01");
    assert.equal(await offsiteMain(["--date", "2026-11-01", "--only", "beehiiv", "--root", root], base({ r2: r2.deps })), 0);
    assert.deepEqual(r2.calls.map((c) => c.split(" ")[0]), ["PUT", "HEAD"]);
  });

  it("failed → notifyEditor (acao, fingerprint por tipo) e exit 1", async () => {
    const found: NotifyEditorFinding[] = [];
    const code = await offsiteMain(["--root", snapshotRoot("2026-11-08")], base({ env: {}, r2: r2Ok().deps, notify: async (f) => (found.push(f), okResult()) }));
    assert.equal(code, 1);
    assert.deepEqual(found.map((f) => [f.severity, f.fingerprint]), [
      ["acao", "backup-offsite-failed:beehiiv"],
      ["acao", "backup-offsite-failed:eia-votes"],
    ]);
  });

  it("um notify que lança não impede o do outro tipo", async () => {
    const found: string[] = [];
    let first = true;
    const code = await offsiteMain(["--root", snapshotRoot("2026-11-08")], base({
      env: {},
      r2: r2Ok().deps,
      notify: async (f) => {
        found.push(f.fingerprint);
        if (first) {
          first = false;
          throw new Error("gh fora do ar");
        }
        return okResult();
      },
    }));
    assert.equal(code, 1);
    assert.equal(found.length, 2);
  });

  it("Beehiiv pulado na execução agendada (sem --date) vira achado, exit 0", async () => {
    const found: string[] = [];
    const code = await offsiteMain(["--root", snapshotRoot("2026-11-01")], base({ r2: r2Ok().deps, notify: async (f) => (found.push(f.fingerprint), okResult()) }));
    assert.equal(code, 0);
    assert.deepEqual(found, ["backup-offsite-skipped:beehiiv"]);
  });

  it("pulado com --date explícito não alarma; --dry-run nunca alarma", async () => {
    const found: string[] = [];
    const notify = async (f: NotifyEditorFinding) => (found.push(f.fingerprint), okResult());
    const root = snapshotRoot("2026-11-08", false);
    assert.equal(await offsiteMain(["--date", "2026-11-08", "--root", root], base({ r2: r2Ok().deps, notify })), 0);
    assert.equal(await offsiteMain(["--dry-run", "--root", root], base({ env: {}, r2: r2Ok().deps, notify })), 1);
    assert.deepEqual(found, []);
  });
});

// ---------------------------------------------------------------------------
// 13. restauração: pasta temporária + CLI

const ENC_VOTES = encryptBackup(gzipSync(Buffer.from('{"key":"vote:1:a","value":"x"}\n')), KEY);

function r2Bucket(objects: Record<string, { body: Buffer; lm: string }>) {
  const fetchFn = async (url: string) => {
    const u = new URL(url);
    if (u.searchParams.get("list-type") === "2") {
      const prefix = u.searchParams.get("prefix") ?? "";
      return new Response(listXml(Object.entries(objects).filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, lm: o.lm }))));
    }
    const key = decodeURIComponent(u.pathname.replace(/^\/diaria-backup\//, ""));
    const o = objects[key];
    return o ? new Response(new Uint8Array(o.body)) : new Response("NoSuchKey", { status: 404 });
  };
  return { fetch: fetchFn, now: () => NOW };
}

describe("#11413 review — restauração", () => {
  const out = () => join(mkdtempSync(join(tmpdir(), "restore-cli-11413-")), "out");
  const rdeps = (r2: ReturnType<typeof r2Bucket>, env: Record<string, string> = ENV, logs: string[] = []) => ({
    env,
    r2,
    skipEnvLoad: true,
    log: (m: string) => logs.push(m),
    tar: ((args: string[]) => {
      if (args[0] === "-xzf") writeFileSync(join(args[args.length - 1], "ok.txt"), "x");
      return { status: 0, stdout: Buffer.alloc(0), stderr: "" };
    }) as TarRunner,
  });

  it("tar que falha não deixa --out nem pasta temporária", () => {
    const dir = out();
    const failing: TarRunner = () => ({ status: 2, stdout: Buffer.alloc(0), stderr: "corrompido" });
    assert.throws(() => restoreBlob(encryptBackup(Buffer.from("x"), KEY), KEY, "beehiiv", "b/2026-11-08.tar.gz.enc", dir, failing), /tar -xzf falhou/);
    assert.equal(existsSync(dir), false);
    assert.deepEqual(readdirSync(dirname(dir)), []);
  });

  it("--latest escolhe pela data da chave", async () => {
    const r2 = r2Bucket({
      "eia-votes/2026-11-08.jsonl.gz.enc": { body: ENC_VOTES, lm: "2026-11-08T06:00:00Z" },
      "eia-votes/2026-10-25.jsonl.gz.enc": { body: Buffer.from("velho"), lm: "2026-11-09T06:00:00Z" },
    });
    const dir = out();
    assert.equal(await restoreMain(["--latest", "eia-votes", "--out", dir], rdeps(r2)), 0);
    assert.ok(existsSync(join(dir, "eia-votes-2026-11-08.jsonl")));
  });

  it("--file decifra arquivo local; --key-env usa outra var", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "restore-file-11413-")), "2026-11-08.jsonl.gz.enc");
    writeFileSync(f, ENC_VOTES);
    const dir = out();
    assert.equal(await restoreMain(["--file", f, "--out", dir, "--key-env", "OLD_KEY"], rdeps(r2Bucket({}), { OLD_KEY: KEY_B64 })), 0);
    assert.equal(readFileSync(join(dir, "eia-votes-2026-11-08.jsonl"), "utf8"), '{"key":"vote:1:a","value":"x"}\n');
    // Sem a var indicada: exit 1, nada escrito.
    const dir2 = out();
    assert.equal(await restoreMain(["--file", f, "--out", dir2, "--key-env", "OLD_KEY"], rdeps(r2Bucket({}), ENV)), 1);
    assert.equal(existsSync(dir2), false);
  });

  it("flags exclusivas e tipo desconhecido = exit 2", async () => {
    const d = rdeps(r2Bucket({}));
    assert.equal(await restoreMain(["--key", "beehiiv/2026-11-08.tar.gz.enc", "--latest", "beehiiv", "--out", out()], d), 2);
    assert.equal(await restoreMain(["--key", "beehiiv/2026-11-08.tar.gz.enc"], d), 2);
    assert.equal(await restoreMain(["--key", "outro/arquivo.bin", "--out", out()], d), 2);
    assert.equal(await restoreMain(["--latest", "nada", "--out", out()], d), 2);
  });

  it("GET 404 = exit 1 com a mensagem do objeto ausente", async () => {
    const logs: string[] = [];
    const dir = out();
    assert.equal(await restoreMain(["--key", "beehiiv/2026-01-01.tar.gz.enc", "--out", dir], rdeps(r2Bucket({}), ENV, logs)), 1);
    assert.ok(logs.some((l) => /objeto não existe no bucket diaria-backup/.test(l)), logs.join("\n"));
    assert.equal(existsSync(dir), false);
  });
});

// ---------------------------------------------------------------------------
// 1/8/12. main() do alarme: estado do check remoto, sem rede

function monthsBetween(start: string, endExclusive: string): string[] {
  const outM: string[] = [];
  let [y, m] = start.split("-").map(Number);
  for (;;) {
    const cur = `${y}-${String(m).padStart(2, "0")}`;
    if (cur >= endExclusive) break;
    outM.push(cur);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return outM;
}

/** Root com snapshot de hoje, cobertura mensal completa e exit-history completo: só o check remoto pode alarmar. */
function healthyRoot(): { root: string; statePath: string } {
  const root = mkdtempSync(join(tmpdir(), "alarm-remote-11413-"));
  const todayIso = new Date().toISOString().slice(0, 10);
  for (const d of [todayIso, ...monthsBetween(BEEHIIV_BACKUP_COVERAGE_START_MONTH, todayIso.slice(0, 7)).map((m) => `${m}-01`)]) {
    mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, d, "subscribers.jsonl"), JSON.stringify({ email: "a@b.c" }) + "\n");
  }
  mkdirSync(join(root, "exit-history"), { recursive: true });
  writeFileSync(join(root, "exit-history", "manifest.json"), JSON.stringify({ complete: true }));
  return { root, statePath: join(root, "state.json") };
}

const STALE: RemoteOffsiteEvaluation = {
  configured: true,
  ok: false,
  fingerprint: "remote:beehiiv=stale@beehiiv/2026-10-25.tar.gz.enc",
  prefixes: [{ kind: "beehiiv", verdict: "stale", latestKey: "beehiiv/2026-10-25.tar.gz.enc", ageDays: 14 }],
};
const OK: RemoteOffsiteEvaluation = { configured: true, ok: true, fingerprint: null, prefixes: [] };

describe("#11413 review — main() do alarme, check remoto", () => {
  it("grava lastRemoteFingerprint depois do envio e volta a null quando fica ok; loadState lê o campo", async () => {
    const { root, statePath } = healthyRoot();
    const origLog = console.log;
    console.log = quiet;
    try {
      const sent: string[] = [];
      const notify = async (f: NotifyEditorFinding) => (sent.push(f.fingerprint), okResult());
      await alarmMain(["--root", root, "--state", statePath], { skipEnvLoad: true, checkRemote: async () => STALE, notify });
      assert.deepEqual(sent, [STALE.fingerprint]);
      assert.equal(loadState(statePath).lastRemoteFingerprint, STALE.fingerprint);
      // Mesmo estado: não reenvia.
      await alarmMain(["--root", root, "--state", statePath], { skipEnvLoad: true, checkRemote: async () => STALE, notify });
      assert.equal(sent.length, 1);
      await alarmMain(["--root", root, "--state", statePath], { skipEnvLoad: true, checkRemote: async () => OK, notify });
      assert.equal(loadState(statePath).lastRemoteFingerprint, null);
    } finally {
      console.log = origLog;
    }
  });

  it("--dry-run não grava nem notifica", async () => {
    const { root, statePath } = healthyRoot();
    const origLog = console.log;
    console.log = quiet;
    try {
      let calls = 0;
      await alarmMain(["--dry-run", "--root", root, "--state", statePath], {
        skipEnvLoad: true,
        checkRemote: async () => STALE,
        notify: async () => (calls++, okResult()),
      });
      assert.equal(calls, 0);
      assert.equal(existsSync(statePath), false);
    } finally {
      console.log = origLog;
    }
  });

  it("credencial ausente alarma (achado, não ok)", async () => {
    const { root, statePath } = healthyRoot();
    const origLog = console.log;
    console.log = quiet;
    try {
      const sent: string[] = [];
      const noCreds: RemoteOffsiteEvaluation = { configured: false, missing: ["R2_BACKUP_ACCESS_KEY_ID"], ok: false, fingerprint: "remote:no-credentials:R2_BACKUP_ACCESS_KEY_ID", prefixes: [] };
      await alarmMain(["--root", root, "--state", statePath], { skipEnvLoad: true, checkRemote: async () => noCreds, notify: async (f) => (sent.push(f.subject), okResult()) });
      assert.equal(sent.length, 1);
      assert.match(sent[0], /credencial do bucket ausente/);
    } finally {
      console.log = origLog;
    }
  });

  it("falha de notify num check não impede os outros; lança só no fim", async () => {
    const { root, statePath } = healthyRoot();
    // Exit-history incompleto + remoto stale: 2 alarmes, o 1º falha.
    writeFileSync(join(root, "exit-history", "manifest.json"), JSON.stringify({ complete: false }));
    const origLog = console.log;
    console.log = quiet;
    try {
      const checks: string[] = [];
      await assert.rejects(
        alarmMain(["--root", root, "--state", statePath], {
          skipEnvLoad: true,
          checkRemote: async () => STALE,
          notify: async (f) => {
            checks.push(f.check);
            if (f.check === "beehiiv-exit-history") throw new Error("gh fora do ar");
            return okResult();
          },
        }),
        /1 alarme\(s\) não registrado\(s\): beehiiv-exit-history: gh fora do ar/,
      );
      assert.deepEqual(checks, ["beehiiv-exit-history", "backup-offsite-remote"]);
      assert.equal(loadState(statePath).lastRemoteFingerprint, STALE.fingerprint);
      assert.equal(loadState(statePath).lastExitHistoryFingerprint, null);
    } finally {
      console.log = origLog;
    }
  });
});
