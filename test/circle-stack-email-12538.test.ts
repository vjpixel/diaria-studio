/**
 * #12538 — post semanal da Stack também por e-mail (Kit) aos apoiadores Núcleo.
 *
 * Cobre: o render (mesmo post do Circle, UTM do canal e-mail, sem "Assine a
 * diar.ia.br", sem Markdown cru), o publicador (dry-run sem Kit, guards de
 * audiência, payload, idempotência, cancelamento quando a releitura não
 * confirma a audiência) e a integração com a task de segunda (só com o ciclo
 * aprovado, independente do Circle, falha vira exit 1 e entra no e-mail).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCircleStackPost, type CircleStackSelection } from "../scripts/lib/circle-stack-render.ts";
import {
  inlineMarkdownToHtml,
  renderStackEmail,
  stackMarkdownToHtml,
} from "../scripts/lib/circle-stack-email-render.ts";
import { STACK_EMAIL_NIVEIS, StackEmailGuardError } from "../scripts/lib/circle-stack-email-channel.ts";
import {
  STACK_EMAIL_SEND_DELAY_MIN,
  resolveStackEmailPaths,
  runCircleStackEmail,
  type StackEmailDeps,
} from "../scripts/publish-circle-stack-email-kit.ts";
import { buildTagFilter, type CreateBroadcastInput } from "../scripts/lib/kit-broadcasts.ts";
import { buildCircleStackApproval } from "../scripts/lib/circle-stack-schedule.ts";
import { resolveCyclePaths, runScheduledCircleStackPublish } from "../scripts/publish-circle-stack-scheduled.ts";
import { resolveWeeklyLinkedinCycle } from "../scripts/lib/weekly-linkedin-cycle.ts";
import type { PushMessage } from "../scripts/lib/push-notify.ts";

const MONDAY = "261109";
const CYCLE = resolveWeeklyLinkedinCycle(MONDAY)!.cycle;
const NOW = new Date("2026-11-09T09:00:00.000Z");

function selection(): CircleStackSelection {
  return {
    cycle: CYCLE,
    contentWindow: ["261102", "261103", "261104", "261105", "261106"],
    destaques: [
      {
        editionDate: "261102",
        url: "https://openai.com/index/anuncio",
        title: "Modelo novo chega com **preço** menor",
        body: "A OpenAI lançou um modelo. Ele custa menos.",
        why: "Muda a conta de quem constrói <agentes>.",
        destaqueN: 1,
      },
    ],
    lancamentos: [
      {
        editionDate: "261103",
        url: "https://cursor.com/changelog",
        title: "Cursor [beta] ganha agentes",
        body: "texto da newsletter",
        why: "",
        stackNote: "Agora o agente roda em segundo plano.",
      },
    ],
    useMelhor: [],
    radar: [],
    weeklyEditions: [{ editionDate: "261104", url: "https://diar.ia.br/p/edicao-x", destaques: ["Outro assunto da semana"] }],
    video: { title: "Vídeo da semana", url: "https://www.youtube.com/watch?v=abc", editionDate: "261102" },
  };
}

describe("render do e-mail (#12538)", () => {
  it("Circle continua com o CTA de assinatura e a UTM stack/circle", () => {
    const md = renderCircleStackPost(selection()).markdown;
    assert.match(md, /Assine a diar\.ia\.br/);
    assert.match(md, /utm_source=stack&utm_medium=circle/);
  });

  it("e-mail: mesmo post, UTM stack-email/email, sem o CTA de assinatura", () => {
    const e = renderStackEmail(selection());
    assert.equal(e.subject, "Stack da semana: Modelo novo chega com **preço** menor");
    assert.equal(e.previewText, "Exclusivo para apoiadores");
    assert.ok(!e.html.includes("Assine a diar.ia.br"));
    assert.ok(!e.html.includes("utm_source=stack&amp;utm_medium=circle"));
    assert.match(e.html, /utm_source=stack-email&amp;utm_medium=email&amp;utm_campaign=stack-/);
    assert.match(e.html, /Vídeo mais assistido da semana/);
    assert.match(e.html, /Agora o agente roda em segundo plano\./);
    assert.match(e.html, /Outro assunto da semana/);
    assert.match(e.html, /n&iacute;vel N&uacute;cleo/);
  });

  it("não deixa Markdown cru nem HTML do conteúdo sem escape", () => {
    const html = renderStackEmail(selection()).html;
    assert.ok(!/\]\(https?:/.test(html), "link Markdown sobrou");
    assert.ok(!/^\s*(##|- )/m.test(html), "marcador de bloco sobrou");
    assert.ok(html.includes("&lt;agentes&gt;"));
    assert.ok(!html.includes("<agentes>"));
  });

  it("stackMarkdownToHtml: cabeçalhos, lista, negrito e link", () => {
    const html = stackMarkdownToHtml(
      "Abertura com [link](https://a.com/x%28y%29).\n\n## Radar\n\n- [Item](https://b.com): desc\n- [Outro](https://c.com)\n\n### [Título](https://d.com)\n\n**Por que isso importa:**",
    );
    assert.match(html, /<p [^>]*>Abertura com <a href="https:\/\/a\.com\/x%28y%29"[^>]*>link<\/a>\.<\/p>/);
    assert.match(html, /<h2 [^>]*>Radar<\/h2>/);
    assert.equal((html.match(/<li /g) ?? []).length, 2);
    assert.match(html, /<h3 [^>]*><a href="https:\/\/d\.com"/);
    assert.match(html, /<strong>Por que isso importa:<\/strong>/);
  });

  it("inlineMarkdownToHtml desfaz o escape de barra do rótulo e escapa aspas na URL", () => {
    assert.match(inlineMarkdownToHtml("[a \\\\ b](https://x.com/?q=\"1\")"), /href="https:\/\/x\.com\/\?q=&quot;1&quot;"[^>]*>a \\ b<\/a>/);
  });
});

// ── publicador ─────────────────────────────────────────────────────────────

function setupRoot(opts: { tag?: string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stack-email-"));
  const cfg = opts.tag === null ? {} : { kit_stack: { audience_tag: opts.tag ?? "apoio-stack" } };
  writeFileSync(join(root, "platform.config.json"), JSON.stringify(cfg));
  const paths = resolveStackEmailPaths(root, MONDAY);
  mkdirSync(join(paths.selectionPath, ".."), { recursive: true });
  writeFileSync(paths.selectionPath, JSON.stringify(selection(), null, 2));
  return { root, paths };
}

function kitDeps(opts: { tagId?: number | null; members?: number; reread?: unknown; rereadThrows?: boolean; deleteThrows?: boolean } = {}) {
  const created: CreateBroadcastInput[] = [];
  const deleted: number[] = [];
  const written: Record<string, string> = {};
  const deps: StackEmailDeps = {
    writeFile: (p, c) => {
      written[p] = c;
      writeFileSync(p, c);
    },
    findTagId: async () => (opts.tagId === undefined ? 42 : opts.tagId),
    countTagMembers: async () => opts.members ?? 3,
    createBroadcast: async (input) => {
      created.push(input);
      return { id: 900 + created.length };
    },
    getBroadcast: async () => {
      if (opts.rereadThrows) throw new Error("timeout");
      return { subscriber_filter: opts.reread === undefined ? buildTagFilter(42) : opts.reread };
    },
    deleteBroadcast: async (id) => {
      if (opts.deleteThrows) throw new Error("422");
      deleted.push(id);
    },
    resolveKitConfig: () => ({ ok: true, config: { apiKey: "k" } }) as ReturnType<StackEmailDeps["resolveKitConfig"]>,
  };
  return { deps, created, deleted, written };
}

const run = (root: string, deps: StackEmailDeps, extra: { send?: boolean; force?: boolean } = {}) =>
  runCircleStackEmail({
    rootDir: root,
    dataRoot: root,
    publishMonday: MONDAY,
    send: extra.send ?? true,
    force: extra.force ?? false,
    log: () => {},
    now: () => NOW,
    deps,
  });

describe("publish-circle-stack-email-kit (#12538)", () => {
  it("audiência é só Núcleo (patrono)", () => {
    assert.deepEqual([...STACK_EMAIL_NIVEIS], ["patrono"]);
  });

  it("dry-run grava a prévia e não chama o Kit", async () => {
    const { root, paths } = setupRoot();
    const k = kitDeps();
    let kitCalled = false;
    k.deps.findTagId = async () => {
      kitCalled = true;
      return 1;
    };
    const res = await run(root, k.deps, { send: false });
    assert.equal(res.kind, "dry-run");
    assert.ok(existsSync(paths.previewPath));
    assert.equal(kitCalled, false);
    assert.equal(k.created.length, 0);
  });

  it("sem tag configurada recusa até no dry-run (filtro ausente = base inteira)", async () => {
    const { root } = setupRoot({ tag: null });
    await assert.rejects(run(root, kitDeps().deps, { send: false }), StackEmailGuardError);
  });

  it("tag inexistente ou vazia recusa sem criar broadcast", async () => {
    for (const opts of [{ tagId: null }, { members: 0 }]) {
      const { root } = setupRoot();
      const k = kitDeps(opts);
      await assert.rejects(run(root, k.deps), StackEmailGuardError);
      assert.equal(k.created.length, 0);
    }
  });

  it("envio: filtro de tag, public false, send_at = agora + atraso, grava o registro", async () => {
    const { root, paths } = setupRoot();
    const k = kitDeps();
    const res = await run(root, k.deps);
    assert.equal(res.kind, "enviado");
    assert.equal(k.created.length, 1);
    const input = k.created[0];
    assert.deepEqual(input.subscriber_filter, buildTagFilter(42));
    assert.equal(input.public, false);
    assert.equal(input.send_at, new Date(NOW.getTime() + STACK_EMAIL_SEND_DELAY_MIN * 60_000).toISOString());
    assert.match(input.subject, /^Stack da semana: /);
    const saved = JSON.parse(readFileSync(paths.publishedPath, "utf8"));
    assert.equal(saved.broadcastId, 901);
    assert.equal(saved.audienceVerification.status, "confirmed");
  });

  it("segundo envio do mesmo ciclo é recusado sem --force", async () => {
    const { root } = setupRoot();
    const k = kitDeps();
    await run(root, k.deps);
    await assert.rejects(run(root, k.deps), (e: Error) => e instanceof StackEmailGuardError && /já foi criado/.test(e.message));
    assert.equal(k.created.length, 1);
    await run(root, k.deps, { force: true });
    assert.equal(k.created.length, 2);
  });

  it("releitura divergente ou sem resposta: cancela o broadcast e não grava registro", async () => {
    for (const opts of [{ reread: [{ all: [] }] }, { rereadThrows: true }, { reread: undefined as unknown }]) {
      const { root, paths } = setupRoot();
      const k = kitDeps(opts);
      if ("reread" in opts && opts.reread === undefined) k.deps.getBroadcast = async () => ({});
      await assert.rejects(run(root, k.deps), /CANCELADO/);
      assert.deepEqual(k.deleted, [901]);
      assert.ok(!existsSync(paths.publishedPath));
    }
  });

  it("cancelamento falhando: grava o registro (guard de duplicata) e grita", async () => {
    const { root, paths } = setupRoot();
    const k = kitDeps({ reread: [{ all: [] }], deleteThrows: true });
    await assert.rejects(run(root, k.deps), /cancelamento automático FALHOU/);
    assert.ok(existsSync(paths.publishedPath));
  });
});

// ── task de segunda ────────────────────────────────────────────────────────

describe("task de segunda envia o e-mail Núcleo (#12538)", () => {
  const mondayAt6 = () => new Date(2026, 10, 9, 6, 0, 0);
  const DURING_RUN = new Date(2026, 10, 9, 6, 0, 5).toISOString();

  function setupCycle(approve: boolean) {
    const dataRoot = mkdtempSync(join(tmpdir(), "stack-email-sched-"));
    const paths = resolveCyclePaths(dataRoot, MONDAY);
    mkdirSync(join(paths.selectionPath, ".."), { recursive: true });
    const sel = JSON.stringify(selection(), null, 2);
    writeFileSync(paths.selectionPath, sel);
    if (approve) writeFileSync(paths.approvalPath, JSON.stringify(buildCircleStackApproval(CYCLE, sel, new Date())));
    return paths;
  }

  function deps(paths: ReturnType<typeof resolveCyclePaths>, circleOk: boolean, email: () => Promise<{ broadcastId: number; sendAt: string }>) {
    const emails: PushMessage[] = [];
    const emailCalls: string[] = [];
    return {
      emails,
      emailCalls,
      d: {
        rootDir: "/repo",
        platformConfig: {},
        env: {},
        now: mondayAt6,
        runPublish: async () => {
          if (!circleOk) throw new Error("HTTP 500 do webhook");
          writeFileSync(paths.statePath, JSON.stringify({ cycle: CYCLE, attempted_at: DURING_RUN, published_at: DURING_RUN }));
        },
        sendEmail: async (m: PushMessage) => {
          emails.push(m);
          return { ok: true as const };
        },
        runStackEmail: async (monday: string) => {
          emailCalls.push(monday);
          return email();
        },
      },
    };
  }

  it("ciclo aprovado: Circle e e-mail, desfecho do e-mail no aviso ao editor", async () => {
    const paths = setupCycle(true);
    const h = deps(paths, true, async () => ({ broadcastId: 77, sendAt: "2026-11-09T09:05:00.000Z" }));
    const res = await runScheduledCircleStackPublish(paths, h.d);
    assert.equal(res.outcome.kind, "publicado");
    assert.deepEqual(h.emailCalls, [MONDAY]);
    assert.deepEqual(res.stackEmail, { kind: "enviado", broadcastId: 77, sendAt: "2026-11-09T09:05:00.000Z" });
    assert.match(h.emails[0].body, /apoiadores Núcleo \(Kit\): agendado para 2026-11-09T09:05:00\.000Z \(broadcast 77\)/);
    assert.equal(res.exitCode, 0);
  });

  it("e-mail sai mesmo se o Circle falhou", async () => {
    const paths = setupCycle(true);
    const h = deps(paths, false, async () => ({ broadcastId: 78, sendAt: "x" }));
    const res = await runScheduledCircleStackPublish(paths, h.d);
    assert.equal(res.outcome.kind, "falhou");
    assert.equal(h.emailCalls.length, 1);
  });

  it("sem aprovação: nem Circle nem e-mail", async () => {
    const paths = setupCycle(false);
    const h = deps(paths, true, async () => ({ broadcastId: 1, sendAt: "x" }));
    const res = await runScheduledCircleStackPublish(paths, h.d);
    assert.equal(res.outcome.kind, "nao-enviado");
    assert.equal(h.emailCalls.length, 0);
    assert.equal(res.stackEmail, null);
  });

  it("falha do e-mail: exit 1 e erro literal no aviso, mesmo com o Circle publicado", async () => {
    const paths = setupCycle(true);
    const h = deps(paths, true, async () => {
      throw new Error('tag "apoio-stack" não existe no Kit');
    });
    const res = await runScheduledCircleStackPublish(paths, h.d);
    assert.equal(res.outcome.kind, "publicado");
    assert.equal(res.exitCode, 1);
    assert.match(h.emails[0].body, /FALHOU[\s\S]*apoio-stack" não existe[\s\S]*--send/);
  });
});
