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
  checkBrevoDiariaGuards,
  checkPollTokenGuards,
  checkContactCountReconciliation,
  resolvePublicImagesPath,
  stripGreetingAndSupporterBlocks,
} from "../scripts/publish-daily-brevo.ts";
import type { NewsletterContent } from "../scripts/lib/newsletter-parse.ts";
import { resolve } from "node:path";

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
    assert.equal(buildDailyBrevoSubject(fixtureContent), "diar.ia.br — Modelos se replicam sozinhos");
  });

  it("preview text é o subtítulo", () => {
    assert.equal(buildDailyBrevoPreviewText(fixtureContent), "E o que isso muda pra você");
  });
});

describe("resolvePublicImagesPath — raiz da edição, não _internal/ (achado 260803)", () => {
  it("resolve pra 06-public-images.json na raiz da edição", () => {
    const editionDir = resolve("data/editions/2608/260803");
    assert.equal(resolvePublicImagesPath(editionDir), resolve(editionDir, "06-public-images.json"));
  });

  it("nunca aponta pra dentro de _internal/ (regressão: main() apontava lá, deixando toda imagem unresolved mesmo com 06-public-images.json presente e populado)", () => {
    const editionDir = resolve("data/editions/2608/260803");
    assert.doesNotMatch(resolvePublicImagesPath(editionDir), /_internal/);
  });
});

describe("stripGreetingAndSupporterBlocks — achado 260803 (revisão do editor no 1º rascunho)", () => {
  it("zera coverageLine, coverageLineTrailer e introCallout (saudação pessoal + agradecimento a apoiadores)", () => {
    const content = {
      ...fixtureContent,
      coverageLine: "Olá! Eu sou o Pixel, editor desta newsletter...",
      coverageLineTrailer: "algum trailer",
      introCallout: "**Agradeço à nova apoiadora: **Fulana**...**",
    } as unknown as NewsletterContent;
    const stripped = stripGreetingAndSupporterBlocks(content);
    assert.equal(stripped.coverageLine, null);
    assert.equal(stripped.coverageLineTrailer, null);
    assert.equal(stripped.introCallout, null);
  });

  it("preserva o resto do conteúdo intacto (destaques, eia, título)", () => {
    const stripped = stripGreetingAndSupporterBlocks(fixtureContent);
    assert.equal(stripped.title, fixtureContent.title);
    assert.deepEqual(stripped.destaques, fixtureContent.destaques);
    assert.deepEqual(stripped.eia, fixtureContent.eia);
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

describe("checkBrevoDiariaGuards — pré-condições fora de --dry-run (#4404)", () => {
  const validBrevoDiaria = {
    api_key_env: "BREVO_DIARIA_API_KEY",
    list_id: 42,
    sender_email: "editor@diar.ia.br",
    sender_name: "diar.ia.br",
    daily_send_cap: 300,
  };

  it("--dry-run: nenhum guard bloqueia mesmo com tudo ausente (só brevo_diaria precisa existir)", () => {
    assert.deepEqual(
      checkBrevoDiariaGuards({ dryRun: true, brevoDiaria: { ...validBrevoDiaria, list_id: null, sender_email: null }, apiKey: undefined }),
      { ok: true },
    );
  });

  it("brevo_diaria ausente → not ok, mesmo em --dry-run", () => {
    const result = checkBrevoDiariaGuards({ dryRun: true, brevoDiaria: undefined, apiKey: undefined });
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /brevo_diaria não configurado/);
  });

  it("fora de --dry-run com list_id null → not ok (guard existente)", () => {
    const result = checkBrevoDiariaGuards({
      dryRun: false,
      brevoDiaria: { ...validBrevoDiaria, list_id: null },
      apiKey: "key",
    });
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /brevo_diaria\.list_id não definido/);
  });

  it("fora de --dry-run com sender_email null → not ok, erro explícito (#4404 — antes caía no erro genérico da API Brevo)", () => {
    const result = checkBrevoDiariaGuards({
      dryRun: false,
      brevoDiaria: { ...validBrevoDiaria, sender_email: null },
      apiKey: "key",
    });
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /brevo_diaria\.sender_email não definido/);
  });

  it("fora de --dry-run com API key ausente do ambiente → not ok (guard existente)", () => {
    const result = checkBrevoDiariaGuards({ dryRun: false, brevoDiaria: validBrevoDiaria, apiKey: undefined });
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /BREVO_DIARIA_API_KEY não definido no ambiente/);
  });

  it("fora de --dry-run com tudo presente → ok", () => {
    assert.deepEqual(
      checkBrevoDiariaGuards({ dryRun: false, brevoDiaria: validBrevoDiaria, apiKey: "key" }),
      { ok: true },
    );
  });
});

describe("checkPollTokenGuards — credenciais pra injeção do token opaco de voto (#4517)", () => {
  const valid = {
    pollSecret: "secret",
    cloudflareAccountId: "acct",
    cloudflareWorkersToken: "wtoken",
  };

  it("tudo presente → ok", () => {
    assert.deepEqual(checkPollTokenGuards(valid), { ok: true });
  });

  it("POLL_SECRET ausente → not ok, motivo explica que é pra popular o token opaco de voto", () => {
    const result = checkPollTokenGuards({ ...valid, pollSecret: undefined });
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /POLL_SECRET não definido/);
    assert.match((result as { ok: false; reason: string }).reason, /token opaco de voto/);
  });

  it("CLOUDFLARE_ACCOUNT_ID ausente → not ok", () => {
    const result = checkPollTokenGuards({ ...valid, cloudflareAccountId: undefined });
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /CLOUDFLARE_ACCOUNT_ID não definido/);
  });

  it("CLOUDFLARE_WORKERS_TOKEN ausente → not ok", () => {
    const result = checkPollTokenGuards({ ...valid, cloudflareWorkersToken: undefined });
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /CLOUDFLARE_WORKERS_TOKEN não definido/);
  });
});

describe("checkContactCountReconciliation — reconciliação enumeração×lista (#4532, achado HIGH)", () => {
  it("total_contacts igual a listTotalSubscribers → ok", () => {
    assert.deepEqual(checkContactCountReconciliation(104, 104), { ok: true });
  });

  it("total_contacts maior que listTotalSubscribers (lista cresceu entre as 2 chamadas) → ok", () => {
    assert.deepEqual(checkContactCountReconciliation(110, 104), { ok: true });
  });

  it("total_contacts === 0 mas a lista reporta assinantes → not ok, motivo cita os 2 números e o endpoint", () => {
    const result = checkContactCountReconciliation(0, 104);
    assert.equal(result.ok, false);
    const reason = (result as { ok: false; reason: string }).reason;
    assert.match(reason, /0 contato\(s\)/);
    assert.match(reason, /104 assinante\(s\)/);
    assert.match(reason, /brevoGetList/);
  });

  it("total_contacts positivo mas abaixo de listTotalSubscribers (enumeração parcial) → not ok", () => {
    const result = checkContactCountReconciliation(80, 104);
    assert.equal(result.ok, false);
    const reason = (result as { ok: false; reason: string }).reason;
    assert.match(reason, /80 contato\(s\)/);
    assert.match(reason, /104 assinante\(s\)/);
  });

  it("ambos 0 (lista genuinamente vazia) → ok, não é divergência", () => {
    assert.deepEqual(checkContactCountReconciliation(0, 0), { ok: true });
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
    assert.match(html, /\{\{ contact\.POLL_TOKEN \}\}@vote\.eia\.diaria\.local/, "usa merge tag Brevo do token opaco (esp brevo, #4517)");
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
