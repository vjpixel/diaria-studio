/**
 * test/microsoft-ads-ingest-5502.test.ts (#5502, transporte SOAP real #5928)
 *
 * Cobre `scripts/lib/microsoft-ads-ingest.ts`: normalização
 * CampaignPerformanceReport→SpendRow (incluindo os dois formatos de data
 * aceitos), o transporte SOAP real (submit→poll→download→unzip→parse,
 * #5928), e o caminho fail-soft (rede/auth/qualquer etapa nunca lança) —
 * nunca chama a API real. Espelha `test/google-ads-ingest-5237.test.ts`
 * ponto a ponto onde o formato permite (a Reporting API é SOAP assíncrona,
 * não uma chamada síncrona como a GAQL do Google).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import {
  aggregateMicrosoftAdsSpendByMonth,
  aggregateMicrosoftAdsSpendByMonthWithDiscards,
  refreshMicrosoftAdsAccessToken,
  fetchMicrosoftAdsSpendRows,
  runMicrosoftAdsIngest,
  type MicrosoftAdsReportRow,
  type MicrosoftAdsAuthConfig,
  type FetchLike,
} from "../scripts/lib/microsoft-ads-ingest.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";

const AUTH: MicrosoftAdsAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  developerToken: "dev-token",
  customerId: "12345678",
  accountId: "87654321",
};

const DATE_RANGE = { start: new Date("2026-05-24T00:00:00Z"), end: new Date("2026-08-22T00:00:00Z") };
/** Testes nunca esperam de verdade entre tentativas de poll. */
const NO_SLEEP = { sleepImpl: async () => {} };
const SERVICE_URL = "https://reporting.api.bingads.microsoft.com/Api/Advertiser/Reporting/v13/ReportingService.svc";
const DOWNLOAD_URL = "https://reporting-download.bingads.microsoft.com/fake/report.zip";

/** Monta um ZIP mínimo de 1 entry (Local File Header + dados DEFLATE), o
 *  mesmo formato que `Compress-Archive` produz e que `unzipFirstEntry`
 *  (scripts/lib/microsoft-ads-ingest.ts) sabe ler — validado ao vivo contra
 *  um ZIP real do PowerShell durante a implementação (#5928). */
function buildTestZip(csvContent: string): Buffer {
  const data = Buffer.from(csvContent, "utf8");
  const compressed = deflateRawSync(data);
  const nameBuf = Buffer.from("CampaignPerformanceReport.csv", "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8); // compression method = deflate
  header.writeUInt32LE(0, 14); // crc32 — não validado pelo reader
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuf, compressed]);
}

/** Monta um Local File Header ZIP com controle total sobre os campos — só
 *  pros testes de edge case de `unzipFirstEntry` (método de compressão não
 *  suportado, streaming, buffer truncado). `buildTestZip` acima cobre o
 *  caminho feliz (DEFLATE bem formado); `STORED` (method 0) também é
 *  exercitado via este helper, já que é o outro método OFICIALMENTE
 *  suportado e `buildTestZip` nunca o gera. */
function buildRawZipEntry(opts: {
  compressionMethod: number;
  generalPurposeFlag?: number;
  data: Buffer;
  /** Sobrepõe o tamanho declarado no header — usado só pro teste de buffer
   *  truncado (declara mais bytes do que o entry realmente contém). */
  declaredCompressedSize?: number;
}): Buffer {
  const filename = Buffer.from("CampaignPerformanceReport.csv", "utf8");
  const compressedData = opts.compressionMethod === 8 ? deflateRawSync(opts.data) : opts.data;
  const declaredSize = opts.declaredCompressedSize ?? compressedData.length;
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(opts.generalPurposeFlag ?? 0, 6);
  header.writeUInt16LE(opts.compressionMethod, 8);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(declaredSize, 18);
  header.writeUInt32LE(opts.data.length, 22);
  header.writeUInt16LE(filename.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, filename, compressedData]);
}

