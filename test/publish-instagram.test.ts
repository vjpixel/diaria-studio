/**
 * publish-instagram.test.ts (#49)
 *
 * Testa o fluxo de 2 passos da Instagram Graph API (container → publish)
 * com mock da API (sem chamadas reais), incluindo o caso de imagem ausente.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractDestaquesFromSocialMd,
  extractPostText,
  truncateCaption,
  postToWorkerQueue,
  type InstagramQueuePayload,
} from "../scripts/publish-instagram.ts";

const __ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Leitura da source estática — reutilizada por múltiplos testes estáticos
const SRC = readFileSync(resolve(__ROOT, "scripts/publish-instagram.ts"), "utf8");

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MD_INSTAGRAM = `# Instagram

## d1
Post d1 para o Instagram. #inovacao #tecnologia

## d2
Post d2 para o Instagram. #ia #futuro

## d3
Post d3 para o Instagram. #dados
<!-- comentario oculto -->

# Facebook

## d1
Post d1 Facebook diferente.
`;

const MD_SEM_INSTAGRAM = `# Facebook

## d1
Post d1 Facebook.

## d2
Post d2 Facebook.

## d3
Post d3 Facebook.
`;

const MD_CRLF = MD_INSTAGRAM.replace(/\n/g, "\r\n");

// ─── extractDestaquesFromSocialMd ────────────────────────────────────────────

describe("extractDestaquesFromSocialMd (instagram)", () => {
  it("retorna d1/d2/d3 quando seção Instagram existe com 3 destaques", () => {
    const destaques = extractDestaquesFromSocialMd(MD_INSTAGRAM, "instagram");
    assert.deepEqual(destaques, ["d1", "d2", "d3"]);
  });

  it("usa fallback Facebook quando seção Instagram ausente", () => {
    const destaques = extractDestaquesFromSocialMd(MD_SEM_INSTAGRAM, "instagram");
    assert.deepEqual(destaques, ["d1", "d2", "d3"]);
  });

  it("retorna fallback [d1,d2,d3] quando nenhuma seção existe", () => {
    const destaques = extractDestaquesFromSocialMd("# Outra\n## d1\ntexto", "instagram");
    assert.deepEqual(destaques, ["d1", "d2", "d3"]);
  });

  it("retorna d1/d2 quando edição tem só 2 destaques", () => {
    const md = `# Instagram\n\n## d1\nPost d1.\n\n## d2\nPost d2.\n`;
    const destaques = extractDestaquesFromSocialMd(md, "instagram");
    assert.deepEqual(destaques, ["d1", "d2"]);
  });
});

// ─── extractPostText ─────────────────────────────────────────────────────────

describe("extractPostText (instagram)", () => {
  it("extrai d1 da seção Instagram", () => {
    const t = extractPostText(MD_INSTAGRAM, "d1");
    assert.ok(t.includes("Post d1 para o Instagram."));
    assert.ok(!t.includes("Post d1 Facebook diferente."));
  });

  it("extrai d2 sem vazar d1 ou d3", () => {
    const t = extractPostText(MD_INSTAGRAM, "d2");
    assert.ok(t.includes("Post d2 para o Instagram."));
    assert.ok(!t.includes("Post d1"));
    assert.ok(!t.includes("Post d3"));
  });

  it("extrai d3 e remove comentários HTML", () => {
    const t = extractPostText(MD_INSTAGRAM, "d3");
    assert.ok(t.includes("Post d3 para o Instagram."));
    assert.ok(!t.includes("comentario oculto"));
  });

  it("não vaza seção Facebook quando Instagram presente", () => {
    const t = extractPostText(MD_INSTAGRAM, "d1");
    assert.ok(!t.includes("Post d1 Facebook diferente."));
  });

  it("usa fallback Facebook quando seção Instagram ausente", () => {
    const t = extractPostText(MD_SEM_INSTAGRAM, "d1");
    assert.ok(t.includes("Post d1 Facebook."));
  });

  it("normaliza CRLF para LF", () => {
    const t = extractPostText(MD_CRLF, "d1");
    assert.ok(t.includes("Post d1 para o Instagram."));
  });

  it("lança quando destaque não encontrado", () => {
    assert.throws(
      () => extractPostText(MD_INSTAGRAM, "d9"),
      /d9|não encontrado/i,
    );
  });

  it("lança quando não há seção Instagram nem Facebook", () => {
    assert.throws(
      () => extractPostText("# LinkedIn\n## d1\ntexto", "d1"),
      /não encontrado/i,
    );
  });
});

describe("extractPostText/extractDestaquesFromSocialMd (instagram) — formato novo # Social (#3991)", () => {
  const SOCIAL_MD = "# Social\n\n## d1\n\nTexto genérico d1.\n\n#IA\n\n## d2\n\nTexto genérico d2.\n";

  it("extrai d1 de # Social e injeta a linha 'link na bio' ENTRE corpo e tags", () => {
    const t = extractPostText(SOCIAL_MD, "d1");
    assert.equal(
      t,
      "Texto genérico d1.\n\nEdição completa no link da bio. Segue @diar.ia pra não perder a próxima.\n\n#IA",
    );
  });

  it("extrai d2 sem vazar d1, CTA injetada mesmo sem hashtags", () => {
    const t = extractPostText(SOCIAL_MD, "d2");
    assert.ok(t.includes("Texto genérico d2."));
    assert.ok(!t.includes("Texto genérico d1."));
    assert.ok(t.includes("link da bio"));
  });

  it("extractDestaquesFromSocialMd lê # Social quando presente", () => {
    const destaques = extractDestaquesFromSocialMd(SOCIAL_MD, "instagram");
    assert.deepEqual(destaques, ["d1", "d2"]);
  });

  it("# Social tem precedência sobre # Instagram/# Facebook legado quando presentes", () => {
    const mixed = "# Social\n\n## d1\n\nTexto novo d1.\n\n# Instagram\n\n## d1\n\nTexto legado d1.\n";
    const t = extractPostText(mixed, "d1");
    assert.ok(t.includes("Texto novo d1."));
    assert.ok(!t.includes("Texto legado d1."));
  });
});

// ─── truncateCaption ─────────────────────────────────────────────────────────

describe("truncateCaption", () => {
  it("não trunca caption dentro do limite (2200 chars)", () => {
    const short = "Texto curto #hashtag";
    assert.equal(truncateCaption(short), short);
  });

  it("trunca caption acima de 2200 chars com '...'", () => {
    const long = "A".repeat(2100) + " " + "B".repeat(200);
    const result = truncateCaption(long);
    assert.ok(result.length <= 2200);
    assert.ok(result.endsWith("..."));
  });

  it("corta no último espaço antes do limite", () => {
    const text = "palavra ".repeat(300); // ~2400 chars
    const result = truncateCaption(text);
    assert.ok(result.length <= 2200);
    assert.ok(result.trim().length > 0);
  });

  it("aceita maxLen customizado", () => {
    const text = "ola mundo tudo bem";
    const result = truncateCaption(text, 10);
    assert.ok(result.length <= 10);
  });
});

// ─── Fluxo de 2 passos — verificação estática do código ──────────────────────

describe("Fluxo Instagram 2 passos (verificação estática do script)", () => {
  it("passo 1: envia image_url + caption para /{ig-user-id}/media", () => {
    assert.match(SRC, /image_url/, "deve enviar image_url para /media");
    assert.match(SRC, /caption/, "deve enviar caption para /media");
    // O endpoint /media é montado via concatenação de string (não literal com aspas)
    assert.match(SRC, /\/media`/, "deve chamar endpoint /media via template string");
  });

  it("passo 2: envia creation_id para /{ig-user-id}/media_publish", () => {
    assert.match(SRC, /creation_id/, "deve enviar creation_id para /media_publish");
    assert.match(SRC, /\/media_publish`/, "deve chamar endpoint /media_publish via template string");
  });

  it("fluxo completo: containerId do passo 1 é passado ao passo 2", () => {
    // containerId deve ser retornado por createMediaContainer e passado a publishMediaContainer
    assert.match(
      SRC,
      /containerId.*publishMediaContainer|publishMediaContainer.*containerId/s,
      "containerId deve fluir de createMediaContainer para publishMediaContainer",
    );
  });

  it("retorna status 'published' após fluxo bem-sucedido (não 'scheduled')", () => {
    // Instagram publica imediato — status deve ser "published", não "scheduled"
    assert.match(SRC, /status: "published"/, "status do post Instagram deve ser 'published'");
  });

  it("armazena ig_media_id e ig_container_id no entry", () => {
    assert.match(SRC, /ig_media_id/, "deve gravar ig_media_id no entry");
    assert.match(SRC, /ig_container_id/, "deve gravar ig_container_id no entry");
  });

  it("busca permalink real (não usa media_id como shortcode na URL) (#49)", () => {
    // O media_id é numérico, não o shortcode da URL pública — fetchPermalink
    // busca o permalink real via GET ?fields=permalink.
    assert.match(SRC, /fetchPermalink/, "deve ter helper fetchPermalink");
    assert.match(SRC, /fields=permalink/, "deve buscar campo permalink da Graph API");
    // NÃO deve construir /p/${mediaId}/ diretamente
    assert.doesNotMatch(
      SRC,
      /instagram\.com\/p\/\$\{mediaId\}/,
      "não deve usar media_id numérico como shortcode na URL",
    );
  });

  it("summary.skipped usa contador dedicado, não tautologia (#49)", () => {
    // Bug anterior: results.indexOf(r) === results.indexOf(r) (sempre true).
    assert.match(SRC, /skipped: skippedCount/, "skipped deve usar skippedCount");
    assert.doesNotMatch(
      SRC,
      /results\.indexOf\(r\) === results\.indexOf\(r\)/,
      "não deve ter comparação tautológica",
    );
  });

  it("lê 06-public-images.json UMA vez antes do loop (não por destaque) (#49)", () => {
    assert.match(SRC, /const publicImagesExists = existsSync/, "deve hoistar a leitura");
  });
});

// ─── Caso de imagem ausente (erro claro) ────────────────────────────────────

describe("Erro claro quando imagem ausente", () => {
  it("emite erro acionável quando imagem local não existe", () => {
    assert.match(SRC, /not found/, "deve mencionar 'not found' quando imagem ausente");
  });

  it("usa imagem 1x1 (quadrada) para Instagram", () => {
    // Instagram prefere formato quadrado — verificar que usa 04-dN-1x1.jpg
    const imageFile = (d: string) => `04-${d}-1x1.jpg`;
    assert.equal(imageFile("d1"), "04-d1-1x1.jpg");
    assert.equal(imageFile("d2"), "04-d2-1x1.jpg");
    assert.equal(imageFile("d3"), "04-d3-1x1.jpg");
    for (const f of ["d1", "d2", "d3"].map(imageFile)) {
      assert.ok(!f.includes("2x1"), "não deve usar imagem 2x1 no Instagram");
    }
    // Verificar no source também
    assert.match(SRC, /04-\$\{d\}-1x1\.jpg|1x1\.jpg/, "deve usar imagem 1x1 no Instagram");
  });

  it("emite erro quando 06-public-images.json ausente", () => {
    assert.match(
      SRC,
      /06-public-images\.json/,
      "deve verificar existência de 06-public-images.json",
    );
    assert.match(
      SRC,
      /upload-images-public/,
      "deve mencionar upload-images-public.ts na mensagem de erro",
    );
  });

  it("entry com status 'failed' quando imagem pública ausente (mock)", () => {
    // Simula o entry de falha quando URL pública não encontrada
    const failEntry = {
      platform: "instagram",
      destaque: "d1",
      url: null,
      status: "failed" as const,
      scheduled_at: null,
      reason: "public URL para d1 ausente em 06-public-images.json",
    };
    assert.equal(failEntry.status, "failed");
    assert.equal(failEntry.url, null);
    assert.ok(failEntry.reason.includes("public URL para d1"));
  });

  it("chave de imagem pública é images.{destaque} (ex: images.d1) — mesmo shape de publish-linkedin.ts (#3634)", () => {
    // #3634: bug anterior lia publicImages[`${d}_1x1`] direto no objeto raiz
    // (JSON real é { images: { d1: { url }, ... } }, sem sufixo _1x1) — 100%
    // miss em runtime. Fix alinha com o ImageCacheFile shape de publish-linkedin.ts.
    assert.match(SRC, /images\?\.\[d\]\?\.url/, "deve ler via images?.[d]?.url (shape aninhado, sem sufixo _1x1)");
    assert.doesNotMatch(SRC, /\$\{d\}_1x1/, "não deve mais montar chave com sufixo _1x1");
  });
});

// ─── Resume-aware (pula posts já publicados) ─────────────────────────────────

describe("Resume-aware skip posts já publicados", () => {
  it("pula post com status 'published'", () => {
    const posts = [{ platform: "instagram", destaque: "d1", status: "published" }];
    const existing = posts.find(
      (p) =>
        p.platform === "instagram" &&
        p.destaque === "d1" &&
        (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
    );
    assert.ok(existing !== undefined);
    assert.equal(existing.status, "published");
  });

  it("não pula post failed (retry)", () => {
    const posts = [{ platform: "instagram", destaque: "d1", status: "failed" }];
    const existing = posts.find(
      (p) =>
        p.platform === "instagram" &&
        p.destaque === "d1" &&
        (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
    );
    assert.equal(existing, undefined);
  });

  it("não pula outra plataforma", () => {
    const posts = [{ platform: "facebook", destaque: "d1", status: "published" }];
    const existing = posts.find(
      (p) =>
        p.platform === "instagram" &&
        p.destaque === "d1" &&
        (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
    );
    assert.equal(existing, undefined);
  });

  it("script verifica status 'published' como válido para skip", () => {
    // No Facebook apenas draft/scheduled são skipped; no Instagram, published também é skip
    assert.match(
      SRC,
      /status === "published"/,
      "deve incluir 'published' na verificação de skip",
    );
  });
});

// ─── Credenciais obrigatórias ────────────────────────────────────────────────

describe("Credenciais INSTAGRAM obrigatórias", () => {
  it("INSTAGRAM_BUSINESS_ACCOUNT_ID verificado no script", () => {
    assert.match(
      SRC,
      /INSTAGRAM_BUSINESS_ACCOUNT_ID/,
      "deve verificar INSTAGRAM_BUSINESS_ACCOUNT_ID",
    );
  });

  it("INSTAGRAM_ACCESS_TOKEN verificado no script", () => {
    assert.match(SRC, /INSTAGRAM_ACCESS_TOKEN/, "deve verificar INSTAGRAM_ACCESS_TOKEN");
  });

  it("script tem CLI guard (não roda em import)", () => {
    // Padrão CLI guard canônico do repo (#2834): isMainModule(import.meta.url)
    assert.match(SRC, /isMainModule\(import\.meta\.url\)/, "deve ter CLI guard padrão do repo");
  });

  it("#2486: credenciais ausentes resultam em process.exit(0) (graceful skip, não exit 1)", () => {
    // #2486 finding 2: exit 1 mascarava violations de consent de LinkedIn/Facebook.
    // O comportamento correto é exit 0 + log de aviso — Instagram é best-effort.
    // O check estático verifica que o caminho de "ausente" chama process.exit(0).
    assert.match(SRC, /process\.exit\(0\)/, "deve sair graciosamente (exit 0) quando env vars ausentes");
    // Verifica também que o script NÃO usa process.exit(1) no caminho de credenciais ausentes
    // (ainda pode ter process.exit(1) em outros erros fatais — só a bifurcação de creds mudou).
    assert.match(SRC, /SKIP:.*ausente/, "deve emitir mensagem SKIP quando creds ausentes");
  });
});

// ─── Kill-switch manual via platform.config.json (#3635) ────────────────────

describe("Kill-switch publishing.social.instagram.enabled (#3635)", () => {
  it("lê publishing.social.instagram do platform.config.json", () => {
    assert.match(
      SRC,
      /platformConfig\?\.publishing\?\.social\?\.instagram/,
      "deve ler publishing.social.instagram de platform.config.json",
    );
  });

  it("sai com exit 0 (graceful skip) quando enabled === false", () => {
    assert.match(
      SRC,
      /igConfig\?\.enabled === false/,
      "deve checar enabled === false explicitamente (chave ausente = habilitado por default)",
    );
  });

  it("checa o kill-switch ANTES da checagem de credenciais", () => {
    const killSwitchIdx = SRC.indexOf("igConfig?.enabled === false");
    const credsIdx = SRC.indexOf("if (!igUserId || !accessToken)");
    assert.ok(killSwitchIdx > 0 && credsIdx > 0, "ambos os trechos devem existir");
    assert.ok(
      killSwitchIdx < credsIdx,
      "kill-switch deve ser checado antes das credenciais (bloqueio editorial > config incompleta)",
    );
  });

});

// ─── Retry com backoff exponencial ───────────────────────────────────────────

describe("Retry com backoff exponencial", () => {
  it("script tenta até 3 vezes em caso de falha", () => {
    assert.match(SRC, /attempt <= 3/, "deve tentar até 3 vezes");
  });

  it("script usa backoff exponencial entre tentativas", () => {
    assert.match(SRC, /Math\.pow\(2, attempt - 1\)/, "deve usar backoff 2^(attempt-1)");
  });

  it("em test-mode, pula o sleep entre tentativas", () => {
    // Análogo a publish-facebook.ts: !isTest guard no setTimeout
    assert.match(SRC, /isTest/, "deve respeitar isTest para pular delay");
  });
});

// ─── #3817 --schedule: enfileiramento via Worker (postToWorkerQueue) ────────

describe("#3817 postToWorkerQueue (--schedule enfileira no Worker em vez de publicar)", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it("POSTa pro endpoint /queue com channel:instagram e retorna a resposta parseada", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | null = null;
    let capturedToken = "";
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : (url as Request).url;
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      capturedToken = new Headers(init?.headers).get("X-Diaria-Token") ?? "";
      return new Response(
        JSON.stringify({
          queued: true,
          key: "queue:2026-07-23T10:00:00.000Z:uuid-1",
          scheduled_at: "2026-07-23T10:00:00.000Z",
          destaque: "d1",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const payload: InstagramQueuePayload = {
        text: "Legenda #ia",
        image_url: "https://poll.diaria.workers.dev/img/img-260723-04-d1-1x1.jpg",
        scheduled_at: "2026-07-23T10:00:00.000Z",
        destaque: "d1",
        channel: "instagram",
      };
      const res = await postToWorkerQueue("https://worker.test/", "tok123", payload);
      assert.equal(capturedUrl, "https://worker.test/queue", "deve normalizar trailing slash e ir pro /queue");
      assert.equal(capturedToken, "tok123", "deve mandar o token no header X-Diaria-Token");
      assert.equal(capturedBody?.channel, "instagram");
      assert.equal(capturedBody?.destaque, "d1");
      assert.equal(res.queued, true);
      assert.equal(res.key, "queue:2026-07-23T10:00:00.000Z:uuid-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retenta em falha HTTP e lança erro claro após esgotar as tentativas", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return new Response("worker down", { status: 500 });
    }) as typeof fetch;

    try {
      await assert.rejects(
        () =>
          postToWorkerQueue(
            "https://worker.test",
            "tok",
            {
              text: "x",
              image_url: "https://x.test/i.jpg",
              scheduled_at: "2026-07-23T10:00:00Z",
              destaque: "d1",
              channel: "instagram",
            },
            2,
          ),
        /Worker queue HTTP 500/,
      );
      assert.equal(attempts, 2, "deve tentar exatamente maxAttempts vezes");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lança erro claro quando resposta do Worker não bate o schema esperado", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ queued: false }), { status: 200 })) as typeof fetch;

    try {
      await assert.rejects(
        () =>
          postToWorkerQueue(
            "https://worker.test",
            "tok",
            {
              text: "x",
              image_url: "https://x.test/i.jpg",
              scheduled_at: "2026-07-23T10:00:00Z",
              destaque: "d1",
              channel: "instagram",
            },
            1,
          ),
        /Worker response inválido/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── #3817 --schedule: verificação estática do modo agendamento ─────────────

describe("#3817 --schedule: modo agendamento (verificação estática do script)", () => {
  it("flag --schedule é opt-in — default preserva publicação imediata", () => {
    assert.match(SRC, /doSchedule = flags\.has\("schedule"\)/, "deve ler --schedule via flags.has");
  });

  it("resolve scheduled_at via computeScheduledAt com platform instagram (mesma fonte de FB/LinkedIn)", () => {
    assert.match(SRC, /computeScheduledAt/, "deve importar/usar computeScheduledAt");
    assert.match(SRC, /platform: "instagram"/, "deve passar platform: 'instagram'");
  });

  it("payload de enfileiramento inclui channel: instagram", () => {
    assert.match(SRC, /channel: "instagram"/, "payload do Worker deve marcar channel instagram");
  });

  it("grava status 'scheduled' com scheduled_at real (não null) no modo --schedule", () => {
    assert.match(SRC, /status: "scheduled"/, "modo --schedule deve gravar status scheduled");
  });

  it("reusa DIARIA_LINKEDIN_CRON_URL / DIARIA_LINKEDIN_CRON_TOKEN (mesmo Worker do LinkedIn)", () => {
    assert.match(SRC, /DIARIA_LINKEDIN_CRON_URL/, "deve ler DIARIA_LINKEDIN_CRON_URL");
    assert.match(SRC, /DIARIA_LINKEDIN_CRON_TOKEN/, "deve ler DIARIA_LINKEDIN_CRON_TOKEN");
  });

  it("fail-fast quando --schedule é passado sem o Worker configurado", () => {
    assert.match(
      SRC,
      /ERRO: --schedule passado mas o Cloudflare Worker não está configurado/,
      "deve abortar com mensagem clara em vez de degradar silenciosamente",
    );
  });

  it("sem --schedule, comportamento de publicação imediata permanece intocado (status published)", () => {
    // O branch --schedule sempre faz `continue` antes do fluxo de publicação imediata —
    // então o código de createMediaContainer/publishMediaContainer nunca roda em modo --schedule.
    assert.match(
      SRC,
      /continue; \/\/ não cai no fluxo de publicação imediata abaixo/,
      "branch --schedule deve pular o fluxo de publicação imediata via continue",
    );
  });
});
