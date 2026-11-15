/**
 * test/social-retry-outside-dispatch-13089.test.ts (#13089)
 *
 * `--retry` aceita d1/d2/d3/um sem olhar a edição, mas o laço só cobre os ids
 * que esta execução despacha. `--retry d3` numa edição de 2 destaques (ou
 * `--retry um` num dia sem o post USE MELHOR) saía 0 sem log nem envio, e o
 * editor lia o silêncio como "feito". Agora sai 1 com o id nomeado, antes de
 * enviar qualquer coisa. O caso do semanal (`--retry facebook` sem página) está
 * em test/publish-weekly-social.test.ts ("#13089: ...").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatRetryOutsideDispatch, retryIdsOutsideDispatch } from "../scripts/lib/social-retry.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function entry(platform: string, destaque: string, status: PostEntry["status"], over: Partial<PostEntry> = {}): PostEntry {
  return { platform, destaque, url: null, status, scheduled_at: "2026-10-23T09:45:00-03:00", ...over };
}

describe("#13089: regra pura", () => {
  it("sem --retry: nada fora; com --retry: só os ids ausentes do envio", () => {
    assert.deepEqual(retryIdsOutsideDispatch(null, ["d1"]), []);
    assert.deepEqual(retryIdsOutsideDispatch(new Set(["d2"]), ["d1", "d2"]), []);
    assert.deepEqual(retryIdsOutsideDispatch(new Set(["d2", "d3", "um"]), ["d1", "d2"]), ["d3", "um"]);
  });
  it("mensagem nomeia o id pedido e os disponíveis", () => {
    const m = formatRetryOutsideDispatch("instagram", ["d3"], ["d1", "d2"]);
    assert.match(m, /--retry pediu d3/);
    assert.match(m, /disponíveis: d1, d2/);
    assert.match(formatRetryOutsideDispatch("threads", ["um"], []), /disponíveis: nenhum/);
  });
});

function setup(prefix: string, socialMd: string, posts: PostEntry[]): { tmp: string; dir: string; publishedPath: string } {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(tmp, "260999");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "03-social.md"), socialMd, "utf8");
  const publishedPath = join(dir, "_internal", "06-social-published.json");
  writeFileSync(publishedPath, JSON.stringify({ posts }, null, 2), "utf8");
  return { tmp, dir, publishedPath };
}

function run(script: string, dir: string, extra: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", script), "--edition-dir", dir, ...extra], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "test-ig-user",
      INSTAGRAM_ACCESS_TOKEN: "test-ig-token",
      THREADS_USER_ID: "fake_13089",
      THREADS_ACCESS_TOKEN: "fake_13089",
      DIARIA_LINKEDIN_CRON_URL: "",
      DIARIA_LINKEDIN_CRON_TOKEN: "",
    },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("#13089: Instagram --retry com id fora do envio (CLI real, sem rede)", () => {
  const MD = ["# Social", "", "## d1", "Post d1.", "", "## d2", "Post d2."].join("\n");

  it("--retry d3 numa edição de 2 destaques sai 1 e não toca no store", () => {
    const { tmp, dir, publishedPath } = setup("ig-13089-", MD, [entry("instagram", "d2", "send_unknown", { worker_queue_key: "queue:ig:d2" })]);
    try {
      const before = readFileSync(publishedPath, "utf8");
      const r = run("publish-instagram.ts", dir, ["--test-mode", "--retry", "d3"]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /ERRO instagram: --retry pediu d3, que esta execução não despacha \(disponíveis: d1, d2\)/);
      assert.equal(readFileSync(publishedPath, "utf8"), before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--retry d2,um sem post USE MELHOR sai 1 sem despachar o d2", () => {
    const { tmp, dir, publishedPath } = setup("ig-13089-", MD, [entry("instagram", "d2", "send_unknown", { worker_queue_key: "queue:ig:d2" })]);
    try {
      const r = run("publish-instagram.ts", dir, ["--test-mode", "--retry", "d2,um"]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /--retry pediu um/);
      const d2 = (JSON.parse(readFileSync(publishedPath, "utf8")).posts as PostEntry[]).find((p) => p.destaque === "d2");
      assert.equal(d2?.status, "send_unknown");
      assert.equal(d2?.worker_queue_key, "queue:ig:d2");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("#13089: Threads --retry com id fora do envio (CLI real, dry-run)", () => {
  const MD = ["# Curto", "", "## d1", "Post d1 curto.", "", "## d2", "Post d2 curto."].join("\n");

  it("--retry d3 numa edição de 2 destaques sai 1 sem dry-run de nada", () => {
    const { tmp, dir, publishedPath } = setup("th-13089-", MD, []);
    try {
      const r = run("publish-threads.ts", dir, ["--dry-run", "--log-root-dir", tmp, "--retry", "d3"]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /ERRO threads: --retry pediu d3, que esta execução não despacha \(disponíveis: d1, d2\)/);
      assert.doesNotMatch(r.out, /DRY-RUN threads\//);
      assert.deepEqual(JSON.parse(readFileSync(publishedPath, "utf8")).posts, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--retry d2 (presente) segue para o dry-run normalmente", () => {
    const { tmp, dir } = setup("th-13089-", MD, []);
    try {
      const r = run("publish-threads.ts", dir, ["--dry-run", "--log-root-dir", tmp, "--retry", "d2"]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /DRY-RUN threads\/d2/);
      assert.doesNotMatch(r.out, /DRY-RUN threads\/d1/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
