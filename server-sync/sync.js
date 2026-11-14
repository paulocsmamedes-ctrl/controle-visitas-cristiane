/**
 * Sincronização de MÃO DUPLA entre o Google Agenda e o Firestore, pensada para
 * rodar sem navegador nenhum aberto (GitHub Actions, disparado a cada 5 min pelo cron-job.org).
 *
 * Ordem de execução de cada ciclo:
 *   1. Busca todos os eventos de todos os calendários (guardando de qual calendário veio cada um).
 *   2. ENVIO: visitas marcadas com `pendingGoogleSync` são gravadas no Google (PATCH ou criação).
 *   3. EXCLUSÃO: tombstones da coleção `googleDeletions` viram exclusão do evento no Google.
 *   4. LEITURA: importa/atualiza visitas a partir do que está hoje no Google.
 *
 * Variáveis de ambiente exigidas (configuradas como GitHub Secrets):
 *   GOOGLE_CLIENT_ID              - Client ID OAuth "Desktop app"
 *   GOOGLE_CLIENT_SECRET          - Client Secret desse mesmo Client ID
 *   GOOGLE_REFRESH_TOKEN          - gerado via get-refresh-token.js, COM escopo de escrita
 *   FIREBASE_SERVICE_ACCOUNT_JSON - conteúdo integral do JSON da service account do Firebase
 */
const admin = require('firebase-admin');
const { createHash } = require('node:crypto');
const cota = require('./quota.cjs');
let primaryCalendarId = 'primary';
// Dono esperado da agenda vem só do secret GOOGLE_CALENDAR_OWNER: o repositório é
// público e não guarda e-mail. Sem ele o ciclo para antes de qualquer escrita.
const EXPECTED_CALENDAR_OWNER = String(process.env.GOOGLE_CALENDAR_OWNER || '').trim().toLowerCase();
// Nos registros públicos do Actions o id da agenda (que costuma ser e-mail) sai como hash curto.
function idParaLog(id) { return 'agenda#' + createHash('sha256').update(String(id)).digest('hex').slice(0, 8); }
// Etapas com dinheiro combinado ou recebido: excluir o compromisso não rebaixa o funil.
const STATUS_PRESERVADOS_NA_EXCLUSAO = new Set(['Vendido', 'Contrato assinado', 'Aguardando desfecho bancário', 'Proposta enviada', 'Aguardando assinatura']);
function calendarKey(id) { return id === 'primary' ? primaryCalendarId : id; }
function eventKey(calendarId, eventId) { return JSON.stringify([calendarKey(calendarId || 'primary'), eventId]); }
function importedVisitId(calendarId, id) { return 'gcal_' + createHash('sha256').update(eventKey(calendarId, id)).digest('hex'); }
function createdEventId(visitId) { return 'crm' + createHash('sha256').update('visit:' + visitId).digest('hex'); }
function sameVersion(a, b) { return !!a.updateTime && !!b.updateTime && a.updateTime.isEqual(b.updateTime); }
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function fetchWithRetry(url, options = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
      if (![429, 500, 502, 503, 504].includes(res.status) || attempt >= 2) return res;
      await res.arrayBuffer();
    } catch (e) { if (attempt >= 2) throw e; }
    await pause(500 * 2 ** attempt);
  }
}

// Limite de segurança por calendário; ultrapassá-lo marca o ciclo como parcial.
// Ausência em uma lista, completa ou não, nunca autoriza apagar visitas.
const MAX_EVENTS_PER_CALENDAR = 20000;
const SYNC_TIME_MIN = '2025-01-01T00:00:00Z';
const SYNC_TIME_MAX = '2035-12-31T23:59:59Z';
const DEFAULT_CALENDAR_ID = 'primary';

// Bloco que este sistema controla dentro da descrição do evento. Tudo que o usuário
// escreveu ANTES deste marcador é preservado intacto a cada gravação.
const DESC_MARKER = '--- Controle de Visitas ---';

// Texto que a importação antiga gravava quando ninguém escrevia nada. Reconhecer
// este valor é o que permite preencher as visitas já importadas sem apagar nota real.
const OBS_IMPORT_PADRAO = 'Importado do Google Agenda';

// Inverso de buildDescription: devolve só o que uma pessoa digitou na descrição do
// evento, descartando o bloco que este próprio sistema escreve do marcador para baixo.
// Sem esse corte, cada sincronização importaria o eco do CRM de volta para a observação.
// A Descrição do evento volta da API como HTML sempre que a pessoa usa o editor
// com formatação do Google Agenda: cada quebra de linha vira <br>, listas viram
// <li>, negrito vira <b>. Sem esta conversão a observação chegaria no CRM com as
// tags à mostra ("Flat 1 Suíte<br>Prédio novo<br>...").
const ENTIDADES_HTML = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
function htmlParaTexto(valor) {
  let t = String(valor || '');
  // Só desmonta tag se houver tag. Mas as entidades são decodificadas SEMPRE:
  // uma descrição de uma linha só volta como "Deana &amp; Adão", sem tag nenhuma
  // para detectar, e sair cedo aqui deixaria o "&amp;" cru no campo.
  if (/<[a-z!/][\s\S]*>/i.test(t)) {
    t = t.replace(/<\s*br\s*\/?\s*>/gi, '\n')
         .replace(/<\s*li[^>]*>/gi, '\n• ')     // o marcador já abre a linha...
         .replace(/<\s*\/\s*(div|p|tr|h[1-6]|ul|ol)\s*>/gi, '\n')   // ...por isso </li> fica fora
         .replace(/<[^>]*>/g, '');
  }
  t = t.replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos);/gi, m => {
    const chave = m.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTIDADES_HTML, chave) ? ENTIDADES_HTML[chave] : m;
  });
  t = t.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
  return t.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function obsDoGoogle(descricao) {
  // Converte ANTES de cortar: assim o marcador é encontrado mesmo quando o Google
  // transformou a descrição inteira em HTML depois de uma edição com formatação.
  const texto = htmlParaTexto(descricao);
  const idx = texto.indexOf(DESC_MARKER);
  return (idx >= 0 ? texto.slice(0, idx) : texto).trim();
}

