# Vigia externo do 300 (#12981)

Deployado e armado em 25/11/2026 (Worker com secrets Gmail, cron `*/5`, timer de heartbeat no 300). Ensaio feito no mesmo dia (passo 6 abaixo): 1 e-mail "[infra] 300 sem heartbeat", nenhum repetido, e 1 e-mail "[infra] 300 voltou".

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

**Sondas de saída (#14368).** Desde o #14368 o valor é
`{timestamp, hostname, probes: {github, r2}}`. A cada batida o script faz um
HEAD (timeout de 5 s, em paralelo) em `https://api.github.com/` e no endpoint
S3 do R2 (`https://{R2_ACCOUNT_ID ou CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/`).
Qualquer resposta HTTP conta como `ok` (o R2 responde 400/403 a um HEAD sem
assinatura: o que se mede é DNS, TCP e TLS chegando ao host); erro de rede ou
timeout é `falha`; sem id de conta é `sem-config`. A falha de uma sonda nunca
impede a gravação do heartbeat: a queda parcial aparece como heartbeat fresco
com sonda em falha. O Worker só avalia as sondas num heartbeat `fresco` (o
atrasado/ausente já é o alarme de queda total), conta batidas pelo
`timestamp` distinto (a mesma batida lida em dois crons conta uma vez) e
manda um e-mail "[infra] 300 sem acesso a {host}" quando a sonda falha em 3
batidas seguidas (`PROBE_FAIL_BEATS`, ~15 min), e um "voltou a acessar" quando
ela responde de novo. O canal é o mesmo Gmail do Worker, que não depende do
GitHub nem da rede do 300. Heartbeat sem `probes` (script antigo) ou sonda
`sem-config` nunca alarma. Estado por sonda no Durable Object (chave
`probes`), com o "voltou" retido para retry se o envio falhar, no mesmo
padrão do #14136.

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

## Ativação (feita em 25/11/2026)

Registro do que foi feito, na ordem, para refazer se o Worker for recriado:

1. Worker e migração SQLite `InfraWatchdog` (binding `WATCHDOG`; `OPS_STATE`
   no namespace existente). O workflow `deploy-infra-watchdog.yml` só executa
   com a variável de repositório `INFRA_300_WATCHDOG_DEPLOY_ENABLED` igual a
   `true` (ligada em 25/11/2026, inclusive no dispatch manual). Com o cron
   declarado no TOML (passo 5), todo deploy deste Worker também arma o cron.
2. Secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
   e `EDITOR_EMAIL`, gravados com `wrangler secret put` por stdin a partir do
   mesmo token dos alarmes locais (`data/.credentials.json`, escopo
   `gmail.send` conferido), com autorização do editor para a custódia no Worker.
3. No 300, `INFRA_300_HOSTNAME=300` (comparação exata com o hostname) vai como
   `Environment=` na unit instalada, não no `.env` (o `sync-env` regrava o
   `.env`). `infra-300-heartbeat.ts --dry-run` antes da 1ª escrita real.
4. Templates de `infra/infra-300-heartbeat/` instalados à mão em
   `~/.config/systemd/user/`, com `ExecStart` apontando para o node do nvm e o
   `Environment=` acima, e o timer habilitado. O merge e o remediador de tasks
   do projeto não instalam esses templates.
5. Cron Trigger `*/5 * * * *`: o TOML declara `crons = ["*/5 * * * *"]` (o
   deploy aplica o cron; um cron posto só pelo painel seria apagado no deploy
   seguinte).
6. Ensaio: timer do heartbeat parado de 18:12Z a 18:38Z (26 min, o bastante
   para passar o limite de 20 min); `down-since` gravado e 1 e-mail de queda às
   18:30Z, nenhum repetido no ciclo das 18:35Z; ao religar, sinal removido e 1
   e-mail de volta às 18:41Z. Os logs do Worker não foram lidos: os dois
   e-mails chegarem foi tomado como prova de OAuth/envio funcionando. Para
   repetir: parar só o timer (nunca o 300 inteiro).

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
`test/infra-300-heartbeat-probes-14368.test.ts` cobre as sondas (fetch
injetado) e o alarme de N batidas seguidas.
No repo os templates são inertes; no 300 estão instalados à mão (passo 4). Referências oficiais:
[DO concurrency barrier](https://developers.cloudflare.com/durable-objects/api/state/)
e [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
