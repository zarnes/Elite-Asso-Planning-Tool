/**
 * Planning des représentants — backend.
 * Google Apps Script lié au Google Sheet du planning. Mise en place : voir README.md.
 *
 * Onglets :
 *   Membres     email | nom | code | derniers créneaux   (rempli à la main, sauf « derniers créneaux »)
 *   Réponses    semaine | email | nom | envoyé le | statut | nb créneaux | Lun 06:00 | … | Dim 20:30
 *               Une ligne par représentant et par semaine ouverte. 1 = disponible sur cette demi-heure.
 *   Historique  mêmes colonnes, rempli chaque dimanche. Ligne 2 : totaux par demi-heure.
 *               Contient aussi une ligne « sans réponse » pour chaque représentant qui n'a pas répondu.
 *   Analyse     grille jours × heures et réponses par semaine, calculées par formules depuis Historique
 *   Erreurs     date | action | erreur
 *
 * semaine = lundi de la semaine, en texte 'AAAA-MM-JJ'
 * L'app échange les créneaux sous forme d'identifiants de demi-heures : 'Mo:0600' = lundi 06:00–06:30
 */

const TZ = 'Europe/Paris';
const DAYS = [['Mo', 'Lun'], ['Tu', 'Mar'], ['We', 'Mer'], ['Th', 'Jeu'], ['Fr', 'Ven'], ['Sa', 'Sam'], ['Su', 'Dim']];
const OPEN = 6 * 60; // 06:00
const CLOSE = 21 * 60; // 21:00

// Les 210 demi-heures de la semaine, dans l'ordre des colonnes : { id: 'Mo:0600', label: 'Lun 06:00' }
const SLOTS = [];
DAYS.forEach(([code, short]) => {
  for (let m = OPEN; m < CLOSE; m += 30) {
    SLOTS.push({ id: code + ':' + hhmm(m).replace(':', ''), label: short + ' ' + hhmm(m) });
  }
});
const SLOT_IDS = new Set(SLOTS.map(s => s.id));

const INFO = ['semaine', 'email', 'nom', 'envoyé le', 'statut', 'nb créneaux'];
const HEADER = INFO.concat(SLOTS.map(s => s.label));
const FIRST_SLOT_COL = INFO.length + 1; // colonne G
const HISTORY_FIRST_ROW = 3; // ligne 1 : en-tête, ligne 2 : totaux

// ---------- Point d'entrée HTTP ----------

