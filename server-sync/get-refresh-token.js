/**
 * Passo único e manual: gera o refresh token do Google Agenda que o workflow do
 * GitHub Actions vai usar para sempre, sem precisar de navegador aberto.
 *
 * Como rodar (a partir da pasta do projeto):
 *   node server-sync/get-refresh-token.js
 *
 * As credenciais podem vir de duas formas — escolha uma:
 *   a) arquivo `server-sync/.oauth-client.json` (recomendado, não vaza no histórico do shell):
 *        { "client_id": "....apps.googleusercontent.com", "client_secret": "GOCSPX-..." }
 *   b) variáveis de ambiente GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.
 *
 * São as credenciais do OAuth Client tipo "Aplicativo para computador" (Desktop) no
 * Google Cloud Console — NÃO é o Client ID "Web" que o site usa no navegador.
 *
 * O que o script faz sozinho:
 *   1. Abre o navegador na tela de autorização do Google.
 *   2. Confere se o Google concedeu mesmo a permissão de ESCRITA (calendar.events).
 *   3. Grava o refresh token direto no GitHub Secret GOOGLE_REFRESH_TOKEN (via gh).
 *   4. Dispara uma sincronização de teste.
 * O token nunca é impresso na tela nem passa pela linha de comando.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawnSync, exec } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CLIENT_FILE = path.join(__dirname, '.oauth-client.json');
const FALLBACK_FILE = path.join(__dirname, '.refresh-token.secret');
const WORKFLOW = 'gcal-sync.yml';

// LEITURA + ESCRITA. O `calendar.events` é o que permite ao sync.js gravar de volta no
// Google Agenda (alterar, criar e excluir compromissos); o `calendar.readonly` continua
// necessário para listar os calendários da conta.
const SCOPE = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly';
const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function lerCredenciais() {
  let id = process.env.GOOGLE_CLIENT_ID;
  let secret = process.env.GOOGLE_CLIENT_SECRET;
  if ((!id || !secret) && fs.existsSync(CLIENT_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
      // aceita tanto o formato simples quanto o JSON que o Google Cloud Console baixa
      const fonte = j.installed || j.web || j;
      id = id || fonte.client_id;
      secret = secret || fonte.client_secret;
    } catch (e) {
      console.error('Não consegui ler ' + CLIENT_FILE + ': ' + e.message);
    }
  }
  return { id, secret };
}

const { id: CLIENT_ID, secret: CLIENT_SECRET } = lerCredenciais();

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(`
Faltam as credenciais do OAuth Client "Desktop".

Onde pegar:
  Google Cloud Console -> APIs e Serviços -> Credenciais
  -> clique no OAuth Client do tipo "Aplicativo para computador"
  -> copie o "ID do cliente" e a "Chave secreta do cliente"
     (se a chave não aparecer, use "Transferir JSON" e salve o arquivo baixado)

Depois, crie o arquivo server-sync/.oauth-client.json com:

  {
    "client_id": "....apps.googleusercontent.com",
    "client_secret": "GOCSPX-..."
  }

(ou salve ali o próprio JSON baixado do Google) e rode este script de novo.
`);
  process.exit(1);
}

function gh(args, input) {
  return spawnSync('gh', args, { cwd: REPO_ROOT, input, encoding: 'utf8', shell: process.platform === 'win32' });
}

function abrirNavegador(url) {
  // GCAL_NO_BROWSER=1 desliga a abertura automática — útil quando outra ferramenta
  // já vai conduzir a autorização numa aba específica, para não abrir duas.
  if (process.env.GCAL_NO_BROWSER) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => { });
}

function guardarToken(refreshToken) {
  // Caminho preferido: manda direto para o GitHub Secret, via stdin — assim o valor
  // não aparece na lista de processos nem no histórico do shell.
  const res = gh(['secret', 'set', 'GOOGLE_REFRESH_TOKEN'], refreshToken);
  if (res.status === 0) {
    console.log('\n✅ GitHub Secret GOOGLE_REFRESH_TOKEN atualizado.');
    if (fs.existsSync(FALLBACK_FILE)) {
      fs.unlinkSync(FALLBACK_FILE);
      console.log('   (arquivo local antigo de token apagado)');
    }
    return true;
  }

  fs.writeFileSync(FALLBACK_FILE, refreshToken, { mode: 0o600 });
  console.error('\n⚠️  Não consegui atualizar o GitHub Secret automaticamente.');
  console.error('   Motivo: ' + String(res.stderr || res.error || 'gh não encontrado').trim());
  console.error('\n   O token foi salvo em: ' + FALLBACK_FILE);
  console.error('   Atualize na mão e apague o arquivo depois:');
  console.error('     gh secret set GOOGLE_REFRESH_TOKEN < "' + FALLBACK_FILE + '"');
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Autorização negada.</h1>Pode fechar esta aba.');
    console.error('\nGoogle retornou erro: ' + error);
    server.close();
    process.exitCode = 1;
    return;
  }

  try {
    const port = server.address().port;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(JSON.stringify(tokenData));

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Pronto!</h1>Pode fechar esta aba e voltar ao terminal.');

    // 1. A permissão de escrita foi mesmo concedida?
    const concedidos = String(tokenData.scope || '');
    if (!concedidos.includes(REQUIRED_SCOPE)) {
      console.error('\n❌ O Google NÃO concedeu a permissão de escrita (calendar.events).');
      console.error('   Permissões concedidas: ' + (concedidos || '(nenhuma informada)'));
      console.error('\n   Na tela de autorização, a caixa de gerenciar/editar os eventos precisa');
      console.error('   ficar marcada. Rode o script de novo e aceite todas as permissões pedidas.');
      process.exitCode = 1;
      return;
    }

    // 2. Veio refresh token? (só vem com access_type=offline + prompt=consent)
    if (!tokenData.refresh_token) {
      console.error('\n❌ Não veio refresh_token.');
      console.error('   Revogue o acesso em https://myaccount.google.com/permissions e rode de novo.');
      process.exitCode = 1;
      return;
    }

    console.log('\n✅ Permissão de escrita concedida (calendar.events).');

    // 3. Guarda o token onde o robô do GitHub vai ler.
    const guardado = guardarToken(tokenData.refresh_token);
    if (!guardado) return;

    // 4. Testa de verdade, disparando uma sincronização.
    console.log('\nDisparando uma sincronização de teste...');
    const run = gh(['workflow', 'run', WORKFLOW, '--ref', 'main']);
    if (run.status === 0) {
      console.log('✅ Sincronização disparada.');
      console.log('\nAcompanhe com:  gh run list --limit 3');
      console.log('Em ~40 segundos, confira no site se o aviso vermelho sumiu e se a');
      console.log('alteração que estava pendente apareceu no Google Agenda.\n');
    } else {
      console.log('(Não consegui disparar automaticamente — rode pela aba Actions do GitHub.)\n');
    }
  } catch (e) {
    res.writeHead(500); res.end('Erro ao trocar o código por tokens — veja o terminal.');
    console.error('\n❌ ' + e.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline'); // exige refresh_token
  authUrl.searchParams.set('prompt', 'consent');       // força reemitir o refresh_token mesmo se já autorizou antes

  const url = authUrl.toString();
  console.log('\n============================================================');
  console.log(' ATENÇÃO: faça login com a conta DONA DA AGENDA');
  console.log(' (kris.noleto@gmail.com) — não com outra conta.');
  console.log(' O token fica preso na conta que autorizar.');
  console.log('============================================================\n');
  console.log('Abrindo o navegador. Se não abrir, use este endereço:\n');
  console.log(url + '\n');
  console.log('Aguardando você autorizar...\n');
  abrirNavegador(url);
});