function soapFault(message: string): string {
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>${message}</faultstring></s:Fault></s:Body></s:Envelope>`;
}

/** Fault no formato REAL da Microsoft Advertising (`AdApiFaultDetail`),
 *  distinto do `faultstring` simples que `soapFault()` acima produz — é o
 *  shape que `extractSoapFaultMessage` (scripts/lib/microsoft-ads-ingest.ts)
 *  também sabe extrair e que a API usa na prática pra erros de negócio
 *  (developer token inválido, identity mismatch, etc). */
function soapFaultAdApi(code: number, errorCode: string, message: string): string {
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Server</faultcode><faultstring>Invalid client data.</faultstring><detail><AdApiFaultDetail xmlns="https://adapi.microsoft.com"><Errors><AdApiError><Code>${code}</Code><ErrorCode>${errorCode}</ErrorCode><Message>${message}</Message></AdApiError></Errors></AdApiFaultDetail></detail></s:Fault></s:Body></s:Envelope>`;
}

function submitResponseXml(reportRequestId: string): string {
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><SubmitGenerateReportResponse xmlns="https://bingads.microsoft.com/Reporting/v13"><ReportRequestId>${reportRequestId}</ReportRequestId></SubmitGenerateReportResponse></s:Body></s:Envelope>`;
}

function pollResponseXml(status: string, downloadUrl?: string): string {
  const downloadEl = downloadUrl ? `<ReportDownloadUrl>${downloadUrl}</ReportDownloadUrl>` : "";
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><PollGenerateReportResponse xmlns="https://bingads.microsoft.com/Reporting/v13"><ReportRequestStatus><ReportRequestId>req-1</ReportRequestId><Status>${status}</Status>${downloadEl}</ReportRequestStatus></PollGenerateReportResponse></s:Body></s:Envelope>`;
}

/** Router de fetch mockado pro fluxo SOAP completo — distingue submit vs
 *  poll pelo texto `<Action>` dentro do corpo (os 2 vão pra mesma URL,
 *  `SERVICE_URL`), e o download por URL separada (`DOWNLOAD_URL`). */
function mockReportingFlow(opts: {
  reportRequestId?: string;
  pollStatuses?: string[]; // ex: ["Pending", "Success"] — 1 por chamada de poll, na ordem
  csv?: string;
  /** Sobrepõe o payload do download (zip cru) — quando presente, `csv` é ignorado. */
  rawZip?: Buffer;
  submitError?: { status: number; body: string };
  pollError?: { status: number; body: string };
  /** Faz `Success` sair sem `ReportDownloadUrl` — cenário defensivo. */
  pollSuccessWithoutDownloadUrl?: boolean;
  /** Captura `(url, init)` de toda chamada — usado pro teste de headers/envelope. */
  onRequest?: (url: string, init: RequestInit | undefined) => void;
}): FetchLike {
  const reportRequestId = opts.reportRequestId ?? "req-1";
  const pollStatuses = opts.pollStatuses ?? ["Success"];
  let pollCall = 0;
  return async (url, init) => {
    opts.onRequest?.(url, init);
    if (url.includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    }
    if (url === DOWNLOAD_URL) {
      const body = opts.rawZip ?? buildTestZip(opts.csv ?? '"TimePeriod","Spend"\r\n"2026-08-10","50.00"\r\n');
      return new Response(body, { status: 200 });
    }
    if (url === SERVICE_URL) {
      const body = String(init?.body ?? "");
      if (body.includes(">SubmitGenerateReport<")) {
        if (opts.submitError) return new Response(opts.submitError.body, { status: opts.submitError.status });
        return new Response(submitResponseXml(reportRequestId), { status: 200 });
      }
      if (body.includes(">PollGenerateReport<")) {
        if (opts.pollError) return new Response(opts.pollError.body, { status: opts.pollError.status });
        const status = pollStatuses[Math.min(pollCall, pollStatuses.length - 1)];
        pollCall++;
        const downloadUrl = status === "Success" && !opts.pollSuccessWithoutDownloadUrl ? DOWNLOAD_URL : undefined;
        return new Response(pollResponseXml(status, downloadUrl), { status: 200 });
      }
    }
    throw new Error(`URL/corpo inesperado no mock: ${url} — ${String(init?.body).slice(0, 200)}`);
  };
}

