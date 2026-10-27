/**
 * test/channel-names-legacy-compat-5862.test.ts (#5862)
 *
 * Decisão do editor (27/10/2026, caminho (a)): as 3 specs temporárias do
 * teste 2608 ("X Ads (teste 2608)") ficam, renomeadas para nomes permanentes
 * por plataforma ("X Ads (UTM)"), sem arquivar `spend.csv`.
 *
 * O risco que a própria issue nomeia: o gasto histórico, gravado em disco
 * com o nome antigo, cair em "canal desconhecido" (`unattributedSpend`,
 * #5860). Este arquivo trava a leitura dos nomes antigos em cada leitor dos
 * arquivos do teste: `spend.csv`, `clicks-2608.csv`, `run-state.json`,
 * `edicoes.jsonl` e `gasto-fases-2608.json`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalChannelName,
  CHANNEL_KEY_SPECS,
  GOOGLE_ADS_UTM_CANAL,
  LEGACY_CHANNEL_NAME_ALIASES,
  META_ADS_UTM_CANAL,
  MICROSOFT_ADS_UTM_CANAL,
} from "../scripts/lib/shared/channel-key-specs.ts";
import { parseSpendCsv } from "../scripts/lib/aquisicao-spend.ts";
import { buildCacReport, CHANNEL_GROUP_KEYS } from "../scripts/lib/cac.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";
import { parseClicksCsv } from "../scripts/lib/ads-test-watch.ts";
import {
  ADS_TEST_2608_BRACOS,
  assertValidRunState,
  canonicalizeRunStateChannelNames,
} from "../scripts/lib/ads-test-run-state.ts";
import { normalizeEdicaoRegistro } from "../scripts/lib/ads-rolling-window.ts";
import { parseEmendaGastoPorFase } from "../scripts/lib/teste-2608-emenda.ts";
import { sumTeste2608Spend } from "../scripts/lib/ads-daily-digest.ts";

const NOVOS = [GOOGLE_ADS_UTM_CANAL, MICROSOFT_ADS_UTM_CANAL, META_ADS_UTM_CANAL];

describe("#5862 — nomes permanentes por plataforma", () => {
  it("nenhum nome de canal de CHANNEL_KEY_SPECS carrega mais '(teste 2608)'", () => {
    const comTeste = CHANNEL_KEY_SPECS.map((s) => s.canal).filter((c) => c.includes("teste 2608"));
    assert.deepEqual(comTeste, []);
  });

  it("os 3 nomes novos têm spec com a mesma chave de utm_source de antes", () => {
    const keysPorCanal = Object.fromEntries(CHANNEL_KEY_SPECS.map((s) => [s.canal, s.keys]));
    assert.deepEqual(keysPorCanal[GOOGLE_ADS_UTM_CANAL], ["google-ads"]);
    assert.deepEqual(keysPorCanal[MICROSOFT_ADS_UTM_CANAL], ["microsoft-ads"]);
    assert.deepEqual(keysPorCanal[META_ADS_UTM_CANAL], ["meta-ads"]);
  });

  it("o Google por UTM NÃO se funde com o canal legado 'Google Ads' (referrer, PMax/Search)", () => {
    // Fundir somaria `android.googlequicksearchbox` (que também carrega
    // orgânico) à coorte do gasto atual.
    assert.notEqual(GOOGLE_ADS_UTM_CANAL, "Google Ads");
    assert.deepEqual(CHANNEL_GROUP_KEYS[GOOGLE_ADS_UTM_CANAL], ["google-ads"]);
    assert.ok(!CHANNEL_GROUP_KEYS["Google Ads"].includes("google-ads"));
  });

  it("os braços do teste 2608 são os nomes novos", () => {
    assert.deepEqual([...ADS_TEST_2608_BRACOS].sort(), [...NOVOS].sort());
  });
});

describe("#5862 — canonicalChannelName", () => {
  it("troca cada nome antigo pelo novo", () => {
    for (const [antigo, novo] of Object.entries(LEGACY_CHANNEL_NAME_ALIASES)) {
      assert.equal(canonicalChannelName(antigo), novo);
    }
    assert.equal(Object.keys(LEGACY_CHANNEL_NAME_ALIASES).length, 3);
  });

  it("troca o prefixo de um rótulo de sub-campanha", () => {
    assert.equal(canonicalChannelName("Microsoft Ads (teste 2608) — PMax"), "Microsoft Ads (UTM) — PMax");
    assert.equal(canonicalChannelName("Microsoft Ads (teste 2608) - Search"), "Microsoft Ads (UTM) - Search");
  });

  it("deixa os outros nomes como estão e é idempotente", () => {
    for (const canal of ["Google Ads", "LinkedIn", "Beehiiv Boosts", "Meta", "Google Ads (teste 2608)x", ...NOVOS]) {
      if (canal.endsWith("x")) {
        assert.equal(canonicalChannelName(canal), canal, "sem separador depois do prefixo, não é o mesmo canal");
        continue;
      }
      assert.equal(canonicalChannelName(canal), canal);
    }
    for (const antigo of Object.keys(LEGACY_CHANNEL_NAME_ALIASES)) {
      const uma = canonicalChannelName(antigo);
      assert.equal(canonicalChannelName(uma), uma);
    }
  });
});

describe("#5862 — spend.csv com os nomes antigos continua atribuído (#5860)", () => {
  // Forma real de data/aquisicao/spend.csv em 27/10/2026.
  const SPEND_CSV = [
    "canal,mes,moeda,valor,fonte,subcanal",
    'Google Ads,2026-02,BRL,718.39,"painel Google Ads",PMax',
    'Google Ads,2026-02,BRL,239.62,"painel Google Ads",Search',
    "Google Ads (teste 2608),2026-09,BRL,1147.77,google-ads-api,",
    "Meta Ads (teste 2608),2026-09,BRL,1435.51,meta-graph-api,",
    "Meta Ads (teste 2608),2026-10,BRL,8.3,meta-graph-api,",
    "Microsoft Ads (teste 2608),2026-09,BRL,835.97,microsoft-ads-api,",
  ].join("\n");

  it("parseSpendCsv devolve as linhas antigas com o nome novo e mantém o legado 'Google Ads'", () => {
    const { rows, errors } = parseSpendCsv(SPEND_CSV);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      rows.map((r) => r.canal),
      ["Google Ads", "Google Ads", GOOGLE_ADS_UTM_CANAL, META_ADS_UTM_CANAL, META_ADS_UTM_CANAL, MICROSOFT_ADS_UTM_CANAL],
    );
  });

  it("buildCacReport não manda nenhum gasto antigo pra 'canal desconhecido'", () => {
    const { rows } = parseSpendCsv(SPEND_CSV);
    const sub: BeehiivBackupSubscriber = {
      email: "leitor@example.com",
      status: "active",
      created: Date.parse("2026-09-10T12:00:00Z") / 1000,
      utm_source: "meta-ads",
      utm_medium: "cpc",
      utm_campaign: "ads-meta-2608",
      referring_site: "",
      stats: { total_received: 30, total_unique_clicked: 2, total_unique_opened: 20 },
    };
    const report = buildCacReport(rows, [sub]);
    assert.deepEqual(report.unmappedChannels, []);
    assert.deepEqual(report.unattributedSpend, []);
    const meta = report.rows.filter((r) => r.canal === META_ADS_UTM_CANAL);
    assert.equal(meta.length, 2);
  });

  it("sumTeste2608Spend soma o gasto dos 3 braços lido do arquivo antigo", () => {
    const { rows } = parseSpendCsv(SPEND_CSV);
    assert.equal(sumTeste2608Spend(rows), Number((1147.77 + 1435.51 + 8.3 + 835.97).toFixed(2)));
  });
});

describe("#5862 — artefatos congelados do teste 2608 lidos com o nome novo", () => {
  it("parseClicksCsv", () => {
    const csv = [
      "canal,data_apuracao,gasto_acumulado",
      "Google Ads (teste 2608),2026-09-05,102.61",
      "Microsoft Ads (teste 2608),2026-09-05,1.34",
    ].join("\n");
    const { rows, errors } = parseClicksCsv(csv);
    assert.deepEqual(errors, []);
    assert.deepEqual(rows.map((r) => r.canal), [GOOGLE_ADS_UTM_CANAL, MICROSOFT_ADS_UTM_CANAL]);
  });

  const runStateAntigo = () => ({
    d0: "2026-09-05",
    fim_janela: "2026-09-23",
    religar_brevo: "2026-09-26",
    coorte_madura: "2026-10-20",
    apuracao_snapshot: "2026-10-21",
    bracos: ["Google Ads (teste 2608)", "Microsoft Ads (teste 2608)", "Meta Ads (teste 2608)"],
    registrado_em: "2026-09-05T02:54:26.025Z",
    revisao: {
      pausa: {
        inicio: "2026-09-09T16:05:36-03:00",
        fim: "2026-09-17T00:16:00-03:00",
        inicio_por_braco: {
          "Google Ads (teste 2608)": "2026-09-09T16:05:49-03:00",
          "Meta Ads (teste 2608)": "2026-09-09T16:05:36-03:00",
          "Microsoft Ads (teste 2608)": "2026-09-09T16:18:21-03:00",
        },
      },
    },
  });

  it("assertValidRunState normaliza bracos e inicio_por_braco do run-state.json real", () => {
    const raw: unknown = runStateAntigo();
    assertValidRunState(raw);
    assert.deepEqual(raw.bracos, [GOOGLE_ADS_UTM_CANAL, MICROSOFT_ADS_UTM_CANAL, META_ADS_UTM_CANAL]);
    const pausa = raw.revisao?.pausa as unknown as { inicio_por_braco: Record<string, string> };
    assert.deepEqual(Object.keys(pausa.inicio_por_braco).sort(), [...NOVOS].sort());
    assert.equal(pausa.inicio_por_braco[MICROSOFT_ADS_UTM_CANAL], "2026-09-09T16:18:21-03:00");
  });

  it("canonicalizeRunStateChannelNames tolera forma inválida sem lançar", () => {
    assert.equal(canonicalizeRunStateChannelNames(null), null);
    assert.deepEqual(canonicalizeRunStateChannelNames({ bracos: "x", revisao: { pausa: [null, { inicio_por_braco: [] }] } }), {
      bracos: "x",
      revisao: { pausa: [null, { inicio_por_braco: [] }] },
    });
  });

  it("normalizeEdicaoRegistro (edicoes.jsonl)", () => {
    const n = normalizeEdicaoRegistro({ braco: "Google Ads (teste 2608)", ts: "2026-09-06T15:23:21.363Z", tipo: "edicao-em-voo" });
    assert.equal(n?.braco, GOOGLE_ADS_UTM_CANAL);
    const todos = normalizeEdicaoRegistro({ ts: "2026-09-06T15:23:21.363Z", tipo: "edicao-em-voo" });
    assert.equal(todos?.braco, "todos");
  });

  it("parseEmendaGastoPorFase (gasto-fases-2608.json)", () => {
    const out = parseEmendaGastoPorFase({
      "Google Ads (teste 2608)": { "pre-pausa": 500.91, "pos-retomada": 646.88 },
      "Meta Ads (teste 2608)": { "pre-pausa": 517.86, "pos-retomada": 917.65 },
    });
    assert.deepEqual(Object.keys(out).sort(), [GOOGLE_ADS_UTM_CANAL, META_ADS_UTM_CANAL].sort());
    assert.equal(out[GOOGLE_ADS_UTM_CANAL]["pos-retomada"], 646.88);
  });
});
