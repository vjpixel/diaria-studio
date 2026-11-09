/**
 * #12538 — post semanal da Stack também por e-mail (Kit) aos apoiadores Núcleo.
 *
 * Cobre: o render (mesmo post do Circle, UTM do canal e-mail em todo link que
 * leva UTM, sem "Assine a diar.ia.br", sem Markdown cru, chaves Liquid
 * neutralizadas), o publicador (dry-run sem Kit, travas de conteúdo do Circle,
 * guards de audiência, payload, registro antes do POST, estados ambíguos,
 * já enviado, lock, cancelamento conferido quando a releitura não confirma
 * audiência/agendamento) e a task de segunda (desfechos tipados, instrução
 * certa por caso, assunto marcado quando pede ação, exit code).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCircleStackUrl, renderCircleStackPost, type CircleStackSelection } from "../scripts/lib/circle-stack-render.ts";
import {
  formatStackEmailBrt,
  inlineMarkdownToHtml,
  renderStackEmail,
  stackMarkdownToHtml,
} from "../scripts/lib/circle-stack-email-render.ts";
import {
  STACK_EMAIL_NIVEIS,
  StackEmailGuardError,
  StackEmailIncidentError,
} from "../scripts/lib/circle-stack-email-channel.ts";
import {
  STACK_EMAIL_SEND_DELAY_MIN,
  resolveStackEmailPaths,
  runCircleStackEmail,
  verifyStackEmailReread,
  type StackEmailDeps,
} from "../scripts/publish-circle-stack-email-kit.ts";
import { buildTagFilter, type CreateBroadcastInput } from "../scripts/lib/kit-broadcasts.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";
import { buildCircleStackApproval } from "../scripts/lib/circle-stack-schedule.ts";
import {
  appendStackEmailOutcome,
  classifyStackEmailRun,
  resolveCyclePaths,
  runScheduledCircleStackPublish,
  type StackEmailOutcome,
} from "../scripts/publish-circle-stack-scheduled.ts";
import { resolveWeeklyLinkedinCycle } from "../scripts/lib/weekly-linkedin-cycle.ts";
import type { PushMessage } from "../scripts/lib/push-notify.ts";

const MONDAY = "261109";
const CYCLE = resolveWeeklyLinkedinCycle(MONDAY)!.cycle;
const NOW = new Date("2026-11-09T09:00:00.000Z");

function selection(extra: Partial<CircleStackSelection> = {}): CircleStackSelection {
  return {
    cycle: CYCLE,
    contentWindow: ["261102", "261103", "261104", "261105", "261106"],
    destaques: [
      {
        editionDate: "261102",
        url: "https://openai.com/index/anuncio",
        title: "Modelo novo chega com preço menor",
        body: "A OpenAI lançou um modelo. Ele custa menos.",
        why: "Muda a conta de quem constrói <agentes> com {{ $json.x }}.",
        destaqueN: 1,
      },
    ],
    lancamentos: [],
    useMelhor: [],
    radar: [
      {
        editionDate: "261103",
        url: "https://exemplo.com.br/noticia",
        title: "Cursor ganha agentes em segundo plano",
        body: "texto da newsletter",
        why: "",
        stackNote: "Agora o agente roda em segundo plano.",
      },
    ],
    weeklyEditions: [{ editionDate: "261104", url: "https://diar.ia.br/p/edicao-x", destaques: ["Outro assunto da semana"] }],
    video: { title: "Vídeo da semana", url: "https://www.youtube.com/watch?v=abc", editionDate: "261102" },
    ...extra,
  };
}

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

describe("render do e-mail (#12538)", () => {
  it("Circle sem `channel` segue igual: CTA de assinatura e UTM stack/circle", () => {
    const md = renderCircleStackPost(selection()).markdown;
    assert.match(md, /Assine a diar\.ia\.br/);
    assert.match(md, /utm_source=stack&utm_medium=circle/);
    assert.ok(!md.includes("stack-email"));
  });

  it("buildCircleStackUrl com canal troca só source/medium", () => {
    const u = new URL(buildCircleStackUrl("https://diar.ia.br/p/x", "26w45", "video", { utmSource: "s", utmMedium: "m" }));
    assert.equal(u.searchParams.get("utm_source"), "s");
    assert.equal(u.searchParams.get("utm_medium"), "m");
    assert.equal(u.searchParams.get("utm_campaign"), "stack-26w45");
    assert.equal(u.searchParams.get("utm_content"), "video");
  });

  it("e-mail: todo link com UTM é do canal e-mail (edição e vídeo), sem CTA de assinatura", () => {
    const e = renderStackEmail(selection());
    assert.equal(e.subject, "Stack da semana: Modelo novo chega com preço menor");
    assert.equal(e.previewText, "Exclusivo para apoiadores");
    assert.ok(!e.html.includes("Assine a diar.ia.br"));
    const utm = hrefs(e.html).filter((h) => h.includes("utm_"));
    // Sem "Outros destaques" (#12550) não há mais link da edição no e-mail; o do vídeo continua.
    assert.ok(utm.some((h) => h.includes("utm_content=video")), "link do vídeo");
    for (const h of utm) {
      const u = new URL(h);
      assert.equal(u.searchParams.get("utm_source"), "stack-email", h);
      assert.equal(u.searchParams.get("utm_medium"), "email", h);
    }
    assert.match(e.html, /Agora o agente roda em segundo plano\./);
    assert.match(e.html, /n&iacute;vel N&uacute;cleo/);
  });

  it("#12550: o e-mail não leva \"Outros destaques da semana\"; o Circle continua levando", () => {
    const e = renderStackEmail(selection());
    assert.ok(!e.html.includes("Outros destaques"));
    assert.ok(!e.html.includes("Outro assunto da semana"));
    const circle = renderCircleStackPost(selection()).markdown;
    assert.ok(circle.includes("## Outros destaques da semana"));
    assert.ok(circle.includes("- Outro assunto da semana"));
  });

  it("escapa HTML e neutraliza chaves Liquid do conteúdo", () => {
    const html = renderStackEmail(selection()).html;
    assert.ok(!/\]\(https?:/.test(html), "link Markdown sobrou");
    assert.ok(!html.includes("**"), "negrito Markdown sobrou");
    assert.ok(html.includes("&lt;agentes&gt;"));
    assert.ok(!html.includes("{{"), "chaves Liquid chegariam ao Kit");
    assert.ok(html.includes("&#123;&#123; $json.x &#125;&#125;"));
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

  it("inlineMarkdownToHtml desfaz o escape de barra do rótulo e escapa aspas e & na URL", () => {
    assert.match(
      inlineMarkdownToHtml('[a \\\\ b](https://x.com/?q="1"&r=2)'),
      /href="https:\/\/x\.com\/\?q=&quot;1&quot;&amp;r=2"[^>]*>a \\ b<\/a>/,
    );
  });

  it("formatStackEmailBrt mostra o horário de Brasília", () => {
    assert.equal(formatStackEmailBrt("2026-11-16T09:05:00.000Z"), "16/11 06:05 BRT");
    assert.equal(formatStackEmailBrt("lixo"), "lixo");
  });
});

// ── publicador ─────────────────────────────────────────────────────────────

function setupRoot(opts: { tag?: string | null; circleEnabled?: boolean; sel?: CircleStackSelection } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stack-email-"));
  const cfg: Record<string, unknown> = opts.tag === null ? {} : { kit_stack: { audience_tag: opts.tag ?? "apoio-stack" } };
  if (opts.circleEnabled === false) cfg.circle_stack = { enabled: false };
  writeFileSync(join(root, "platform.config.json"), JSON.stringify(cfg));
  const paths = resolveStackEmailPaths(root, MONDAY);
  mkdirSync(join(paths.selectionPath, ".."), { recursive: true });
  writeFileSync(paths.selectionPath, JSON.stringify(opts.sel ?? selection(), null, 2));
  return { root, paths };
}

const SCHEDULED = { subscriber_filter: buildTagFilter(42), status: "scheduled", send_at: "2026-11-09T09:05:00.000Z" };

interface KitOpts {
  tagId?: number | null;
  members?: number;
  rereads?: Array<object | Error>;
  deleteThrows?: boolean;
  createThrows?: boolean;
  writeThrowsOn?: (contents: string) => boolean;
}

function kitDeps(opts: KitOpts = {}) {
  const created: CreateBroadcastInput[] = [];
  const deleted: number[] = [];
  const rereads = [...(opts.rereads ?? [SCHEDULED])];
  let sleeps = 0;
  const deps: Partial<StackEmailDeps> = {
    writeFile: (p, c) => {
      if (opts.writeThrowsOn?.(c)) throw new Error("disco cheio");
      writeFileSync(p, c);
    },
    findTagId: async () => (opts.tagId === undefined ? 42 : opts.tagId),
    countTagMembers: async () => opts.members ?? 3,
    createBroadcast: async (input) => {
      if (opts.createThrows) throw new Error("timeout");
      created.push(input);
      return { id: 900 + created.length };
    },
    getBroadcast: async () => {
      const next = rereads.length > 1 ? rereads.shift()! : rereads[0];
      if (next instanceof Error) throw next;
      return next as Awaited<ReturnType<StackEmailDeps["getBroadcast"]>>;
    },
    deleteBroadcast: async (id) => {
      if (opts.deleteThrows) throw new Error("422");
      deleted.push(id);
    },
    resolveKitConfig: () => ({ ok: true, config: { apiKey: "k" } }) as ReturnType<StackEmailDeps["resolveKitConfig"]>,
    sleep: async () => {
      sleeps++;
    },
  };
  return { deps, created, deleted, sleeps: () => sleeps };
}

const run = (root: string, deps: Partial<StackEmailDeps>, extra: { send?: boolean; force?: boolean } = {}) =>
  runCircleStackEmail({
    rootDir: root,
    dataRoot: root,
    publishMonday: MONDAY,
    mode: extra.send === false ? { kind: "dry-run" } : { kind: "send", force: extra.force ?? false },
    log: () => {},
    now: () => NOW,
    deps,
  });

const notFound = new KitApiError("/broadcasts/901", 404, "not found");
const record = (paths: { publishedPath: string }) => JSON.parse(readFileSync(paths.publishedPath, "utf8"));

describe("publish-circle-stack-email-kit (#12538)", () => {
  it("audiência é só Núcleo (patrono)", () => {
    assert.deepEqual([...STACK_EMAIL_NIVEIS], ["patrono"]);
  });

  it("dry-run grava a prévia, lista o que recusaria e não chama o Kit", async () => {
    const { root, paths } = setupRoot({ circleEnabled: false });
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
    assert.match((res as { problems: string[] }).problems.join(), /circle_stack\.enabled = false/);
  });

  it("sem tag configurada recusa até no dry-run (filtro ausente = base inteira)", async () => {
    const { root } = setupRoot({ tag: null });
    await assert.rejects(run(root, kitDeps().deps, { send: false }), StackEmailGuardError);
  });

  it("travas de conteúdo do Circle: desligado no config ou título sem português não revisado", async () => {
    const unreviewed = selection({
      radar: [{ editionDate: "261103", url: "https://exemplo.com.br/n", title: "Codex Launch Notes", body: "b", why: "" }],
    });
    for (const opts of [{ circleEnabled: false }, { sel: unreviewed }]) {
      const { root } = setupRoot(opts);
      const k = kitDeps();
      await assert.rejects(run(root, k.deps), (e: Error) => e instanceof StackEmailGuardError && /travas do Circle/.test(e.message));
      assert.equal(k.created.length, 0);
    }
  });

  it("tag inexistente ou vazia recusa sem criar broadcast", async () => {
    for (const opts of [{ tagId: null }, { members: 0 }]) {
      const { root } = setupRoot();
      const k = kitDeps(opts);
      await assert.rejects(run(root, k.deps), StackEmailGuardError);
      assert.equal(k.created.length, 0);
    }
  });

  it("Kit sem credencial recusa como guard", async () => {
    const { root } = setupRoot();
    const k = kitDeps();
    k.deps.resolveKitConfig = () => ({ ok: false, reason: "KIT_API_KEY ausente" }) as ReturnType<StackEmailDeps["resolveKitConfig"]>;
    await assert.rejects(run(root, k.deps), (e: Error) => e instanceof StackEmailGuardError && /KIT_API_KEY/.test(e.message));
  });

  it("envio: filtro de tag, public false, send_at = agora + atraso, registro `sent`", async () => {
    const { root, paths } = setupRoot();
    const k = kitDeps();
    const res = await run(root, k.deps);
    assert.equal(res.kind, "enviado");
    const input = k.created[0];
    assert.deepEqual(input.subscriber_filter, buildTagFilter(42));
    assert.equal(input.public, false);
    assert.equal(input.send_at, new Date(NOW.getTime() + STACK_EMAIL_SEND_DELAY_MIN * 60_000).toISOString());
    assert.match(input.subject, /^Stack da semana: /);
    const saved = record(paths);
    assert.equal(saved.status, "sent");
    assert.equal(saved.broadcastId, 901);
    assert.equal(saved.audienceVerification.status, "confirmed");
  });

  it("registro `pending` é gravado ANTES do POST", async () => {
    const { root, paths } = setupRoot();
    const k = kitDeps();
    let seenAtCreate: unknown;
    const orig = k.deps.createBroadcast!;
    k.deps.createBroadcast = async (i, c) => {
      seenAtCreate = record(paths).status;
      return orig(i, c);
    };
    await run(root, k.deps);
    assert.equal(seenAtCreate, "pending");
  });

  it("já enviado: devolve `ja-enviado` sem criar outro; --force cria", async () => {
    const { root, paths } = setupRoot();
    const k = kitDeps();
    await run(root, k.deps);
    const again = await run(root, k.deps);
    assert.equal(again.kind, "ja-enviado");
    assert.equal(k.created.length, 1);
    await run(root, k.deps, { force: true });
    assert.equal(k.created.length, 2);
    assert.equal(record(paths).broadcastId, 902);
  });

  it("POST falhando: incidente, `pending` fica, reexecução recusa como ambíguo", async () => {
    const { root, paths } = setupRoot();
    const k = kitDeps({ createThrows: true });
    await assert.rejects(run(root, k.deps), (e: Error) => e instanceof StackEmailIncidentError && /PODE tê-lo aceitado/.test(e.message));
    assert.equal(record(paths).status, "pending");
    await assert.rejects(run(root, kitDeps().deps), (e: Error) => e instanceof StackEmailIncidentError && /estado ambíguo/.test(e.message));
  });

  it("registro ilegível bloqueia (nunca vira 'nunca enviado')", async () => {
    const { root, paths } = setupRoot();
    writeFileSync(paths.publishedPath, "{trunc");
    const k = kitDeps();
    await assert.rejects(run(root, k.deps), (e: Error) => e instanceof StackEmailIncidentError && /ilegível/.test(e.message));
    assert.equal(k.created.length, 0);
  });

  it("lock de outro envio (ou de um que morreu) é incidente", async () => {
    const { root, paths } = setupRoot();
    writeFileSync(paths.lockPath, "{}");
    await assert.rejects(run(root, kitDeps().deps), (e: Error) => e instanceof StackEmailIncidentError && /em andamento/.test(e.message));
  });

  it("releitura falha na 1ª e confirma na 2ª: enviado, com espera entre elas", async () => {
    const { root } = setupRoot();
    const k = kitDeps({ rereads: [new Error("timeout"), SCHEDULED] });
    const res = await run(root, k.deps);
    assert.equal(res.kind, "enviado");
    assert.equal(k.sleeps(), 1);
    assert.equal(k.deleted.length, 0);
  });

  it("filtro divergente, sem resposta ou broadcast não agendado: cancela, confere o 404 e não grava registro", async () => {
    const cases: Array<{ rereads: Array<object | Error>; label: RegExp }> = [
      { rereads: [{ ...SCHEDULED, subscriber_filter: [{ all: [] }] }, notFound], label: /NÃO CONFERE/ },
      { rereads: [new Error("t1"), new Error("t2"), notFound], label: /NÃO CONFIRMADA/ },
      { rereads: [{ ...SCHEDULED, status: "draft", send_at: null }, notFound], label: /NÃO CONFIRMADA/ },
    ];
    for (const c of cases) {
      const { root, paths } = setupRoot();
      const k = kitDeps({ rereads: c.rereads });
      await assert.rejects(run(root, k.deps), (e: Error) => {
        assert.ok(e instanceof StackEmailIncidentError && e.cancelled, e.message);
        assert.match(e.message, c.label);
        assert.match(e.message, /CANCELADO \(exclusão conferida\)/);
        return true;
      });
      assert.deepEqual(k.deleted, [901]);
      assert.ok(!existsSync(paths.publishedPath));
    }
  });

  it("DELETE ok mas o broadcast continua lá: incidente (não cancelado), registro `cancel-failed`", async () => {
    const { root, paths } = setupRoot();
    const k = kitDeps({ rereads: [{ ...SCHEDULED, subscriber_filter: [{ all: [] }] }] });
    await assert.rejects(run(root, k.deps), (e: Error) => {
      assert.ok(e instanceof StackEmailIncidentError && !e.cancelled);
      assert.match(e.message, /continua existindo/);
      assert.match(e.message, /Cancele AGORA/);
      return true;
    });
    assert.equal(record(paths).status, "cancel-failed");
  });

  it("DELETE falhando e registro sem gravar: a mensagem diz as duas coisas", async () => {
    const { root } = setupRoot();
    const k = kitDeps({
      rereads: [{ ...SCHEDULED, subscriber_filter: [{ all: [] }] }],
      deleteThrows: true,
      writeThrowsOn: (c) => c.includes("cancel-failed"),
    });
    await assert.rejects(run(root, k.deps), /DELETE falhou[\s\S]*registro do ciclo também não foi gravado/);
  });

  it("--force por cima de `sent` e cancelado: o registro do envio anterior volta", async () => {
    const { root, paths } = setupRoot();
    await run(root, kitDeps().deps);
    const before = readFileSync(paths.publishedPath, "utf8");
    const k = kitDeps({ rereads: [{ ...SCHEDULED, subscriber_filter: [{ all: [] }] }, notFound] });
    await assert.rejects(run(root, k.deps, { force: true }), /CANCELADO/);
    assert.equal(readFileSync(paths.publishedPath, "utf8"), before);
  });

  it("registro final sem gravar: incidente que diz que o e-mail VAI sair, `pending` fica", async () => {
    const { root, paths } = setupRoot();
    const k = kitDeps({ writeThrowsOn: (c) => c.includes('"sent"') });
    await assert.rejects(run(root, k.deps), (e: Error) => e instanceof StackEmailIncidentError && /VAI sair/.test(e.message));
    assert.equal(record(paths).status, "pending");
    assert.equal(k.deleted.length, 0);
  });

  it("já enviado responde antes das travas de conteúdo (seleção editada ou canal desligado depois)", async () => {
    const { root } = setupRoot();
    await run(root, kitDeps().deps);
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ kit_stack: { audience_tag: "apoio-stack" }, circle_stack: { enabled: false } }));
    assert.equal((await run(root, kitDeps().deps)).kind, "ja-enviado");
  });

  it("erro de leitura da tag no Kit ou seleção inválida: guard (nada criado), não incidente", async () => {
    const { root } = setupRoot();
    const k = kitDeps();
    k.deps.findTagId = async () => {
      throw new KitApiError("/tags", 503, "fora");
    };
    await assert.rejects(run(root, k.deps), (e: Error) => e instanceof StackEmailGuardError && /conferir a audiência/.test(e.message));
    const bad = setupRoot();
    writeFileSync(bad.paths.selectionPath, "{");
    await assert.rejects(run(bad.root, kitDeps().deps), StackEmailGuardError);
  });

  it("--force por cima de `sent`: o `pending` guarda o registro anterior em `previous`", async () => {
    const { root, paths } = setupRoot();
    await run(root, kitDeps().deps);
    const before = readFileSync(paths.publishedPath, "utf8");
    await assert.rejects(run(root, kitDeps({ createThrows: true }).deps, { force: true }), StackEmailIncidentError);
    const rec = record(paths);
    assert.equal(rec.status, "pending");
    assert.equal(rec.previous, before);
  });

  it("--force por cima de registro ambíguo e cancelado: mantém o ambíguo e a mensagem pede --force", async () => {
    const { root, paths } = setupRoot();
    writeFileSync(paths.publishedPath, JSON.stringify({ status: "pending", cycle: CYCLE, attemptedAt: "x" }));
    const before = readFileSync(paths.publishedPath, "utf8");
    const k = kitDeps({ rereads: [{ ...SCHEDULED, subscriber_filter: [{ all: [] }] }, notFound] });
    await assert.rejects(run(root, k.deps, { force: true }), /CANCELADO[\s\S]*rode de novo com --force/);
    assert.equal(readFileSync(paths.publishedPath, "utf8"), before);
  });

  it("verifyStackEmailReread exige filtro E agendamento", () => {
    assert.equal(verifyStackEmailReread(SCHEDULED, 42).verified, true);
    assert.equal(verifyStackEmailReread({ ...SCHEDULED, subscriber_filter: buildTagFilter(7) }, 42).verified, false);
    assert.equal(verifyStackEmailReread({ ...SCHEDULED, send_at: null }, 42).verified, null);
    assert.equal(verifyStackEmailReread({ subscriber_filter: buildTagFilter(42) }, 42).verified, null);
  });
});

// ── task de segunda ────────────────────────────────────────────────────────

describe("classifyStackEmailRun e o aviso ao editor (#12538)", () => {
  const sent = { status: "sent" as const, broadcastId: 7, sendAt: "2026-11-09T09:05:00.000Z" };
  it("mapeia resultado e erros nos desfechos", async () => {
    assert.equal((await classifyStackEmailRun(async () => ({ kind: "enviado", record: sent as never }))).kind, "enviado");
    assert.equal((await classifyStackEmailRun(async () => ({ kind: "ja-enviado", record: sent as never }))).kind, "ja-enviado");
    assert.equal((await classifyStackEmailRun(async () => { throw new StackEmailGuardError("tag"); })).kind, "recusado");
    assert.equal((await classifyStackEmailRun(async () => { throw new StackEmailIncidentError("x", 1, true); })).kind, "cancelado");
    assert.equal((await classifyStackEmailRun(async () => { throw new StackEmailIncidentError("x", 1); })).kind, "incidente");
    assert.equal((await classifyStackEmailRun(async () => { throw new Error("rede"); })).kind, "incidente");
  });

  it("registro ambíguo na execução real vira incidente, nunca 'não saiu'", async () => {
    const root = mkdtempSync(join(tmpdir(), "stack-email-amb-"));
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ kit_stack: { audience_tag: "apoio-stack" } }));
    const paths = resolveStackEmailPaths(root, MONDAY);
    mkdirSync(join(paths.selectionPath, ".."), { recursive: true });
    writeFileSync(paths.selectionPath, JSON.stringify(selection()));
    writeFileSync(paths.publishedPath, JSON.stringify({ status: "pending", cycle: CYCLE, attemptedAt: "x" }));
    const o = await classifyStackEmailRun(() =>
      runCircleStackEmail({ rootDir: root, dataRoot: root, publishMonday: MONDAY, mode: { kind: "send", force: false }, log: () => {} }),
    );
    assert.equal(o.kind, "incidente");
  });

  const base = { subject: "Radar de Notícias Stack 26w45: Publicado", body: "Nada a fazer." };
  it("enviado/já enviado: assunto intacto, horário em BRT no fim", () => {
    const e = appendStackEmailOutcome(base, { kind: "enviado", broadcastId: 7, sendAt: sent.sendAt }, MONDAY);
    assert.equal(e.subject, base.subject);
    assert.match(e.body, /^Nada a fazer\.[\s\S]*agendado para 09\/11 06:05 BRT \(broadcast 7\)/);
    assert.match(appendStackEmailOutcome(base, { kind: "ja-enviado", broadcastId: 7, sendAt: sent.sendAt }, MONDAY).body, /já tinha saído/);
  });
  it("recusado/cancelado: assunto marcado, desfecho no topo, comando sem --force", () => {
    for (const kind of ["recusado", "cancelado"] as const) {
      const e = appendStackEmailOutcome(base, { kind, reason: "tag vazia" }, MONDAY);
      assert.match(e.subject, /e-mail Núcleo: não saiu$/);
      assert.match(e.body, /^E-mail aos apoiadores Núcleo \(Kit\): NÃO SAIU/);
      assert.match(e.body, /--send/);
      assert.ok(!e.body.includes("--force"));
    }
  });
  it("incidente: assunto INCIDENTE, manda conferir o Kit antes de reexecutar", () => {
    const e = appendStackEmailOutcome(base, { kind: "incidente", reason: "timeout no POST" }, MONDAY);
    assert.match(e.subject, /INCIDENTE$/);
    assert.match(e.body, /^E-mail aos apoiadores Núcleo \(Kit\): INCIDENTE[\s\S]*Não reexecute antes de conferir/);
  });
});

describe("task de segunda envia o e-mail Núcleo (#12538)", () => {
  const mondayAt6 = () => new Date(2026, 10, 9, 6, 0, 0);
  const tuesdayAt6 = () => new Date(2026, 10, 10, 6, 0, 0);
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

  function deps(paths: ReturnType<typeof resolveCyclePaths>, circleOk: boolean, outcome: StackEmailOutcome | null) {
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
        ...(outcome
          ? {
              runStackEmail: async (p: { publishMonday: string }) => {
                emailCalls.push(p.publishMonday);
                return outcome;
              },
            }
          : {}),
      },
    };
  }

  it("ciclo aprovado: Circle e e-mail, exit 0", async () => {
    const paths = setupCycle(true);
    const h = deps(paths, true, { kind: "enviado", broadcastId: 77, sendAt: "2026-11-09T09:05:00.000Z" });
    const res = await runScheduledCircleStackPublish(paths, h.d);
    assert.equal(res.outcome.kind, "publicado");
    assert.deepEqual(h.emailCalls, [MONDAY]);
    assert.match(h.emails[0].body, /broadcast 77/);
    assert.equal(res.exitCode, 0);
  });

  it("e-mail sai mesmo se o Circle falhou por erro de entrega", async () => {
    const paths = setupCycle(true);
    const h = deps(paths, false, { kind: "enviado", broadcastId: 78, sendAt: "x" });
    const res = await runScheduledCircleStackPublish(paths, h.d);
    assert.equal(res.outcome.kind, "falhou");
    assert.equal(h.emailCalls.length, 1);
  });

  it("já enviado antes (Passo 7): exit 0, sem alarme", async () => {
    const paths = setupCycle(true);
    const h = deps(paths, true, { kind: "ja-enviado", broadcastId: 5, sendAt: "2026-11-08T12:00:00.000Z" });
    const res = await runScheduledCircleStackPublish(paths, h.d);
    assert.equal(res.exitCode, 0);
    assert.ok(!/não saiu|INCIDENTE/.test(h.emails[0].subject));
  });

  it("sem aprovação ou fora da janela: nem Circle nem e-mail, e o aviso diz que o e-mail também não saiu", async () => {
    for (const now of [mondayAt6, tuesdayAt6]) {
      const paths = setupCycle(now === tuesdayAt6);
      const h = deps(paths, true, { kind: "enviado", broadcastId: 1, sendAt: "x" });
      const res = await runScheduledCircleStackPublish(paths, { ...h.d, now });
      assert.equal(res.outcome.kind, "nao-enviado");
      assert.equal(h.emailCalls.length, 0);
      assert.deepEqual(res.stackEmail, { kind: "nao-tentado" });
      assert.match(h.emails[0].body, /também não saiu/);
      assert.equal(res.exitCode, 0);
    }
  });

  it("canal não ligado (sem runStackEmail): nada sobre e-mail no aviso", async () => {
    const paths = setupCycle(true);
    const h = deps(paths, true, null);
    const res = await runScheduledCircleStackPublish(paths, h.d);
    assert.equal(res.stackEmail, null);
    assert.ok(!h.emails[0].body.includes("Núcleo"));
  });

  it("falha do e-mail: exit 1 e assunto marcado, mesmo com o Circle publicado", async () => {
    const paths = setupCycle(true);
    const h = deps(paths, true, { kind: "recusado", reason: 'tag "apoio-stack" não existe no Kit' });
    const res = await runScheduledCircleStackPublish(paths, h.d);
    assert.equal(res.outcome.kind, "publicado");
    assert.equal(res.exitCode, 1);
    assert.match(h.emails[0].subject, /Publicado · e-mail Núcleo: não saiu$/);
    assert.match(h.emails[0].body, /^E-mail aos apoiadores Núcleo[\s\S]*apoio-stack" não existe/);
  });
});
