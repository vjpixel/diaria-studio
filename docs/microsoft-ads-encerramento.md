# Microsoft Ads: canal encerrado (21/10/2026)

**Decisão do editor, 21/10/2026 (`/diaria-develop 261021`, issue #10755): a diar.ia.br não usa mais o Microsoft Ads.** Antes de reativar o canal, leia esta página.

## Por quê

O canal ficou parado depois do teste 2608 (#5524). O braço Microsoft gastou R$ 835,97 entre 05 e 22/09/2026 e trouxe 1 cadastro e 0 leitores (#10733, cancelada). O custo por cadastro ficou uma ordem de grandeza acima de Google e Meta no mesmo teste.

## O que saiu do repo (#10755)

- Task agendada `Diaria-Microsoft-Ads-Spend-Ingest` (diária 09:52 BRT, #7544). O nome está em `RETIRED_TASK_NAMES` (`scripts/lib/scheduled-tasks.ts`): até o timer ser desarmado na `300`, o disparo vira no-op (exit 0).
- Scripts de ingestão e de motivos editoriais: `scripts/microsoft-ads-ingest-spend.ts`, `scripts/lib/microsoft-ads-ingest.ts`, `scripts/microsoft-ads-editorial-reasons.ts`, `scripts/lib/microsoft-ads-editorial-reasons.ts`, com os testes próprios.
- O braço Microsoft do alarme `Diaria-Ads-Spend-Ingest-Alarm` (o log parado viraria `alarm-no-run` todo dia).
- A busca ao vivo da Reporting API em `scripts/lib/ads-campaign-economics-fetch.ts` (página `/ads` do Studio e `scripts/ads-live-spend-signups.ts`), com a quebra de gasto por campanha (#8256) e o workaround de variáveis de ambiente do #8237.
- `docs/microsoft-ads-api-setup.md` e o bloco `MICROSOFT_ADS_*` do `.env.example`.

## O que fica (log de atividades)

- **Nada em `data/` foi apagado.** O gasto já gravado em `data/aquisicao/spend.csv`, o log `data/aquisicao/.microsoft-ads-ingest.log`, o registro de edições das campanhas (`edicoes.jsonl`, `scripts/ads-registrar-edicao.ts`) e os relatórios congelados em `data/aquisicao/cac-reports/` continuam onde estão.
- O braço `Microsoft Ads (UTM)` (era `Microsoft Ads (teste 2608)` até o #5862, que tornou os nomes permanentes; a linha antiga de `spend.csv` é lida com o nome novo por `canonicalChannelName`) segue em `CHANNEL_KEY_SPECS` e em `ADS_TEST_2608_BRACOS`. É isso que mantém o gasto histórico atribuído no relatório de CAC (`cac-report.ts`) e na apuração do teste 2608 (`sumTeste2608Spend`). Travado por `test/microsoft-ads-encerramento-10755.test.ts`.
- Cadastros que ainda chegam por link antigo continuam classificados certo: `utm_source=microsoft-ads` cai no braço Microsoft, e o `click_id` `msclkid:` é reconhecido como origem paga Microsoft (`resolveOrigemPagaWithClickIdFallback`).
- Na página `/ads`, o braço aparece na tabela de canais com o último gasto reconciliado em `spend.csv` (selo "manual"), sem fonte ao vivo.

## Ações de conta (editor, fora do repo)

1. Desarmar o timer na `300`: `systemctl --user disable --now diaria-microsoft-ads-spend-ingest.timer && rm ~/.config/systemd/user/diaria-microsoft-ads-spend-ingest.{service,timer} && systemctl --user daemon-reload`. O mesmo vale para `diaria-microsoft-ads-editorial-reasons`, se o unit ainda estiver instalado (#10148).
2. Remover do Doppler e dos `.env` das máquinas: `MICROSOFT_ADS_DEVELOPER_TOKEN`, `MICROSOFT_ADS_CUSTOMER_ID`, `MICROSOFT_ADS_ACCOUNT_ID`, `MICROSOFT_ADS_GOOGLE_REFRESH_TOKEN`, `MICROSOFT_ADS_CLIENT_ID`, `MICROSOFT_ADS_CLIENT_SECRET`, `MICROSOFT_ADS_REFRESH_TOKEN`. `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` ficam: o `oauth-setup.ts` também usa.
3. Despublicar no GTM (`GTM-TC8C65ZN`) a tag UET base (`__baut`, ids 17/18 no container v24). A tag de evento UET da proposta `docs/gtm-confirmation-secondary-import-proposal.json` está marcada NAO IMPORTAR.
4. Decidir se a conta Microsoft Advertising é encerrada ou fica parada.

## Reativar

Reativar o canal é decisão nova do editor, com orçamento e hipótese próprios. O código removido está no histórico do git (PR do #10755). Restaurar a ingestão exige recolocar a task no registro, tirar o nome de `RETIRED_TASK_NAMES` e reconfigurar as credenciais.
