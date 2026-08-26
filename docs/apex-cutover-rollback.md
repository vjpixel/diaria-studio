# Plano de rollback do cutover do apex `diar.ia.br` (#467)

Preparado em **25/08/2026**, antes de qualquer ação. Existe porque a capacidade
central do cutover — `custom_domain = true` no apex depois que a Beehiiv soltar
o custom hostname — **não é testável antes**: o teste é a própria janela.

Medido ao vivo via API da Cloudflare (zona `0c1a216dee80404257ce225a18fae896`).

> **Este documento é o estado PRÉ-cutover.** Se ele divergir da realidade,
> confie na zona, não neste arquivo — e atualize-o.

**Decisão que este plano serve** (registrada nos comentários do #467,
25/08/2026): o apex aponta pro **nosso Worker**; o Kit fica **só com o e-mail**.
Isso não é a única saída possível — o Kit *tem* suporte a página em domínio
raiz (confirmado no #6047) —, foi a escolhida para eliminar o mapa de 301 das
258 edições. Sem esse contexto, a premissa "restaurar A/AAAA para a Beehiiv"
parece contradizer o eixo da migração; não contradiz.

---

## 1. Estado a restaurar (valores exatos)

```
A     diar.ia.br  →  104.16.243.55        proxied=true   ttl=1 (auto)
                     id 9246e7ffc5e6c8df11c979d31ca6cb1e

AAAA  diar.ia.br  →  2001:12ff:0:2::95    proxied=true   ttl=1 (auto)
                     id 1e19bf3285dff54456b607f6564617f7
```

Fatos vizinhos, verificados na mesma medição:

- **`www.diar.ia.br` não existe** na zona. Nada a restaurar ali.
- **0 rotas de Worker** na zona (a fantasma `diar.ia.br/2026/o-agente*` foi
  removida em 25/08 — ver #467). Se aparecer rota nova, não é resíduo: é algo
  que o cutover criou.
- O token de API do projeto **NÃO lê custom hostnames**
  (`Authentication error` em `/custom_hostnames`). O lado Cloudflare for SaaS
  da Beehiiv só é observável pelo painel — não automatizar checagem por ali.
  **Correção (26/08/2026):** o texto original desta linha dizia só "escreve
  DNS" — incompleto. Confirmado ao vivo que o token também escreve **Workers
  routes** da zona (`DELETE /zones/{z}/workers/routes/{id-inexistente}` →
  HTTP **404**, não 403 — 404 prova permissão de escrita, só o recurso não
  existe) e, por extensão, o recurso de Workers Custom Domains usado pelo
  `--cutover` de `scripts/apex-cutover.ts` (ver §7 abaixo). A única lacuna
  real do token é `/custom_hostnames` (produto Cloudflare for SaaS da
  Beehiiv) — nada relacionado à nossa zona.

## 2. Gatilhos de rollback

> ⚠️ **Meça com user-agent de navegador.** `curl` cru leva challenge **403** da
> Cloudflare no apex — e 403 de challenge **não distingue "no ar" de "fora do
> ar"**. Usar o bloco da seção 5; um 403 de `curl -I` NÃO é gatilho.

Reverter **sem discutir** se, após o cutover:

1. `https://diar.ia.br/` não responde 200 por mais de ~10 min *(medido com UA de navegador — ver aviso acima)*
2. `https://diar.ia.br/p/{slug}` de uma edição conhecida não responde 200 *(idem)*
3. O certificado não emite / erro de TLS no apex
4. `/subscribe` ou os formulários param de aceitar cadastro

O critério é **funcional, não estético**. Layout errado se conserta com o apex
já nosso; página fora do ar, não.

## 3. Procedimento

### 3.1. Primeiro: o custom domain do Worker já assumiu o apex?

Isso decide a ordem, e não dá pra adivinhar no meio do incidente:

```bash
npx wrangler deployments domains list 2>/dev/null | grep -i "diar.ia.br"
# ou, se o wrangler não cooperar, olhar no painel:
#   Workers & Pages → {worker} → Settings → Domains & Routes
```

**Se apareceu o apex como custom domain: soltar o binding ANTES de mexer em
DNS** (`npx wrangler deployments domains delete diar.ia.br`, ou pelo painel).
Enquanto o binding existir, a Cloudflare mantém o roteamento pro Worker e o
PATCH de A/AAAA não tem efeito visível.

**Se não apareceu:** ir direto pro 3.2.

### 3.2. Restaurar A/AAAA

**Confirmar que os IDs ainda existem antes de dar PATCH** — anexar um custom
domain pode fazer a Cloudflare criar/gerenciar registro próprio no lugar do
manual, e aí o PATCH contra o id antigo devolve 404 no pior momento:

```bash
ZONE=0c1a216dee80404257ce225a18fae896

curl -s "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records?name=diar.ia.br&type=A" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | grep -o '"id":"[^"]*"'
```

- **Id igual ao da seção 1** → PATCH (abaixo).
- **Id diferente** → PATCH contra o id NOVO, mesmo corpo.
- **Nenhum registro** → criar com POST (mesmo corpo, sem `/{id}` na URL).

```bash
ZONE=0c1a216dee80404257ce225a18fae896

# A
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/9246e7ffc5e6c8df11c979d31ca6cb1e" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"type":"A","name":"diar.ia.br","content":"104.16.243.55","proxied":true,"ttl":1}'

# AAAA
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/1e19bf3285dff54456b607f6564617f7" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"type":"AAAA","name":"diar.ia.br","content":"2001:12ff:0:2::95","proxied":true,"ttl":1}'
```

`ttl: 1` = automático (exigido quando `proxied: true`).

### 3.3. O que este procedimento NÃO toca

Tranquilização pra quem lê sob pressão: **os subdomínios não são afetados.**
`arquivo.`, `especial.`, `livros.`, `cursos.` e `eia.` usam `custom_domain =
true` em rotas próprias, e `news.`/`reativa.` são registros de envio
independentes. Nenhum deles depende do A/AAAA do apex.

## 4. O que o rollback NÃO devolve

Registrado para a decisão de reverter ser informada, não otimista:

- **O custom hostname da Beehiiv precisa ser re-adicionado do lado deles.**
  Soltar é ação no painel da Beehiiv; voltar também é. O DNS apontar de volta
  pros IPs antigos não recria o binding SaaS na ponta deles.
- **Tempo de propagação**: os registros são `proxied=true` com TTL auto, o que
  torna a volta rápida no edge da Cloudflare — mas resolvers intermediários e
  o lado da Beehiiv têm cache próprio.
- **Certificado**: se o cutover emitir cert novo pro apex, reverter pode deixar
  uma janela de incompatibilidade até a Beehiiv reemitir o dela.

**Consequência prática:** rollback é recuperação de indisponibilidade, não um
"desfazer" barato. Vale ter a janela curta e a decisão de reverter tomada cedo.

## 5. Verificação pós-cutover (e pós-rollback)

```bash
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36"
for u in "https://diar.ia.br/" "https://diar.ia.br/robots.txt" \
         "https://diar.ia.br/p/35-mil-bolsas-pra-virar-creator-com-ia" \
         "https://arquivo.diar.ia.br/" "https://especial.diar.ia.br/2026/o-agente/"; do
  printf "%-50s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" --max-time 20 "$u")"
done
```

**Usar user-agent de navegador.** `curl` cru leva challenge 403 da Cloudflare no
apex — achado ao vivo em 25/08, e é medição inútil: 403 de challenge não
distingue "no ar" de "fora do ar".

Sinais de que o cutover **funcionou** (não só "respondeu"):

- `GET /robots.txt` **não** contém `# beehiiv default robots.txt` no topo
- `GET /p/{slug}` de uma edição traz `<html lang="pt-BR">`, não `lang="en"`
- a meta description da página descreve **aquela** edição, não outras (#5101)
- `GET /p/{slug}` (sem barra — forma indexada pelo Google e referenciada no
  repo) dá **200 direto**, não 307. Um 307 aí significa que o
  `html_handling` do Worker voltou a canonicalizar pra COM barra
  (`workers/site/wrangler.toml`), contradizendo o `<link rel="canonical">`
  sem barra que a própria página serve — o cenário de "cópia, canônica
  divergente" do `docs/seo-notes.md` Fato 2, desta vez causado pelo lado do
  Worker. **Diferença do Fato 2:** lá os três sinais estavam CORRETOS e a
  causa era crawl desatualizado do Google — resolveu-se sozinho, sem mexer
  em código. Aqui é config de servidor (`html_handling`) que não muda
  sozinha — exige o fix de 1 linha no `wrangler.toml`, não esperar. **E não
  é gatilho de rollback de DNS** (seção 2): um 307 aqui significa "o Worker
  ainda não está pronto" (bug de config, fix rápido), não "reverter" — o
  gatilho 2 da seção 2 pressupõe `/p/{slug}` fora do ar, não redirecionando.

Os quatro são exatamente o que o cutover existe para consertar; se qualquer um
continuar como antes, o apex ainda não é nosso, independentemente do 200.

## 6. Antes de abrir a janela

- [ ] Reconfirmar a seção 1 contra a zona (este arquivo pode ter envelhecido)
- [ ] Worker do apex **deployado e testado em host alternativo** — a janela não
      é hora de descobrir bug de render
- [ ] Editor com acesso ao painel da Beehiiv aberto (soltar o custom hostname)
      **e** ao da Cloudflare (rollback)
- [ ] Janela fora do horário de envio da edição (06:00 BRT) e do cluster de
      tasks matinais (09:00-09:50) — ver `docs/scheduled-tasks-registry.md`

## 7. `scripts/apex-cutover.ts` — o lado Cloudflare deste plano é um script, não mais um procedimento manual

Achado ao vivo em 26/08/2026 (comentários do #467): o cutover não é "editor em
dois painéis" — é **um**. O painel da Beehiiv (`Disconnect domain`) é o único
passo humano; tudo que este documento descreve do lado Cloudflare (seções 3-5)
está mecanizado em `scripts/apex-cutover.ts`, dry-run por padrão:

```bash
npx tsx scripts/apex-cutover.ts --status              # lê o estado atual (nunca muta)
npx tsx scripts/apex-cutover.ts --cutover              # imprime o plano (dry-run)
npx tsx scripts/apex-cutover.ts --cutover --apply      # executa
npx tsx scripts/apex-cutover.ts --rollback             # imprime o plano (dry-run)
npx tsx scripts/apex-cutover.ts --rollback --apply     # executa — restaura exatamente a §1
```

O que o script faz por você, e onde:

- **§1 (estado a restaurar):** `--status` lê os registros A/AAAA do apex com
  os IDs atuais direto da zona — nunca precisa reconferir este arquivo à mão.
- **§2 (gatilhos):** `--status` já mede com User-Agent de navegador, pelos
  mesmos paths desta seção.
- **§3 (procedimento):** `--rollback` faz a ordem certa sozinho — solta o
  Custom Domain (3.1) ANTES de restaurar A/AAAA (3.2), e resolve o "id
  diferente" da 3.2 automaticamente (lê o id atual e faz PATCH nele).
  **Rode `--status` IMEDIATAMENTE antes de `--rollback --apply`** — o
  dry-run do rollback (`--rollback` sem `--apply`) imprime o PLANO (attach a
  soltar + patches/creates), não os registros crus da zona, então uma
  duplicata (2 registros A, por exemplo um remanescente do Custom Domain
  mais um manual) não fica visível ali. `--status` imprime `dns.A`/`dns.AAAA`
  crus — é onde uma duplicata aparece antes de decidir aplicar. Desde a PR
  #6364, uma duplicata detectada faz `--rollback` (com ou sem `--apply`)
  **lançar** em vez de silenciosamente escolher "o primeiro registro" — mas
  o operador só vê a mensagem de erro DEPOIS de já ter tentado; rodar
  `--status` antes evita a surpresa.
- **`--cutover`** mecaniza o passo que faltava documentar aqui: anexa o apex
  ao Worker `diaria-site` via **Workers Custom Domain**
  (`PUT /accounts/{account}/workers/domains`) — o mesmo mecanismo por trás de
  `custom_domain = true` em `wrangler.toml`, comprovado 3× em produção neste
  projeto (`livros.`, `cursos.`, `especial.diar.ia.br`). Justificativa
  completa do porquê deste mecanismo (e não uma Workers Route clássica, já
  refutada pra este apex, nem editar `wrangler.toml` + `wrangler deploy`) no
  docstring de `scripts/lib/apex-cutover.ts`. **Guard de pré-condição
  embutido:** recusa (exit 1) a menos que `/` sirva 200 **com o `<title>`
  real no corpo** (não só "responder alguma coisa" — um Worker que capture
  uma exceção e devolva 200 com página de erro passaria despercebido só com
  status) **e** `/subscribe` **redirecione (3xx)** pro perfil Kit hospedado
  (`diar-ia-br.kit.com`) — `/subscribe` é um redirect por design, não uma
  página 200 (#6359/#6363/#6365, em implementação paralela a este script).
- **Verificação pós-mutação (#573):** todo `--apply` termina relendo o
  estado da API (nunca confia na resposta do PUT/PATCH/POST/DELETE).
- **O que o script NUNCA toca:** MX/TXT/CAA do apex, nem a Beehiiv — o
  `Disconnect domain` continua manual, no painel dela.

Testes: `test/apex-cutover.test.ts` (miolo puro — `scripts/lib/apex-cutover.ts`,
sem rede, sem mock de `fetch`) e `test/apex-cutover-script.test.ts` (camada de
I/O do script — `fetch` mockado com um estado de zona em memória, mesmo
padrão de `test/worker-drift-check-script.test.ts`; cobre a sequência guard →
mutação → verificação, contagem de chamadas de mutação com/sem `--apply`, e
os exit codes 1/2/3).
