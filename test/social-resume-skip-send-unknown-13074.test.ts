/**
 * test/social-resume-skip-send-unknown-13074.test.ts (#13074)
 *
 * A reconciliação de feed (#13009) grava `send_unknown` (absent_from_feed)
 * quando o post vencido não casa com o feed, contando que "nenhum publicador
 * reposta sozinho numa retomada". Só o Threads pulava `send_unknown`: o
 * Instagram, o LinkedIn, o carrossel semanal e a Retrospectiva redespachavam
 * a entrada e duplicavam o post público. Aqui:
 *
 *   - o status que a reconciliação grava está no conjunto compartilhado de
 *     skip (`RESUME_SKIP_STATUSES`) e os 5 publicadores usam esse conjunto;
 *   - o LinkedIn re-rodado (CLI real) não dispara uma entrada `send_unknown`;
 *   - `published` com prova de disparo (`ig_media_id`) não é rebaixado.
 *
 * O carrossel semanal tem o teste de comportamento em
 * test/publish-weekly-social.test.ts ("#13074: ...").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { needsFeedReconcile, reconcilePostsAgainstFeeds, type FeedRead } from "../scripts/lib/social-feed-reconcile.ts";
import { RESUME_SKIP_STATUSES, type PostEntry } from "../scripts/lib/social-published-store.ts";
import { findLiveSocialDispatch, RETROSPECTIVA_SOCIAL_DESTAQUE } from "../scripts/publish-retrospectiva-social.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LATE = new Date("2026-10-24T13:44:00Z");
const TEXT = "O Nubank anunciou que vai usar agentes de inteligência artificial para detectar fraude em transferências Pix em tempo real.";

/** Feed que cobre a janela e não tem o post: a reconciliação declara ausência. */
const EMPTY_FEED: FeedRead = { items: [], coveredSince: "2026-10-20T00:00:00.000Z", error: null };

function workerPublished(platform: string, over: Partial<PostEntry> = {}): PostEntry {
  return {
    platform,
    destaque: "d1",
    url: null,
    status: "published",
    scheduled_at: "2026-10-23T09:45:00-03:00",
    worker_queue_key: "queue:2026-10-23T12:45:00.000Z:abc",
    verification_note: "worker_drained_feed_unverified: saiu da fila do Worker sem cair na DLQ.",
    ...over,
  };
}

describe("#13074: o que a reconciliação grava é pulado na retomada", () => {
  for (const platform of ["instagram", "threads", "linkedin"] as const) {
    it(`${platform}: published sem url e ausente do feed vira send_unknown, que está no skip compartilhado`, () => {
      const { posts } = reconcilePostsAgainstFeeds([workerPublished(platform)], { [platform]: EMPTY_FEED }, () => TEXT, LATE);
      assert.equal(posts[0].status, "send_unknown");
      assert.ok(RESUME_SKIP_STATUSES.has(posts[0].status), "send_unknown precisa estar no skip de retomada");
    });
  }

  it("o skip compartilhado cobre published e send_unknown e deixa failed para a retomada", () => {
    for (const s of ["draft", "scheduled", "published", "send_unknown"] as const) assert.ok(RESUME_SKIP_STATUSES.has(s), s);
    assert.equal(RESUME_SKIP_STATUSES.has("failed"), false);
  });

  it("Retrospectiva: send_unknown no store conta como post vivo", () => {
    const store = { posts: [{ platform: "instagram", destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, url: null, status: "send_unknown" as const, scheduled_at: "2026-10-23T09:45:00-03:00" }] };
    const live = findLiveSocialDispatch(store, "instagram");
    assert.equal(live?.status, "send_unknown");
  });
});

describe("#13074: os publicadores usam o skip compartilhado", () => {
  const cases: Array<[string, RegExp]> = [
    ["scripts/publish-instagram.ts", /p\.platform === "instagram" &&\s*p\.destaque === d &&[\s\S]{0,200}?RESUME_SKIP_STATUSES\.has\(p\.status\)/],
    ["scripts/publish-linkedin.ts", /const alreadyDone = [\s\S]{0,400}?RESUME_SKIP_STATUSES\.has\(p\.status\)/],
    ["scripts/publish-weekly-social.ts", /const isExisting = \(p: PostEntry\): boolean => RESUME_SKIP_STATUSES\.has\(p\.status\)/],
    ["scripts/publish-retrospectiva-social.ts", /export function findLiveSocialDispatch[\s\S]{0,600}?RESUME_SKIP_STATUSES\.has\(p\.status\)/],
    ["scripts/publish-threads.ts", /RESUME_SKIP_STATUSES\.has\(existing\.status\)/],
  ];
  for (const [file, re] of cases) {
    it(file, () => {
      const src = readFileSync(resolve(ROOT, file), "utf8");
      assert.match(src, /\bRESUME_SKIP_STATUSES\b[^\n]*\} from "\.\/lib\/social-published-store\.ts"|import \{[^}]*\bRESUME_SKIP_STATUSES\b[^}]*\} from "\.\/lib\/social-published-store\.ts"/);
      assert.match(src, re);
      // Nenhuma cópia local do conjunto (a fonte é uma só).
      assert.doesNotMatch(src, /const RESUME_SKIP_STATUSES\s*=/);
    });
  }
});