describe("#5502 — aggregateMicrosoftAdsSpendByMonth", () => {
  it("agrega Spend por mês, formato de data MM/DD/YYYY (default da Reporting API)", () => {
    const rows: MicrosoftAdsReportRow[] = [
      { TimePeriod: "08/01/2026", Spend: "10.50" },
      { TimePeriod: "08/15/2026", Spend: "25.00" },
      { TimePeriod: "07/30/2026", Spend: "5.00" },
    ];

    const out = aggregateMicrosoftAdsSpendByMonth(rows, {
      canal: "Microsoft Advertising",
      moeda: "BRL",
      fonteLabel: "Microsoft Advertising Reporting API",
    });

    assert.equal(out.length, 2);
    const ago = out.find((r) => r.mes === "2026-08")!;
    const jul = out.find((r) => r.mes === "2026-07")!;
    assert.equal(ago.valor, 35.5);
    assert.equal(jul.valor, 5.0);
    assert.equal(ago.canal, "Microsoft Advertising");
    assert.equal(ago.moeda, "BRL");
    assert.match(ago.fonte, /Microsoft Advertising Reporting API/);
    assert.match(ago.fonte, /2 dia\(s\)/);
  });

  it("também aceita TimePeriod em YYYY-MM-DD (robustez a mudança de serialização upstream)", () => {
    const rows: MicrosoftAdsReportRow[] = [{ TimePeriod: "2026-08-01", Spend: 12.34 }];
    const out = aggregateMicrosoftAdsSpendByMonth(rows, { canal: "Microsoft Advertising", moeda: "BRL", fonteLabel: "x" });
    assert.equal(out.length, 1);
    assert.equal(out[0].valor, 12.34);
  });

  it("Spend como number (não só string) também é aceito", () => {
    const rows: MicrosoftAdsReportRow[] = [{ TimePeriod: "08/01/2026", Spend: 9.99 }];
    const out = aggregateMicrosoftAdsSpendByMonth(rows, { canal: "Microsoft Advertising", moeda: "BRL", fonteLabel: "x" });
    assert.equal(out[0].valor, 9.99);
  });

  it("ignora linhas sem TimePeriod, com data não reconhecida, ou sem Spend — nunca soma como zero silencioso", () => {
    const rows: MicrosoftAdsReportRow[] = [
      { Spend: "10.00" },
      { TimePeriod: "08/01/2026" },
      { TimePeriod: "not-a-date", Spend: "10.00" },
      { TimePeriod: "2026-13-99", Spend: "10.00" }, // não casa nenhum dos 2 padrões aceitos
    ];
    assert.deepEqual(
      aggregateMicrosoftAdsSpendByMonth(rows, { canal: "Microsoft Advertising", moeda: "BRL", fonteLabel: "x" }),
      [],
    );
  });

  it("lista vazia de rows produz lista vazia", () => {
    assert.deepEqual(aggregateMicrosoftAdsSpendByMonth([], { canal: "Microsoft Advertising", moeda: "BRL", fonteLabel: "x" }), []);
  });
});

describe("#5502 — refreshMicrosoftAdsAccessToken (fail-soft)", () => {
  it("sucesso devolve o access_token", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ access_token: "tok-123" }), { status: 200 });
    const out = await refreshMicrosoftAdsAccessToken(fetchImpl, AUTH);
    assert.deepEqual(out, { accessToken: "tok-123" });
  });

  it("falha de rede nunca lança — devolve { error }", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const out = await refreshMicrosoftAdsAccessToken(fetchImpl, AUTH);
    assert.ok("error" in out);
    assert.match(out.error, /ECONNREFUSED/);
  });

  it("resposta HTTP de erro (sem access_token) devolve { error }, não lança", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ error_description: "invalid_grant" }), { status: 400 });
    const out = await refreshMicrosoftAdsAccessToken(fetchImpl, AUTH);
    assert.ok("error" in out);
    assert.match(out.error, /invalid_grant/);
  });

  it("corpo não-JSON (ex: HTML de proxy) devolve { error }, não lança", async () => {
    const fetchImpl: FetchLike = async () => new Response("<html>502</html>", { status: 502 });
    const out = await refreshMicrosoftAdsAccessToken(fetchImpl, AUTH);
    assert.ok("error" in out);
  });
});

