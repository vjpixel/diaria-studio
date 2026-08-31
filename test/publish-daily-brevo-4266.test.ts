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
  checkSubjectNotEmpty,
  buildDailyBrevoHtml,
  checkBrevoDiariaGuards,
  checkPollTokenGuards,
  checkContactCountReconciliation,
  checkSendTestGuards,
  resolveSendTestRecipient,
  resolvePublicImagesPath,
  stripGreetingAndSupporterBlocks,
} from "../scripts/publish-daily-brevo.ts";
import type { NewsletterContent } from "../scripts/lib/newsletter-parse.ts";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    assert.equal(buildDailyBrevoSubject(fixtureContent), "Modelos se replicam sozinhos");
  });

  it("preview text é o subtítulo", () => {
    assert.equal(buildDailyBrevoPreviewText(fixtureContent), "E o que isso muda pra você");
  });
});

describe("checkSubjectNotEmpty — guard contra assunto vazio (#4588)", () => {
  it("assunto não-vazio → ok", () => {
    assert.deepEqual(checkSubjectNotEmpty("Modelos se replicam sozinhos"), { ok: true });
  });

  it("assunto vazio ('') → not ok, motivo cita content.title em branco", () => {
    const result = checkSubjectNotEmpty("");
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /assunto vazio/i);
  });

  it("assunto só com whitespace ('   ') → not ok (trim antes de checar)", () => {
    const result = checkSubjectNotEmpty("   ");
    assert.equal(result.ok, false);
  });

  it("buildDailyBrevoSubject com content.title vazio → checkSubjectNotEmpty pega o defeito (integração das 2 funções puras)", () => {
    const emptyTitleContent = { ...fixtureContent, title: "" };
    const subject = buildDailyBrevoSubject(emptyTitleContent);
    assert.equal(checkSubjectNotEmpty(subject).ok, false);
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

describe("checkDailySendCap — freio de VOLUME removido (#6793 Faixa A, item 5)", () => {
  it("dentro do cap (líquido dos seeds default) → ok", () => {
    assert.deepEqual(checkDailySendCap(250, 300), { ok: true });
  });

  it("bruto acima do cap, mas líquido dos seeds default (5) exatamente no cap → ok (inclusivo)", () => {
    assert.deepEqual(checkDailySendCap(305, 300), { ok: true });
  });

  it("#6793: acima do cap histórico → NÃO bloqueia mais — guard de volume desativado (piso de estado impossível segue intacto)", () => {
    const result = checkDailySendCap(306, 300);
    assert.deepEqual(result, { ok: true });
  });

  it("seedCount explícito (compat/teste sem depender de EDITOR_SEED_EMAILS) → 301 bruto, 0 seeds, cap 300 → ok (#6793)", () => {
    const result = checkDailySendCap(301, 300, 0);
    assert.deepEqual(result, { ok: true });
  });

  it("seedCount explícito → 301 bruto, 1 seed, cap 300 → ok (líquido 300)", () => {
    assert.deepEqual(checkDailySendCap(301, 300, 1), { ok: true });
  });

  it("#6793: lista MUITO acima do cap (ex: 10x) → ainda ok, sem teto de volume", () => {
    assert.deepEqual(checkDailySendCap(3000, 300), { ok: true });
  });
});

describe("checkDailySendCap — exclui EDITOR_SEED_EMAILS do denominador (#4631, #6793: cap não bloqueia mais, mas o piso de estado impossível segue igual)", () => {
  it("reproduz o incidente 260804: lista Brevo com 179 assinantes, cap 175 → ok (líquido dos 5 seeds = 174)", () => {
    // Antes do #4631: checkDailySendCap(179, 175) abortava com "acima do cap
    // diário (175)" mesmo com a fila real (`in_brevo` no store) batendo
    // exatamente 175 — os 5 EDITOR_SEED_EMAILS (nunca rastreados no store,
    // mas permanentemente vinculados à lista) infestavam o bruto da API.
    // Desde #6793, o cap nem bloquearia mais de qualquer forma — este teste
    // fica como regressão do PISO (totalSubscribers >= seedCount), que segue
    // intacto.
    assert.deepEqual(checkDailySendCap(179, 175), { ok: true });
  });

  it("#6793: 179 bruto, cap 173 (fila real de 174 excederia o cap líquido histórico) → ok, cap não bloqueia mais", () => {
    const result = checkDailySendCap(179, 173);
    assert.deepEqual(result, { ok: true });
  });
});

describe("checkDailySendCap — piso contra totalSubscribers < seedCount (achado convergente silent-failure-hunter + type-design-analyzer, PR #4646)", () => {
  it("totalSubscribers (4) abaixo de seedCount default (5) → not ok, NUNCA passa por 'líquido negativo <= cap'", () => {
    const result = checkDailySendCap(4, 300);
    assert.equal(result.ok, false);
    const reason = (result as { ok: false; reason: string }).reason;
    assert.match(reason, /4/);
    assert.match(reason, /5/);
    assert.match(reason, /impossível/i);
  });

  it("totalSubscribers (0) com seedCount explícito (1) → not ok (mesmo guard vale com seedCount parametrizado)", () => {
    const result = checkDailySendCap(0, 300, 1);
    assert.equal(result.ok, false);
  });

  it("totalSubscribers exatamente igual a seedCount (5) → ok (líquido 0, dentro de qualquer cap não-negativo) — o piso é só '<', não '<='", () => {
    assert.deepEqual(checkDailySendCap(5, 300), { ok: true });
  });

  it("seedCount 0 (compat) → guard nunca dispara pra totalSubscribers >= 0", () => {
    assert.deepEqual(checkDailySendCap(0, 300, 0), { ok: true });
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

describe("checkSendTestGuards — guards de --send-test/--send-test-to (#5086)", () => {
  it("--send-test ausente → ok independente de --send-test-to/test_email (n/a)", () => {
    assert.deepEqual(
      checkSendTestGuards({ sendTest: false, sendTestTo: undefined, testEmail: undefined }),
      { ok: true },
    );
  });

  it("--send-test-to sem --send-test → not ok, motivo cita a dependência", () => {
    const result = checkSendTestGuards({ sendTest: false, sendTestTo: "a@b.com", testEmail: null });
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /--send-test-to requer --send-test/);
  });

  it("--send-test com --send-test-to em formato inválido → not ok", () => {
    const result = checkSendTestGuards({ sendTest: true, sendTestTo: "não-é-email", testEmail: null });
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /--send-test-to inválido/);
  });

  it("--send-test sem --send-test-to e sem brevo_diaria.test_email → not ok, motivo explica as 2 formas de resolver", () => {
    const result = checkSendTestGuards({ sendTest: true, sendTestTo: undefined, testEmail: null });
    assert.equal(result.ok, false);
    const reason = (result as { ok: false; reason: string }).reason;
    assert.match(reason, /--send-test-to/);
    assert.match(reason, /brevo_diaria\.test_email/);
  });

  it("--send-test sem brevo_diaria.test_email configurado (undefined, não só null) → not ok", () => {
    const result = checkSendTestGuards({ sendTest: true, sendTestTo: undefined, testEmail: undefined });
    assert.equal(result.ok, false);
  });

  it("--send-test com --send-test-to válido, sem test_email configurado → ok (flag basta)", () => {
    assert.deepEqual(
      checkSendTestGuards({ sendTest: true, sendTestTo: "editor@example.com", testEmail: undefined }),
      { ok: true },
    );
  });

  it("--send-test sem --send-test-to, mas com brevo_diaria.test_email configurado → ok (fallback)", () => {
    assert.deepEqual(
      checkSendTestGuards({ sendTest: true, sendTestTo: undefined, testEmail: "vjpixel@gmail.com" }),
      { ok: true },
    );
  });
});

describe("resolveSendTestRecipient — prioridade --send-test-to > brevo_diaria.test_email (#5086)", () => {
  it("--send-test-to presente → usa ele, mesmo com test_email também presente", () => {
    assert.equal(resolveSendTestRecipient("override@example.com", "default@example.com"), "override@example.com");
  });

  it("--send-test-to ausente → cai pro test_email", () => {
    assert.equal(resolveSendTestRecipient(undefined, "default@example.com"), "default@example.com");
  });

  it("nenhum dos dois definido → lança (contrato violado — checkSendTestGuards deveria ter abortado antes)", () => {
    assert.throws(() => resolveSendTestRecipient(undefined, null), /checkSendTestGuards deveria ter abortado/);
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
    assert.match(html, /\{\{ contact\.POLL_TOKEN \}\}%40vote\.eia\.diaria\.local/, "usa merge tag Brevo do token opaco, @ percent-encoded (esp brevo, #4517/#4692)");
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

describe("publish-daily-brevo.ts exit semantics (#4651, mesma classe do #4638/#1401)", () => {
  // Regressão: process.exit(N) chamado DEPOIS de um await fetch
  // (brevoGetList/injectPollTokenBrevo/brevoPost) derruba o processo no
  // Windows com UV_HANDLE_CLOSING enquanto o fetch agent ainda tem sockets
  // keep-alive abertos (mesma classe já corrigida em verify-scheduled-post.ts
  // pro #4638). Fix: process.exitCode + return nos branches PÓS-await (cap
  // excedido, credenciais de token ausentes, falha de injeção, divergência de
  // reconciliação) e no catch handler do isMainModule(). Os branches
  // PRÉ-await (args ausentes, guard de config, assunto vazio) ficam como
  // process.exit() de propósito — nenhum fetch rodou ainda nesses pontos.
  const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "publish-daily-brevo.ts");

  function readMainAndCatchBodies(): { mainBody: string; catchBody: string } {
    const source = readFileSync(SCRIPT, "utf8");
    const sourceNoComments = source.replace(/\/\/.*$/gm, "");
    const mainMatch = sourceNoComments.match(/async function main\([^)]*\)[^{]*\{[\s\S]*?\n\}\n\nif \(isMainModule/);
    assert.ok(mainMatch, "main() não encontrada em publish-daily-brevo.ts");
    const catchMatch = sourceNoComments.match(/if \(isMainModule\(import\.meta\.url\)\) \{[\s\S]*?\n\}\n?$/);
    assert.ok(catchMatch, "bloco isMainModule() não encontrado em publish-daily-brevo.ts");
    return { mainBody: mainMatch[0], catchBody: catchMatch[0] };
  }

  it("branches pós-await (exit 3/4/5/6) usam process.exitCode, não process.exit (#4651)", () => {
    const { mainBody } = readMainAndCatchBodies();
    for (const code of [3, 4, 5, 6]) {
      assert.equal(
        new RegExp(`process\\.exit\\(${code}\\)`).test(mainBody),
        false,
        `process.exit(${code}) não deveria mais existir em main() — usar process.exitCode (#4651 Windows crash)`,
      );
      assert.match(
        mainBody,
        new RegExp(`process\\.exitCode = ${code}`),
        `process.exitCode = ${code} deveria existir no branch pós-await correspondente`,
      );
    }
  });

  it("branches pré-await (exit 1/2/7 — args, config, assunto vazio) continuam com process.exit — sem risco libuv (#4651)", () => {
    // Positive control: nenhum await fetch rodou ainda nestes pontos, então
    // manter process.exit() ali é seguro e intencional.
    const { mainBody } = readMainAndCatchBodies();
    for (const code of [1, 2, 7]) {
      assert.match(
        mainBody,
        new RegExp(`process\\.exit\\(${code}\\)`),
        `process.exit(${code}) deveria continuar existindo (guard pré-await, seguro)`,
      );
    }
  });

  it("catch handler do isMainModule() usa process.exitCode, não process.exit (#4651)", () => {
    const { catchBody } = readMainAndCatchBodies();
    assert.equal(
      /process\.exit\s*\(/.test(catchBody),
      false,
      "catch de main() não pode chamar process.exit() — usar process.exitCode (#4651 Windows crash)",
    );
    assert.match(catchBody, /process\.exitCode/, "catch de main() deve setar process.exitCode");
  });
});
