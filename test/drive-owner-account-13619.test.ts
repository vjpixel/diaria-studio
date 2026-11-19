/**
 * test/drive-owner-account-13619.test.ts (#13619)
 *
 * A conta dona da pasta de vídeo (diaria.editor) pelo remote rclone: config,
 * leitura do `rclone config dump`, renovação do token em memória e o fetch
 * autenticado. Nunca roda o rclone nem toca a rede (dump e fetch injetados).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  accessTokenUsable,
  archiveFolderOwnerFrom,
  makeRcloneOwnerFetch,
  ownerFetchFromConfigFile,
  parseRcloneDriveCredential,
  remoteKeyOf,
} from "../scripts/lib/diaria/drive-owner-account.ts";

const NOW = Date.parse("2026-11-19T03:00:00Z");
const dump = (token: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    gdrive: { type: "drive", client_id: "outro", client_secret: "x", token: "{}" },
    "gdrive-diaria": { type: "drive", client_id: "cid", client_secret: "csecret", scope: "drive", token: JSON.stringify(token), ...extra },
  });
const validToken = { access_token: "AT-velho", refresh_token: "RT", expiry: "2026-11-19T04:00:00Z" };

describe("config e credencial (#13619)", () => {
  it("archiveFolderOwnerFrom lê publishing.video.archive_folder_owner.rclone_remote; ausente/vazio = null", () => {
    assert.deepEqual(archiveFolderOwnerFrom({ publishing: { video: { archive_folder_owner: { rclone_remote: " gdrive-diaria: " } } } }), { rcloneRemote: "gdrive-diaria:" });
    assert.equal(archiveFolderOwnerFrom({ publishing: { video: {} } }), null);
    assert.equal(archiveFolderOwnerFrom({ publishing: { video: { archive_folder_owner: { rclone_remote: "" } } } }), null);
    assert.equal(archiveFolderOwnerFrom(null), null);
  });

  it("o platform.config.json versionado aponta a diaria.editor (gdrive-diaria:), a decisão do editor", async () => {
    const { readFileSync } = await import("node:fs");
    const cfg = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
    assert.deepEqual(archiveFolderOwnerFrom(cfg), { rcloneRemote: "gdrive-diaria:" });
  });

  it("remoteKeyOf tira os dois-pontos e o caminho", () => {
    assert.equal(remoteKeyOf("gdrive-diaria:"), "gdrive-diaria");
    assert.equal(remoteKeyOf("gdrive-diaria:diaria-studio-video"), "gdrive-diaria");
    assert.equal(remoteKeyOf("gdrive-diaria"), "gdrive-diaria");
    assert.throws(() => remoteKeyOf(":x"), /inválido/);
  });

  it("parseRcloneDriveCredential pega o remote certo e recusa sem segredo na mensagem", () => {
    const c = parseRcloneDriveCredential(dump(validToken), "gdrive-diaria:");
    assert.equal(c.clientId, "cid");
    assert.equal(c.refreshToken, "RT");
    assert.equal(c.accessToken, "AT-velho");
    assert.equal(c.expiryMs, Date.parse("2026-11-19T04:00:00Z"));
    assert.throws(() => parseRcloneDriveCredential(dump(validToken), "nao-existe:"), /não existe no rclone/);
    assert.throws(() => parseRcloneDriveCredential(dump(validToken, { type: "onedrive" }), "gdrive-diaria:"), /não drive/);
    assert.throws(() => parseRcloneDriveCredential(dump(validToken, { client_id: "" }), "gdrive-diaria:"), /sem client_id\/client_secret próprios/);
    assert.throws(() => parseRcloneDriveCredential(dump({ access_token: "a" }), "gdrive-diaria:"), /sem refresh_token/);
    assert.throws(() => parseRcloneDriveCredential("não é json", "gdrive-diaria:"), /ilegível/);
    try {
      parseRcloneDriveCredential(dump({ access_token: "a" }, { client_id: "" }), "gdrive-diaria:");
    } catch (e) {
      assert.doesNotMatch((e as Error).message, /csecret|RT|AT-velho/);
    }
  });

  it("accessTokenUsable: só com folga de 1 min antes do expiry", () => {
    assert.equal(accessTokenUsable({ accessToken: "a", expiryMs: NOW + 120_000 }, NOW), true);
    assert.equal(accessTokenUsable({ accessToken: "a", expiryMs: NOW + 30_000 }, NOW), false);
    assert.equal(accessTokenUsable({ accessToken: "a" }, NOW), false);
    assert.equal(accessTokenUsable({ expiryMs: NOW + 120_000 }, NOW), false);
  });

  it("ownerFetchFromConfigFile: sem a chave (ou config ilegível) = undefined; com a chave, um fetch preguiçoso", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owner-13619-"));
    const p = join(dir, "platform.config.json");
    writeFileSync(p, JSON.stringify({ publishing: { video: {} } }));
    assert.equal(ownerFetchFromConfigFile(p), undefined);
    writeFileSync(p, "{");
    assert.equal(ownerFetchFromConfigFile(p), undefined);
    writeFileSync(p, JSON.stringify({ publishing: { video: { archive_folder_owner: { rclone_remote: "gdrive-diaria:" } } } }));
    let dumped = 0;
    const f = ownerFetchFromConfigFile(p, { dumpConfig: async () => (dumped++, dump(validToken)), fetchImpl: async () => new Response("{}"), now: () => NOW });
    assert.equal(typeof f, "function");
    assert.equal(dumped, 0, "nada roda até a 1ª chamada");
    await f!("https://www.googleapis.com/drive/v3/files");
    assert.equal(dumped, 1);
  });
});

describe("makeRcloneOwnerFetch (#13619)", () => {
  const recorder = (tokenResponses: Array<Response>, apiResponses: Array<Response>) => {
    const calls: Array<{ url: string; auth?: string; body?: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: u, auth: headers.Authorization, body: typeof init?.body === "string" ? init.body : undefined });
      return u.startsWith("https://oauth2.googleapis.com/token") ? tokenResponses.shift()! : apiResponses.shift()!;
    }) as typeof fetch;
    return { calls, fetchImpl };
  };
  const tokenOk = (at: string) => new Response(JSON.stringify({ access_token: at, expires_in: 3599 }), { status: 200 });

  it("token do dump ainda válido: usa direto, sem renovar", async () => {
    const r = recorder([], [new Response("{}")]);
    const f = makeRcloneOwnerFetch("gdrive-diaria:", { dumpConfig: async () => dump(validToken), fetchImpl: r.fetchImpl, now: () => NOW });
    await f("https://api/x", { method: "POST", headers: { "Content-Type": "application/json" } });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].auth, "Bearer AT-velho");
  });

  it("token vencido: renova com o client do remote e guarda em memória para a próxima chamada", async () => {
    const r = recorder([tokenOk("AT-novo")], [new Response("{}"), new Response("{}")]);
    let dumped = 0;
    const f = makeRcloneOwnerFetch("gdrive-diaria:", {
      dumpConfig: async () => (dumped++, dump({ ...validToken, expiry: "2026-11-19T02:00:00Z" })),
      fetchImpl: r.fetchImpl,
      now: () => NOW,
    });
    await f("https://api/a");
    await f("https://api/b");
    assert.equal(dumped, 1, "o dump é lido uma vez");
    const tokenCalls = r.calls.filter((c) => c.url.startsWith("https://oauth2"));
    assert.equal(tokenCalls.length, 1);
    const form = new URLSearchParams(tokenCalls[0].body);
    assert.equal(form.get("client_id"), "cid");
    assert.equal(form.get("refresh_token"), "RT");
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.deepEqual(r.calls.filter((c) => c.url.startsWith("https://api")).map((c) => c.auth), ["Bearer AT-novo", "Bearer AT-novo"]);
  });

  it("401 renova e repete 1x", async () => {
    const r = recorder([tokenOk("AT-2")], [new Response("x", { status: 401 }), new Response("{}", { status: 200 })]);
    const f = makeRcloneOwnerFetch("gdrive-diaria:", { dumpConfig: async () => dump(validToken), fetchImpl: r.fetchImpl, now: () => NOW });
    const res = await f("https://api/c");
    assert.equal(res.status, 200);
    assert.deepEqual(r.calls.filter((c) => c.url.startsWith("https://api")).map((c) => c.auth), ["Bearer AT-velho", "Bearer AT-2"]);
  });

  it("renovação recusada lança sem segredo na mensagem; dump que falha é tentado de novo na próxima chamada", async () => {
    const r = recorder([new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })], []);
    const f = makeRcloneOwnerFetch("gdrive-diaria:", { dumpConfig: async () => dump({ refresh_token: "RT" }), fetchImpl: r.fetchImpl, now: () => NOW });
    await assert.rejects(f("https://api/d"), (e: Error) => /recusada \(400 invalid_grant\)/.test(e.message) && !/RT|csecret/.test(e.message));

    let n = 0;
    const g = makeRcloneOwnerFetch("gdrive-diaria:", {
      dumpConfig: async () => {
        if (++n === 1) throw new Error("rclone config dump falhou (ENOENT)");
        return dump(validToken);
      },
      fetchImpl: recorder([], [new Response("{}")]).fetchImpl,
      now: () => NOW,
    });
    await assert.rejects(g("https://api/e"), /ENOENT/);
    await g("https://api/e");
    assert.equal(n, 2);
  });
});
