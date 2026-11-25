# Vigia externo do 300 (#12981)

Deployado e armado em 25/11/2026 (Worker com secrets Gmail, cron `*/5`, timer de heartbeat no 300). Ainda NÃO validado com e-mail real: falta o ensaio do passo 6.

## Infra investigada

Os alarmes locais usam Gmail API/OAuth (`scripts/lib/gmail-send.ts` e
`google-auth.ts`), cujo token reside em `data/.credentials.json` no host.
Esse arquivo não existe automaticamente num Worker e não pode ser importado no
bundle. O namespace existente `diaria-ops-state`, configurado em
`platform.config.json`, já é consumido pelo Neo (#12982). O novo Worker usa
esse mesmo namespace; não inventa um namespace ou um serviço de e-mail.

`workers/infra-watchdog` lê `infra:heartbeat:300` a cada 5 min (cron ativo desde 25/11/2026).
O valor é JSON `{timestamp: ISO-8601 UTC, hostname: string}`. Idade >20 min é
`atrasado`; ausência, JSON inválido ou relógio >1 min no futuro é `ausente`.
Ambos abrem incidente. Falha de leitura lança erro e não abre/fecha incidente.
O heartbeat não expira, permitindo distinguir atraso de ausência.

Um Durable Object singleton `300` serializa as checagens, persiste o instante
da primeira detecção e a confirmação do envio, e espelha o instante ISO em
`infra:300:down-since` antes do e-mail. Retorno remove a chave e envia aviso
uma vez; nova queda inicia novo incidente. O Neo já aceita o valor ISO não
vazio em `readDownSignal`. KV tem consistência eventual: propagação e cron
podem acrescentar atraso à janela de 20 min, inclusive à retirada do sinal.

A confirmação do Gmail precede o marcador de envio. Falhas são visíveis no
Worker e permitem retry na próxima checagem. Há uma janela inevitável entre
Gmail aceitar o e-mail e persistir a confirmação (ou resposta de rede perdida):
nesse caso pode haver duplicata. Gmail não oferece chave idempotente de envio;
a garantia testada é um envio por transição com respostas confirmadas, não
exactly-once distribuído. O sinal operacional independe do sucesso do e-mail.

## Bloqueio exato para ativação (ação operacional separada)

1. Provisionar o novo Worker e a migração SQLite `InfraWatchdog`, com binding
   `WATCHDOG`, e autorizar o binding `OPS_STATE` ao namespace existente.
   A configuração versionada descreve isso; existência/permissões remotas
   não foram presumidas nem alteradas nesta implementação.
   O workflow `deploy-infra-watchdog.yml` usa o deploy reutilizável padrão,
   mas só executa quando a variável de repositório
   `INFRA_300_WATCHDOG_DEPLOY_ENABLED` é exatamente `true` (inclusive no
   dispatch manual). Deixá-la ausente/desabilitada até autorização; depois,
   habilitá-la e disparar o workflow para provisionar. Com o cron declarado no
   TOML (passo 5), todo deploy deste Worker também arma o cron.
2. Provisionar secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_REFRESH_TOKEN` com escopo `gmail.send` e `EDITOR_EMAIL`, usando
   a conta editorial autorizada dos alarmes. Confirmar que o token é válido
   e que sua custódia no Worker é autorizada. Nenhum segredo foi lido/copiado.
3. No 300, definir `INFRA_300_HOSTNAME` com o hostname real (comparação exata)
   no `.env`; confirmar as credenciais KV que o resolver já exige. Rodar
   `npx tsx scripts/infra-300-heartbeat.ts --dry-run` antes da escrita real.
4. Somente em ativação autorizada, instalar os templates de user systemd em
   `infra/infra-300-heartbeat/` (ajustar WorkingDirectory ao checkout real,
   confirmar `npx` no PATH do serviço), e habilitar o timer. Os templates
   não são instalados pelo merge nem pelo remediador de tasks do projeto.
5. Configurar o Cron Trigger `*/5 * * * *` após o primeiro heartbeat. Feito em
   25/11/2026: o TOML passou a declarar `crons = ["*/5 * * * *"]` (o deploy
   aplica o cron; um cron posto só pelo painel seria apagado no deploy seguinte).
6. Em janela supervisionada, parar só o timer por 30 min, conferir 1 e-mail
   e `down-since`, retomar e conferir 1 retorno e remoção do sinal. Confirmar
   também logs do Worker para erros de OAuth/envio. Não parar o 300 inteiro.

Rollback: desligar o cron ANTES de qualquer outra coisa, por PR que volta o
TOML a `crons = []` (desligar só no painel é desfeito pelo próximo deploy; se
for urgente, desligar no painel e pôr `INFRA_300_WATCHDOG_DEPLOY_ENABLED=false`
até a PR entrar). Com o cron ligado, o Worker regrava `down-since` a cada 5 min
durante a queda. Depois, parar o timer do heartbeat no 300; remover `down-since` somente após confirmar
que o 300 está saudável, evitando induzir o Neo a tomar posse indevidamente.
Não alterar o lease `infra:scheduler-owner` por este monitor.

## Validação local

`npx tsx --test test/infra-300-heartbeat.test.ts` simula passagem do tempo,
queda, retorno, persistência entre checagens e falhas sem chamar rede.
Templates são artefatos inertes, não agendamento ativo. Referências oficiais:
[DO concurrency barrier](https://developers.cloudflare.com/durable-objects/api/state/)
e [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
