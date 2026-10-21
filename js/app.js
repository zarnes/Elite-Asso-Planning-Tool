// Planning des coachs — frontend. Toute l'app est un seul composant Alpine, utilisé par index.html.
// Backend : apps-script/Code.gs. Mise en place : README.md.

const API_URL = 'https://script.google.com/macros/s/AKfycbwPZ0j_SkEsq7GRic00LUREpr1SapZGwbSBNoSK3qLcWyZCYO6tMVjsiqgRXhHGyuuuYQ/exec';

const DAYS = [
  { code: 'Mo', short: 'Lun', label: 'Lundi' },
  { code: 'Tu', short: 'Mar', label: 'Mardi' },
  { code: 'We', short: 'Mer', label: 'Mercredi' },
  { code: 'Th', short: 'Jeu', label: 'Jeudi' },
  { code: 'Fr', short: 'Ven', label: 'Vendredi' },
  { code: 'Sa', short: 'Sam', label: 'Samedi' },
  { code: 'Su', short: 'Dim', label: 'Dimanche' },
];

// Horaires d'ouverture, identiques tous les jours : 06:00 → 21:00 par pas de 30 minutes
const OPEN = 6 * 60;
const CLOSE = 21 * 60;
const TIMES = [];
for (let m = OPEN; m <= CLOSE; m += 30) TIMES.push(hhmm(m));

const ERRORS = {
  unauthorized: 'Email ou code inconnu.',
  week_closed: 'Cette semaine est close. Rechargez la page.',
  bad_slots: 'Créneaux invalides.',
  server_error: 'Erreur serveur, veuillez réessayer.',
};

// ---------- Utilitaires horaires ----------

function hhmm(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

function toMin(time) {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
}

function daysFromToday(week) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(week + 'T00:00:00') - today) / 864e5);
}

// ---------- Plages ({ day, start, end }) <-> identifiants de demi-heures ('Mo:0600') ----------

let nextKey = 0;

function rangesToIds(ranges) {
  const ids = new Set();
  for (const r of ranges) {
    for (let m = toMin(r.start); m < toMin(r.end); m += 30) ids.add(r.day + ':' + hhmm(m).replace(':', ''));
  }
  const dayIndex = id => DAYS.findIndex(d => d.code === id.slice(0, 2));
  return [...ids].sort((a, b) => dayIndex(a) - dayIndex(b) || a.localeCompare(b));
}

function idsToRanges(ids) {
  const ranges = [];
  for (const { code } of DAYS) {
    const starts = ids
      .filter(id => id.startsWith(code + ':'))
      .map(id => toMin(id.slice(3, 5) + ':' + id.slice(5)))
      .sort((a, b) => a - b);
    for (const m of starts) {
      const last = ranges[ranges.length - 1];
      if (last && last.day === code && toMin(last.end) === m) last.end = hhmm(m + 30);
      else ranges.push({ key: ++nextKey, day: code, start: hhmm(m), end: hhmm(m + 30) });
    }
  }
  return ranges;
}

// ---------- Identifiants, mémorisés sur l'appareil ----------

function loadCreds() {
  try {
    return JSON.parse(localStorage.getItem('coach'));
  } catch {
    return null;
  }
}

function saveCreds(creds) {
  try {
    if (creds) localStorage.setItem('coach', JSON.stringify(creds));
    else localStorage.removeItem('coach');
  } catch {
    // Navigation privée : le coach devra simplement se reconnecter la prochaine fois
  }
}