describe("#5928 — fetchMicrosoftAdsSpendRows (transporte SOAP real: submit→poll→download→unzip→parse)", () => {
  it("caminho feliz: submit + poll (Success de cara) + download do ZIP devolve as rows parseadas", async () => {
    const fetchImpl = mockReportingFlow({ csv: '"TimePeriod","Spend"\r\n"2026-08-10","50.00"\r\n"2026-08-11","12.34"\r\n' });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.deepEqual(out, {
      rows: [
        { TimePeriod: "2026-08-10", Spend: "50.00" },
        { TimePeriod: "2026-08-11", Spend: "12.34" },
      ],
    });
  });

  it("poll Pending 2× antes de Success — resolve sem exceder maxPollAttempts", async () => {
    const fetchImpl = mockReportingFlow({ pollStatuses: ["Pending", "Pending", "Success"], csv: '"TimePeriod","Spend"\r\n"2026-08-10","1.00"\r\n' });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, { ...NO_SLEEP, maxPollAttempts: 5 });
    assert.deepEqual(out, { rows: [{ TimePeriod: "2026-08-10", Spend: "1.00" }] });
  });

  it("poll nunca sai de Pending → { error } após maxPollAttempts, nunca lança", async () => {
    const fetchImpl = mockReportingFlow({ pollStatuses: ["Pending"] });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, { ...NO_SLEEP, maxPollAttempts: 3 });
    assert.ok("error" in out);
    assert.match(out.error, /não completou/);
  });

  it("poll devolve status de erro (nem Pending nem Success) → { error }", async () => {
    const fetchImpl = mockReportingFlow({ pollStatuses: ["Error"] });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("error" in out);
    assert.match(out.error, /status inesperado/);
  });

  it("SubmitGenerateReport respondeu HTTP de erro (SOAP Fault) → { error } com a faultstring, não lança", async () => {
    const fetchImpl = mockReportingFlow({ submitError: { status: 500, body: soapFault("DeveloperTokenInvalid") } });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("error" in out);
    assert.match(out.error, /DeveloperTokenInvalid/);
  });

  it("falha de rede em qualquer etapa nunca lança", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("error" in out);
  });

  it("download com corpo que não é um ZIP válido → { error }, não lança", async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      if (url === DOWNLOAD_URL) return new Response("não sou um zip", { status: 200 });
      const body = String(init?.body ?? "");
      if (body.includes(">SubmitGenerateReport<")) return new Response(submitResponseXml("req-1"), { status: 200 });
      return new Response(pollResponseXml("Success", DOWNLOAD_URL), { status: 200 });
    };
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("error" in out);
    assert.match(out.error, /descompactar/);
  });

  it("CSV baixado sem as colunas TimePeriod/Spend → { error } (nunca 'zero gasto' silencioso)", async () => {
    const fetchImpl = mockReportingFlow({ csv: '"CampaignId","Clicks"\r\n"123","5"\r\n' });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("error" in out);
    assert.match(out.error, /colunas esperadas/);
  });
});

describe("#5502/#5928 — runMicrosoftAdsIngest (orquestração end-to-end, fail-soft)", () => {
  const existingRows: SpendRow[] = [
    { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "painel manual" },
    { canal: "LinkedIn", mes: "2026-08", moeda: "BRL", valor: 0, fonte: "placeholder" },
  ];

  it("caminho feliz: token + Reporting API OK produz merge atualizado", async () => {
    const fetchImpl = mockReportingFlow({ csv: '"TimePeriod","Spend"\r\n"2026-08-10","50.00"\r\n' });
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows, ...NO_SLEEP });
    assert.equal(result.kind, "updated");
    if (result.kind === "updated") {
      assert.equal(result.fetchedRows, 1);
      const ms = result.rows.find((r) => r.canal === "Microsoft Advertising" && r.mes === "2026-08");
      assert.ok(ms);
      assert.equal(ms!.valor, 50);
      // Google Ads e LinkedIn (não recobertos pela query) preservados.
      assert.ok(result.rows.some((r) => r.canal === "Google Ads"));
      assert.ok(result.rows.some((r) => r.canal === "LinkedIn"));
    }
  });

  it("canal default é EXATAMENTE o nome reservado em RESERVED_CHANNEL_NAMES (#5493) — nunca 'Microsoft Ads'/'Bing Ads'", async () => {
    const fetchImpl = mockReportingFlow({ csv: '"TimePeriod","Spend"\r\n"2026-08-10","1.00"\r\n' });
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows: [], ...NO_SLEEP });
    assert.equal(result.kind, "updated");
    if (result.kind === "updated") {
      assert.equal(result.rows[0]?.canal, "Microsoft Advertising");
    }
  });

  it("MCP/API indisponível (falha de token) → fallback, spend.csv não é tocado", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows, ...NO_SLEEP });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.match(result.reason, /ETIMEDOUT/);
  });

  it("token OK mas Reporting API falha (ex: credencial não emitida) → fallback", async () => {
    const fetchImpl = mockReportingFlow({ submitError: { status: 401, body: soapFault("InvalidCredentials") } });
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows, ...NO_SLEEP });
    assert.equal(result.kind, "fallback");
  });

  it("Reporting API responde sem nenhuma linha de custo → fallback (nada pra atualizar)", async () => {
    const fetchImpl = mockReportingFlow({ csv: '"TimePeriod","Spend"\r\n' }); // só header, 0 linhas de dado
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows, ...NO_SLEEP });
    assert.equal(result.kind, "fallback");
  });
});

