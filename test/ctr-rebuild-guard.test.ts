/**
 * test/ctr-rebuild-guard.test.ts (#4836)
 *
 * Regressão do dano irreversível: `build-link-ctr.ts --full` rodado sobre um
 * cache degradado reescrevia `data/link-ctr-table.csv` com MENOS cliques do que
 * ele já continha, silenciosamente e reportando sucesso.
 *
 * O caso `reproduz o incidente de 05/ago` abaixo é o teste que teria barrado a
 * perda dos 109 cliques em 22 edições.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assessClickLoss,
  parseClickCountsFromCsv,
  formatClickLossAbort,
  formatUntrustedCsvAbort,
  editionKey,
  ALLOW_CLICK_LOSS_FLAG,
  type ClickCountRow,
} from "../scripts/lib/shared/ctr-rebuild-guard.ts";

const row = (date: string, title: string, clicks: number): ClickCountRow => ({
  date,
  post_title: title,
  unique_verified_clicks: clicks,
});

describe("assessClickLoss", () => {
  it("aprova quando o rebuild preserva todos os cliques", () => {
    const antes = [row("2026-05-01", "A", 3), row("2026-05-02", "B", 5)];
    const depois = [row("2026-05-01", "A", 3), row("2026-05-02", "B", 5)];

    const r = assessClickLoss(antes, depois);

    assert.equal(r.safe, true);
    assert.equal(r.totalBefore, 8);
    assert.equal(r.totalAfter, 8);
    assert.equal(r.totalDelta, 0);
    assert.deepEqual(r.editionsLosing, []);
  });

  it("aprova quando o rebuild RECUPERA cliques (ex: fix do #4834)", () => {
    const antes = [row("2026-05-01", "A", 3)];
    const depois = [row("2026-05-01", "A", 3), row("2026-05-01", "A", 4)];

    const r = assessClickLoss(antes, depois);

    assert.equal(r.safe, true);
    assert.equal(r.totalDelta, 4);
  });

  it("recusa quando uma edição perde cliques", () => {
    const antes = [row("2026-05-01", "A", 10)];
    const depois = [row("2026-05-01", "A", 2)];

    const r = assessClickLoss(antes, depois);

    assert.equal(r.safe, false);
    assert.equal(r.editionsLosing.length, 1);
    assert.equal(r.editionsLosing[0].before, 10);
    assert.equal(r.editionsLosing[0].after, 2);
    assert.equal(r.editionsLosing[0].delta, -8);
  });

  it("recusa quando uma edição some por completo do rebuild", () => {
    const antes = [row("2026-05-01", "A", 7), row("2026-05-02", "B", 4)];
    const depois = [row("2026-05-02", "B", 4)];

    const r = assessClickLoss(antes, depois);

    assert.equal(r.safe, false);
    assert.deepEqual(r.editionsVanishing, [editionKey("2026-05-01", "A")]);
    assert.equal(r.editionsLosing[0].after, 0);
  });

  it("recusa mesmo quando o TOTAL fecha positivo — a perda é por edição", () => {
    // Sem a checagem por edição, o agregado (+15) mascararia a perda de 20 em A.
    const antes = [row("2026-05-01", "A", 20), row("2026-05-02", "B", 5)];
    const depois = [row("2026-05-01", "A", 0), row("2026-05-02", "B", 40)];

    const r = assessClickLoss(antes, depois);

    assert.equal(r.totalDelta, 15, "o total sobe");
    assert.equal(r.safe, false, "mas a edição A perdeu tudo — tem que recusar");
    assert.equal(r.editionsLosing.length, 1);
    assert.equal(r.editionsLosing[0].date, "2026-05-01");
  });

  it("reproduz o incidente de 05/ago (#4836): cache zerado apaga cliques reais", () => {
    // 22 posts com stats.clicks sobrescrito por [] enquanto o agregado
    // (unique_verified_clicks) seguia entre 6 e 28. O rebuild produziria zero
    // linhas de clique para eles.
    const antes: ClickCountRow[] = [];
    const depois: ClickCountRow[] = [];
    let esperado = 0;
    for (let i = 0; i < 22; i++) {
      const clicks = 6 + (i % 18); // 6..23, a faixa medida nos 22 posts da janela
      antes.push(row(`2026-04-${String(i + 1).padStart(2, "0")}`, `Edição ${i}`, clicks));
      depois.push(row(`2026-04-${String(i + 1).padStart(2, "0")}`, `Edição ${i}`, 0));
      esperado += clicks;
    }

    const r = assessClickLoss(antes, depois);

    assert.equal(r.safe, false);
    assert.equal(r.editionsLosing.length, 22);
    assert.equal(r.totalAfter, 0);
    assert.equal(r.totalBefore, esperado);

    // Ordenação por severidade: a maior perda vem primeiro.
    assert.ok(r.editionsLosing[0].delta <= r.editionsLosing.at(-1)!.delta);
  });

  it("soma múltiplas linhas da mesma edição", () => {
    const antes = [row("2026-05-01", "A", 2), row("2026-05-01", "A", 3)];
    const depois = [row("2026-05-01", "A", 5)];

    const r = assessClickLoss(antes, depois);
    assert.equal(r.safe, true);
    // Sem estes dois, um tally() que duplicasse a soma passaria despercebido:
    // super-contar ainda lê como "seguro".
    assert.equal(r.totalBefore, 5);
    assert.equal(r.totalAfter, 5);
  });

  it("trata CSV inexistente/vazio como seguro (bootstrap legítimo)", () => {
    const r = assessClickLoss([], [row("2026-05-01", "A", 3)]);
    assert.equal(r.safe, true);
    assert.equal(r.totalBefore, 0);
  });

  it("não confunde edições distintas de mesma data (2ª edição no mesmo dia)", () => {
    const antes = [row("2026-05-01", "Manhã", 4), row("2026-05-01", "Extra", 6)];
    const depois = [row("2026-05-01", "Manhã", 4)];

    const r = assessClickLoss(antes, depois);

    assert.equal(r.safe, false);
    assert.deepEqual(r.editionsVanishing, [editionKey("2026-05-01", "Extra")]);
  });
});

describe("parseClickCountsFromCsv", () => {
  const header =
    "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,section,origin";

  it("lê por NOME de coluna, não por posição (título com vírgula)", () => {
    const csv = [
      header,
      `2026-05-01,"IA, robôs e você",,âncora,https://x.com/a,x.com,100,9,7,0.70,Outro,Destaque,BR`,
    ].join("\n");

    const { rows, trusted } = parseClickCountsFromCsv(csv);

    assert.equal(trusted, true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].post_title, "IA, robôs e você");
    assert.equal(rows[0].unique_verified_clicks, 7, "vírgula no título não pode deslocar a coluna");
  });

  it("CSV vazio ou só cabeçalho é CONFIÁVEL e vazio (bootstrap legítimo)", () => {
    for (const entrada of ["", "   ", header]) {
      const r = parseClickCountsFromCsv(entrada);
      assert.deepEqual(r.rows, [], `entrada: ${JSON.stringify(entrada.slice(0, 20))}`);
      assert.equal(r.trusted, true, "vazio legítimo não pode bloquear o bootstrap");
    }
  });

  it("trata clique ausente/não-numérico como zero em vez de NaN", () => {
    const csv = [header, `2026-05-01,A,,anc,https://x.com/a,x.com,100,,,,Outro,Destaque,BR`].join("\n");

    const { rows, trusted } = parseClickCountsFromCsv(csv);

    assert.equal(trusted, true, "linha isolada sem clique é normal, não é CSV ilegível");
    assert.equal(rows[0].unique_verified_clicks, 0);
    assert.ok(!Number.isNaN(rows[0].unique_verified_clicks));
  });
});

describe("formatClickLossAbort", () => {
  it("nomeia o que se perde, a issue de referência e a saída de escape", () => {
    const r = assessClickLoss([row("2026-05-01", "A", 10)], [row("2026-05-01", "A", 1)]);
    const msg = formatClickLossAbort(r);

    assert.match(msg, /REBUILD ABORTADO/);
    assert.match(msg, /2026-05-01/);
    assert.match(msg, /#4836/, "precisa apontar o procedimento de restauração");
    assert.match(msg, /--allow-click-loss/, "um abort sem saída documentada vira --force às cegas");
  });

  it("trunca a listagem em 10 edições e diz quantas sobraram", () => {
    const antes = Array.from({ length: 14 }, (_, i) => row(`2026-05-${String(i + 1).padStart(2, "0")}`, `E${i}`, 5));
    const depois = antes.map((r) => ({ ...r, unique_verified_clicks: 0 }));

    const msg = formatClickLossAbort(assessClickLoss(antes, depois));

    assert.match(msg, /e mais 4 edições/);
  });
});

describe("parseClickCountsFromCsv — distinção entre vazio e ILEGÍVEL (#4850 review)", () => {
  const header =
    "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,section,origin";

  it("coluna de cliques renomeada => untrusted (senão todo clique lê como zero)", () => {
    // Antes deste guard: as linhas parseavam, `unique_verified_clicks` virava 0
    // em TODAS, `assessClickLoss` comparava contra zero e nunca acusava perda.
    const renomeada = header.replace("unique_verified_clicks", "clicks_unique");
    const csv = [renomeada, "2026-05-01,A,,anc,https://x.com/a,x.com,100,9,7,0.70,Outro,Destaque,BR"].join("\n");

    const r = parseClickCountsFromCsv(csv);

    assert.equal(r.trusted, false);
    assert.deepEqual(r.rows, []);
    assert.match(r.reason ?? "", /unique_verified_clicks/);
  });

  it("coluna date ausente => untrusted", () => {
    const csv = ["post_title,unique_verified_clicks", "A,7"].join("\n");
    assert.equal(parseClickCountsFromCsv(csv).trusted, false);
  });

  it("CSV com conteúdo mas nenhuma linha legível => untrusted, não 'vazio'", () => {
    // Assinatura de UTF-16LE lido como utf8: NUL intercalado, nenhum rec.date bate.
    const utf16 = Buffer.from(`${header}\n2026-05-01,A,,,,,,,7,,,,\n`, "utf16le").toString("utf8");

    const r = parseClickCountsFromCsv(utf16);

    assert.equal(r.trusted, false, "CSV ilegível não pode ser tratado como bootstrap");
    assert.match(r.reason ?? "", /NUL|UTF-16|encoding/i);
  });

  it("BOM UTF-8 continua confiável (Papa normaliza) — não superdiagnosticar", () => {
    const csv = `﻿${header}\n2026-05-01,A,,anc,https://x.com/a,x.com,100,9,7,0.70,Outro,Destaque,BR`;

    const r = parseClickCountsFromCsv(csv);

    assert.equal(r.trusted, true);
    assert.equal(r.rows[0].unique_verified_clicks, 7);
  });

  it("CRLF continua confiável no parser (o gatilho de rebuild é outro)", () => {
    const csv = `${header}\r\n2026-05-01,A,,anc,https://x.com/a,x.com,100,9,7,0.70,Outro,Destaque,BR\r\n`;

    const r = parseClickCountsFromCsv(csv);

    assert.equal(r.trusted, true);
    assert.equal(r.rows[0].unique_verified_clicks, 7);
  });
});

describe("formatUntrustedCsvAbort", () => {
  it("nomeia o motivo e a saída de escape", () => {
    const msg = formatUntrustedCsvAbort("cabeçalho sem `unique_verified_clicks`");

    assert.match(msg, /REBUILD ABORTADO/);
    assert.match(msg, /unique_verified_clicks/);
    assert.match(msg, new RegExp(ALLOW_CLICK_LOSS_FLAG));
  });
});