// ---------- L'application ----------

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    DAYS,
    TIMES,
    view: 'loading', // loading | login | form | availability
    id: '',
    code: '',
    name: '',
    weeks: [],
    week: '',
    drafts: {}, // semaine -> plages affichées dans le formulaire
    entries: {}, // semaine -> { slots, submittedAt } tels qu'enregistrés sur le serveur
    lastSlots: [],
    avail: null,
    availDay: DAYS[(new Date().getDay() + 6) % 7].code,
    busy: false,
    error: '',
    message: '',

    init() {
      const creds = loadCreds();
      if (!creds) return (this.view = 'login');
      this.id = creds.id;
      this.code = creds.code;
      this.login().then(() => {
        if (this.view === 'loading') this.view = 'login';
      });
    },

    async call(action, extra = {}) {
      if (API_URL.startsWith('PASTE')) throw new Error('API_URL non renseignée dans js/app.js');
      let data;
      try {
        // Volontairement sans en-tête Content-Type : en text/plain, le navigateur n'envoie pas
        // de requête CORS préalable (preflight), à laquelle Apps Script ne sait pas répondre
        const res = await fetch(API_URL, {
          method: 'POST',
          body: JSON.stringify({ action, id: this.id, code: this.code, ...extra }),
        });
        data = await res.json();
      } catch {
        throw new Error('Erreur réseau, veuillez réessayer.');
      }
      if (data.error === 'unauthorized') this.logout();
      if (!data.ok) throw new Error(ERRORS[data.error] || 'Une erreur est survenue.');
      return data;
    },

    // Exécute une action asynchrone en gérant l'indicateur de chargement et le bandeau d'erreur
    async run(action) {
      this.busy = true;
      this.error = '';
      try {
        await action();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },

    login() {
      return this.run(async () => {
        const data = await this.call('init');
        saveCreds({ id: this.id, code: this.code });
        this.name = data.name;
        this.weeks = data.weeks;
        this.entries = data.entries;
        this.lastSlots = data.lastSlots;
        this.drafts = {};
        for (const w of data.weeks) this.drafts[w] = idsToRanges(data.entries[w]?.slots ?? data.lastSlots);
        this.week = data.weeks.find(w => daysFromToday(w) > 0) || data.weeks[0];
        this.view = 'form';
      });
    },

    logout() {
      saveCreds(null);
      this.view = 'login';
    },

    // ----- Semaines -----

    selectWeek(w) {
      this.week = w;
      if (this.view === 'availability') this.loadAvailability();
    },

    weekTitle(w) {
      const days = daysFromToday(w);
      return days <= 0 ? 'Cette semaine' : days <= 7 ? 'Semaine prochaine' : 'Dans 2 semaines';
    },

    weekRange(w) {
      const start = new Date(w + 'T00:00:00');
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      const fmt = d => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
      return fmt(start) + ' – ' + fmt(end);
    },

    // ----- Formulaire -----

    get slots() {
      return this.drafts[this.week] || [];
    },

    get status() {
      const entry = this.entries[this.week];
      if (entry) {
        const when = new Date(entry.submittedAt).toLocaleString('fr-FR', {
          weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        });
        return 'Envoyé le ' + when;
      }
      return this.lastSlots.length ? 'Pas encore envoyé · pré-rempli avec votre dernière réponse' : 'Pas encore envoyé';
    },

    endTimes(slot) {
      return TIMES.filter(t => t > slot.start); // les textes 'HH:MM' se comparent comme des heures
    },

    fixEnd(slot) {
      if (slot.end <= slot.start) slot.end = hhmm(toMin(slot.start) + 30);
    },

    // Un nouveau créneau reprend les horaires du précédent, le jour suivant : la plupart des coachs
    // ont des horaires réguliers
    addSlot() {
      const last = this.slots[this.slots.length - 1];
      const day = last ? DAYS[(DAYS.findIndex(d => d.code === last.day) + 1) % 7].code : 'Mo';
      this.slots.push({ key: ++nextKey, day, start: last?.start ?? '18:00', end: last?.end ?? '20:00' });
    },

    removeSlot(i) {
      this.slots.splice(i, 1);
    },

    submit() {
      return this.run(async () => {
        const week = this.week;
        const slots = rangesToIds(this.slots);
        const data = await this.call('submit', { week, slots });
        this.entries[week] = { slots, submittedAt: data.savedAt };
        this.lastSlots = slots;
        // Fusionne les chevauchements de cette semaine, et pré-remplit les autres semaines pas encore envoyées
        for (const w of this.weeks) if (w === week || !this.entries[w]) this.drafts[w] = idsToRanges(slots);
        this.toast('Enregistré ✓');
      });
    },

    toast(text) {
      this.message = text;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => (this.message = ''), 2500);
    },

    // ----- Disponibilités -----

    showAvailability() {
      this.view = 'availability';
      this.loadAvailability();
    },

    loadAvailability() {
      const week = this.week;
      this.avail = null;
      return this.run(async () => {
        const data = await this.call('availability', { week });
        if (this.week === week) this.avail = data; // ignore une réponse arrivée après un changement de semaine
      });
    },

    names(day, time) {
      return this.avail?.slots[day + ':' + time.replace(':', '')] || [];
    },

    dayPeak(day) {
      return Math.max(0, ...TIMES.map(t => this.names(day, t).length));
    },

    get rows() {
      if (!this.avail) return [];
      const max = Math.max(1, this.avail.respondents);
      return TIMES.slice(0, -1).map(t => {
        const names = this.names(this.availDay, t);
        return { t, names, pct: Math.round((names.length / max) * 100) };
      });
    },
  }));
});