function normalizeText(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/* "Hoje" no fuso da corretora, não no do servidor — corrigido em 07/10/2026.
   O runner do GitHub Actions roda em UTC, então das 21h à meia-noite de
   Brasília o getDate() local já devolvia AMANHÃ. Nessas três horas, toda visita
   do dia era tratada como passada: a importada nascia 'Realizada' em vez de
   'Agendada', e as agendadas do dia viravam 'Realizada' às 21h — o que ainda
   ligava o relógio de 14 dias antes da visita acontecer. O navegador nunca
   teve isso porque já roda no fuso dela. 'en-CA' é o formato AAAA-MM-DD. */
function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function isHolidayCalendar(c) {
  const id = String(c.id || '').toLowerCase();
  const summary = normalizeText(c.summary);
  const isHoliday = id.includes('#holiday@group.v.calendar.google.com') || summary.includes('feriad') || summary.includes('holiday');
  const isBirthdays = id.includes('addressbook#contacts@group.v.calendar.google.com') || id.includes('#contacts@group.v.calendar.google.com') || summary.includes('aniversari') || summary.includes('birthday');
  return isHoliday || isBirthdays;
}

/** Quantos dias separam duas datas ISO (YYYY-MM-DD). Meio-dia UTC evita problema de fuso/horário de verão. */
function daysBetweenISO(fromISO, toISO) {
  return Math.round((Date.parse(toISO + 'T12:00:00Z') - Date.parse(fromISO + 'T12:00:00Z')) / 86400000);
}

function addDaysISO(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Desloca só a parte da data, preservando hora e offset originais ('2026-08-14T15:00:00-03:00'). */
function shiftDateTimeString(value, days) {
  const datePart = value.slice(0, 10);
  return addDaysISO(datePart, days) + value.slice(10);
}

/* HORÁRIO DA VISITA — 13/11/2026.
   O campo `hora` da visita ('HH:mm', horário de Brasília) é o que o formulário do
   CRM grava. `googleHora` é o último horário trocado com o Google, na mesma lógica
   de googleData/googleTitulo/googleLocal: só vai para a agenda o que mudou no CRM.
   Brasília não tem horário de verão desde 2019, por isso o -03:00 fixo. */
const HORA_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DURACAO_PADRAO_MS = 60 * 60 * 1000;   // compromisso criado pelo CRM dura 1 h
const FUSO = 'America/Sao_Paulo';

function horaValida(h) { return HORA_RE.test(String(h || '')) ? String(h) : ''; }

/** 'HH:mm' de Brasília do início do evento; '' para evento de dia inteiro. */
function horaDoEvento(raw) {
  const inicio = new Date((raw && raw.start && raw.start.dateTime) || '');
  if (!Number.isFinite(inicio.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(inicio);
}

/** Data (AAAA-MM-DD, Brasília) do início do evento. */
function dataDoEvento(raw) {
  const start = (raw && raw.start) || {};
  if (start.dateTime) return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(start.dateTime));
  return String(start.date || '').slice(0, 10);
}

function isoBrasilia(ms) { return new Date(ms - 3 * 60 * 60 * 1000).toISOString().slice(0, 19) + '-03:00'; }

/** start/end com horário. Preserva a duração do evento original; sem ela, 1 hora.
    `limparDiaInteiro` zera o campo `date`: sem isso o PATCH de um evento de dia
    inteiro para um com horário é recusado pelo Google. */
function horarioParaGoogle(evOriginal, dataISO, hora, limparDiaInteiro) {
  const inicio = dataISO + 'T' + hora + ':00-03:00';
  const s = (evOriginal && evOriginal.start) || {}, e = (evOriginal && evOriginal.end) || {};
  let duracao = DURACAO_PADRAO_MS;
  if (s.dateTime && e.dateTime) {
    const d = Date.parse(e.dateTime) - Date.parse(s.dateTime);
    if (d > 0) duracao = d;
  }
  const extra = limparDiaInteiro ? { date: null } : {};
  return { inicio,
    start: { dateTime: inicio, timeZone: FUSO, ...extra },
    end: { dateTime: isoBrasilia(Date.parse(inicio) + duracao), timeZone: FUSO, ...extra } };
}

// ---------------------------------------------------------------- autenticação

class ScopeError extends Error {}

async function getFreshAccessToken() {
  const res = await fetchWithRetry('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Falha ao renovar o token do Google: ' + JSON.stringify(data));
  return data.access_token;
}

/** Chamada à API do Calendar que distingue "falta permissão de escrita" de erro comum. */
async function calendarFetch(accessToken, url, options) {
  const res = await fetchWithRetry(url, {
    ...options,
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', ...(options && options.headers) }
  });
  if (res.status === 204) return {};
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = (data.error && data.error.message) || text || ('HTTP ' + res.status);
    if (res.status === 403 && /insufficient|scope/i.test(message)) {
      throw new ScopeError('O token do servidor não tem permissão de escrita no Google Agenda. Gere um novo refresh token com o escopo calendar.events (ver server-sync/README.md).');
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------- leitura

async function fetchCalendarIds(accessToken) {
  const calendars = [];
  let pageToken;
  const seenPages = new Set();
  do {
    const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    url.searchParams.set('minAccessRole', 'reader');
    url.searchParams.set('showHidden', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await calendarFetch(accessToken, url);
    calendars.push(...(data.items || []));
    pageToken = data.nextPageToken;
    if (pageToken && seenPages.has(pageToken)) throw new Error('Paginação de calendários repetida; ciclo interrompido com segurança.');
    if (pageToken) seenPages.add(pageToken);
  } while (pageToken);
  const primary = calendars.find(c => c.primary);
  if (!EXPECTED_CALENDAR_OWNER) throw new ScopeError('Secret GOOGLE_CALENDAR_OWNER ausente: ciclo interrompido antes de qualquer escrita.');
  if (!primary || String(primary.id).toLowerCase() !== EXPECTED_CALENDAR_OWNER) {
    throw new Error('A conta do token Google não corresponde à agenda autorizada. Ciclo interrompido sem alterar visitas.');
  }
  primaryCalendarId = primary.id;
  return [...new Set(calendars.filter(c => !isHolidayCalendar(c)).map(c => c.id))];
}

/* Devolve SEMPRE {events, truncado, erro} — nunca só a lista.

   O `catch { break }` que existia aqui era o pior tipo de erro: um calendário
   que falhasse no meio da paginação devolvia a lista parcial (ou vazia) com
   cara de calendário lido inteiro, e a fase de leitura apagava do CRM toda
   visita cujo evento tivesse ficado de fora. Agora a falha viaja junto com o
   resultado e quem chama decide o que fazer com ela. */
async function fetchEventsFromCalendar(accessToken, calendarId, prazoFinal, updatedMin = null) {
  let events = [];
  let pageToken;
  let truncado = false;
  do {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events');
    url.searchParams.set('timeMin', SYNC_TIME_MIN);
    url.searchParams.set('timeMax', SYNC_TIME_MAX);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    // Leitura rápida: o Google devolve só o que foi criado ou alterado desde então.
    if (updatedMin) url.searchParams.set('updatedMin', updatedMin);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    let data;
    try {
      data = await calendarFetch(accessToken, url);
    } catch (e) {
      return { events, truncado: true, erro: String((e && e.message) || e) };
    }
    events = events.concat(data.items || []);
    pageToken = data.nextPageToken;
    if (pageToken && events.length >= MAX_EVENTS_PER_CALENDAR) { truncado = true; break; }
    // Limita a leitura para deixar tempo para envios e confirmação do ciclo.
    // O workflow aguarda o ciclo atual em vez de cancelá-lo.
    if (pageToken && Date.now() > prazoFinal) { truncado = true; break; }
  } while (pageToken);
  return { events, truncado, erro: null };
}

// Prazo da fase de leitura inteira. O job leva ~25 s hoje; 3 minutos dão folga
// larga para uma agenda grande sem chegar perto do disparo seguinte (5 min).
const PRAZO_LEITURA_MS = 3 * 60 * 1000;

async function fetchGoogleEvents(accessToken, { updatedMin = null } = {}) {
  const calendarIds = await fetchCalendarIds(accessToken);
  const prazoFinal = Date.now() + PRAZO_LEITURA_MS;
  const rawByCalendar = await Promise.all(
    calendarIds.map(id => fetchEventsFromCalendar(accessToken, id, prazoFinal, updatedMin)
      .then(r => ({ id, list: r.events, truncado: r.truncado, erro: r.erro }))
      .catch(e => ({ id, list: [], truncado: true, erro: String((e && e.message) || e) })))
  );

  // Incompletude é publicada no estado do ciclo e preserva todas as visitas.
  const porCalendario = rawByCalendar.map(c => ({ id: c.id, eventos: c.list.length, truncado: !!c.truncado, erro: c.erro || null }));
  const leituraCompleta = porCalendario.every(c => !c.truncado && !c.erro);
  porCalendario.filter(c => c.truncado || c.erro).forEach(c => {
    console.error('Leitura incompleta do calendário ' + idParaLog(c.id) + ':', c.erro || ('teto de ' + MAX_EVENTS_PER_CALENDAR + ' eventos'));
  });

  const seen = new Set();
  const events = [];
  rawByCalendar.forEach(({ id: calendarId, list }) => {
    list.forEach(ev => {
      if (!ev.id || seen.has(eventKey(calendarId, ev.id))) return;
      seen.add(eventKey(calendarId, ev.id));
      const start = ev.start && (ev.start.dateTime || ev.start.date);
      const iso = ev.start?.dateTime ? new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(start)) : start ? start.slice(0,10) : '';
      if (!iso) return;
      const hora = (ev.start && ev.start.dateTime) ? new Date(ev.start.dateTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '';
      events.push({ id: ev.id, calendarId, titulo: ev.summary || '(sem título)', data: iso, hora, local: ev.location || '', descricao: ev.description || '', raw: ev });
    });
  });
  return { events, calendarsCount: calendarIds.length, leituraCompleta, porCalendario };
}

// -------------------------------------------------- montagem do evento a gravar

/* ESPELHO de bairroDe() nas duas interfaces: o mesmo conceito mora em DOIS
   campos e nenhum dos dois pode ser lido sozinho. `bairro` é o que esta
   sincronização grava (vem do `location` do compromisso) e `bairro2` é o que a
   interface e a importação de planilha gravam. Ler só um dos dois foi o que
   fazia o endereço sumir do compromisso na agenda. */
function localDaVisita(visit) {
  return String((visit && (visit.bairro || visit.bairro2)) || '').trim();
}

function buildDescription(visit, previousDescription) {
  const linhas = [DESC_MARKER];
  if (visit.cliente) linhas.push('Cliente: ' + visit.cliente);
  if (visit.telefone) linhas.push('Telefone: ' + visit.telefone);
  if (visit.status) linhas.push('Status: ' + visit.status);
  if (visit.bairro2 || visit.bairro) linhas.push('Bairro: ' + (visit.bairro2 || visit.bairro));
  if (visit.followup) linhas.push('Retorno: ' + visit.followup);
  if (visit.obs) linhas.push('Observações: ' + visit.obs);

  const anterior = String(previousDescription || '');
  const idx = anterior.indexOf(DESC_MARKER);
  const preservado = (idx >= 0 ? anterior.slice(0, idx) : anterior).trimEnd();

  return (preservado ? preservado + '\n\n' : '') + linhas.join('\n');
}

/** Título que sobrevive ao filtro de importação: precisa conter "visita". */
function tituloParaGoogle(imovel, foraDoFunil = false) {
  // Compromisso que não é visita (reunião, consulta...) não ganha o prefixo.
  if (foraDoFunil) return String(imovel || '').trim() || '(sem título)';
  const texto = String(imovel || '').trim() || 'Visita';
  return normalizeText(texto).includes('visita') ? texto : 'Visita - ' + texto;
}

/** Novo start/end preservando hora e duração do evento original. */
function datasParaGoogle(evOriginal, novaDataISO) {
  if (!evOriginal) {
    return { start: { date: novaDataISO }, end: { date: addDaysISO(novaDataISO, 1) } };
  }
  const start = evOriginal.start || {};
  const end = evOriginal.end || {};
  const dataAtual = (start.dateTime || start.date || '').slice(0, 10);
  if (!dataAtual || dataAtual === novaDataISO) return null; // data não mudou: não mexe

  const shift = daysBetweenISO(dataAtual, novaDataISO);
  if (start.dateTime) {
    return {
      start: { dateTime: shiftDateTimeString(start.dateTime, shift), timeZone: start.timeZone || 'America/Sao_Paulo' },
      end: { dateTime: shiftDateTimeString(end.dateTime || start.dateTime, shift), timeZone: end.timeZone || start.timeZone || 'America/Sao_Paulo' }
    };
  }
  return {
    start: { date: addDaysISO(start.date, shift) },
    end: { date: addDaysISO(end.date || addDaysISO(start.date, 1), shift) }
  };
}

// ------------------------------------------------- ENVIO: CRM -> Google Agenda

// Confirma somente a versão efetivamente enviada. Uma edição mais recente continua na fila.
async function acknowledgePush(db, snapshot, patch) {
  return db.runTransaction(async tx => {
    const current = await tx.get(snapshot.ref);
    if (!current.exists) return false;
    const unchanged = sameVersion(current, snapshot);
    const data = { ...patch, pendingGoogleSync: !unchanged,
      googleSyncError: null, googleSyncedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (!unchanged) delete data.imovel;
    tx.update(snapshot.ref, data);
    return unchanged;
  });
}

async function recordPushError(db, snapshot, message) {
  await db.runTransaction(async tx => {
    const current = await tx.get(snapshot.ref);
    if (current.exists && sameVersion(current, snapshot)) {
      tx.update(snapshot.ref, { googleSyncError: message.slice(0, 300) });
    }
  });
}

// Somente cancelamento explícito ou HTTP 410 confirma exclusão. Um 404 pode
// também significar acesso insuficiente: ele aparece como indisponível, sem apagar dados.
function exclusaoJaRegularizada(v) {
  return !!(v.finalizadaPorExclusao || v.exclusaoPreservouStatus) && v.googleCalendarState === 'deleted' && !v.pendingGoogleSync && !v.googleSyncError;
}
async function settleDeletedVisit(db, snapshot) {
  // Já regularizada: nem abre transação (era uma leitura por visita excluída a cada ciclo).
  if (exclusaoJaRegularizada(snapshot.data())) return false;
  return db.runTransaction(async tx => {
    const current = await tx.get(snapshot.ref);
    if (!current.exists || !sameVersion(current, snapshot)) return false;
    const v = current.data();
    if (exclusaoJaRegularizada(v)) return false;
    const patch = {googleCalendarState:'deleted',pendingGoogleSync:false,googleSyncError:null,googleDeletionRequested:false,googleSyncDisposition:'local-only-deleted'};
    if (!v.googleDeletedAt) patch.googleDeletedAt = admin.firestore.FieldValue.serverTimestamp();
    // Decisão de 12/11/2026: venda, contrato, banco, proposta e assinatura mantêm o
    // status; só ganham a etiqueta de excluída da agenda. O resto é finalizado.
    if (!v.finalizadaPorExclusao && !v.exclusaoPreservouStatus) {
      if (STATUS_PRESERVADOS_NA_EXCLUSAO.has(v.status)) patch.exclusaoPreservouStatus = true;
      else Object.assign(patch, {status:'Atendimento finalizado',statusAntesDaExclusao:v.status || '',statusEm:todayISO(),finalizadaPorExclusao:true});
    }
    tx.update(snapshot.ref,patch);return true;
  });
}

async function reconcileGoogleDeletions(db, accessToken, eventById, visitsSnapshot = null, { parar = () => false } = {}) {
  const visits = visitsSnapshot || await db.collection('visits').get();
  let marked = 0, restored = 0, unavailable = 0, failed = 0, interrompido = false;
  for (const snapshot of visits.docs) {
    if (parar()) { interrompido = true; break; }
    const v = snapshot.data();
    if (!v.sourceId || !v.calendarId) continue;
    let state = 'active';
    try {
      const listed = eventById.get(eventKey(v.calendarId, v.sourceId));
      // Exclusão já regularizada e evento ainda fora da lista: continua excluído sem
      // gastar um GET por ciclo. Se o evento for restaurado, ele volta à lista.
      if (!listed && exclusaoJaRegularizada(v)) continue;
      const raw = listed?.raw || await calendarFetch(accessToken, eventUrl(v.calendarId, v.sourceId));
      if (raw.status === 'cancelled') state = 'deleted';
    } catch (error) {
      if (error.status === 410) state = 'deleted';
      else if (error.status === 404) state = 'unavailable';
      else { failed++; continue; }
    }
    // Não reduz uma exclusão já confirmada a uma ausência ambígua em ciclos seguintes.
    if (state === 'unavailable' && v.googleCalendarState === 'deleted') state = 'deleted';
    if (state === 'deleted') { if (await settleDeletedVisit(db,snapshot)) marked++; continue; }
    if (state === 'unavailable') unavailable++;
    if ((v.googleCalendarState || 'active') === state) continue;
    const changed = await db.runTransaction(async tx => {
      const current = await tx.get(snapshot.ref);
      if (!current.exists || !sameVersion(current, snapshot)) return false;
      const patch = { googleCalendarState: state, googleCalendarCheckedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (state === 'deleted') patch.googleDeletedAt = admin.firestore.FieldValue.serverTimestamp();
      else if (state === 'active') { patch.googleDeletedAt = null; patch.googleSyncError = null; }
      tx.update(snapshot.ref, patch);
      return true;
    });
    if (changed && state === 'deleted') marked++;
    if (changed && state === 'active') restored++;
  }
  return { marked, restored, unavailable, failed, interrompido };
}

async function pushPendingVisits(db, accessToken, eventById, { parar = () => false } = {}) {
  const snap = await db.collection('visits').where('pendingGoogleSync', '==', true).get();
  const protegidos = new Set();
  let enviados = 0, criados = 0, falhas = 0, adiados = 0, interrompido = false;
  let scopeError = null;
  for (const snapshot of snap.docs) {
    // Pendência que não foi enviada continua pendente e também protegida da importação.
    if (parar()) { interrompido = true; snap.docs.forEach(d => { const x = d.data(); if (x.sourceId) protegidos.add(eventKey(x.calendarId || 'primary', x.sourceId)); }); break; }
    const v = { ...snapshot.data(), id: snapshot.id };
    try {
      if (v.googleCalendarState === 'deleted') {
        await settleDeletedVisit(db, snapshot);
        continue;
      }
      // Uma exclusão confirmada no CRM não pode ser desfeita por um envio já em andamento.
      const live = await snapshot.ref.get();
      if (!live.exists || !sameVersion(live, snapshot)) { adiados++; continue; }
      let calendarId = calendarKey(v.calendarId || DEFAULT_CALENDAR_ID);
      let existing = v.sourceId ? eventById.get(eventKey(calendarId, v.sourceId)) : null;
      if (v.sourceId && !v.calendarId) {
        const matches = [...eventById.values()].filter(e => e.id === v.sourceId);
        if (matches.length !== 1) throw new Error('Calendário de origem indefinido. Alteração preservada para revisão.');
        existing = matches[0]; calendarId = existing.calendarId;
      }
      if (v.sourceId && !existing) {
        // Ausência em uma janela de leitura não prova exclusão. Confere o evento diretamente.
        const raw = await calendarFetch(accessToken, eventUrl(calendarId, v.sourceId));
        if (raw.status === 'cancelled') throw new Error('Evento cancelado no Google. Alteração local preservada para revisão.');
        existing = { id: v.sourceId, calendarId, raw };
      }
      if (existing) {
        /* Decisão de 12/11/2026: o CRM envia só o que mudou NELE. googleData,
           googleTitulo e googleLocal guardam o último valor trocado com o Google;
           campo igual a ele não foi mexido no CRM e não vai, para não desfazer um
           reagendamento ou renomeação feitos no Google e ainda não importados.
           Registro antigo, sem a referência, envia como antes. */
        const mudou = (campo, atual) => v[campo] === undefined || (atual || '') !== (v[campo] || '');
        const body = { description: buildDescription(v, existing.raw && existing.raw.description) };
        if (mudou('googleTitulo', v.imovel)) body.summary = tituloParaGoogle(v.imovel, v.foraDoFunil);
        const local = localDaVisita(v);
        if (local && mudou('googleLocal', v.bairro)) body.location = local;
        const mudouData = !!v.data && mudou('googleData', v.data);
        // Horário: referência gravada ou, em registro antigo, o próprio evento.
        // Campo vazio no CRM nunca apaga o horário que está na agenda.
        const horaCrm = horaValida(v.hora);
        const horaRef = v.googleHora !== undefined ? (v.googleHora || '') : horaDoEvento(existing.raw);
        const diaDoHorario = mudouData ? v.data : (dataDoEvento(existing.raw) || v.data);
        const comHorario = horaCrm && horaCrm !== horaRef && diaDoHorario ? horarioParaGoogle(existing.raw, diaDoHorario, horaCrm, true) : null;
        const dates = comHorario ? { start: comHorario.start, end: comHorario.end }
          : mudouData ? datasParaGoogle(existing.raw, v.data) : null;
        if (dates) Object.assign(body, dates);
        await calendarFetch(accessToken, eventUrl(calendarId, v.sourceId), { method: 'PATCH', body: JSON.stringify(body) });
        protegidos.add(eventKey(calendarId, v.sourceId));
        const enviado = { calendarId };
        if (body.summary) enviado.googleTitulo = v.imovel || '';
        if (body.location) enviado.googleLocal = v.bairro || '';
        if (dates && mudouData) enviado.googleData = v.data;
        if (comHorario) Object.assign(enviado, { googleHora: horaCrm, googleStartAt: comHorario.inicio, googleStartDate: diaDoHorario });
        if (!await acknowledgePush(db, snapshot, enviado)) adiados++;
        enviados++;
      } else {
        if (!v.data) throw new Error('Visita sem data. Corrija a data para enviar; alteração preservada.');
        const id = createdEventId(v.id);
        // Com horário no formulário, o compromisso nasce com hora marcada (1 h);
        // sem horário, continua nascendo como dia inteiro.
        const horaCrm = horaValida(v.hora);
        const comHorario = horaCrm ? horarioParaGoogle(null, v.data, horaCrm, false) : null;
        const body = { id, summary: tituloParaGoogle(v.imovel, v.foraDoFunil), location: localDaVisita(v),
          description: buildDescription(v, ''),
          start: comHorario ? comHorario.start : { date: v.data }, end: comHorario ? comHorario.end : { date: addDaysISO(v.data, 1) },
          extendedProperties: { private: { crmVisitId: v.id } } };
        try {
          await calendarFetch(accessToken, eventUrl(calendarId), { method: 'POST', body: JSON.stringify(body) });
        } catch (e) {
          if (e.status !== 409) throw e;
          const previous = await calendarFetch(accessToken, eventUrl(calendarId, id));
          if (previous.status === 'cancelled' || previous.extendedProperties?.private?.crmVisitId !== v.id) {
            throw new Error('Evento anterior indisponível para recuperação. Alteração preservada para revisão.');
          }
          // Uma tentativa anterior criou o evento, mas não confirmou no Firestore.
          const { id: ignoredId, ...patch } = body;
          // A tentativa anterior pode ter criado o evento como dia inteiro.
          if (comHorario) Object.assign(patch, (({ start, end }) => ({ start, end }))(horarioParaGoogle(null, v.data, horaCrm, true)));
          await calendarFetch(accessToken, eventUrl(calendarId, id), { method: 'PATCH', body: JSON.stringify(patch) });
        }
        protegidos.add(eventKey(calendarId, id));
        if (!await acknowledgePush(db, snapshot, { sourceId: id, calendarId, pushedToGoogle: true, imovel: body.summary,
          googleTitulo: body.summary, googleData: v.data, googleLocal: v.bairro || '', googleHora: horaCrm,
          ...(comHorario ? { googleStartAt: comHorario.inicio, googleStartDate: v.data } : {}) })) adiados++;
        criados++;
      }
    } catch (e) {
      if (Number(e.code) === 8) throw e;
      falhas++;
      try { await recordPushError(db, snapshot, String(e.message)); } catch (recordError) { console.error('Falha ao registrar pendência:', recordError.message); }
      if (e instanceof ScopeError) { scopeError = e.message; break; }
    }
  }
  return { enviados, criados, falhas, adiados, descartados: 0, protegidos, scopeError, interrompido };
}

function eventUrl(calendarId, eventId) {
  return 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarKey(calendarId)) + '/events' +
    (eventId ? '/' + encodeURIComponent(eventId) : '');
}

// Margem para relógio errado do aparelho que gravou `requestedAt`.
const MARGEM_PEDIDO_EXCLUSAO_MS = 24 * 60 * 60 * 1000;

// `desde` (ms) limita a leitura aos pedidos recentes: o ciclo de 5 min não relê
// todo o histórico de exclusões, que só cresce. Pedidos mais antigos, ou sem
// `requestedAt`, são tratados no ciclo completo, que lê a coleção inteira.
/* O servidor apaga com credencial própria (o Admin SDK ignora as Firestore Rules).
   Então, quando o pedido diz de qual visita é, o evento TEM de ser o dessa visita:
   o que ela importou (sourceId) ou o que o servidor cria para ela (createdEventId).
   Pedido sem visitId continua valendo: é a lixeira da agenda do site, para evento
   do Google que nunca virou registro. */
async function pedidoDeExclusaoConfere(db, t) {
  if (!t.visitId) return true;
  const visita = await db.collection('visits').doc(t.visitId).get();
  if (!visita.exists) return false;
  const v = visita.data();
  const eventoDaVisita = v.sourceId === t.sourceId || createdEventId(t.visitId) === t.sourceId;
  const mesmoCalendario = !v.calendarId || calendarKey(v.calendarId) === calendarKey(t.calendarId || 'primary');
  return eventoDaVisita && mesmoCalendario;
}

async function processDeletions(db, accessToken, { desde = null, parar = () => false } = {}) {
  const colecao = db.collection('googleDeletions');
  const snap = Number.isFinite(desde) ? await colecao.where('requestedAt', '>=', desde).get() : await colecao.get();
  const excluidosIds = new Set();
  // Mesmo pedidos que falhem neste ciclo impedem reimportação. Pedido recusado não.
  const pendentesIds = new Set(snap.docs.filter(d => !d.data().recusadoEm).map(d => eventKey(d.data().calendarId || 'primary', d.data().sourceId)));
  let excluidos = 0, falhas = 0, recusados = 0, scopeError = null, interrompido = false;
  let restantes = snap.docs.filter(d => !d.data().completedAt).length;
  for (const snapshot of snap.docs) {
    const t = snapshot.data();
    if (t.completedAt) continue;
    if (!t.sourceId || !t.calendarId) { falhas++; continue; }
    // Orçamento do dia no fim: para aqui; o que sobrou continua na fila.
    if (parar()) { interrompido = true; break; }
    try {
      if (!(await pedidoDeExclusaoConfere(db, t))) {
        // Não apaga nada no Google e tira o pedido da fila, com o motivo gravado.
        await snapshot.ref.update({ completedAt: admin.firestore.FieldValue.serverTimestamp(), recusadoEm: admin.firestore.FieldValue.serverTimestamp(),
          motivoDaRecusa: 'O evento do pedido não pertence à visita indicada.' });
        recusados++; restantes--;
        continue;
      }
      try { await calendarFetch(accessToken, eventUrl(t.calendarId, t.sourceId), { method: 'DELETE' }); }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
      excluidosIds.add(eventKey(t.calendarId, t.sourceId));
      // Não remove um pedido novo que tenha substituído este durante a chamada HTTP.
      await db.runTransaction(async tx => {
        const current = await tx.get(snapshot.ref);
        const visitRef = t.visitId ? db.collection('visits').doc(t.visitId) : null;
        const visit = visitRef ? await tx.get(visitRef) : null;
        if (current.exists && sameVersion(current, snapshot)) {
          tx.update(snapshot.ref, { completedAt: admin.firestore.FieldValue.serverTimestamp() });
          if (visit?.exists) tx.update(visitRef, {googleCalendarState:'deleted',googleDeletedAt:admin.firestore.FieldValue.serverTimestamp(),googleDeletionRequested:false,pendingGoogleSync:false,googleSyncError:null});
        }
      });
      excluidos++; restantes--;
    } catch (e) {
      if (Number(e.code) === 8) throw e;
      falhas++;
      if (e instanceof ScopeError) { scopeError = e.message; break; }
    }
  }
  return { excluidos, falhas, recusados, excluidosIds, pendentesIds, scopeError, restantes, interrompido };
}

// Somente o servidor importa. Não se apaga histórico por ausência, renomeação,
// perda de acesso ou janela de datas; exclusões são pedidos explícitos do CRM.
function patchDaAgenda(v, ev, today, now = Date.now()) {
  const patch = {};
  // Último valor visto no Google: base do "enviar só o que mudou no CRM".
  if (v.googleData !== ev.data) patch.googleData = ev.data;
  if (v.googleTitulo !== (ev.titulo || '')) patch.googleTitulo = ev.titulo || '';
  if (v.googleLocal !== (ev.local || '')) patch.googleLocal = ev.local || '';
  const startAt = ev.raw?.start?.dateTime || null;
  if ((v.googleStartAt || null) !== startAt) patch.googleStartAt = startAt;
  if ((v.googleStartDate || null) !== (startAt ? ev.data : null)) patch.googleStartDate = startAt ? ev.data : null;
  // O Google é a fonte do horário: evento de dia inteiro deixa a visita sem hora.
  const horaEv = horaDoEvento(ev.raw);
  if (v.googleHora !== horaEv) patch.googleHora = horaEv;
  if ((v.hora || '') !== horaEv) patch.hora = horaEv;
  if (ev.data !== v.data) patch.data = ev.data;
  if (ev.titulo && ev.titulo !== v.imovel) patch.imovel = ev.titulo;
  if (ev.local && ev.local !== v.bairro) patch.bairro = ev.local;
  if (!v.calendarId) patch.calendarId = ev.calendarId;
  const obs = obsDoGoogle(ev.descricao);
  if (obs && obs !== (v.obs || '').trim() && (!(v.obs || '').trim() || v.obs === OBS_IMPORT_PADRAO)) patch.obs = obs;
  if (v.status === 'Agendada' && (patch.data || v.data) < today) patch.status = 'Realizada';
  // Concluída pelo horário e depois reagendada para o futuro no Google: a visita
  // não aconteceu. Volta para Agendada (decisão de 12/11/2026).
  const mudouHorario = 'data' in patch || 'googleStartAt' in patch;
  const futura = startAt ? Date.parse(startAt) > now : (patch.data || v.data) > today;
  if (v.realizadaPorHorario && v.status === 'Realizada' && mudouHorario && futura) {
    Object.assign(patch, { status: 'Agendada', realizadaPorHorario: false, realizadaAutomaticamenteEm: null, statusEm: today });
  }
  return patch;
}

async function importGoogleEventsIntoVisits(db, events, opts = {}) {
  const { protegidos = new Set(), excluidosIds = new Set(), pendentesIds = new Set(), leituraCompleta = true, parar = () => false } = opts;
  let interrompido = false;
  const today = todayISO();
  const visits = opts.visitsSnapshot || await db.collection('visits').get();
  const byKey = new Map();
  const legacy = new Map();
  const counts = new Map();
  events.forEach(e => counts.set(e.id, (counts.get(e.id) || 0) + 1));
  for (const snapshot of visits.docs) {
    const v = snapshot.data();
    if (!v.sourceId) continue;
    if (v.calendarId) byKey.set(eventKey(v.calendarId, v.sourceId), snapshot);
    else legacy.set(v.sourceId, snapshot);
  }
  let imported = 0, updated = 0, skipped = 0;
  for (const ev of events) {
    if (parar()) { interrompido = true; break; }
    const key = eventKey(ev.calendarId, ev.id);
    if (!ev.data || ev.raw?.status === 'cancelled' || !normalizeText(ev.titulo).includes('visita') || protegidos.has(key) || excluidosIds.has(key) || pendentesIds.has(key)) { skipped++; continue; }
    if (legacy.has(ev.id) && counts.get(ev.id) !== 1) { skipped++; continue; }
    const snapshot = byKey.get(key) || legacy.get(ev.id);
    if (snapshot && (snapshot.data().pendingGoogleSync || !Object.keys(patchDaAgenda(snapshot.data(),ev,today)).length)) { skipped++; continue; }
    const ref = snapshot ? snapshot.ref : db.collection('visits').doc(importedVisitId(ev.calendarId, ev.id));
    const deletionRef = db.collection('googleDeletions').doc(importedVisitId(ev.calendarId, ev.id));
    const legacyDeletionRef = db.collection('googleDeletions').doc(ev.id);
    const outcome = await db.runTransaction(async tx => {
      const [current, deletion, legacyDeletion] = await Promise.all([tx.get(ref), tx.get(deletionRef), tx.get(legacyDeletionRef)]);
      if (deletion.exists || (legacyDeletion.exists && eventKey(legacyDeletion.data().calendarId || 'primary', ev.id) === key)) return 'skipped';
      if (snapshot && (!current.exists || !sameVersion(current, snapshot))) return 'skipped';
      // Um ciclo concorrente já criou o registro. Não aplica um snapshot antigo por cima dele.
      if (!snapshot && current.exists) return 'skipped';
      if (current.exists) {
        const v = current.data();
        if (v.pendingGoogleSync) return 'skipped';
        const patch = patchDaAgenda(v,ev,today);
        if (!Object.keys(patch).length) return 'skipped';
        tx.update(ref, patch); return 'updated';
      }
      tx.create(ref, { sourceId: ev.id, calendarId: ev.calendarId, fromGoogle: true,
        googleStartAt: ev.raw?.start?.dateTime || null, googleStartDate: ev.raw?.start?.dateTime ? ev.data : null,
        data: ev.data, imovel: ev.titulo, bairro: ev.local || '', cliente: '', telefone: '',
        googleData: ev.data, googleTitulo: ev.titulo || '', googleLocal: ev.local || '',
        hora: horaDoEvento(ev.raw), googleHora: horaDoEvento(ev.raw),
        status: ev.data < today ? 'Realizada' : 'Agendada', followup: '', obs: obsDoGoogle(ev.descricao) || OBS_IMPORT_PADRAO });
      return 'imported';
    });
    if (outcome === 'imported') imported++;
    else if (outcome === 'updated') updated++;
    else skipped++;
  }
  return { imported, updated, skipped, removed: 0, totalEvents: events.length, leituraCompleta, interrompido };
}

/* LEITURA RÁPIDA — roda nos disparos de 5 min, entre um ciclo completo e outro.

   Antes, visita criada ou alterada no Google Agenda só chegava ao CRM no ciclo
   completo (~15 min). Aqui o servidor pede ao Google apenas os eventos mexidos
   desde o último completo (`updatedMin`) e importa só esses. Sem mudança na
   Agenda, o custo no Firestore é ZERO leituras; com mudança, lê apenas as visitas
   daqueles eventos (consulta por `sourceId`), nunca a coleção inteira.

   O que continua só no ciclo completo: conferir evento APAGADO no Google
   (reconciliação) e o carimbo `lastSyncedAt`. Evento cancelado vem sem data e é
   descartado aqui, como na importação normal. */
const MARGEM_LEITURA_RAPIDA_MS = 2 * 60 * 1000;   // folga de relógio entre o runner e o Google
const LOTE_IN = 30;                               // teto do operador `in` do Firestore

async function lerMudancasDaAgenda(db, accessToken, desdeMs, opts = {}) {
  const corte = desdeMs - MARGEM_LEITURA_RAPIDA_MS;
  let events, leituraCompleta = true;
  if (opts.eventosDaAgenda) {
    // A agenda inteira já foi lida neste disparo (havia envio pendente): filtra em memória.
    events = opts.eventosDaAgenda.filter(ev => Date.parse(ev.raw?.updated || '') >= corte);
  } else {
    ({ events, leituraCompleta } = await fetchGoogleEvents(accessToken, { updatedMin: new Date(corte).toISOString() }));
  }
  const candidatos = events.filter(ev => ev.data && ev.raw?.status !== 'cancelled' && normalizeText(ev.titulo).includes('visita'));
  if (!candidatos.length) return { eventos: events.length, imported: 0, updated: 0, leituraCompleta, interrompido: false };
  const ids = [...new Set(candidatos.map(ev => ev.id))];
  const docs = [];
  for (let i = 0; i < ids.length; i += LOTE_IN) {
    docs.push(...(await db.collection('visits').where('sourceId', 'in', ids.slice(i, i + LOTE_IN)).get()).docs);
  }
  const r = await importGoogleEventsIntoVisits(db, candidatos, { ...opts, leituraCompleta, visitsSnapshot: { docs } });
  return { eventos: events.length, imported: r.imported, updated: r.updated, leituraCompleta, interrompido: !!r.interrompido };
}

function visitaAtingiuHorario(v, now = Date.now()) {
  if (v.status !== 'Agendada' || !v.sourceId || v.foraDoFunil || v.pendingGoogleSync || ['deleted','unavailable'].includes(v.googleCalendarState)) return false;
  const start = Date.parse(v.googleStartAt || '');
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  return Number.isFinite(start) && v.googleStartDate === v.data && v.data === today && start <= now;
}

async function concluirVisitasPorHorario(db, now = Date.now()) {
  // Só visitas de hoje podem atingir o horário: não reler todas as agendadas a cada 5 min.
  const hoje = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const snap = await db.collection('visits').where('status','==','Agendada').where('data','==',hoje).get();
  let count = 0;
  for (const snapshot of snap.docs) {
    if (!visitaAtingiuHorario(snapshot.data(), now)) continue;
    const done = await db.runTransaction(async tx => {
      const current = await tx.get(snapshot.ref);
      if (!current.exists || !visitaAtingiuHorario(current.data(), now)) return false;
      tx.update(snapshot.ref, { status:'Realizada', statusEm:current.data().data, realizadaPorHorario:true, realizadaAutomaticamenteEm:admin.firestore.FieldValue.serverTimestamp() });
      return true;
    });
    if (done) count++;
  }
  return count;
}

async function main({ fullSync = true, usoAnterior = null, custoCompleto = null, ultimoCompleto = null } = {}) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();
  const meta = db.collection('meta').doc('googleSync');
  const medidor = cota.medirFirestore(admin.firestore);
  let usoBase = cota.usoDeHoje(usoAnterior);
  const usoAtual = (extra = {}) => cota.somarUso(usoBase, { leituras: medidor.contador.leituras + (extra.leituras || 0), gravacoes: medidor.contador.gravacoes + (extra.gravacoes || 0) });
  try {
    // O contador gravado no banco sobrevive à perda do cache do Actions.
    const anterior = await meta.get();
    usoBase = cota.maiorUso(usoBase, anterior.exists ? anterior.data().cotaDoSync : null);
    // Sem o cache do Actions, o custo medido do completo vem do banco, não da estimativa.
    if (!custoCompleto && anterior.exists && anterior.data().custoCompleto) custoCompleto = anterior.data().custoCompleto;
    if (cota.esgotado(usoBase)) {
      console.warn(cota.resumoDoUso(usoAtual()));
      return { healthy: false, fullSync: false, leituraCompleta: false, orcamentoEsgotado: true, uso: usoAtual(), custoCiclo: { ...medidor.contador } };
    }
    if (fullSync && !cota.cabeCicloCompleto(usoBase, custoCompleto)) { fullSync = false; console.warn('Orçamento diário acima de ' + Math.round(cota.FAIXA_COMPLETO * 100) + '%: ciclo só de envio de pendências.'); }
    await meta.set({ lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(), status: 'running' }, { merge: true });
    const accessToken = await getFreshAccessToken();
    // Orçamento checado DURANTE o ciclo, não só antes: cada laço para quando o uso
    // do dia chega ao limite, e o que sobrou fica na fila para depois da virada.
    const parar = () => cota.esgotado(usoAtual());
    // A agenda só é lida quando alguém vai usá-la: no ciclo completo (importação e
    // reconciliação) ou quando há visita pendente de envio (o envio precisa do
    // evento original). Pedido de exclusão não precisa dela.
    const precisaDaAgenda = fullSync || !(await db.collection('visits').where('pendingGoogleSync', '==', true).get()).empty;
    const { events, calendarsCount, leituraCompleta, porCalendario } = precisaDaAgenda
      ? await fetchGoogleEvents(accessToken)
      : { events: [], calendarsCount: 0, leituraCompleta: true, porCalendario: null };
    const eventById = new Map(events.map(ev => [eventKey(ev.calendarId, ev.id), ev]));
    let del = { excluidos: 0, falhas: 0, excluidosIds: new Set(), pendentesIds: new Set(), scopeError: null };
    let push = { enviados: 0, criados: 0, falhas: 0, adiados: 0, descartados: 0, protegidos: new Set(), scopeError: null };
    // Se a leitura da fila de exclusões falhar, o ciclo para: importar sem ela recriaria exclusões.
    // Fora do ciclo completo, só os pedidos feitos desde o último completo (com margem).
    const desde = fullSync ? null : (Number.isFinite(ultimoCompleto) ? ultimoCompleto : Date.now()) - MARGEM_PEDIDO_EXCLUSAO_MS;
    del = await processDeletions(db, accessToken, { desde, parar });
    del.excluidosIds.forEach(key => eventById.delete(key));
    // O histórico completo é relido a cada ~15 min; a fila continua em cada disparo.
    const visitsSnapshot = fullSync ? await db.collection('visits').get() : null;
    const reconciliation = fullSync ? await reconcileGoogleDeletions(db, accessToken, eventById, visitsSnapshot, { parar }) : { marked:0, restored:0, unavailable:0, failed:0 };
    push = await pushPendingVisits(db, accessToken, eventById, { parar });
    const result = fullSync ? await importGoogleEventsIntoVisits(db, events, { ...del, protegidos: push.protegidos, leituraCompleta, visitsSnapshot, parar }) : { imported:0, updated:0, skipped:0, removed:0, totalEvents:events.length, leituraCompleta };
    // Disparo de 5 min: importa só o que mudou na Agenda desde o último completo.
    // Uma falha aqui nunca derruba o envio de pendências; o ciclo completo cobre.
    if (!fullSync && Number.isFinite(ultimoCompleto) && !parar()) {
      try {
        const rapida = await lerMudancasDaAgenda(db, accessToken, ultimoCompleto, { ...del, protegidos: push.protegidos, parar,
          eventosDaAgenda: precisaDaAgenda && leituraCompleta ? events : null });
        result.imported = rapida.imported; result.updated = rapida.updated;
        result.interrompido = rapida.interrompido;
        result.leituraRapida = { eventos: rapida.eventos, completa: rapida.leituraCompleta };
      } catch (e) {
        if (Number(e.code) === 8) throw e;
        console.warn('Leitura rápida da Agenda falhou (o ciclo completo cobre):', String((e && e.message) || e).slice(0, 200));
        result.leituraRapida = { erro: String((e && e.message) || e).slice(0, 200) };
      }
    }
    result.fullSync = fullSync;
    result.agendaLida = precisaDaAgenda;
    result.realizadasPorHorario = parar() ? 0 : await concluirVisitasPorHorario(db);
    const interrompido = !!(del.interrompido || reconciliation.interrompido || push.interrompido || result.interrompido);
    result.interrompidoPeloOrcamento = interrompido;
    result.pedidosRecusados = del.recusados || 0;
    const pending = await db.collection('visits').where('pendingGoogleSync', '==', true).get();
    // Contado na própria leitura da fila: reler a coleção inteira dobrava o custo.
    const remainingDeletions = del.restantes;
    const writeScopeError = push.scopeError || del.scopeError || null;
    Object.assign(result, { calendars: calendarsCount, enviados: push.enviados, criadosNoGoogle: push.criados,
      excluidosNoGoogle: del.excluidos, falhasDeEnvio: push.falhas + del.falhas, adiados: push.adiados,
      descartados: 0, pendentes: pending.size, exclusoesPendentes: remainingDeletions,
      excluidasNaAgenda: reconciliation.marked, restauradasNaAgenda: reconciliation.restored,
      naoLocalizadasNaAgenda: reconciliation.unavailable, falhasDeVerificacao: reconciliation.failed });
    const healthy = leituraCompleta && !interrompido && !writeScopeError && !result.falhasDeEnvio && !result.pendentes && !result.exclusoesPendentes && !result.falhasDeVerificacao;
    const metadata = { lastCycleAt: admin.firestore.FieldValue.serverTimestamp(), lastCycle: result,
      writeScopeError, lastError: null, status: healthy ? 'ok' : 'partial', source: 'github-actions' };
    if (porCalendario) metadata.porCalendario = porCalendario;
    // lastSyncedAt = "a agenda foi lida inteira e importada". Leitura parcial ou
    // ciclo cortado pelo orçamento não contam: a tela mostraria dado novo que não é.
    if (fullSync) metadata.lastImport = result;
    if (fullSync && leituraCompleta && !interrompido) metadata.lastSyncedAt = admin.firestore.FieldValue.serverTimestamp();
    if (healthy && fullSync) metadata.lastSuccessfulAt = admin.firestore.FieldValue.serverTimestamp();
    // Conta a própria gravação deste registro.
    metadata.cotaDoSync = { ...usoAtual({ gravacoes: 1 }), limiteLeituras: cota.LIMITE.leituras, limiteGravacoes: cota.LIMITE.gravacoes };
    result.custoDoCiclo = { leituras: medidor.contador.leituras, gravacoes: medidor.contador.gravacoes + 1 };
    if (fullSync && !interrompido) metadata.custoCompleto = { ...result.custoDoCiclo };
    metadata.lastCycle = result;
    await meta.set(metadata, { merge: true });
    console.log('Ciclo finalizado:', JSON.stringify(result));
    console.log(cota.resumoDoUso(usoAtual()));
    if (!healthy) console.warn('Sincronização parcial; consulte meta/googleSync e as pendências no CRM.');
    // Ciclo cortado pelo orçamento: o run-sync pausa até a virada da cota.
    return { healthy, fullSync, leituraCompleta: leituraCompleta && !interrompido, orcamentoEsgotado: interrompido || undefined, uso: usoAtual(), custoCiclo: { ...medidor.contador } };
  } catch (e) {
    // A cota já bloqueou o banco: não insistir numa segunda escrita de erro.
    if (Number(e.code) !== 8) await meta.set({ status: 'error', lastError: String(e.message).slice(0, 300) }, { merge: true }).catch(() => {});
    e.uso = usoAtual();
    throw e;
  } finally {
    medidor.desligar();
  }
}

if (require.main === module) {
  main().catch(err => { console.error('Sincronização falhou:', err.message); process.exitCode = 1; });
}
module.exports = { horaDoEvento, horarioParaGoogle, patchDaAgenda, tituloParaGoogle, settleDeletedVisit, visitaAtingiuHorario, concluirVisitasPorHorario, main, fetchCalendarIds, fetchGoogleEvents, fetchWithRetry, calendarFetch, eventKey,
  importedVisitId, createdEventId, reconcileGoogleDeletions, acknowledgePush, pushPendingVisits, processDeletions, importGoogleEventsIntoVisits, lerMudancasDaAgenda };