describe("#5605 — aggregateMicrosoftAdsSpendByMonthWithDiscards (espelha #5598 do Google Ads)", () => {
  it("perda PARCIAL: discardedCount bate com o número exato de linhas malformadas, mesmo com linhas válidas", () => {
    const rows: MicrosoftAdsReportRow[] = [
      { TimePeriod: "08/10/2026", Spend: "50.00" }, // válida
      { Spend: "10.00" }, // descartada: sem TimePeriod
      { TimePeriod: "not-a-date", Spend: "10.00" }, // descartada: data irreconhecível
      { TimePeriod: "08/12/2026" }, // descartada: sem Spend
    ];
    const out = aggregateMicrosoftAdsSpendByMonthWithDiscards(rows, {
      canal: "Microsoft Advertising",
      moeda: "BRL",
      fonteLabel: "x",
    });
    assert.equal(out.discardedCount, 3);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0]?.valor, 50);
  });

  it("perda TOTAL: discardedCount === nº de linhas de entrada, agregado vazio", () => {
    const rows: MicrosoftAdsReportRow[] = [{ Spend: "1.00" }, { TimePeriod: "08/10/2026" }];
    const out = aggregateMicrosoftAdsSpendByMonthWithDiscards(rows, {
      canal: "Microsoft Advertising",
      moeda: "BRL",
      fonteLabel: "x",
    });
    assert.equal(out.discardedCount, 2);
    assert.deepEqual(out.rows, []);
  });

  it("sem malformação: discardedCount é 0", () => {
    const rows: MicrosoftAdsReportRow[] = [{ TimePeriod: "08/10/2026", Spend: "50.00" }];
    const out = aggregateMicrosoftAdsSpendByMonthWithDiscards(rows, {
      canal: "Microsoft Advertising",
      moeda: "BRL",
      fonteLabel: "x",
    });
    assert.equal(out.discardedCount, 0);
  });

  it("aggregateMicrosoftAdsSpendByMonth (atalho) devolve exatamente .rows de WithDiscards — assinatura preservada", () => {
    const rows: MicrosoftAdsReportRow[] = [{ TimePeriod: "08/10/2026", Spend: "50.00" }, { Spend: "1.00" }];
    const opts = { canal: "Microsoft Advertising", moeda: "BRL", fonteLabel: "x" };
    assert.deepEqual(aggregateMicrosoftAdsSpendByMonth(rows, opts), aggregateMicrosoftAdsSpendByMonthWithDiscards(rows, opts).rows);
  });
});

