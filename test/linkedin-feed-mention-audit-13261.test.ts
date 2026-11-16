/**
 * test/linkedin-feed-mention-audit-13261.test.ts (#13261)
 *
 * Regressão: no ciclo de 16/11/2026 o post de feed do artigo semanal do
 * LinkedIn saiu com "@diar.ia.br" em texto puro (o passo manual da #13049 foi
 * pulado) e o LinkedIn auto-linkou para o site. Nada detectava: o texto
 * entregue é o mesmo com ou sem a menção real. Os casos abaixo reproduzem o
 * incidente (texto puro, link para o site) e o caminho certo (menção
 * escolhida na lista). Só arquivos temporários.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  auditFeedPostMention,
  feedPostWantsMention,
  FEED_MENTION_DOM_SNIPPET,
  type FeedMentionTarget,
} from "../scripts/lib/linkedin-feed-mention-audit.ts";
import {
  FEED_POST_MENTION_REL,
  loadMentionTarget,
  MentionAuditInputError,
  parseDomJson,
  runMentionAudit,
} from "../scripts/weekly-feed-post-mention-audit.ts";
import { feedPostPath } from "../scripts/lib/weekly-feed-post-review.ts";

const TARGET: FeedMentionTarget = { name: "diar.ia.br", urn: "urn:li:organization:110742958" };
const SOURCE =
  "As três saíram na @diar.ia.br, a newsletter de IA que escrevo e mando por e-mail todo dia útil.\n\n#InteligenciaArtificial\n";

describe("feedPostWantsMention (#13261)", () => {
  it("acha o @nome seguido de pontuação", () => {
    assert.equal(feedPostWantsMention(SOURCE, "diar.ia.br"), true);
    assert.equal(feedPostWantsMention("saiu na @diar.ia.br.", "diar.ia.br"), true);
  });
  it("não confunde com nome sem @ nem com nome mais longo", () => {
    assert.equal(feedPostWantsMention("saiu na diar.ia.br, leia", "diar.ia.br"), false);
    assert.equal(feedPostWantsMention("saiu na @diar.ia.brasil", "diar.ia.br"), false);
  });
});

describe("auditFeedPostMention (#13261)", () => {
  it("incidente: @diar.ia.br colado em texto puro reprova", () => {
    const r = auditFeedPostMention({ sourceText: SOURCE, dom: { text: SOURCE, anchors: [], mentions: [] }, target: TARGET });
    assert.equal(r.ok, false);
    assert.equal(r.status, "plain-text");
    assert.match(r.message, /lista de menções/);
  });

  it("incidente no post publicado: diar.ia.br virou link para o site", () => {
    const r = auditFeedPostMention({
      sourceText: SOURCE,
      dom: { text: SOURCE.replace("@diar.ia.br", "diar.ia.br"), anchors: [{ text: "diar.ia.br", base: "http://diar.ia.br/" }] },
      target: TARGET,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, "site-link");
  });

  it("link encurtado lnkd.in também reprova", () => {
    const r = auditFeedPostMention({
      sourceText: SOURCE,
      dom: { text: "na diar.ia.br", anchors: [{ text: "diar.ia.br", base: "https://lnkd.in/abc" }] },
      target: TARGET,
    });
    assert.equal(r.status, "site-link");
  });

  it("menção escolhida na lista (elemento de menção) aprova", () => {
    const r = auditFeedPostMention({
      sourceText: SOURCE,
      dom: { text: SOURCE.replace("@diar.ia.br", "diar.ia.br"), mentions: [{ text: "diar.ia.br", urn: null }] },
      target: TARGET,
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, "mention");
  });

  it("menção pelo URN da organização aprova mesmo com outro texto", () => {
    const r = auditFeedPostMention({
      sourceText: SOURCE,
      dom: { text: "na diar.ia.br", mentions: [{ text: "", urn: "urn:li:organization:110742958" }] },
      target: TARGET,
    });
    assert.equal(r.status, "mention");
  });

  it("post publicado com link para a página da empresa aprova", () => {
    const r = auditFeedPostMention({
      sourceText: SOURCE,
      dom: { text: "na diar.ia.br", anchors: [{ text: "diar.ia.br", base: "https://www.linkedin.com/company/diar.ia.br/" }] },
      target: TARGET,
    });
    assert.equal(r.status, "mention");
  });

  it("nome sem @ e sem sinal de menção no DOM fica unverified (reprova)", () => {
    const r = auditFeedPostMention({ sourceText: SOURCE, dom: { text: "na diar.ia.br, a newsletter" }, target: TARGET });
    assert.equal(r.ok, false);
    assert.equal(r.status, "unverified");
  });

  it("nome apagado do post reprova como missing", () => {
    const r = auditFeedPostMention({ sourceText: SOURCE, dom: { text: "As três saíram na , a newsletter" }, target: TARGET });
    assert.equal(r.status, "missing");
  });

  it("texto revisado sem @nome: nada a conferir", () => {
    const r = auditFeedPostMention({ sourceText: "sem menção", dom: { text: "sem menção" }, target: TARGET });
    assert.equal(r.ok, true);
    assert.equal(r.status, "not-needed");
  });
});

describe("snippet e CLI (#13261)", () => {
  it("snippet devolve texto, âncoras sem query e elementos de menção", () => {
    assert.match(FEED_MENTION_DOM_SNIPPET, /\[role="dialog"\] \[contenteditable="true"\]/);
    assert.match(FEED_MENTION_DOM_SNIPPET, /u\.origin \+ u\.pathname/);
    assert.match(FEED_MENTION_DOM_SNIPPET, /data-entity-urn/);
  });

  it("parseDomJson aceita a string JSON aninhada do javascript_tool e recusa o erro do snippet", () => {
    const inner = JSON.stringify({ text: "x", anchors: [], mentions: [] });
    assert.equal(parseDomJson(JSON.stringify(inner)).text, "x");
    assert.throws(() => parseDomJson(JSON.stringify({ error: "campo do post nao encontrado" })), MentionAuditInputError);
    assert.throws(() => parseDomJson("{}"), MentionAuditInputError);
  });

  it("loadMentionTarget lê nome e URN da página do platform.config.json real", () => {
    const t = loadMentionTarget(resolve(import.meta.dirname, "..", "platform.config.json"));
    assert.equal(t.name, "diar.ia.br");
    assert.match(t.urn ?? "", /^urn:li:organization:\d+$/);
  });

  it("runMentionAudit grava o resultado e reprova o texto puro do incidente", () => {
    const dir = mkdtempSync(join(tmpdir(), "mention-13261-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(feedPostPath(dir), SOURCE);
      const dom = join(dir, "dom.json");
      writeFileSync(dom, JSON.stringify({ text: SOURCE, anchors: [], mentions: [] }));
      const r = runMentionAudit({ cycleDir: dir, domJsonPath: dom, target: TARGET, now: new Date("2026-11-16T12:00:00Z") });
      assert.equal(r.status, "plain-text");
      const saved = JSON.parse(readFileSync(join(dir, FEED_POST_MENTION_REL), "utf8"));
      assert.equal(saved.ok, false);
      assert.equal(saved.em, "2026-11-16T12:00:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runMentionAudit sem o texto revisado recusa com erro de entrada", () => {
    const dir = mkdtempSync(join(tmpdir(), "mention-13261-"));
    try {
      assert.throws(
        () => runMentionAudit({ cycleDir: dir, domJsonPath: join(dir, "x.json"), target: TARGET, now: new Date() }),
        MentionAuditInputError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
