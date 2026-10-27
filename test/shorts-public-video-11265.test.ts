/**
 * test/shorts-public-video-11265.test.ts
 *
 * #11265: URL pública do vertical pelo Cloudflare Tunnel do 300 (backend
 * `tunnel`) em vez do R2. Cobre o config, a retenção da pasta servida, a cópia
 * + conferência da URL e a resolução do host (pasta ausente fora do 300, túnel
 * fora do ar no planejamento).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brtAammdd,
  loadPublicVideoConfig,
  planTunnelRetention,
  resolvePublicVideoHost,
  stageVideoInTunnelDir,
  tunnelVideoUrl,
  type PublicVideoHostDeps,
  type TunnelPublicVideoConfig,
} from "../scripts/lib/diaria/shorts-public-video.ts";

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "shorts-tunnel-"));
  tmpDirs.push(d);
  return d;
}

const tunnelRaw = (extra: Record<string, unknown> = {}) => ({
  publishing: { shorts: { public_video: { backend: "tunnel", tunnel_public_base: "https://media.diar.ia.br/", tunnel_dir: "~/diaria-media/shorts", ...extra } } },
});

function deps(over: Partial<PublicVideoHostDeps> & { calls?: string[] } = {}): PublicVideoHostDeps & { warns: string[] } {
  const warns: string[] = [];
  return {
    fetch: over.fetch ?? (async () => new Response("ok", { status: 200 })),
    now: over.now ?? (() => new Date("2026-10-28T15:00:00Z")),
    warn: (m) => warns.push(m),
    warns,
  };
}

describe("loadPublicVideoConfig (#11265)", () => {
  it("sem public_video = r2 (comportamento do #10823)", () => {
    assert.deepEqual(loadPublicVideoConfig({ publishing: { shorts: {} } }, {}), { backend: "r2" });
  });

  it("tunnel: base sem barra final e ~ expandido", () => {
    assert.deepEqual(loadPublicVideoConfig(tunnelRaw(), {}, "/home/x"), {
      backend: "tunnel",
      publicBase: "https://media.diar.ia.br",
      dir: "/home/x/diaria-media/shorts",
    });
  });

  it("SHORTS_MEDIA_DIR sobrepõe tunnel_dir", () => {
    const c = loadPublicVideoConfig(tunnelRaw(), { SHORTS_MEDIA_DIR: "/srv/media" }, "/home/x");
    assert.equal(c.backend === "tunnel" && c.dir, "/srv/media");
  });

  it("config inválido lança (nunca vira 'sem URL pública' em silêncio)", () => {
    assert.throws(() => loadPublicVideoConfig(tunnelRaw({ backend: "s3" }), {}), /backend precisa ser/);
    assert.throws(() => loadPublicVideoConfig(tunnelRaw({ tunnel_public_base: "http://media.diar.ia.br" }), {}), /origem https/);
    assert.throws(() => loadPublicVideoConfig(tunnelRaw({ tunnel_public_base: "https://media.diar.ia.br/x" }), {}), /origem https/);
    assert.throws(() => loadPublicVideoConfig(tunnelRaw({ tunnel_dir: "" }), {}), /tunnel_dir é obrigatório/);
    assert.throws(() => loadPublicVideoConfig({ publishing: { shorts: { public_video: [] } } }, {}), /precisa ser um objeto/);
  });

  it("o platform.config.json do repo escolhe o túnel em media.diar.ia.br (decisão do editor, 261027d)", () => {
    const cfg = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
    const c = loadPublicVideoConfig(cfg, {}, "/home/x");
    assert.equal(c.backend, "tunnel");
    assert.equal(c.backend === "tunnel" && tunnelVideoUrl(c, "261028"), "https://media.diar.ia.br/diaria-comentada-261028-short.mp4");
  });
});

describe("planTunnelRetention (#11265)", () => {
  const now = new Date("2026-10-28T02:00:00Z"); // 27/10 23:00 BRT
  it("hoje em BRT, não em UTC", () => {
    assert.equal(brtAammdd(now), "261027");
  });

  it("apaga só vertical de edição passada; mantém hoje, futuros e o recém-copiado; fora do padrão vira aviso", () => {
    const r = planTunnelRetention(
      [
        "diaria-comentada-261020-short.mp4",
        "diaria-comentada-261026-short.mp4",
        "diaria-comentada-261027-short.mp4",
        "diaria-comentada-261028-short.mp4",
        ".diaria-comentada-261028-short.mp4.tmp",
        "notas.txt",
      ],
      "261028",
      now,
    );
    assert.deepEqual(r.remove, ["diaria-comentada-261020-short.mp4", "diaria-comentada-261026-short.mp4"]);
    assert.deepEqual(r.foreign, ["notas.txt"]);
  });
});

describe("stageVideoInTunnelDir (#11265)", () => {
  function setup() {
    const root = tmp();
    const dir = join(root, "served");
    const src = join(root, "src.mp4");
    writeFileSync(src, Buffer.alloc(1234, 7));
    mkdirSync(dir, { recursive: true });
    const cfg: TunnelPublicVideoConfig = { backend: "tunnel", publicBase: "https://media.diar.ia.br", dir };
    return { dir, src, cfg };
  }

  it("copia com o nome do vertical, apaga edição passada e devolve a URL depois do HEAD com o mesmo tamanho", async () => {
    const { dir, src, cfg } = setup();
    writeFileSync(join(dir, "diaria-comentada-261020-short.mp4"), "velho");
    const seen: string[] = [];
    const d = deps({
      fetch: async (u, i) => {
        seen.push(`${i?.method} ${u}`);
        return new Response(null, { status: 200, headers: { "content-length": "1234" } });
      },
    });
    const url = await stageVideoInTunnelDir(d, cfg, "261028", src, 1234);
    assert.equal(url, "https://media.diar.ia.br/diaria-comentada-261028-short.mp4");
    assert.deepEqual(seen, ["HEAD https://media.diar.ia.br/diaria-comentada-261028-short.mp4"]);
    assert.deepEqual(readdirSync(dir).sort(), ["diaria-comentada-261028-short.mp4"]);
    assert.equal(readFileSync(join(dir, "diaria-comentada-261028-short.mp4")).length, 1234);
  });

  it("HEAD fora do ar, não-200 ou tamanho diferente lança (o Reel não entra na fila)", async () => {
    const { src, cfg } = setup();
    await assert.rejects(
      stageVideoInTunnelDir(deps({ fetch: async () => { throw new Error("ECONNREFUSED"); } }), cfg, "261028", src, 1234),
      /não respondeu.*ECONNREFUSED/,
    );
    await assert.rejects(stageVideoInTunnelDir(deps({ fetch: async () => new Response(null, { status: 502 }) }), cfg, "261028", src, 1234), /HEAD 502/);
    await assert.rejects(
      stageVideoInTunnelDir(deps({ fetch: async () => new Response(null, { status: 200, headers: { "content-length": "10" } }) }), cfg, "261028", src, 1234),
      /serve 10 bytes/,
    );
  });
});

describe("resolvePublicVideoHost (#11265)", () => {
  const cfg = (dir: string): TunnelPublicVideoConfig => ({ backend: "tunnel", publicBase: "https://media.diar.ia.br", dir });

  it("r2 sem as env vars: não pronto, lista o que falta", async () => {
    const h = await resolvePublicVideoHost({ backend: "r2" }, {}, deps());
    assert.equal(h.ready, false);
    assert.equal(h.label, "R2");
    assert.ok(!h.ready && h.missing.includes("SHORTS_R2_BUCKET"));
  });

  it("túnel numa máquina sem a pasta servida (fora do 300): não pronto e não sonda a rede", async () => {
    let fetched = false;
    const h = await resolvePublicVideoHost(cfg(join(tmp(), "nao-existe")), {}, deps({ fetch: async () => { fetched = true; return new Response("ok"); } }), { probe: true });
    assert.equal(h.ready, false);
    assert.ok(!h.ready && /só existe no 300/.test(h.missing[0]));
    assert.equal(fetched, false);
  });

  it("túnel fora do ar no planejamento: não pronto (destinos caem em pendente/guiado)", async () => {
    const dir = tmp();
    const down = await resolvePublicVideoHost(cfg(dir), {}, deps({ fetch: async () => { throw new Error("fetch failed"); } }), { probe: true });
    assert.ok(!down.ready && /healthz não respondeu/.test(down.missing[0]));
    const bad = await resolvePublicVideoHost(cfg(dir), {}, deps({ fetch: async () => new Response("", { status: 530 }) }), { probe: true });
    assert.ok(!bad.ready && /HTTP 530/.test(bad.missing[0]));
  });

  it("túnel de pé: pronto, e o upload copia pra pasta servida", async () => {
    const dir = tmp();
    const src = join(tmp(), "v.mp4");
    writeFileSync(src, Buffer.alloc(50));
    const seen: string[] = [];
    const h = await resolvePublicVideoHost(
      cfg(dir),
      {},
      deps({
        fetch: async (u, i) => {
          seen.push(`${i?.method} ${u}`);
          return new Response(i?.method === "HEAD" ? null : "ok", { status: 200, headers: { "content-length": i?.method === "HEAD" ? "50" : "2" } });
        },
      }),
      { probe: true },
    );
    assert.ok(h.ready);
    assert.equal(seen[0], "GET https://media.diar.ia.br/healthz");
    const url = await h.upload("261028", readFileSync(src), src);
    assert.equal(url, "https://media.diar.ia.br/diaria-comentada-261028-short.mp4");
    assert.ok(existsSync(join(dir, "diaria-comentada-261028-short.mp4")));
  });
});