describe("#5605 — runMicrosoftAdsIngest propaga discardedCount + console.warn em perda parcial", () => {
  it("resultado 'updated' expõe discardedCount batendo com o nº exato de linhas descartadas", async () => {
    // 2ª linha vem com Spend não-numérico ("N/A") — descartada na agregação (Number.isFinite), não no parse do CSV
    // ("" seria Number("") === 0, um falso-positivo de "válida"; N/A garante NaN de verdade).
    const fetchImpl = mockReportingFlow({ csv: '"TimePeriod","Spend"\r\n"2026-08-10","50.00"\r\n"2026-08-11","N/A"\r\n' });
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows: [], ...NO_SLEEP });
    assert.equal(result.kind, "updated");
    if (result.kind === "updated") {
      assert.equal(result.discardedCount, 1);
      assert.equal(result.fetchedRows, 2); // linhas do report BRUTAS, não o nº de meses agregados
    }
  });

  it("discardedCount > 0 emite console.warn no caminho de SUCESSO, sem virar exit não-zero", async () => {
    const fetchImpl = mockReportingFlow({ csv: '"TimePeriod","Spend"\r\n"2026-08-10","50.00"\r\n"2026-08-11","N/A"\r\n' });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows: [], ...NO_SLEEP });
      assert.equal(result.kind, "updated");
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(warnings.some((w) => w.includes("1") && /descartad/.test(w)));
  });

  it("discardedCount === 0 (nenhuma linha malformada) NÃO emite warning", async () => {
    const fetchImpl = mockReportingFlow({ csv: '"TimePeriod","Spend"\r\n"2026-08-10","50.00"\r\n' });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows: [], ...NO_SLEEP });
      assert.equal(result.kind, "updated");
      if (result.kind === "updated") assert.equal(result.discardedCount, 0);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 0);
  });

  it("perda TOTAL continua caindo em 'fallback' — mas a reason MENCIONA o descarte, não vira 'sem gasto' genérico", async () => {
    // Regressão: sem o enriquecimento, esta reason seria idêntica à de um
    // dia genuinamente sem gasto — indistinguível de um schema drift total.
    const fetchImpl = mockReportingFlow({ csv: '"TimePeriod","Spend"\r\n"2026-08-10","N/A"\r\n' }); // Spend não-numérico
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows: [], ...NO_SLEEP });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") {
      assert.match(result.reason, /1 linha\(s\)/);
      assert.match(result.reason, /descartada/);
    }
  });

  it("falha de token/API antes de qualquer linha chegar → fallback com a reason ORIGINAL (sem menção a descarte)", async () => {
    const fetchImpl = mockReportingFlow({ submitError: { status: 401, body: soapFault("InvalidCredentials") } });
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows: [], ...NO_SLEEP });
    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") assert.doesNotMatch(result.reason, /descartada/);
  });
});

describe("#5928 — regressão do transporte SOAP 1.1 (Content-Type/SOAPAction) — #4234 'PR de bugfix exige teste de regressão'", () => {
  it("submit E poll vão com Content-Type text/xml + header SOAPAction — nunca application/soap+xml (SOAP 1.2, causou HTTP 415 ao vivo)", async () => {
    const seen: { url: string; contentType: string | undefined; soapAction: string | undefined }[] = [];
    const fetchImpl = mockReportingFlow({
      onRequest: (url, init) => {
        if (url !== SERVICE_URL) return;
        const headers = new Headers(init?.headers);
        seen.push({ url, contentType: headers.get("Content-Type") ?? undefined, soapAction: headers.get("SOAPAction") ?? undefined });
      },
    });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("rows" in out, `esperava sucesso, veio: ${JSON.stringify(out)}`);
    assert.equal(seen.length, 2); // 1 submit + 1 poll
    for (const call of seen) {
      assert.equal(call.contentType, "text/xml; charset=utf-8");
    }
    assert.equal(seen[0].soapAction, "SubmitGenerateReport");
    assert.equal(seen[1].soapAction, "PollGenerateReport");
  });
});

