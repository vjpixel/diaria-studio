/**
 * test/publish-daily-brevo-4266.test.ts (#4266)
 *
 * Publisher fino do canal Brevo próprio do editor: assunto/preview
 * derivados, cap de envio (guard de segurança, não rotação de ondas) e
 * montagem do HTML final — inclusive o guard que recusa montar sem o bloco
 * de intro obrigatório do segmento Pending.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDailyBrevoSubject,
  buildDailyBrevoPreviewText,
  checkDailySendCap,
  buildDailyBrevoHtml,
} from "../scripts/publish-daily-brevo.ts";
import type { NewsletterContent } from "../scripts/lib/newsletter-parse.ts";

const baseDestaque = {
  n: 1 as const,
  category: "RISCO",
  title: "Modelos se replicam sozinhos",
  body: "Parágrafo 1.\nParágrafo 2.",
  why: "Por que importa.",
  url: "https://example.com/d1",
  emoji: "⚠️",
  imageFile: "04-d1-2x1.jpg",
};

const fixtureContent = {
  title: "Modelos se replicam sozinhos",
  subtitle: "E o que isso muda pra você",
  coverImage: "04-d1-2x1.jpg",
  destaques: [baseDestaque],
  eia: {
    credit: "Foto: Author / CC BY-SA 4.0.",
    imageA: "01-eia-A.jpg",
    imageB: "01-eia-B.jpg",
    edition: "260999",
  },
  sections: [],
} as unknown as NewsletterContent;

describe("buildDailyBrevoSubject / buildDailyBrevoPreviewText — #4266", () => {
  it("assunto deriva do título do D1", () => {
    assert.equal(buildDailyBrevoSubject(fixtureContent), "Diar.ia — Modelos se replicam sozinhos");
  });

  it("preview text é o subtítulo", () => {
    assert.equal(buildDailyBrevoPreviewText(fixtureContent), "E o que isso muda pra você");
  });
});

describe("checkDailySendCap — guard de segurança, não rotação (#4266)", () => {
  it("dentro do cap → ok", () => {
    assert.deepEqual(checkDailySendCap(250, 300), { ok: true });
  });

  it("exatamente no cap → ok (inclusivo)", () => {
    assert.deepEqual(checkDailySendCap(300, 300), { ok: true });
  });

  it("acima do cap → not ok, motivo explica que não há rotação de ondas", () => {
    const result = checkDailySendCap(301, 300);
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /301/);
    assert.match((result as { ok: false; reason: string }).reason, /rotação por ondas/);
  });
});

describe("buildDailyBrevoHtml — guard do bloco de intro obrigatório (#4266 item 5)", () => {
  it("introHtml null → lança (nunca monta sem a explicação de compliance)", () => {
    assert.throws(
      () => buildDailyBrevoHtml(fixtureContent, {}, null),
      /bloco de intro do segmento Pending ausente/,
    );
  });

  it("introHtml vazio (string vazia) → lança (mesmo guard, falsy)", () => {
    assert.throws(() => buildDailyBrevoHtml(fixtureContent, {}, ""), /bloco de intro do segmento Pending ausente/);
  });

  it("com introHtml presente: monta HTML com merge tag Brevo, sem placeholders de imagem sem match reportando unresolved", () => {
    const { html, unresolvedImages } = buildDailyBrevoHtml(
      fixtureContent,
      {
        images: {
          d1: { file_id: "f1", url: "https://cdn.example.com/d1.jpg", filename: "04-d1-2x1.jpg" },
          eiaA: { file_id: "f2", url: "https://cdn.example.com/eia-a.jpg", filename: "01-eia-A.jpg" },
          eiaB: { file_id: "f3", url: "https://cdn.example.com/eia-b.jpg", filename: "01-eia-B.jpg" },
        },
      },
      "<div>INTRO OBRIGATÓRIA</div>",
    );
    assert.match(html, /\{\{ contact\.EMAIL \}\}/, "usa merge tag Brevo (esp brevo)");
    assert.match(html, /INTRO OBRIGATÓRIA/, "intro injetada no HTML");
    assert.match(html, /https:\/\/cdn\.example\.com\/d1\.jpg/, "placeholder de imagem substituído");
    assert.deepEqual(unresolvedImages, []);
  });

  it("placeholder de imagem sem match no mapa → reporta em unresolvedImages (não lança)", () => {
    const { unresolvedImages } = buildDailyBrevoHtml(fixtureContent, {}, "<div>INTRO</div>");
    assert.ok(unresolvedImages.length > 0, "sem mapa de imagens, todo {{IMG:...}} do fixture deve ficar unresolved");
    assert.ok(unresolvedImages.includes("04-d1-2x1.jpg"), `esperava 04-d1-2x1.jpg em ${JSON.stringify(unresolvedImages)}`);
  });
});
