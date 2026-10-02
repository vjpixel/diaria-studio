/**
 * test/publish-retrospectiva-linkedin-9474.test.ts (#9474)
 *
 * Post PÚBLICO da Retrospectiva na página diar.ia.br: guards de CTA (nunca a
 * URL paywalled), agenda no futuro, destaque aceito pelo Worker, sem fallback
 * imediato, idempotência por canal e reconciliação DLQ → failed.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RETROSPECTIVA_LINKEDIN_DESTAQUE,
  readD1ImageUrl,
  runRetrospectivaLinkedinDispatch,
} from "../scripts/publish-retrospectiva-linkedin.ts";
import { WORKER_DESTAQUE_RE } from "../scripts/publish-artigo-especial-linkedin.ts";
import {
  RETROSPECTIVA_PUBLIC_CTA,
  readRetrospectivaDivulgacaoState,
  retrospectivaDivulgacaoStatePath,
} from "../scripts/lib/mensal/retrospectiva-divulgacao.ts";
import type { DispatchContext, DispatchInput } from "../scripts/publish-linkedin.ts";
import type { PostEntry, SocialPublished } from "../scripts/lib/social-published-store.ts";

const NOW = Date.parse("2026-10-03T10:00:00-03:00");
const AT = "2026-10-04T09:00:00-03:00";
const TEXT = `Setembro teve três viradas que mudam como você usa IA no trabalho.\n\n${RETROSPECTIVA_PUBLIC_CTA}`;

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "retro-li-9474-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function ctx(): DispatchContext {
  return {
    publishedPath: join(tmp, "_internal", "divulgacao-linkedin-published.json"),
    webhookUrl: "https://make.invalid",
    workerUrl: "https://worker.invalid",
    workerToken: "t",
    useWorkerForScheduled: true,
    editionDate: "retrospectiva-2609-10",
    rootDir: tmp,
  };
}

function base(over: Partial<Parameters<typeof runRetrospectivaLinkedinDispatch>[0]> = {}) {
  const seen: DispatchInput[] = [];
  const dispatch = async (input: DispatchInput): Promise<PostEntry> => {
    seen.push(input);
    return { platform: "linkedin", destaque: input.destaque, subtype: "main", url: null, status: "scheduled", scheduled_at: input.scheduledAt, worker_queue_key: "k1" };
  };
  return {
    seen,
    opts: {
      cycle: "2609-10",
      cycleDir: tmp,
      text: TEXT,
      imageUrl: "https://eia.diar.ia.br/img/x.jpg",
      scheduledAt: AT,
      force: false,
      dryRun: false,
      ctx: ctx(),
      dispatch,
      verifyWorker: async (p: SocialPublished) => ({ updated: p, changes: 0, inQueue: 1 }),
      now: NOW,
      ...over,
    },
  };
}

describe("runRetrospectivaLinkedinDispatch", () => {
  it("destaque é aceito pelo regex do Worker publicado", () => {
    assert.match(RETROSPECTIVA_LINKEDIN_DESTAQUE, WORKER_DESTAQUE_RE);
  });

  it("despacha só a página, agendada, sem fallback imediato; canal done; 2ª vez pula", async () => {
    const { seen, opts } = base();
    const r = await runRetrospectivaLinkedinDispatch(opts);
    assert.equal(r.action, "dispatched");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].webhookTarget, "diaria");
    assert.equal(seen[0].scheduledAt, AT);
    assert.equal(seen[0].allowImmediateFallback, false);
    const st = readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10");
    assert.equal(st.channels.linkedin_pagina?.status, "done");
    const again = await runRetrospectivaLinkedinDispatch(base().opts);
    assert.equal(again.action, "skipped");
  });

  it("recusa ANTES de despachar texto com a URL direta da retrospectiva paywalled", async () => {
    const { seen, opts } = base({ text: `${TEXT}\nhttps://retrospectiva.diar.ia.br/2609` });
    await assert.rejects(runRetrospectivaLinkedinDispatch(opts), /paywalled/);
    assert.equal(seen.length, 0);
  });

  it("recusa texto sem a linha literal de CTA", async () => {
    const { seen, opts } = base({ text: "Leia a retrospectiva." });
    await assert.rejects(runRetrospectivaLinkedinDispatch(opts), /linha literal/);
    assert.equal(seen.length, 0);
  });

  it("recusa agenda no passado (Worker publicaria fora da agenda)", async () => {
    const { seen, opts } = base({ scheduledAt: "2026-10-01T09:00:00-03:00" });
    await assert.rejects(runRetrospectivaLinkedinDispatch(opts), /não está no futuro/);
    assert.equal(seen.length, 0);
  });

  it("dry-run não despacha nem grava state", async () => {
    const { seen, opts } = base({ dryRun: true });
    assert.equal((await runRetrospectivaLinkedinDispatch(opts)).action, "dry-run");
    assert.equal(seen.length, 0);
    assert.deepEqual(readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels, {});
  });

  it("reconciliação: Worker manda pro DLQ depois do dispatch → canal vira failed (retentável)", async () => {
    // dispatchEntry real grava o store ao despachar; o fake imita isso.
    const writingDispatch = async (input: DispatchInput): Promise<PostEntry> => {
      const entry: PostEntry = { platform: "linkedin", destaque: input.destaque, subtype: "main", url: null, status: "scheduled", scheduled_at: input.scheduledAt };
      mkdirSync(join(tmp, "_internal"), { recursive: true });
      writeFileSync(ctx().publishedPath, JSON.stringify({ posts: [entry] }));
      return entry;
    };
    const { opts } = base({
      dispatch: writingDispatch,
      verifyWorker: async (p: SocialPublished) => ({
        updated: { posts: p.posts.map((e) => ({ ...e, status: "failed" as const, failure_reason: "DLQ: token expirado" })) },
        changes: 1,
      }),
    });
    const r = await runRetrospectivaLinkedinDispatch(opts);
    assert.equal(r.action, "failed");
    const st = readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10");
    assert.equal(st.channels.linkedin_pagina?.status, "failed");
    assert.match(st.channels.linkedin_pagina!.reason!, /DLQ/);
  });
});

describe("runRetrospectivaLinkedinDispatch — falhas e 2º guard", () => {
  it("dispatch devolve failed → canal failed com o motivo; a próxima execução retenta", async () => {
    const failing = async (input: DispatchInput): Promise<PostEntry> => ({
      platform: "linkedin",
      destaque: input.destaque,
      subtype: "main",
      url: null,
      status: "failed",
      scheduled_at: input.scheduledAt,
      reason: "Worker 400",
    });
    const r = await runRetrospectivaLinkedinDispatch(base({ dispatch: failing }).opts);
    assert.equal(r.action, "failed");
    const st = readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10");
    assert.equal(st.channels.linkedin_pagina?.status, "failed");
    assert.match(st.channels.linkedin_pagina!.reason!, /Worker 400/);
    const { seen, opts } = base();
    assert.equal((await runRetrospectivaLinkedinDispatch(opts)).action, "dispatched");
    assert.equal(seen.length, 1);
  });

  it("store já com o post agendado (state sem registro) → pula sem despachar; --force despacha", async () => {
    mkdirSync(join(tmp, "_internal"), { recursive: true });
    writeFileSync(
      ctx().publishedPath,
      JSON.stringify({ posts: [{ platform: "linkedin", destaque: RETROSPECTIVA_LINKEDIN_DESTAQUE, subtype: "main", url: null, status: "scheduled", scheduled_at: AT, worker_queue_key: "k0" }] }),
    );
    const a = base();
    const r = await runRetrospectivaLinkedinDispatch(a.opts);
    assert.equal(r.action, "skipped");
    assert.equal(a.seen.length, 0);
    const b = base({ force: true });
    assert.equal((await runRetrospectivaLinkedinDispatch(b.opts)).action, "dispatched");
    assert.equal(b.seen.length, 1);
  });

  it("reconciliação que lança → segue agendado (done), mas com verifyError pro caller sair != 0", async () => {
    const { opts } = base({
      verifyWorker: async () => {
        throw new Error("Worker /list 503");
      },
    });
    const r = await runRetrospectivaLinkedinDispatch(opts);
    assert.equal(r.action, "dispatched");
    assert.match((r as { verifyError: string }).verifyError, /503/);
    assert.equal(readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels.linkedin_pagina?.status, "done");
  });
});

describe("readD1ImageUrl", () => {
  it("lê images.d1.url de _internal/public-images.json; ausente → null", () => {
    assert.equal(readD1ImageUrl(tmp), null);
    mkdirSync(join(tmp, "_internal"), { recursive: true });
    writeFileSync(join(tmp, "_internal", "public-images.json"), JSON.stringify({ images: { d1: { url: "https://eia.diar.ia.br/img/d1.jpg" } } }));
    assert.equal(readD1ImageUrl(tmp), "https://eia.diar.ia.br/img/d1.jpg");
  });
});
