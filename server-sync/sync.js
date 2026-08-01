/**
 * Sincronização do Google Agenda -> Firestore, pensada para rodar sem navegador
 * nenhum aberto (GitHub Actions agendado a cada 30 min). Replica exatamente a
 * mesma lógica de importação do controle-visitas.html (mesmos filtros, mesmos
 * campos), para o comportamento ficar idêntico ao da sincronização feita pelo app.
 *
 * Variáveis de ambiente exigidas (configuradas como GitHub Secrets):
 *   GOOGLE_CLIENT_ID              - Client ID OAuth "Desktop app"
 *   GOOGLE_CLIENT_SECRET          - Client Secret desse mesmo Client ID
 *   GOOGLE_REFRESH_TOKEN          - gerado uma vez via get-refresh-token.js
 *   FIREBASE_SERVICE_ACCOUNT_JSON - conteúdo integral do JSON da service account do Firebase
 */
const admin = require('firebase-admin');

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const MAX_EVENTS_PER_CALENDAR = 1000;
const SYNC_TIME_MIN = '2025-01-01T00:00:00Z';
const SYNC_TIME_MAX = '2035-12-31T23:59:59Z';

function normalizeText(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function isHolidayCalendar(c) {
  const id = String(c.id || '').toLowerCase();
  const summary = normalizeText(c.summary);
  const isHoliday = id.includes('#holiday@group.v.calendar.google.com') || summary.includes('feriad') || summary.includes('holiday');
  const isBirthdays = id.includes('addressbook#contacts@group.v.calendar.google.com') || id.includes('#contacts@group.v.calendar.google.com') || summary.includes('aniversari') || summary.includes('birthday');
  return isHoliday || isBirthdays;
}

async function getFreshAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
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

async function fetchCalendarIds(accessToken) {
  const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
  url.searchParams.set('minAccessRole', 'reader');
  url.searchParams.set('showHidden', 'true');
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  const data = await res.json();
  if (!res.ok) throw new Error('Falha ao listar calendários: ' + JSON.stringify(data));
  return (data.items || []).filter(c => !isHolidayCalendar(c)).map(c => c.id);
}

async function fetchEventsFromCalendar(accessToken, calendarId) {
  let events = [];
  let pageToken;
  do {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events');
    url.searchParams.set('timeMin', SYNC_TIME_MIN);
    url.searchParams.set('timeMax', SYNC_TIME_MAX);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    const data = await res.json();
    if (!res.ok) break;
    events = events.concat(data.items || []);
    pageToken = data.nextPageToken;
  } while (pageToken && events.length < MAX_EVENTS_PER_CALENDAR);
  return events;
}

async function fetchGoogleEvents(accessToken) {
  const calendarIds = await fetchCalendarIds(accessToken);
  const rawByCalendar = await Promise.all(
    calendarIds.map(id => fetchEventsFromCalendar(accessToken, id).catch(() => []))
  );

  const seen = new Set();
  const events = [];
  rawByCalendar.flat().forEach(ev => {
    if (!ev.id || seen.has(ev.id)) return;
    seen.add(ev.id);
    const start = ev.start && (ev.start.dateTime || ev.start.date);
    const iso = start ? start.slice(0, 10) : '';
    if (!iso) return;
    const hora = (ev.start && ev.start.dateTime) ? new Date(ev.start.dateTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '';
    events.push({ id: ev.id, titulo: ev.summary || '(sem título)', data: iso, hora, local: ev.location || '' });
  });
  return { events, calendarsCount: calendarIds.length };
}

async function importGoogleEventsIntoVisits(db, events) {
  const today = todayISO();
  const visitsSnap = await db.collection('visits').get();
  const visits = visitsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  let imported = 0, updated = 0, skipped = 0, removed = 0;

  const currentEventIds = new Set(events.map(ev => ev.id));
  const toRemove = visits.filter(v => v.fromGoogle && (!normalizeText(v.imovel).includes('visita') || (v.sourceId && !currentEventIds.has(v.sourceId))));
  const removeIds = new Set(toRemove.map(v => v.id));
  const remaining = visits.filter(v => !removeIds.has(v.id));

  const ops = [];
  toRemove.forEach(v => ops.push({ type: 'delete', id: v.id }));

  events.forEach(ev => {
    if (!ev.data) return;
    const isVisita = normalizeText(ev.titulo).includes('visita');
    if (!isVisita) { skipped++; return; }
    const existing = remaining.find(v => v.sourceId === ev.id);
    if (existing) {
      if (existing.status === 'Agendada' && ev.data < today) {
        ops.push({ type: 'update', id: existing.id, data: { status: 'Realizada' } });
        updated++;
      }
      return;
    }
    ops.push({
      type: 'set', id: db.collection('visits').doc().id, data: {
        sourceId: ev.id,
        fromGoogle: true,
        data: ev.data,
        imovel: ev.titulo,
        bairro: ev.local || '',
        cliente: '',
        telefone: '',
        status: ev.data < today ? 'Realizada' : 'Agendada',
        followup: '',
        obs: 'Importado do Google Agenda'
      }
    });
    imported++;
  });
  removed = toRemove.length;

  const CHUNK = 400;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const batch = db.batch();
    ops.slice(i, i + CHUNK).forEach(op => {
      const ref = db.collection('visits').doc(op.id);
      if (op.type === 'delete') batch.delete(ref);
      else if (op.type === 'update') batch.update(ref, op.data);
      else batch.set(ref, op.data);
    });
    await batch.commit();
  }

  return { imported, updated, skipped, removed, totalEvents: events.length };
}

async function main() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const accessToken = await getFreshAccessToken();
  const { events, calendarsCount } = await fetchGoogleEvents(accessToken);
  const result = await importGoogleEventsIntoVisits(db, events);
  result.calendars = calendarsCount;

  await db.collection('meta').doc('googleSync').set({
    lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastImport: result,
    source: 'github-actions'
  }, { merge: true });

  console.log('Sincronização concluída:', result);
}

main().catch(err => {
  console.error('Sincronização falhou:', err);
  process.exit(1);
});