describe("#5928 — unzipFirstEntry, casos de borda (via fetchMicrosoftAdsSpendRows, sem exportar a função interna)", () => {
  it("STORED (compressionMethod 0) — o outro método oficialmente suportado, não coberto por buildTestZip — funciona", async () => {
    const csv = '"TimePeriod","Spend"\r\n"2026-08-10","7.50"\r\n';
    const rawZip = buildRawZipEntry({ compressionMethod: 0, data: Buffer.from(csv, "utf8") });
    const fetchImpl = mockReportingFlow({ rawZip });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.deepEqual(out, { rows: [{ TimePeriod: "2026-08-10", Spend: "7.50" }] });
  });

  it("método de compressão não suportado (ex: bzip2=12) → { error }, nunca lança", async () => {
    const rawZip = buildRawZipEntry({ compressionMethod: 12, data: Buffer.from("qualquer coisa", "utf8") });
    const fetchImpl = mockReportingFlow({ rawZip });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("error" in out);
    assert.match(out.error, /método de compressão/);
  });

  it("ZIP com data descriptor (streaming, bit 3 do general purpose flag) → { error } explícito, não suportado", async () => {
    const rawZip = buildRawZipEntry({
      compressionMethod: 8,
      generalPurposeFlag: 0x0008,
      data: Buffer.from("x", "utf8"),
      declaredCompressedSize: 0, // characteristic de streaming: tamanho vem só depois dos dados
    });
    const fetchImpl = mockReportingFlow({ rawZip });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("error" in out);
    assert.match(out.error, /data descriptor/);
  });

  it("buffer truncado (header declara mais bytes do que o entry realmente tem) → { error }, nunca dado truncado silencioso", async () => {
    const csv = '"TimePeriod","Spend"\r\n"2026-08-10","50.00"\r\n';
    const rawZip = buildRawZipEntry({
      compressionMethod: 0,
      data: Buffer.from(csv, "utf8"),
      declaredCompressedSize: csv.length + 1000, // mente sobre o tamanho — download truncado
    });
    const fetchImpl = mockReportingFlow({ rawZip });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("error" in out);
    assert.match(out.error, /download truncado/);
  });
});

describe("#5928 — extractSoapFaultMessage no shape REAL da Microsoft Advertising (AdApiFaultDetail)", () => {
  it("fault AdApiFaultDetail (não o faultstring simples) tem a Message extraída pro erro devolvido", async () => {
    const fetchImpl = mockReportingFlow({
      submitError: { status: 500, body: soapFaultAdApi(105, "InvalidDeveloperToken", "The developer token is invalid.") },
    });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("error" in out);
    assert.match(out.error, /developer token is invalid/i);
  });
});

describe("#5928 — poll: branches defensivos não cobertos pelo caminho feliz", () => {
  it("poll HTTP não-200 → { error } com o fault, não lança", async () => {
    const fetchImpl = mockReportingFlow({ pollError: { status: 500, body: soapFault("InternalError") } });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("error" in out);
    assert.match(out.error, /InternalError/);
  });

  it("poll Success SEM ReportDownloadUrl (cenário defensivo) → { error } explícito", async () => {
    const fetchImpl = mockReportingFlow({ pollSuccessWithoutDownloadUrl: true });
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", DATE_RANGE, NO_SLEEP);
    assert.ok("error" in out);
    assert.match(out.error, /sem ReportDownloadUrl/);
  });
});

describe("#5928 — MicrosoftAdsDateRange invertido é rejeitado antes de qualquer chamada de rede", () => {
  it("start > end → { error } local, sem sequer chamar fetchImpl", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      throw new Error("não deveria ser chamado");
    };
    const inverted = { start: new Date("2026-08-22T00:00:00Z"), end: new Date("2026-05-24T00:00:00Z") };
    const out = await fetchMicrosoftAdsSpendRows(fetchImpl, AUTH, "tok", inverted, NO_SLEEP);
    assert.ok("error" in out);
    assert.match(out.error, /invertido/);
    assert.equal(calls, 0);
  });
});

describe("#5928 — runMicrosoftAdsIngest: RunMicrosoftAdsIngestOptions.now é honrado (comentário do tipo cobrado por teste real)", () => {
  it("now: fixo muda o CustomDateRangeStart/End enviados no envelope de submit", async () => {
    let submitBody = "";
    const fetchImpl = mockReportingFlow({
      csv: '"TimePeriod","Spend"\r\n"2026-01-15","1.00"\r\n',
      onRequest: (url, init) => {
        const body = String(init?.body ?? "");
        if (url === SERVICE_URL && body.includes(">SubmitGenerateReport<")) submitBody = body;
      },
    });
    const now = new Date("2026-01-15T12:00:00Z"); // lookback padrão de 90 dias termina em 2025-10-18
    const result = await runMicrosoftAdsIngest(fetchImpl, { auth: AUTH, existingRows: [], now, ...NO_SLEEP });
    assert.equal(result.kind, "updated");
    assert.match(submitBody, /<Year>2026<\/Year>/); // CustomDateRangeEnd bate com `now`
    assert.match(submitBody, /<Year>2025<\/Year>/); // CustomDateRangeStart cai no ano anterior (90 dias atrás)
  });
});