function doPost(e) {
  let req = {};
  try {
    req = JSON.parse(e.postData.contents);
    const member = findMember(req.id, req.code);
    if (!member) return json({ ok: false, error: 'unauthorized' });

    switch (req.action) {
      case 'init':         return json(init(member));
      case 'submit':       return json(submit(member, req.week, req.slots));
      case 'availability': return json(availability(req.week));
      default:             return json({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    logError(req.action, err);
    return json({ ok: false, error: 'server_error' });
  }
}

// ---------- Actions ----------

/** Tout ce dont l'app a besoin au chargement : semaines ouvertes, réponses du représentant, pré-remplissage. */
function init(member) {
  const weeks = allowedWeeks();
  const entries = {};
  readTable('Réponses').forEach(r => {
    const week = asWeek(r[0]);
    if (normEmail(r[1]) === member.email && weeks.includes(week)) {
      entries[week] = { slots: slotsOf(r), submittedAt: new Date(r[3]).toISOString() };
    }
  });
  return { ok: true, name: member.name, weeks, entries, lastSlots: member.lastSlots };
}

/** Remplace la réponse du représentant pour cette semaine. Aucun créneau = pas disponible. */
function submit(member, week, slots) {
  if (!allowedWeeks().includes(week)) return { ok: false, error: 'week_closed' };
  if (!Array.isArray(slots)) return { ok: false, error: 'bad_slots' };
  const ids = [...new Set(slots)].filter(s => SLOT_IDS.has(s));
  const now = new Date();

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet('Réponses');
    const rows = sh.getDataRange().getValues();
    for (let i = rows.length - 1; i >= 1; i--) {
      if (normEmail(rows[i][1]) === member.email && asWeek(rows[i][0]) === week) sh.deleteRow(i + 1);
    }
    sh.appendRow(toRow(week, member, now, ids));
    sheet('Membres').getRange(member.row, 4).setValue(ids.join(','));
  } finally {
    lock.releaseLock();
  }

  CacheService.getScriptCache().remove('agg:' + week);
  return { ok: true, savedAt: now.toISOString() };
}

/** Qui est disponible sur chaque créneau de la semaine : { 'Mo:0600': ['Alice B.', ...], ... } */
function availability(week) {
  if (!allowedWeeks().includes(week)) return { ok: false, error: 'week_closed' };

  const cache = CacheService.getScriptCache();
  const hit = cache.get('agg:' + week);
  if (hit) return JSON.parse(hit);

  const slots = {};
  let respondents = 0;
  readTable('Réponses').forEach(r => {
    if (asWeek(r[0]) !== week) return;
    respondents++;
    slotsOf(r).forEach(id => (slots[id] = slots[id] || []).push(String(r[2])));
  });
  Object.values(slots).forEach(list => list.sort());

  const result = { ok: true, week, respondents, slots };
  cache.put('agg:' + week, JSON.stringify(result), 300);
  return result;
}

// ---------- Archivage hebdomadaire (déclencheur, dimanche vers 21:30) ----------

/**
 * Déplace les réponses des semaines fermées de Réponses vers Historique,
 * en ajoutant une ligne « sans réponse » pour chaque représentant qui n'a pas répondu.
 */
function archiveWeek() {
  const firstOpen = allowedWeeks()[0];
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const src = sheet('Réponses');
    const hist = sheet('Historique');
    const rows = readTable('Réponses');
    const keep = rows.filter(r => asWeek(r[0]) >= firstOpen);
    const closed = rows.filter(r => asWeek(r[0]) < firstOpen);

    // Semaines à archiver : celles trouvées dans Réponses, plus celle qui vient de se terminer
    // (même si personne n'a répondu), sauf si elle est déjà dans Historique
    const historyCount = hist.getLastRow() - HISTORY_FIRST_ROW + 1;
    const archived = historyCount > 0
      ? hist.getRange(HISTORY_FIRST_ROW, 1, historyCount, 1).getValues().map(([w]) => asWeek(w))
      : [];
    const weeks = new Set(closed.map(r => asWeek(r[0])));
    const lastWeek = addDays(firstOpen, -7);
    if (!archived.includes(lastWeek)) weeks.add(lastWeek);

    const members = readRows('Membres')
      .filter(r => r[0])
      .map(r => ({ email: normEmail(r[0]), name: String(r[1]) }));
    weeks.forEach(week => members.forEach(m => {
      const answered = closed.some(r => asWeek(r[0]) === week && normEmail(r[1]) === m.email);
      if (!answered) closed.push(toRow(week, m, '', [], 'sans réponse'));
    }));
    if (!closed.length) return;
    closed.sort((a, b) => asWeek(a[0]).localeCompare(asWeek(b[0])) || String(a[2]).localeCompare(String(b[2])));

    const start = Math.max(hist.getLastRow() + 1, HISTORY_FIRST_ROW);
    const missingRows = start + closed.length - 1 - hist.getMaxRows();
    if (missingRows > 0) hist.insertRowsAfter(hist.getMaxRows(), missingRows);
    hist.getRange(start, 1, closed.length, HEADER.length).setValues(closed);
    formatWideTab(hist, HISTORY_FIRST_ROW); // étend la mise en forme aux nouvelles lignes

    if (rows.length) src.getRange(2, 1, rows.length, HEADER.length).clearContent();
    if (keep.length) src.getRange(2, 1, keep.length, HEADER.length).setValues(keep);
  } finally {
    lock.releaseLock();
  }
}

// ---------- Fonctions d'administration (à lancer depuis l'éditeur) ----------

/**
 * Crée les onglets, leurs en-têtes, leur mise en forme et l'onglet Analyse,
 * et installe le déclencheur du dimanche. Peut être relancée sans risque.
 */
function setup() {
  prepareTab('Membres', ['email', 'nom', 'code', 'derniers créneaux']);
  sheet('Membres').getRange('C:D').setNumberFormat('@'); // sinon Sheets convertit les codes en nombres
  prepareTab('Erreurs', ['date', 'action', 'erreur']);

  [['Réponses', 2], ['Historique', HISTORY_FIRST_ROW]].forEach(([name, firstRow]) => {
    const sh = prepareTab(name, HEADER, firstRow);
    sh.setFrozenColumns(3);
    sh.getRange('A:A').setNumberFormat('@'); // sinon Sheets convertit les semaines en dates
    sh.getRange('D:D').setNumberFormat('dd/MM/yyyy HH:mm');
    sh.setColumnWidths(FIRST_SLOT_COL, SLOTS.length, 72);
  });

  // Ligne 2 de Historique : nombre de représentants disponibles par demi-heure, sur les lignes visibles
  // (SUBTOTAL ignore les lignes masquées par un filtre : filtrer une semaine donne ses totaux)
  const hist = sheet('Historique');
  hist.getRange(2, 1).setValue('Total (lignes filtrées)');
  hist.getRange(2, FIRST_SLOT_COL, 1, SLOTS.length).setFormulas([
    SLOTS.map((_, i) => {
      const col = colLetter(FIRST_SLOT_COL + i);
      return `=SUBTOTAL(109, ${col}${HISTORY_FIRST_ROW}:${col})`;
    }),
  ]);
  hist.getRange(2, 1, 1, HEADER.length).setFontWeight('bold');

  formatWideTab(sheet('Réponses'), 2);
  formatWideTab(hist, HISTORY_FIRST_ROW);
  buildAnalysis();

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'archiveWeek')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('archiveWeek').timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(21).nearMinute(30).inTimezone(TZ).create();
}

