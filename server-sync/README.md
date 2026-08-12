# Sincronização automática via GitHub Actions

> ## ⚠️ AÇÃO NECESSÁRIA: regerar o refresh token (uma vez)
>
> A sincronização agora é de **mão dupla** — o que é alterado no site é gravado de volta no
> Google Agenda. Para isso o servidor precisa de permissão de **escrita**, e o refresh token
> atual só tem permissão de leitura. **Enquanto este passo não for feito, a leitura
> (Google → site) continua funcionando normalmente, mas nada do site chega na agenda.**
>
> **Passo 1 — pegar as credenciais do OAuth Client "Desktop".**
> No *Google Cloud Console → APIs e Serviços → Credenciais*, clique no OAuth Client do tipo
> **Aplicativo para computador** e copie o ID do cliente e a chave secreta. (Se a chave não
> aparecer na tela, use **Transferir JSON** e guarde o arquivo baixado.)
>
> **Passo 2 — salvar em `server-sync/.oauth-client.json`** (já está no `.gitignore`):
> ```json
> {
>   "client_id": "....apps.googleusercontent.com",
>   "client_secret": "GOCSPX-..."
> }
> ```
> O JSON baixado do próprio Google também serve, sem editar nada.
>
> **Passo 3 — rodar o script:**
> ```bash
> node server-sync/get-refresh-token.js
> ```
>
> Ele abre o navegador sozinho. Faça login **com a conta da agenda** (`kris.noleto@gmail.com`),
> não com outra — o token fica preso na conta que autorizar. Aceite **todas** as permissões
> pedidas, inclusive a de gerenciar/editar os eventos.
>
> O resto é automático: o script confere se a permissão de escrita foi mesmo concedida,
> grava o refresh token direto no GitHub Secret `GOOGLE_REFRESH_TOKEN` (via `gh`, sem o token
> passar pela tela ou pelo histórico do shell) e dispara uma sincronização de teste.
>
> Se algo falhar, ele diz exatamente o quê — inclusive o caso em que o Google concede só
> leitura. E enquanto o token não tiver escopo de escrita, o próprio site mostra o aviso na
> aba **Google Agenda**, em vez de o erro ficar escondido no log do Actions.



Isso é o "plano B" caso o teste de deixar o app aberto com a tela apagada não seja suficiente
(ex: precisa funcionar com o celular bloqueado, ou o computador desligado). Roda inteiramente
no servidor do GitHub, de graça, sem depender de nenhum navegador aberto.

Nada disto está ativo ainda — os arquivos só estão prontos para quando vocês decidirem ligar.

## Passo a passo para ativar (feito uma única vez)

1. **Criar um repositório no GitHub** (pode ser privado) e subir esta pasta do projeto para lá.

2. **Criar um novo OAuth Client no Google Cloud Console**, tipo **"Desktop app"** (diferente do
   Client ID "Web" que o `controle-visitas.html` já usa) — em *APIs e Serviços → Credenciais →
   Criar credenciais → ID do cliente OAuth → Tipo: Aplicativo para computador*. Guarde o Client ID
   e o Client Secret gerados.

3. **Gerar o refresh token, uma única vez, rodando localmente:**
   ```bash
   cd server-sync
   npm install
   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node get-refresh-token.js
   ```
   Abra a URL impressa no terminal, faça login com a conta Google onde está a agenda a sincronizar,
   aceite a permissão. O terminal imprime o `refresh_token` — copie e guarde, ele só aparece uma vez.

4. **Gerar a chave da conta de serviço do Firebase** — Console do Firebase → ⚙️ Configurações do
   projeto → Contas de serviço → **Gerar nova chave privada**. Baixa um arquivo `.json`.

5. **No repositório do GitHub → Settings → Secrets and variables → Actions → New repository secret**,
   cadastrar 4 segredos:
   - `GOOGLE_CLIENT_ID` — o Client ID do passo 2
   - `GOOGLE_CLIENT_SECRET` — o Client Secret do passo 2
   - `GOOGLE_REFRESH_TOKEN` — o token do passo 3
   - `FIREBASE_SERVICE_ACCOUNT_JSON` — o conteúdo **inteiro** do arquivo `.json` do passo 4 (colar como texto)

6. Pronto. O workflow em `.github/workflows/gcal-sync.yml` já está agendado para rodar a cada
   30 minutos assim que os secrets existirem. Para testar sem esperar, vá na aba **Actions** do
   repositório → "Sincronizar Google Agenda" → **Run workflow**.

## O que esse script faz

`sync.js` replica exatamente a mesma lógica de importação que o `controle-visitas.html` já usa
no navegador (mesmos filtros de calendário, mesmo critério de "é uma visita" pelo título, mesmos
campos gravados) — só que rodando no servidor do GitHub, então funciona independente de qualquer
navegador ou dispositivo estar ligado. Grava direto na mesma coleção `visits` do Firestore que o
app já lê em tempo real — o app não precisa saber que a sincronização rodou em outro lugar.

## Segurança

`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` e a chave da conta de serviço do Firebase são
segredos de verdade — nunca cole eles no `controle-visitas.html` nem em nenhum arquivo commitado
no repositório. Eles só devem existir dentro dos **GitHub Secrets** (criptografados, não aparecem
nos logs do workflow).
