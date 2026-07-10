/**
 * test/video-youtube-resolve.test.ts (#3202)
 *
 * Regressão: itens da seção VÍDEOS devem sempre linkar pro YouTube. Quando o
 * editor indica um vídeo fora do YouTube (ex: página oficial da empresa que
 * embeda o player), o pipeline deve buscar o equivalente no YouTube e
 * substituir a URL — mas NUNCA fabricar/adivinhar a URL: sem candidato
 * confiável, o item fica flagado pro gate, não republicado com a URL errada.
 *
 * Caso real (260709): "Introducing GPT-Live" só existia acessível na página
 * oficial da OpenAI (bloqueava o bot, 403) — sem resolução automática, a URL
 * oficial acabou reusada, duplicando o link de outro destaque, até o editor
 * colar manualmente `youtu.be/EAN5Cj347PY`.
 *
 * A busca em si (discovery-searcher/WebSearch scoped a site:youtube.com) é
 * disparada pelo orchestrator (não testável aqui sem rede) — estes testes
 * mockam a camada de busca (`candidates`), exercitando só a lógica pura e
 * determinística de match/substituição/flag.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isYoutubeUrl,
  pickBestYoutubeCandidate,
  resolveVideoArticle,
  resolveVideoBucket,
  YOUTUBE_MATCH_THRESHOLD,
  type VideoSearchCandidate,
} from "../scripts/lib/video-youtube-resolve.ts";

// ---------------------------------------------------------------------------
// isYoutubeUrl
// ---------------------------------------------------------------------------

describe("isYoutubeUrl", () => {
  it("aceita youtube.com/watch", () => {
    assert.equal(isYoutubeUrl("https://www.youtube.com/watch?v=EAN5Cj347PY"), true);
    assert.equal(isYoutubeUrl("https://youtube.com/watch?v=EAN5Cj347PY"), true);
  });

  it("aceita youtu.be", () => {
    assert.equal(isYoutubeUrl("https://youtu.be/EAN5Cj347PY"), true);
  });

  // #3273 REGRESSÃO: isYoutubeUrl só aceitava youtube.com/watch e youtu.be —
  // rejeitava m.youtube.com, /live/{id} e /shorts/{id}. Irônico: o caso
  // motivador da feature #3202 ("Introducing GPT-Live", 260709) era
  // justamente uma LIVESTREAM, cuja URL canônica do YouTube usa /live/{id}
  // — pickBestYoutubeCandidate descartava o match perfeito ANTES de pontuar
  // por similaridade de título, flagando video_url_unverified mesmo com
  // candidato disponível.
  it("#3273: aceita youtube.com/live/{id} (livestream — caso motivador #3202)", () => {
    assert.equal(isYoutubeUrl("https://www.youtube.com/live/EAN5Cj347PY"), true);
    assert.equal(isYoutubeUrl("https://youtube.com/live/EAN5Cj347PY"), true);
  });

  it("#3273: aceita youtube.com/shorts/{id}", () => {
    assert.equal(isYoutubeUrl("https://www.youtube.com/shorts/EAN5Cj347PY"), true);
  });

  it("#3273: aceita host m.youtube.com (mobile) pra /watch, /live/ e /shorts/", () => {
    assert.equal(isYoutubeUrl("https://m.youtube.com/watch?v=EAN5Cj347PY"), true);
    assert.equal(isYoutubeUrl("https://m.youtube.com/live/EAN5Cj347PY"), true);
    assert.equal(isYoutubeUrl("https://m.youtube.com/shorts/EAN5Cj347PY"), true);
  });

  it("rejeita a página oficial da empresa que embeda o vídeo (caso real 260709)", () => {
    assert.equal(isYoutubeUrl("https://openai.com/index/introducing-gpt-live/"), false);
  });

  it("rejeita vimeo.com (a regra #3202 é especificamente YouTube)", () => {
    assert.equal(isYoutubeUrl("https://vimeo.com/123456"), false);
  });

  it("rejeita youtube.com sem /watch (ex: /channel/, homepage)", () => {
    assert.equal(isYoutubeUrl("https://www.youtube.com/@OpenAI"), false);
  });

  it("rejeita URL inválida sem lançar", () => {
    assert.equal(isYoutubeUrl("not-a-url"), false);
  });
});

// ---------------------------------------------------------------------------
// pickBestYoutubeCandidate — camada de busca MOCKADA
// ---------------------------------------------------------------------------

describe("pickBestYoutubeCandidate (busca mockada)", () => {
  it("escolhe o candidato YouTube com título mais similar, acima do threshold", () => {
    const candidates: VideoSearchCandidate[] = [
      { url: "https://www.youtube.com/watch?v=EAN5Cj347PY", title: "Introducing GPT-Live | OpenAI" },
      { url: "https://www.youtube.com/watch?v=other1", title: "OpenAI DevDay 2026 Keynote" },
    ];
    const result = pickBestYoutubeCandidate("Introducing GPT-Live", candidates);
    assert.equal(result.matched, true);
    if (result.matched) {
      assert.equal(result.url, "https://www.youtube.com/watch?v=EAN5Cj347PY");
      assert.ok(result.score >= YOUTUBE_MATCH_THRESHOLD);
    }
  });

  it("ignora candidatos fora de youtube.com mesmo com título idêntico", () => {
    const candidates: VideoSearchCandidate[] = [
      { url: "https://vimeo.com/999", title: "Introducing GPT-Live" },
      { url: "https://openai.com/index/introducing-gpt-live/", title: "Introducing GPT-Live" },
    ];
    const result = pickBestYoutubeCandidate("Introducing GPT-Live", candidates);
    assert.equal(result.matched, false);
    if (!result.matched) {
      assert.match(result.reason, /nenhum candidato retornado está em youtube/);
    }
  });

  it("sem match confiável quando o melhor score fica abaixo do threshold", () => {
    const candidates: VideoSearchCandidate[] = [
      { url: "https://www.youtube.com/watch?v=random1", title: "Uma live totalmente aleatória sobre gatos" },
    ];
    const result = pickBestYoutubeCandidate("Introducing GPT-Live", candidates);
    assert.equal(result.matched, false);
    if (!result.matched) {
      assert.match(result.reason, /threshold/);
      assert.ok(result.bestScore! < YOUTUBE_MATCH_THRESHOLD);
    }
  });

  it("#3273: REGRESSÃO — escolhe candidato em formato /live/{id} (livestream, caso motivador #3202)", () => {
    const candidates: VideoSearchCandidate[] = [
      { url: "https://www.youtube.com/live/EAN5Cj347PY", title: "Introducing GPT-Live | OpenAI" },
    ];
    const result = pickBestYoutubeCandidate("Introducing GPT-Live", candidates);
    assert.equal(result.matched, true);
    if (result.matched) {
      assert.equal(result.url, "https://www.youtube.com/live/EAN5Cj347PY");
    }
  });

  it("sem candidatos nenhum → matched false com motivo 'busca não retornou nada'", () => {
    const result = pickBestYoutubeCandidate("Introducing GPT-Live", []);
    assert.equal(result.matched, false);
    if (!result.matched) {
      assert.match(result.reason, /não retornou nenhum candidato/);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveVideoArticle — substituição / flag em UM artigo
// ---------------------------------------------------------------------------

describe("resolveVideoArticle", () => {
  it("no-op quando o artigo já é YouTube", () => {
    const article = {
      url: "https://youtu.be/EAN5Cj347PY",
      title: "Introducing GPT-Live",
    };
    const result = resolveVideoArticle(article, []);
    assert.equal(result.url, "https://youtu.be/EAN5Cj347PY");
    assert.equal(result.video_url_resolved, undefined);
    assert.equal(result.video_url_unverified, undefined);
  });

  it("REGRESSÃO #3202: substitui URL não-YouTube quando a busca mockada retorna match confiável", () => {
    // Reproduz o caso real: artigo com a URL da página oficial da OpenAI
    // (bloqueia o bot, 403) — busca mockada retorna o vídeo real no YouTube.
    const article = {
      url: "https://openai.com/index/introducing-gpt-live/",
      title: "Introducing GPT-Live",
    };
    const candidates: VideoSearchCandidate[] = [
      { url: "https://youtu.be/EAN5Cj347PY", title: "Introducing GPT-Live | OpenAI", source_name: "OpenAI" },
    ];
    const result = resolveVideoArticle(article, candidates);
    assert.equal(result.url, "https://youtu.be/EAN5Cj347PY");
    assert.ok(result.video_url_resolved);
    assert.equal(result.video_url_resolved!.from, "https://openai.com/index/introducing-gpt-live/");
    assert.equal(result.video_url_resolved!.to, "https://youtu.be/EAN5Cj347PY");
    assert.equal(result.video_url_unverified, undefined);
    // Não muta o artigo original (pure)
    assert.equal(article.url, "https://openai.com/index/introducing-gpt-live/");
  });

  it("REGRESSÃO #3202: sem match confiável, flaga o item em vez de manter a URL não-YouTube", () => {
    const article = {
      url: "https://openai.com/index/introducing-gpt-live/",
      title: "Introducing GPT-Live",
    };
    // Busca mockada não retorna nada relevante (simula falha/ausência de resultado)
    const result = resolveVideoArticle(article, []);
    // Nunca fabrica/mantém a URL não-YouTube silenciosamente como se fosse ok:
    assert.equal(result.video_url_unverified, true);
    assert.ok(result.video_url_search_reason);
    assert.equal(result.video_url_resolved, undefined);
    // A URL original é preservada pro editor ver de onde veio (não é sobrescrita
    // com nada fabricado) — mas fica marcada como não-verificada.
    assert.equal(result.url, "https://openai.com/index/introducing-gpt-live/");
  });

  it("nunca emite uma URL youtube-shaped que não veio de um candidato real da busca", () => {
    // Guarda de não-fabricação: mesmo com um candidato de baixa confiança
    // presente, se ele não bate o threshold a URL final NUNCA é trocada por
    // ele nem por qualquer string youtube.com/youtu.be inventada.
    const article = { url: "https://openai.com/index/introducing-gpt-live/", title: "Introducing GPT-Live" };
    const lowConfidenceCandidate: VideoSearchCandidate[] = [
      { url: "https://www.youtube.com/watch?v=irrelevant", title: "Vídeo totalmente sem relação" },
    ];
    const result = resolveVideoArticle(article, lowConfidenceCandidate);
    assert.equal(result.video_url_unverified, true);
    assert.equal(result.url, "https://openai.com/index/introducing-gpt-live/");
    assert.notEqual(result.url, "https://www.youtube.com/watch?v=irrelevant");
  });
});

// ---------------------------------------------------------------------------
// resolveVideoBucket — bucket inteiro
// ---------------------------------------------------------------------------

describe("resolveVideoBucket", () => {
  it("processa múltiplos itens: já-youtube, resolvido, flagado", () => {
    const bucket = [
      { url: "https://youtu.be/already", title: "Já é YouTube" },
      { url: "https://openai.com/index/introducing-gpt-live/", title: "Introducing GPT-Live" },
      { url: "https://blog.example.com/live", title: "Live sem correspondência" },
    ];
    const searchResultsByUrl: Record<string, VideoSearchCandidate[]> = {
      "https://openai.com/index/introducing-gpt-live/": [
        { url: "https://youtu.be/EAN5Cj347PY", title: "Introducing GPT-Live | OpenAI" },
      ],
      // "https://blog.example.com/live" ausente do mapa — sem candidatos.
    };

    const result = resolveVideoBucket(bucket, searchResultsByUrl);

    assert.equal(result.alreadyYoutube, 1);
    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].to, "https://youtu.be/EAN5Cj347PY");
    assert.equal(result.flagged.length, 1);
    assert.equal(result.flagged[0].url, "https://blog.example.com/live");
    assert.equal(result.articles.length, 3);
    assert.equal(result.articles[1].url, "https://youtu.be/EAN5Cj347PY");
    assert.equal(result.articles[2].video_url_unverified, true);
  });

  it("bucket vazio → resultado vazio, sem erro", () => {
    const result = resolveVideoBucket([], {});
    assert.deepEqual(result.articles, []);
    assert.deepEqual(result.resolved, []);
    assert.deepEqual(result.flagged, []);
    assert.equal(result.alreadyYoutube, 0);
  });
});