/** Attribue un code aléatoire entre 111111 et 999999 à chaque membre qui n'en a pas encore. */
function generateCodes() {
  const sh = sheet('Membres');
  const count = sh.getLastRow() - 1;
  if (count < 1) return;
  const range = sh.getRange(2, 3, count, 1);
  const randomCode = () => String(111111 + Math.floor(Math.random() * (999999 - 111111 + 1)));
  range.setValues(range.getValues().map(([code]) => [code || randomCode()]));
}

// ---------- Mise en forme et onglet Analyse ----------

/** Crée l'onglet s'il manque et écrit son en-tête. Refuse d'écraser des données dans un autre format. */
function prepareTab(name, header, firstDataRow = 2) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getMaxColumns() < header.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), header.length - sh.getMaxColumns());
  }
  const current = sh.getRange(1, 1, 1, header.length).getValues()[0];
  if (sh.getLastRow() >= firstDataRow && current.join('|') !== header.join('|')) {
    throw new Error(`L'onglet « ${name} » contient des données dans un ancien format : ` +
      'videz-le ou supprimez-le, puis relancez setup.');
  }
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  sh.setFrozenRows(firstDataRow - 1);
  return sh;
}

/** Colore les cases à 1, et la ligne des totaux de Historique du rouge (vide) au vert (plein). */
function formatWideTab(sh, firstRow) {
  const rows = sh.getMaxRows() - firstRow + 1;
  const rules = [
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberEqualTo(1)
      .setBackground('#8fd8cc')
      .setRanges([sh.getRange(firstRow, FIRST_SLOT_COL, rows, SLOTS.length)])
      .build(),
  ];
  if (firstRow === HISTORY_FIRST_ROW) rules.push(colorScale(sh.getRange(2, FIRST_SLOT_COL, 1, SLOTS.length)));
  sh.setConditionalFormatRules(rules);
}

function colorScale(range) {
  return SpreadsheetApp.newConditionalFormatRule()
    .setGradientMinpoint('#e67c73')
    .setGradientMidpointWithValue('#ffd666', SpreadsheetApp.InterpolationType.PERCENTILE, '50')
    .setGradientMaxpoint('#57bb8a')
    .setRanges([range])
    .build();
}

/**
 * Onglet Analyse, entièrement en formules (recréé à chaque setup) :
 * - une grille heures × jours : nombre moyen de représentants disponibles par semaine,
 *   ou pour une seule semaine si elle est choisie en B1 ;
 * - à droite, le nombre de représentants disponibles / indisponibles / sans réponse par semaine.
 */
