/**
 * test/shorts-media-server-11265.test.ts
 *
 * #11265: o servidor que expõe o vertical do dia pela internet (atrás do
 * túnel) é somente leitura e só serve o nome exato do vertical — sem
 * listagem, sem path traversal, sem symlink, sem outros métodos.
 */
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMediaRequest, resolveMediaRequest, type MediaFileInfo } from "../scripts/shorts-media-server.ts";

const NAME = "diaria-comentada-261028-short.mp4";
const statOk = (size: number) => (n: string): MediaFileInfo => (n === NAME ? { kind: "file", size } : { kind: "missing" });

describe("resolveMediaRequest (puro, #11265)", () => {
  it("GET do vertical: 200 video/mp4 com tamanho, Accept-Ranges e no-store", () => {
    const r = resolveMediaRequest("GET", `/${NAME}`, undefined, statOk(100));
    assert.equal(r.status, 200);
    assert.equal(r.headers["Content-Type"], "video/mp4");
    assert.equal(r.headers["Content-Length"], "100");
    assert.equal(r.headers["Accept-Ranges"], "bytes");
    assert.equal(r.headers["Cache-Control"], "no-store");
    assert.deepEqual("file" in r && r.file, { name: NAME, start: 0, end: 99 });
  });

  it("HEAD: mesmos headers, sem corpo", () => {
    const r = resolveMediaRequest("HEAD", `/${NAME}?x=1`, undefined, statOk(100));
    assert.equal(r.status, 200);
    assert.equal(r.headers["Content-Length"], "100");
    assert.equal("file" in r && r.file, null);
  });

  it("outros métodos: 405", () => {
    for (const m of ["PUT", "POST", "DELETE", "PATCH"]) assert.equal(resolveMediaRequest(m, `/${NAME}`, undefined, statOk(1)).status, 405);
  });

  it("listagem, traversal, encode, subpasta e outros nomes: 404 sem tocar o disco", () => {
    let touched = 0;
    const stat = (n: string): MediaFileInfo => {
      touched++;
      return statOk(1)(n);
    };
    for (const p of [
      "/",
      "/.env",
      "/../etc/passwd",
      `/..%2F${NAME}`,
      `/x/${NAME}`,
      `/${NAME}/`,
      "/diaria-comentada-261028.mp4",
      "/diaria-comentada-26102-short.mp4",
      "/diaria-comentada-261028-short.mp4.tmp",
      `/.${NAME}.tmp`,
      `//${NAME}`,
      `/%64iaria-comentada-261028-short.mp4`,
    ]) {
      assert.equal(resolveMediaRequest("GET", p, undefined, stat).status, 404, p);
    }
    assert.equal(touched, 0);
  });

  it("nome válido mas ausente ou não-regular (symlink): 404", () => {
    assert.equal(resolveMediaRequest("GET", "/diaria-comentada-261029-short.mp4", undefined, statOk(1)).status, 404);
    assert.equal(resolveMediaRequest("GET", `/${NAME}`, undefined, () => ({ kind: "not_regular" })).status, 404);
  });

  it("/healthz: 200 ok", () => {
    const r = resolveMediaRequest("GET", "/healthz", undefined, statOk(1));
    assert.equal(r.status, 200);
    assert.equal("body" in r && r.body, "ok");
  });

  it("Range: intervalo, aberto, sufixo e inválido", () => {
    const a = resolveMediaRequest("GET", `/${NAME}`, "bytes=10-19", statOk(100));
    assert.equal(a.status, 206);
    assert.equal(a.headers["Content-Range"], "bytes 10-19/100");
    assert.equal(a.headers["Content-Length"], "10");
    const b = resolveMediaRequest("GET", `/${NAME}`, "bytes=90-", statOk(100));
    assert.equal(b.headers["Content-Range"], "bytes 90-99/100");
    const c = resolveMediaRequest("GET", `/${NAME}`, "bytes=-5", statOk(100));
    assert.equal(c.headers["Content-Range"], "bytes 95-99/100");
    const d = resolveMediaRequest("GET", `/${NAME}`, "bytes=50-500", statOk(100));
    assert.equal(d.headers["Content-Range"], "bytes 50-99/100");
    for (const bad of ["bytes=100-", "bytes=20-10", "bytes=-", "bytes=0-1,5-6", "items=0-1"]) {
      const r = resolveMediaRequest("GET", `/${NAME}`, bad, statOk(100));
      assert.equal(r.status, 416, bad);
      assert.equal(r.headers["Content-Range"], "bytes */100");
    }
  });
});

describe("handleMediaRequest (servidor real numa pasta temporária, #11265)", () => {
  let dir: string;
  let server: Server;
  let base: string;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "shorts-media-"));
    writeFileSync(join(dir, NAME), Buffer.from("0123456789"));
    writeFileSync(join(dir, "segredo.txt"), "nao");
    symlinkSync(join(dir, "segredo.txt"), join(dir, "diaria-comentada-261029-short.mp4"));
    server = createServer((req, res) => handleMediaRequest(dir, req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serve o vertical inteiro e por Range", async () => {
    const full = await fetch(`${base}/${NAME}`);
    assert.equal(full.status, 200);
    assert.equal(await full.text(), "0123456789");
    const part = await fetch(`${base}/${NAME}`, { headers: { Range: "bytes=2-4" } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "234");
  });

  it("não serve outro arquivo da pasta, nem symlink com nome válido", async () => {
    assert.equal((await fetch(`${base}/segredo.txt`)).status, 404);
    assert.equal((await fetch(`${base}/diaria-comentada-261029-short.mp4`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 404);
  });
});

describe("setup-shorts-media-service-linux.sh (#11265)", () => {
  const script = new URL("../scripts/studio/setup-shorts-media-service-linux.sh", import.meta.url).pathname;
  const source = readFileSync(script, "utf8");
  it("tem sintaxe bash válida e não hardcoda usuário", () => {
    execFileSync("bash", ["-n", script]);
    assert.doesNotMatch(source, /\/home\/[a-z]+\//);
  });
  it("a unit roda o shorts-media-server na mesma pasta padrão do platform.config.json", () => {
    assert.match(source, /ExecStart=\$NODE_DIR\/npx tsx \$SERVER_TS --dir \$MEDIA_DIR --port \$PORT/);
    assert.match(source, /MEDIA_DIR="\$HOME\/diaria-media\/shorts"/);
    const cfg = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
    assert.equal(cfg.publishing.shorts.public_video.tunnel_dir, "~/diaria-media/shorts");
  });
});
