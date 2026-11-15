/**
 * test/social-retry-send-unknown-13076.test.ts (#13076)
 *
 * A retomada pula `send_unknown` (#13074). A saída era `--no-skip-existing`
 * (Instagram) ou `--force`-like global (semanal), que republicava os outros
 * destaques/canais já publicados. Aqui:
 *
 *   - `--retry dN` no Instagram (CLI real, sem rede): sem a flag o send_unknown
 *     é pulado com instrução de recuperação e contador próprio no resumo; com
 *     `--retry d2` só o d2 entra no caminho de dispatch (falha na imagem
 *     ausente, antes de qualquer chamada à Graph API) e d1/d3 ficam intactos;
 *     `--retry d1` (já publicado) é recusado;
 *   - a regra pura compartilhada (`social-retry.ts`) e a do semanal por canal
 *     (o teste de comportamento do semanal está em test/publish-weekly-social.test.ts,
 *     "#13076: ...");
 *   - `prev-social-status` avisa `published` com `feed_absent_at`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decideResumeOrRetry, parseRetryIdList, RETRYABLE_STATUSES } from "../scripts/lib/social-retry.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";
import { parseInstagramRetryIds, summarizeInstagramResults } from "../scripts/publish-instagram.ts";
import { decideWeeklyChannelDispatch, parseWeeklyRetryChannels } from "../scripts/publish-weekly-social.ts";
import { analyzePrevSocial, formatPrevSocialSummary } from "../scripts/lib/prev-social-status.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function entry(platform: string, destaque: string, status: PostEntry["status"], over: Partial<PostEntry> = {}): PostEntry {
  return { platform, destaque, url: null, status, scheduled_at: "2026-10-23T09:45:00-03:00", ...over };
}

describe("#13076: regra compartilhada de --retry", () => {
  it("parseRetryIdList: ausente = null; vazio ou id fora da lista = erro; normaliza caixa", () => {
    const acc = ["d1", "d2"];
    const o = { noun: "os posts", example: "--retry d2" };
    assert.deepEqual(parseRetryIdList(undefined, false, acc, o), { ok: true, ids: null });
    assert.equal(parseRetryIdList(undefined, true, acc, o).ok, false);
    const bad = parseRetryIdList("d9", false, acc, o);
    assert.equal(bad.ok, false);
    assert.match(bad.ok ? "" : bad.error, /d9/);
    const good = parseRetryIdList(" D2 ", false, acc, o);
    assert.ok(good.ok && good.ids && [...good.ids].join() === "d2");
  });

  it("só failed e send_unknown são refeitos", () => {
    assert.deepEqual([...RETRYABLE_STATUSES].sort(), ["failed", "send_unknown"]);
  });

  it("decideResumeOrRetry: retomada pula send_unknown; --retry refaz só o id pedido e recusa o já publicado", () => {
    const su = [entry("instagram", "d2", "send_unknown")];
    const pub = [entry("instagram", "d1", "published")];
    assert.equal(decideResumeOrRetry("d2", su, { skipExisting: true, retryIds: null }).action, "skip-existing");
    assert.equal(decideResumeOrRetry("d2", su, { skipExisting: true, retryIds: new Set(["d2"]) }).action, "dispatch");
    assert.equal(decideResumeOrRetry("d1", pub, { skipExisting: true, retryIds: new Set(["d2"]) }).action, "not-selected");
    assert.equal(decideResumeOrRetry("d1", pub, { skipExisting: true, retryIds: new Set(["d1"]) }).action, "retry-refused");
    assert.equal(decideResumeOrRetry("d3", [], { skipExisting: true, retryIds: new Set(["d3"]) }).action, "dispatch");
    assert.equal(decideResumeOrRetry("d3", [entry("instagram", "d3", "failed")], { skipExisting: true, retryIds: null }).action, "dispatch");
  });

  it("Instagram e semanal aceitam os ids certos", () => {
    assert.equal(parseInstagramRetryIds("d2,um", false).ok, true);
    assert.equal(parseInstagramRetryIds("instagram", false).ok, false);
    assert.equal(parseWeeklyRetryChannels("instagram,facebook,threads,linkedin", false).ok, true);
    assert.equal(parseWeeklyRetryChannels("twitter", false).ok, false);
  });

  it("resumo do Instagram conta send_unknown à parte", () => {
    const s = summarizeInstagramResults([entry("instagram", "d1", "published"), entry("instagram", "d2", "send_unknown")], 2);
    assert.equal(s.send_unknown, 1);
    assert.equal(s.published, 1);
    assert.equal(s.skipped, 2);
  });
});

describe("#13076: semanal decide por canal e por página", () => {
  const key = "weekly-clicked";
  const posts = [
    entry("instagram", key, "send_unknown"),
    entry("threads", key, "published"),
    entry("linkedin", key, "cancelling"),
    entry("facebook", key, "send_unknown", { page: "diaria" }),
    entry("facebook", key, "scheduled", { page: "outra" }),
  ];
  it("sem --retry: tudo existente é pulado (cancelling incluso, #12419)", () => {
    const d = decideWeeklyChannelDispatch(posts, key, ["diaria", "outra"], { skipExisting: true, retryChannels: null });
    assert.equal(d.instagram.action, "skip-existing");
    assert.equal(d.threads.action, "skip-existing");
    assert.equal(d.linkedin.action, "skip-existing");
    assert.deepEqual(d.facebook.map((f) => f.decision.action), ["skip-existing", "skip-existing"]);
  });
  it("--retry instagram,facebook: refaz IG e a página send_unknown; recusa a página agendada; Threads/LinkedIn fora", () => {
    const d = decideWeeklyChannelDispatch(posts, key, ["diaria", "outra"], { skipExisting: true, retryChannels: new Set(["instagram", "facebook"]) });
    assert.equal(d.instagram.action, "dispatch");
    assert.equal(d.threads.action, "not-selected");
    assert.equal(d.linkedin.action, "not-selected");
    assert.deepEqual(d.facebook.map((f) => [f.slug, f.decision.action]), [["diaria", "dispatch"], ["outra", "retry-refused"]]);
  });
  it("--retry linkedin com entrada cancelling é recusado (não retoma cancelamento)", () => {
    const d = decideWeeklyChannelDispatch(posts, key, [], { skipExisting: true, retryChannels: new Set(["linkedin"]) });
    assert.equal(d.linkedin.action, "retry-refused");
  });
});

describe("#13076: Instagram --retry (CLI real, sem rede)", () => {
  function setup(): { tmp: string; dir: string; publishedPath: string } {
    const tmp = mkdtempSync(join(tmpdir(), "ig-13076-"));
    const dir = join(tmp, "260999");
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(join(dir, "03-social.md"), ["# Social", "", "## d1", "Post d1.", "", "## d2", "Post d2.", "", "## d3", "Post d3."].join("\n"), "utf8");
    // Sem imagens: o d2 que entrar no dispatch falha em "imagem não encontrada",
    // antes de qualquer chamada à Graph API.
    const publishedPath = join(internalDir, "06-social-published.json");
    const posts: PostEntry[] = [
      entry("instagram", "d1", "published", { ig_media_id: "1" }),
      entry("instagram", "d2", "send_unknown", { failure_reason: "absent_from_feed: x", worker_queue_key: "queue:ig:d2" }),
      entry("instagram", "d3", "published", { ig_media_id: "3" }),
    ];
    writeFileSync(publishedPath, JSON.stringify({ posts }, null, 2), "utf8");
    return { tmp, dir, publishedPath };
  }
  function run(dir: string, extra: string[]) {
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "publish-instagram.ts"), "--edition-dir", dir, "--test-mode", ...extra], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        INSTAGRAM_BUSINESS_ACCOUNT_ID: "test-ig-user",
        INSTAGRAM_ACCESS_TOKEN: "test-ig-token",
        DIARIA_LINKEDIN_CRON_URL: "",
        DIARIA_LINKEDIN_CRON_TOKEN: "",
      },
    });
    return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "" };
  }
  const byD = (path: string) =>
    Object.fromEntries(
      (JSON.parse(readFileSync(path, "utf8")).posts as PostEntry[]).filter((p) => p.platform === "instagram").map((p) => [p.destaque, p]),
    );
  const summaryOf = (stdout: string) => JSON.parse(stdout.slice(stdout.indexOf("{\n"))).summary;

  it("sem --retry: send_unknown é pulado, com instrução de --retry d2 e contador no resumo", () => {
    const { tmp, dir, publishedPath } = setup();
    try {
      const r = run(dir, []);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /SKIP instagram\/d2 — already send_unknown/);
      assert.match(r.out, /--retry d2/);
      const s = summaryOf(r.stdout);
      assert.equal(s.send_unknown, 1, r.out);
      assert.equal(s.skipped, 3);
      const after = byD(publishedPath);
      assert.equal(after.d2.status, "send_unknown");
      assert.equal(after.d2.worker_queue_key, "queue:ig:d2");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--retry d2: só o d2 entra no dispatch; d1 e d3 publicados ficam intactos", () => {
    const { tmp, dir, publishedPath } = setup();
    try {
      const r = run(dir, ["--retry", "d2"]);
      assert.equal(r.code, 0, r.out);
      assert.doesNotMatch(r.out, /instagram\/d1|instagram\/d3/);
      const after = byD(publishedPath);
      // Chegou ao caminho de dispatch (a imagem ausente o derruba): não foi pulado.
      assert.equal(after.d2.status, "failed", r.out);
      assert.equal(after.d1.status, "published");
      assert.equal(after.d1.ig_media_id, "1");
      assert.equal(after.d3.status, "published");
      const s = summaryOf(r.stdout);
      assert.equal(s.total, 1);
      assert.equal(s.failed, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--retry d1 (já publicado) é recusado; --retry inválido sai 1", () => {
    const { tmp, dir, publishedPath } = setup();
    try {
      const r = run(dir, ["--retry", "d1"]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /SKIP instagram\/d1: --retry recusado — o post já está published/);
      assert.equal(byD(publishedPath).d1.ig_media_id, "1");
      assert.equal(byD(publishedPath).d2.status, "send_unknown");
      const bad = run(dir, ["--retry", "d9"]);
      assert.equal(bad.code, 1, bad.out);
      assert.match(bad.out, /id\(s\) inválido\(s\) d9/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("#13076 item 2: prev-social-status avisa published ausente do feed", () => {
  it("published com feed_absent_at vira aviso; published sem o campo não", () => {
    const report = analyzePrevSocial(
      [
        { platform: "instagram", destaque: "d1", status: "published", feed_absent_at: "2026-10-24T13:44:00Z", feed_absent_reason: "absent_from_feed: x" },
        { platform: "threads", destaque: "d2", status: "published" },
      ],
      new Date("2026-10-25T10:00:00Z"),
    );
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].reason, "published-absent-from-feed");
    assert.match(formatPrevSocialSummary(report, "261024") ?? "", /instagram\/d1 \(publicado, mas não está mais no feed/);
  });
});