describe("#13074: LinkedIn re-rodado não redespacha send_unknown (CLI real)", () => {
  it("SKIP da entrada send_unknown, sem chamada ao webhook, registro intacto", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pl-13074-"));
    try {
      const dir = join(tmp, "260999");
      const internalDir = join(dir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(
        join(internalDir, "01-approved.json"),
        JSON.stringify({
          highlights: [{ article: { title: "D1" } }, { article: { title: "D2" } }, { article: { title: "D3" } }],
          lancamento: [{ title: "L1" }],
          radar: [{ title: "R1" }],
          use_melhor: [],
          video: [],
        }),
        "utf8",
      );
      writeFileSync(join(dir, "03-social.md"), ["# LinkedIn", "", "## d1", "Post d1.", "", "# Facebook", "", "## d1", "FB d1."].join("\n"), "utf8");
      writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images: { cover: { url: "https://img.test/d1.jpg" } } }), "utf8");
      const entry: PostEntry = {
        platform: "linkedin",
        destaque: "d1",
        subtype: "main",
        url: null,
        status: "send_unknown",
        previous_status: "published",
        failure_reason: "absent_from_feed: nenhum post do feed corresponde",
        scheduled_at: "2026-09-29T09:45:00-03:00",
        worker_queue_key: "queue:li:old",
      };
      const publishedPath = join(internalDir, "06-social-published.json");
      writeFileSync(publishedPath, JSON.stringify({ posts: [entry] }, null, 2), "utf8");

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", join(ROOT, "scripts", "publish-linkedin.ts"), "--edition-dir", dir, "--fire-now", "--log-root-dir", tmp, "--only", "d1"],
        {
          cwd: ROOT,
          encoding: "utf8",
          env: { ...process.env, MAKE_LINKEDIN_WEBHOOK_URL: "https://hook.test/noop", DIARIA_LINKEDIN_CRON_URL: "", DIARIA_LINKEDIN_CRON_TOKEN: "" },
        },
      );
      const out = result.stdout + result.stderr;
      assert.match(out, /SKIP linkedin\/d1\/main — already send_unknown/, out);
      const after = JSON.parse(readFileSync(publishedPath, "utf8")).posts.filter((p: PostEntry) => p.platform === "linkedin" && p.destaque === "d1");
      assert.equal(after.length, 1);
      assert.equal(after[0].status, "send_unknown");
      assert.equal(after[0].worker_queue_key, "queue:li:old");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("#13074: published com prova de disparo não é rebaixado", () => {
  it("ig_media_id: fica published, ganha feed_absent_* e não volta a ser reconciliado", () => {
    const proven = workerPublished("instagram", { ig_media_id: "17890000000000001", verification_note: undefined });
    const { posts, summary } = reconcilePostsAgainstFeeds([proven], { instagram: EMPTY_FEED }, () => TEXT, LATE);
    assert.equal(posts[0].status, "published");
    assert.match(posts[0].feed_absent_reason as string, /^absent_from_feed:/);
    assert.equal(posts[0].feed_absent_at, LATE.toISOString());
    assert.equal(posts[0].failure_reason, undefined);
    assert.equal(summary.absent.length, 1, "o alarme do Stage 0 segue listando o post");
    assert.equal(needsFeedReconcile(posts[0]), false);
  });

  it("threads_media_id idem; sem prova (published do Worker) segue rebaixado para send_unknown", () => {
    const proven = workerPublished("threads", { threads_media_id: "18000000000000002" });
    assert.equal(reconcilePostsAgainstFeeds([proven], { threads: EMPTY_FEED }, () => TEXT, LATE).posts[0].status, "published");
    const unproven = workerPublished("threads", { threads_media_id: "  " });
    assert.equal(reconcilePostsAgainstFeeds([unproven], { threads: EMPTY_FEED }, () => TEXT, LATE).posts[0].status, "send_unknown");
  });
});