function buildAnalysis() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName('Analyse') || ss.insertSheet('Analyse');
  sh.clear();

  sh.getRange('A1').setValue('Semaine').setFontWeight('bold');
  sh.getRange('B1').setNumberFormat('@').setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInRange(sheet('Historique').getRange(`A${HISTORY_FIRST_ROW}:A`), true)
      .setAllowInvalid(true)
      .build()
  );
  sh.getRange('C1').setValue('← vide = moyenne par semaine sur tout l\'historique').setFontColor('#667085');

  const times = [];
  for (let m = OPEN; m < CLOSE; m += 30) times.push(hhmm(m));
  sh.getRange(3, 1, 1, 1 + DAYS.length).setValues([['Heure'].concat(DAYS.map(d => d[1]))]).setFontWeight('bold');
  sh.getRange(4, 1, times.length, 1).setNumberFormat('@').setValues(times.map(t => [t]));

  const hist = `Historique!$A$${HISTORY_FIRST_ROW}:$A`;
  const formulas = times.map((_, t) => DAYS.map((_, d) => {
    const col = colLetter(FIRST_SLOT_COL + d * times.length + t);
    const slot = `Historique!${col}${HISTORY_FIRST_ROW}:${col}`;
    return `=IF($B$1="", SUM(${slot}) / MAX(1, COUNTUNIQUE(${hist})), SUMIF(${hist}, $B$1, ${slot}))`;
  }));
  const grid = sh.getRange(4, 2, times.length, DAYS.length);
  grid.setFormulas(formulas).setNumberFormat('0.0');
  sh.setConditionalFormatRules([colorScale(grid)]);

  sh.getRange('J1').setValue('Réponses par semaine').setFontWeight('bold');
  sh.getRange('J3').setFormula(
    `=IFERROR(QUERY(Historique!A${HISTORY_FIRST_ROW}:E, ` +
    `"select A, count(B) where A is not null group by A pivot E order by A desc label A 'semaine'", 0), ` +
    '"Pas encore de données")'
  );
  sh.setFrozenRows(3);
}

// ---------- Utilitaires ----------

/** Une ligne de Réponses/Historique. Sans statut donné : « disponible » ou « indisponible ». */
function toRow(week, member, submittedAt, ids, status) {
  const set = new Set(ids);
  const info = [week, member.email, member.name, submittedAt,
    status || (ids.length ? 'disponible' : 'indisponible'), ids.length];
  return info.concat(SLOTS.map(s => (set.has(s.id) ? 1 : '')));
}

/** Les identifiants des demi-heures cochées dans une ligne de Réponses/Historique. */
function slotsOf(row) {
  return SLOTS.filter((_, i) => row[INFO.length + i]).map(s => s.id);
}

/**
 * Les deux semaines que les représentants peuvent remplir, sous forme de dates du lundi.
 * Jusqu'au dimanche 21:00 (heure de Paris) : cette semaine et la suivante. Ensuite : la suivante et celle d'après.
 */
function allowedWeeks() {
  const now = new Date();
  const monday = mondayOf(Utilities.formatDate(now, TZ, 'yyyy-MM-dd'));
  const closed = Utilities.formatDate(now, TZ, 'u') === '7' && Number(Utilities.formatDate(now, TZ, 'H')) >= 21;
  const first = closed ? addDays(monday, 7) : monday;
  return [first, addDays(first, 7)];
}

// Calculs de dates sur des textes 'AAAA-MM-JJ', à midi UTC pour que le changement d'heure ne décale jamais le jour
function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mondayOf(ymd) {
  const dayIndex = (new Date(ymd + 'T12:00:00Z').getUTCDay() + 6) % 7; // 0 = lundi
  return addDays(ymd, -dayIndex);
}

function hhmm(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

/** Numéro de colonne → lettre(s) : 1 → A, 7 → G, 216 → HH. */
function colLetter(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function findMember(id, code) {
  const email = normEmail(id);
  const c = String(code || '').trim().toUpperCase();
  if (!email || !c) return null;
  const rows = sheet('Membres').getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (normEmail(rows[i][0]) === email && String(rows[i][2]).trim().toUpperCase() === c) {
      return { row: i + 1, email, name: String(rows[i][1]), lastSlots: splitSlots(rows[i][3]) };
    }
  }
  return null;
}

/** Une cellule de semaine en 'AAAA-MM-JJ', même si Sheets l'a convertie en date. */
function asWeek(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  return String(value);
}

/** Les lignes de données d'un onglet au format large (Réponses), sur la largeur exacte de l'en-tête. */
function readTable(name, firstRow = 2) {
  const sh = sheet(name);
  const count = sh.getLastRow() - firstRow + 1;
  return count > 0 ? sh.getRange(firstRow, 1, count, HEADER.length).getValues() : [];
}

const normEmail = v => String(v || '').trim().toLowerCase();
const splitSlots = v => String(v || '').split(',').filter(Boolean);
const sheet = name => SpreadsheetApp.getActive().getSheetByName(name);
const readRows = name => sheet(name).getDataRange().getValues().slice(1);

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function logError(action, err) {
  try {
    sheet('Erreurs').appendRow([new Date(), String(action), String((err && err.stack) || err)]);
  } catch (_) {
    // Plus rien à faire si même l'écriture de l'erreur échoue
  }
}
