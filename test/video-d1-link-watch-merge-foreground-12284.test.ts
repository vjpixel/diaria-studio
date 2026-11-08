/**
 * #12284: a task `Diaria-Video-D1-Link-Watch` roda como unit systemd
 * `Type=oneshot`. Ela republicava a página com `--no-wait-merge`; com o CI
 * pendente o publisher entregava o merge a um waiter destacado e saía — e o
 * systemd (`KillMode=control-group`) mata o cgroup inteiro no fim da task,
 * waiter incluído. O PR ficava aberto, o player nunca ia ao ar e o state já
 * registrava o `video_url` novo, então nada retentava.
 *
 * Fix: a task passa `--no-merge-waiter` (o publisher não dispara waiter) e
 * espera o merge ela mesma, em foreground, com `--merge-pr N`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pendingSitePagePr,
  republishSitePageIfVideoMissing,
  sitePageMergeWaiterArgs,
  sitePageRepublishArgs,
} from "../scripts/video-d1-link-watch.ts";
import {
  deferredMergeWaiterSpawner,
  productionDeps,
  type GhRunner,
  type GitRunner,
} from "../scripts/publish-edition-site-page.ts";

const ID = "RVQp8Ov9FK8";

function editionWith(files: Record<string, string>): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "video-watch-12284-"));
  const dir = join(root, "2611", "261105");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
  return { root, dir };
}

describe("#12284 — task do vídeo espera o merge da página em foreground", () => {
  it("republica com --no-merge-waiter (sem waiter destacado no unit oneshot)", () => {
    const args = sitePageRepublishArgs("/x/261105");
    assert.ok(args.includes("--no-wait-merge"));
    assert.ok(args.includes("--no-merge-waiter"));
  });

  it("cenário da issue: CI pendente → a task roda --merge-pr N e reflete o merge", () => {
    const statePath = "_internal/site-page-published.json";
    const { root, dir } = editionWith({
      "_internal/05-video-url.txt": `https://youtu.be/${ID}\n`,
      [statePath]: JSON.stringify({ published: true, video_url: null }),
    });
    try {
      const calls: string[][] = [];
      const out = republishSitePageIfVideoMissing(dir, () => {}, (args) => {
        calls.push(args);
        if (args.includes("--merge-pr")) return { status: 0 };
        // O publisher grava o state com o PR aberto e não mergeado.
        writeFileSync(
          join(dir, statePath),
          JSON.stringify({ published: true, merged: false, prNumber: 12345, video_url: `https://youtu.be/${ID}` }),
        );
        return { status: 0 };
      });
      assert.deepEqual(calls, [sitePageRepublishArgs(dir), sitePageMergeWaiterArgs(dir, 12345)]);
      assert.equal(out.ok, true);
      assert.deepEqual(out.merge, { prNumber: 12345, merged: true, exitCode: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waiter sem merge vira ok:false (warn no run-log), sem lançar", () => {
    const statePath = "_internal/site-page-published.json";
    const { root, dir } = editionWith({
      "_internal/05-video-url.txt": `https://youtu.be/${ID}\n`,
      [statePath]: JSON.stringify({ published: true }),
    });
    try {
      const out = republishSitePageIfVideoMissing(dir, () => {}, (args) => {
        if (args.includes("--merge-pr")) return { status: 1 };
        writeFileSync(join(dir, statePath), JSON.stringify({ published: true, merged: false, prNumber: 7 }));
        return { status: 0 };
      });
      assert.equal(out.ok, false);
      assert.deepEqual(out.merge, { prNumber: 7, merged: false, exitCode: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publisher já mergeou: não roda o waiter", () => {
    const statePath = "_internal/site-page-published.json";
    const { root, dir } = editionWith({
      "_internal/05-video-url.txt": `https://youtu.be/${ID}\n`,
      [statePath]: JSON.stringify({ published: true }),
    });
    try {
      const calls: string[][] = [];
      const out = republishSitePageIfVideoMissing(dir, () => {}, (args) => {
        calls.push(args);
        writeFileSync(join(dir, statePath), JSON.stringify({ published: true, merged: true, prNumber: 7 }));
        return { status: 0 };
      });
      assert.equal(calls.length, 1);
      assert.equal(out.ok, true);
      assert.equal(out.merge, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pendingSitePagePr só devolve PR publicado, não mergeado e com número válido", () => {
    assert.equal(pendingSitePagePr({ published: true, merged: false, prNumber: 9 }), 9);
    assert.equal(pendingSitePagePr({ published: true, prNumber: 9 }), 9);
    assert.equal(pendingSitePagePr({ published: true, merged: true, prNumber: 9 }), null);
    assert.equal(pendingSitePagePr({ published: false, merged: false, prNumber: 9 }), null);
    assert.equal(pendingSitePagePr({ published: true, merged: false }), null);
    assert.equal(pendingSitePagePr({ published: true, merged: false, prNumber: "9" }), null);
    assert.equal(pendingSitePagePr(null), null);
  });
});

describe("#12284 — publisher com --no-merge-waiter não dispara waiter destacado", () => {
  const RUNNING = { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null };
  const git: GitRunner = (args) => {
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "master\n";
    if (args[0] === "rev-parse") return "deadbeef\ndeadbeef\n";
    if (args[0] === "status") return " M workers/site/public/p/meu-slug/index.html\n";
    if (args[0] === "diff") return "workers/site/public/p/meu-slug/index.html\n";
    return "";
  };
  const lock = () => ({ ok: true, stdout: "", stderr: "" });

  it("CI pendente com syncWait 0: merged:false e o motivo diz que o merge fica com o chamador", () => {
    const gh: GhRunner = (args) => {
      if (args[1] === "list") return "[]";
      if (args[1] === "create") return "https://github.com/vjpixel/diaria-studio/pull/12345\n";
      if (args[1] === "view") return JSON.stringify({ statusCheckRollup: [RUNNING], mergeable: "MERGEABLE", state: "OPEN" });
      throw new Error(`gh inesperado: ${args.join(" ")}`);
    };
    const result = productionDeps("/repo", git, gh, lock, () => {}, undefined, deferredMergeWaiterSpawner, 0).publish(
      "meu-slug",
      undefined,
      "/repo/data/editions/2611/261105",
    );
    assert.equal(result.merged, false);
    assert.equal(result.prNumber, 12345);
    assert.match(result.mergeReason ?? "", /merge fica com o chamador \(--merge-pr 12345/);
    assert.doesNotMatch(result.mergeReason ?? "", /waiter em background/);
  });
});
