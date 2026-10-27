# Beehiiv como arquivo (#11225)

Decisão do editor de 27/10/2026: nenhuma dependência Beehiiv no pipeline diário; envio exclusivamente Kit. Conta, plano, posts, site, estatísticas e assinantes arquivados preservados. Nenhuma ação externa faz parte desta mudança.

| Componentes | Classificação e motivo |
| --- | --- |
| `backup-beehiiv.ts`, agents `beehiiv-engagement-backup`, `beehiiv-exit-history-drain`, `beehiiv-clicks-enricher` | Manter leitura/backup do histórico, somente em rotinas auxiliares. Sem exigência de posts novos. |
| `beehiiv-sync.ts`, `fetch-beehiiv-poll-stats.ts`, `diaria-subscribers-ingest-beehiiv.ts` | Manter leitura histórica e ingestão local. Não representam assinantes ou resultados atuais do Kit. |
| `reconcile-beehiiv-kit.ts` | Manter auditoria auxiliar somente leitura; não usar como guard da edição. |
| `beehiiv-backup-staleness-alarm.ts` | Manter: mede execução/utilidade do snapshot, cobertura e completude do histórico; não mede novos envios. Arquivo estático ainda precisa de backup íntegro. |
| `sync-apoio-nivel-beehiiv.ts`, `sync-apoio-segments-beehiiv.ts`, `sync-sparkloop-exclusion-segment-beehiiv.ts`, skill `diaria-apoios-sync` | Aposentados: CLI retorna antes de rede/escrita. Apoio ativo usa `sync-apoio-nivel-kit.ts` e `sync-apoio-mensal-tag-kit.ts`. Helpers preservados para interpretar/testar dados antigos. |
| `sync-beehiiv-subscribers-kit.ts` | Ponte aposentada: CLI sem efeitos. O consumidor ativo, auto-confirmação histórica em `evaluate-brevo-diaria.ts`, agora cria/verifica no Kit antes de liberar a fila Brevo. Task registrada permanece um no-op compatível. |
| `evaluate-brevo-diaria.ts` | Promoção somente Kit, inclusive sem backend explícito. Leitura Beehiiv residual serve somente à confirmação de contatos históricos; descadastro nativo não altera mais o arquivo. Campos/estados `beehiiv_*` do store são compatibilidade histórica, não destino de envio. |
| `reconcile-send-audiences.ts` | Somente Kit/Brevo; não exige API/config Beehiiv nem mede entrega/ativos do arquivo. |
| `kit-diaria-channel.ts`, `schedule-kit-diaria.ts` | Canal paralelo aposentado inclusive com backend legado/ausente e `enabled:true`, impedindo duplicidade. Estado histórico mantido. |

Os playbooks Beehiiv de publicação e preparação manual documentam o procedimento antigo; não autorizam publicar. `publishing.newsletter.backend` sempre resolve para Kit. Seletores de leitura histórica continuam independentes.
