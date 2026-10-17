import { createStore, isDemo } from './store.js';
import { parseIngredient, formatIngredient, formatQty, aggregate, categorize, normalize, CATEGORIES } from './ingredients.js';
import { importFromUrl } from './importer.js';

// ---------------------------------------------------------------- Constantes

const SLOTS = [
  { key: 'breakfast', label: 'Petit-déjeuner', short: 'Petit-déj', icon: '☕' },
  { key: 'lunch', label: 'Repas du midi', short: 'Midi', icon: '🍽️' },
  { key: 'snack', label: 'Goûter', short: 'Goûter', icon: '🍪' },
  { key: 'dinner', label: 'Repas du soir', short: 'Soir', icon: '🌙' },
  { key: 'prep', label: 'Batch cooking / préparation', short: 'Batch', icon: '🔪', optional: true },
];
const SLOT_BY_KEY = Object.fromEntries(SLOTS.map((s) => [s.key, s]));
const SLOT_ALIASES = {
  breakfast: 'breakfast', 'petit-dejeuner': 'breakfast', 'petit dejeuner': 'breakfast', 'petit-dej': 'breakfast', matin: 'breakfast',
  lunch: 'lunch', midi: 'lunch', dejeuner: 'lunch', 'repas du midi': 'lunch',
  snack: 'snack', gouter: 'snack',
  dinner: 'dinner', soir: 'dinner', diner: 'dinner', 'repas du soir': 'dinner',
  prep: 'prep', batch: 'prep', 'batch cooking': 'prep', preparation: 'prep',
};

const TABS = [
  { view: 'week', label: 'Semaine', icon: '📅' },
  { view: 'recipes', label: 'Recettes', icon: '📖' },
  { view: 'shopping', label: 'Courses', icon: '🛒' },
  { view: 'more', label: 'Plus', icon: '⚙️' },
];

// ---------------------------------------------------------------- Outils

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (k, n) => {
  const d = fromKey(k);
  d.setDate(d.getDate() + n);
  return toKey(d);
};
// Premier jour de la semaine (réglable : lundi, samedi ou dimanche)
const weekStartDay = () => Number(getSetting('weekstart', 1));
const weekStartOf = (date) => {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() - weekStartDay() + 7) % 7));
  return toKey(d);
};
const todayKey = () => toKey(new Date());
const fmt = (k, opts) => new Intl.DateTimeFormat('fr-FR', opts).format(fromKey(k));
const dayTitle = (k) => fmt(k, { weekday: 'long', day: 'numeric', month: 'short' });
const weekLabel = (start) => {
  const end = addDays(start, 6);
  return `${fmt(start, { day: 'numeric', month: 'short' })} – ${fmt(end, { day: 'numeric', month: 'short' })}`;
};
const minutes = (m) => (m ? (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? pad(m % 60) : ''}` : `${m} min`) : '');

function getSetting(key, fallback) {
  try {
    return localStorage.getItem('menu-' + key) ?? fallback;
  } catch {
    return fallback;
  }
}
function setSetting(key, value) {
  try {
    localStorage.setItem('menu-' + key, value);
  } catch {}
}
const defaultServings = () => Number(getSetting('servings', 2)) || 2;

function toast(text, ms = 2600) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function handleError(e) {
  console.error(e);
  const code = e?.code || '';
  if (code.includes('permission-denied')) toast("Accès refusé : votre adresse e-mail n'est pas autorisée dans les règles Firestore.", 6000);
  else toast('Erreur : ' + (e?.message || e), 5000);
}

// Les écritures ne sont pas attendues : Firebase les applique tout de suite
// localement puis les envoie dès que le réseau est disponible.
const run = (promise) => Promise.resolve(promise).catch(handleError);

// ---------------------------------------------------------------- État

const state = {
  store: null,
  user: null,
  view: 'week',
  recipeId: null,
  weekStart: weekStartOf(new Date()),
  recipes: [],
  meals: [],
  shopping: [],
  search: '',
  detailServings: null,
  loaded: { recipes: false, meals: false, shopping: false },
};
const unsubs = {};
const recipeById = (id) => state.recipes.find((r) => r.id === id);

// ---------------------------------------------------------------- Démarrage

async function init() {
  window.addEventListener('hashchange', route);
  route(false);
  try {
    state.store = await createStore();
  } catch (e) {
    $('#app').innerHTML = `<div class="login"><h1>Oups</h1><p>Impossible de charger l'application : ${esc(e.message)}</p><p>Vérifiez votre connexion internet et le fichier js/config.js.</p></div>`;
    return;
  }
  state.store.onAuth((user) => {
    state.user = user;
    if (user) startData();
    else stopData();
    render();
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function startData() {
  const s = state.store;
  unsubs.recipes?.();
  unsubs.shopping?.();
  unsubs.recipes = s.watch(
    'recipes',
    (list) => {
      state.recipes = list.sort((a, b) => a.title.localeCompare(b.title, 'fr'));
      state.loaded.recipes = true;
      render();
    },
    handleError
  );
  unsubs.shopping = s.watch(
    'shopping',
    (list) => {
      state.shopping = list;
      state.loaded.shopping = true;
      render();
    },
    handleError
  );
  watchWeek();
}

function watchWeek() {
  unsubs.meals?.();
  state.loaded.meals = false;
  const start = state.weekStart;
  unsubs.meals = state.store.watchMeals(
    start,
    addDays(start, 6),
    (list) => {
      if (start !== state.weekStart) return;
      state.meals = list;
      state.loaded.meals = true;
      render();
    },
    handleError
  );
}

function stopData() {
  Object.values(unsubs).forEach((u) => u?.());
  state.recipes = [];
  state.meals = [];
  state.shopping = [];
}

function route(doRender = true) {
  const [view, id] = (location.hash.replace('#', '') || 'week').split('/');
  state.view = ['week', 'recipes', 'recipe', 'shopping', 'more'].includes(view) ? view : 'week';
  if (state.view === 'recipe' && state.recipeId !== id) state.detailServings = null;
  state.recipeId = id || null;
  if (doRender) {
    render();
    window.scrollTo(0, 0);
  }
}

// ---------------------------------------------------------------- Rendu

function render() {
  const app = $('#app');
  if (!state.store) return;
  if (!state.user) {
    if (!$('#login-form')) app.innerHTML = loginView();
    return;
  }
  // Conserve la saisie en cours quand un changement arrive de l'autre téléphone
  const active = document.activeElement;
  const activeId = active?.id;
  const sel = activeId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const values = {};
  app.querySelectorAll('input[id], textarea[id], select[id]').forEach((el) => {
    if (el.type !== 'checkbox') values[el.id] = el.value;
  });

  const tab = state.view === 'recipe' ? 'recipes' : state.view;
  const remaining = state.shopping.filter((i) => !i.checked).length;
  app.innerHTML = `
    <header class="topbar">
      <h1>${esc(viewTitle())}</h1>
      ${isDemo ? '<span class="badge" title="Les données ne sont pas partagées">Démo</span>' : ''}
    </header>
    <main id="main">${viewBody()}</main>
    <nav class="tabbar">
      ${TABS.map(
        (t) => `<a href="#${t.view}" class="${t.view === tab ? 'active' : ''}">
          <span class="ico">${t.icon}</span><span>${t.label}</span>
          ${t.view === 'shopping' && remaining ? `<b class="count">${remaining}</b>` : ''}
        </a>`
      ).join('')}
    </nav>`;

  for (const [id, v] of Object.entries(values)) {
    const el = document.getElementById(id);
    if (el) el.value = v;
  }
  if (activeId) {
    const el = document.getElementById(activeId);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel) try { el.setSelectionRange(...sel); } catch {}
    }
  }
}

function viewTitle() {
  if (state.view === 'recipe') return recipeById(state.recipeId)?.title || 'Recette';
  return { week: 'Menu de la semaine', recipes: 'Recettes', shopping: 'Liste de courses', more: 'Réglages' }[state.view];
}

function viewBody() {
  switch (state.view) {
    case 'recipes':
      return recipesView();
    case 'recipe':
      return recipeView();
    case 'shopping':
      return shoppingView();
    case 'more':
      return moreView();
    default:
      return weekView();
  }
}

function loginView() {
  return `
    <div class="login">
      <div class="logo">🥗</div>
      <h1>Nos menus</h1>
      <p>Connectez-vous avec le compte créé dans Firebase.</p>
      <form id="login-form" data-form="login">
        <input type="email" name="email" placeholder="Adresse e-mail" autocomplete="username" required>
        <input type="password" name="password" placeholder="Mot de passe" autocomplete="current-password" required>
        <button class="btn primary" type="submit">Se connecter</button>
      </form>
      <button class="link" data-action="reset-password">Mot de passe oublié ?</button>
    </div>`;
}

// ---------- Semaine

function weekView() {
  const start = state.weekStart;
  const isCurrent = start === weekStartOf(new Date());
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  const byDaySlot = {};
  for (const m of state.meals) (byDaySlot[m.date + m.slot] ||= []).push(m);
  Object.values(byDaySlot).forEach((l) => l.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));

  return `
    <div class="week-nav">
      <button class="icon-btn" data-action="prev-week" aria-label="Semaine précédente">‹</button>
      <div class="week-label">
        <strong>${weekLabel(start)}</strong>
        ${isCurrent ? '<small>Cette semaine</small>' : '<button class="link small" data-action="this-week">Revenir à cette semaine</button>'}
      </div>
      <button class="icon-btn" data-action="next-week" aria-label="Semaine suivante">›</button>
    </div>
    ${!state.loaded.meals ? '<p class="muted center">Chargement…</p>' : ''}
    ${days
      .map(
        (d) => `
      <section class="day ${d === todayKey() ? 'today' : ''}">
        <h2>${esc(dayTitle(d))}${d === todayKey() ? ' <span class="pill">Aujourd’hui</span>' : ''}</h2>
        ${SLOTS.filter((s) => !s.optional || byDaySlot[d + s.key])
          .map(
            (s) => `
          <div class="slot">
            <div class="slot-label"><span>${s.icon}</span>${s.short}</div>
            <div class="chips">
              ${(byDaySlot[d + s.key] || []).map(mealChip).join('')}
            </div>
            <button class="add-btn" data-action="add-meal" data-date="${d}" data-slot="${s.key}" aria-label="Ajouter">+</button>
          </div>`
          )
          .join('')}
      </section>`
      )
      .join('')}
    <div class="actions-row">
      <button class="btn primary block" data-action="generate-shopping">🛒 Faire la liste de courses de cette semaine</button>
    </div>`;
}

function mealChip(m) {
  const missing = m.recipeId && !recipeById(m.recipeId) && state.loaded.recipes;
  return `<button class="chip ${m.recipeId ? '' : 'note'} ${m.prepared ? 'prepared' : ''} ${m.slot === 'prep' ? 'batch' : ''}" data-action="open-meal" data-id="${m.id}">
    ${m.prepared ? '♻️ ' : ''}${esc(m.title)}${missing ? ' <small>(supprimée)</small>' : ''}
    ${m.recipeId ? `<small>· ${m.servings} pers.</small>` : ''}
  </button>`;
}

// ---------- Recettes

function recipesView() {
  return `
    <div class="toolbar">
      <input id="recipe-search" type="search" placeholder="Rechercher une recette, un ingrédient…" value="${esc(state.search)}" data-input="search" autocomplete="off">
    </div>
    <div class="actions-row two">
      <button class="btn primary" data-action="new-recipe">＋ Nouvelle recette</button>
      <button class="btn" data-action="import-url">🌐 Depuis un site</button>
    </div>
    <div id="recipe-list">${recipeListHtml()}</div>`;
}

function filteredRecipes(query) {
  const q = normalize(query);
  if (!q) return state.recipes;
  return state.recipes.filter((r) =>
    normalize([r.title, ...(r.tags || []), ...(r.ingredients || []).map((i) => i.name)].join(' ')).includes(q)
  );
}

function recipeListHtml() {
  if (!state.loaded.recipes) return '<p class="muted center">Chargement…</p>';
  const list = filteredRecipes(state.search);
  if (!state.recipes.length)
    return `<div class="empty"><p>Aucune recette pour l’instant.</p><p>Ajoutez-en une à la main, importez-la depuis un site comme Marmiton, ou importez un plan préparé par Claude dans l’onglet Plus.</p></div>`;
  if (!list.length) return '<p class="muted center">Aucune recette ne correspond.</p>';
  return `<div class="cards">${list
    .map(
      (r) => `
    <a class="card" href="#recipe/${r.id}">
      ${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="ph">${isBatch(r) ? '🥘' : '🍲'}</div>`}
      <div class="card-body">
        <strong>${esc(r.title)}</strong>
        <small>${[minutes((r.prepTime || 0) + (r.cookTime || 0)), r.servings ? r.servings + ' pers.' : ''].filter(Boolean).join(' · ')}</small>
        <div class="tags">${(r.tags || []).slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join('')}</div>
      </div>
    </a>`
    )
    .join('')}</div>`;
}

const isBatch = (r) => (r.tags || []).some((t) => normalize(t).includes('batch'));

function recipeView() {
  const r = recipeById(state.recipeId);
  if (!r) return state.loaded.recipes ? '<p class="muted center">Cette recette n’existe plus.</p><p class="center"><a href="#recipes">← Retour aux recettes</a></p>' : '<p class="muted center">Chargement…</p>';
  const servings = state.detailServings || r.servings || 1;
  const factor = servings / (r.servings || 1);
  return `
    <a class="back" href="#recipes">← Recettes</a>
    ${r.image ? `<img class="hero" src="${esc(r.image)}" alt="" referrerpolicy="no-referrer">` : ''}
    <div class="meta">
      ${r.prepTime ? `<span>🔪 Préparation ${minutes(r.prepTime)}</span>` : ''}
      ${r.cookTime ? `<span>🔥 Cuisson ${minutes(r.cookTime)}</span>` : ''}
    </div>
    <div class="tags">${(r.tags || []).map((t) => `<span>${esc(t)}</span>`).join('')}</div>
    <div class="actions-row two">
      <button class="btn primary" data-action="cook-mode">▶️ Cuisiner pas à pas</button>
      <button class="btn" data-action="plan-recipe">📅 Ajouter au menu</button>
    </div>

    <h3>Ingrédients</h3>
    <div class="stepper">
      <button class="icon-btn" data-action="servings" data-delta="-1">−</button>
      <span>${servings} personne${servings > 1 ? 's' : ''}</span>
      <button class="icon-btn" data-action="servings" data-delta="1">+</button>
    </div>
    <ul class="ingredients">
      ${(r.ingredients || []).map((i, n) => `<li><label><input type="checkbox"> ${esc(formatIngredient(i, factor))}</label></li>`).join('')}
    </ul>

    <h3>Étapes</h3>
    <ol class="steps">
      ${(r.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}
    </ol>
    ${r.notes ? `<h3>Notes</h3><p class="notes">${esc(r.notes)}</p>` : ''}
    ${r.source ? `<p class="muted small">Source : <a href="${esc(r.source)}" target="_blank" rel="noopener">${esc(hostname(r.source))}</a></p>` : ''}
    <div class="actions-row two">
      <button class="btn" data-action="edit-recipe">✏️ Modifier</button>
      <button class="btn danger" data-action="delete-recipe">🗑 Supprimer</button>
    </div>`;
}

const hostname = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

// ---------- Courses

function shoppingView() {
  const groups = {};
  for (const item of state.shopping) (groups[item.category || 'Autre'] ||= []).push(item);
  const ordered = CATEGORIES.filter((c) => groups[c]).concat(Object.keys(groups).filter((c) => !CATEGORIES.includes(c)));
  const checked = state.shopping.filter((i) => i.checked).length;
  return `
    <form class="add-item" data-form="add-item">
      <input id="item-input" name="item" placeholder="Ajouter (ex : 2 kg de pommes)" autocomplete="off" enterkeyhint="done">
      <button class="btn primary" type="submit">Ajouter</button>
    </form>
    <button class="btn block" data-action="generate-shopping">🔄 Générer depuis le menu (${weekLabel(state.weekStart)})</button>
    ${!state.loaded.shopping ? '<p class="muted center">Chargement…</p>' : ''}
    ${state.loaded.shopping && !state.shopping.length ? '<div class="empty"><p>La liste est vide.</p><p>Planifiez des recettes dans l’onglet Semaine puis appuyez sur « Générer », ou ajoutez des articles à la main.</p></div>' : ''}
    ${ordered
      .map(
        (cat) => `
      <section class="group">
        <h3>${esc(cat)}</h3>
        <ul class="items">
          ${groups[cat]
            .sort((a, b) => a.checked - b.checked || a.name.localeCompare(b.name, 'fr'))
            .map(
              (i) => `
            <li class="${i.checked ? 'done' : ''}">
              <label><input type="checkbox" data-change="toggle-item" data-id="${i.id}" ${i.checked ? 'checked' : ''}>
                <span>${esc(itemLabel(i))}</span></label>
              <button class="x" data-action="delete-item" data-id="${i.id}" aria-label="Supprimer">×</button>
            </li>`
            )
            .join('')}
        </ul>
      </section>`
      )
      .join('')}
    ${
      state.shopping.length
        ? `<div class="actions-row two">
        <button class="btn" data-action="clear-checked" ${checked ? '' : 'disabled'}>Retirer les cochés (${checked})</button>
        <button class="btn danger" data-action="clear-all">Tout effacer</button>
      </div>
      <button class="btn block" data-action="share-list">📤 Copier la liste</button>`
        : ''
    }`;
}

function itemLabel(i) {
  if (i.qty === null || i.qty === undefined) return i.name;
  return formatIngredient(i);
}

// ---------- Plus

function moreView() {
  return `
    <section class="panel">
      <h3>Compte</h3>
      ${
        isDemo
          ? `<p><strong>Mode démo.</strong> Les données restent sur ce téléphone et ne sont pas partagées. Suivez l’étape 3 du guide pour activer la synchronisation.</p>
             <button class="btn" data-action="sign-out">Réinitialiser la démo</button>`
          : `<p>Connecté : <strong>${esc(state.user.email)}</strong><br><span class="muted small">Les données sont synchronisées en temps réel.</span></p>
             <button class="btn" data-action="sign-out">Se déconnecter</button>`
      }
    </section>

    <section class="panel">
      <h3>Nombre de personnes par défaut</h3>
      <div class="stepper">
        <button class="icon-btn" data-action="default-servings" data-delta="-1">−</button>
        <span>${defaultServings()} personne${defaultServings() > 1 ? 's' : ''}</span>
        <button class="icon-btn" data-action="default-servings" data-delta="1">+</button>
      </div>
    </section>

    <section class="panel">
      <h3>La semaine commence le</h3>
      <select id="week-start" data-change="week-start">
        ${[[1, 'Lundi'], [6, 'Samedi'], [0, 'Dimanche']].map(([v, l]) => `<option value="${v}" ${weekStartDay() === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <p class="small muted">Pratique si vous faites le batch cooking le week-end pour la semaine qui suit.</p>
    </section>

    <section class="panel">
      <h3>📥 Importer un plan préparé par Claude</h3>
      <p class="small">Collez ici le texte (format JSON) que Claude vous donne : recettes, menu de la semaine, batch cooking et liste de courses sont ajoutés d’un coup.</p>
      <textarea id="plan-json" rows="6" placeholder='{"recipes": [...], "meals": [...], "shopping": [...]}'></textarea>
      <div class="actions-row two">
        <button class="btn primary" data-action="import-plan">Importer</button>
        <label class="btn file">Choisir un fichier<input type="file" accept=".json,application/json,text/plain" data-change="import-file" hidden></label>
      </div>
    </section>

    <section class="panel">
      <h3>📤 Sauvegarde</h3>
      <p class="small">Télécharge toutes vos données. Vous pouvez aussi envoyer ce fichier à Claude pour qu’il tienne compte de vos recettes.</p>
      <button class="btn" data-action="export">Exporter les données</button>
    </section>

    <section class="panel">
      <h3>📱 Installer sur l’iPhone</h3>
      <p class="small">Dans Safari : bouton <strong>Partager</strong> (carré avec une flèche) → <strong>Sur l’écran d’accueil</strong> → <strong>Ajouter</strong>.</p>
    </section>
    <p class="muted small center">Nos menus · version 1.0</p>`;
}

// ---------------------------------------------------------------- Fenêtres

function openModal(html, { full = false } = {}) {
  $('#modal-root').innerHTML = `<div class="backdrop"><div class="sheet ${full ? 'full' : ''}" role="dialog">${html}</div></div>`;
  document.body.classList.add('modal-open');
  return $('#modal-root .sheet');
}
function closeModal() {
  $('#modal-root').innerHTML = '';
  document.body.classList.remove('modal-open');
  releaseWakeLock();
  clearInterval(cook.timer);
}

function slotOptions(selected) {
  return SLOTS.map((s) => `<option value="${s.key}" ${s.key === selected ? 'selected' : ''}>${s.icon} ${s.label}</option>`).join('');
}

function addMealModal(date, slot) {
  const servings = defaultServings();
  const sheet = openModal(`
    <div class="sheet-head"><h2>${SLOT_BY_KEY[slot].icon} ${esc(SLOT_BY_KEY[slot].label)}</h2><button class="x" data-action="close-modal">×</button></div>
    <p class="muted">${esc(dayTitle(date))}</p>
    <div class="stepper">
      <button class="icon-btn" data-action="picker-servings" data-delta="-1">−</button>
      <span id="picker-servings" data-value="${servings}">${servings} pers.</span>
      <button class="icon-btn" data-action="picker-servings" data-delta="1">+</button>
    </div>
    <label class="check"><input type="checkbox" id="picker-prepared"> ♻️ Déjà préparé (batch cooking, restes) : ne pas compter dans les courses</label>
    <input id="picker-search" type="search" placeholder="Rechercher une recette…" data-input="picker-search" autocomplete="off">
    <div id="picker-list" class="picker">${pickerList('')}</div>
    <form class="add-item" data-form="add-note">
      <input name="note" placeholder="Ou une note libre (restes, resto…)" autocomplete="off">
      <button class="btn" type="submit">Ajouter</button>
    </form>`);
  sheet.dataset.date = date;
  sheet.dataset.slot = slot;
}

function pickerList(query) {
  const list = filteredRecipes(query);
  if (!state.recipes.length) return '<p class="muted small">Aucune recette enregistrée pour l’instant.</p>';
  if (!list.length) return '<p class="muted small">Aucune recette ne correspond.</p>';
  return list.map((r) => `<button class="pick" data-action="pick-recipe" data-id="${r.id}">${isBatch(r) ? '🥘' : '🍲'} ${esc(r.title)}</button>`).join('');
}

function mealModal(meal) {
  const r = meal.recipeId ? recipeById(meal.recipeId) : null;
  const sheet = openModal(`
    <div class="sheet-head"><h2>${esc(meal.title)}</h2><button class="x" data-action="close-modal">×</button></div>
    <form data-form="edit-meal" class="form">
      <label>Jour<input type="date" name="date" value="${meal.date}" required></label>
      <label>Moment<select name="slot">${slotOptions(meal.slot)}</select></label>
      ${meal.recipeId ? `<label>Nombre de personnes<input type="number" name="servings" min="1" max="30" value="${meal.servings || defaultServings()}"></label>` : `<label>Texte<input name="title" value="${esc(meal.title)}"></label>`}
      <label class="check"><input type="checkbox" name="prepared" ${meal.prepared ? 'checked' : ''}> ♻️ Déjà préparé : ne pas compter dans les courses</label>
      <button class="btn primary" type="submit">Enregistrer</button>
    </form>
    <div class="actions-row two">
      ${r ? `<button class="btn" data-action="goto-recipe" data-id="${r.id}">📖 Voir la recette</button>` : '<span></span>'}
      <button class="btn danger" data-action="delete-meal">Retirer du menu</button>
    </div>`);
  sheet.dataset.id = meal.id;
}

function planRecipeModal(r) {
  const sheet = openModal(`
    <div class="sheet-head"><h2>📅 Ajouter au menu</h2><button class="x" data-action="close-modal">×</button></div>
    <p class="muted">${esc(r.title)}</p>
    <form data-form="plan-recipe" class="form">
      <label>Jour<input type="date" name="date" value="${todayKey()}" required></label>
      <label>Moment<select name="slot">${slotOptions(isBatch(r) ? 'prep' : 'dinner')}</select></label>
      <label>Nombre de personnes<input type="number" name="servings" min="1" max="30" value="${defaultServings()}"></label>
      <label class="check"><input type="checkbox" name="prepared"> ♻️ Déjà préparé : ne pas compter dans les courses</label>
      <button class="btn primary" type="submit">Ajouter</button>
    </form>`);
  sheet.dataset.id = r.id;
}

function recipeFormModal(r = {}) {
  const sheet = openModal(
    `
    <div class="sheet-head"><h2>${r.id ? 'Modifier la recette' : 'Nouvelle recette'}</h2><button class="x" data-action="close-modal">×</button></div>
    <form data-form="save-recipe" class="form">
      <label>Titre<input name="title" required value="${esc(r.title || '')}"></label>
      <div class="grid3">
        <label>Personnes<input type="number" name="servings" min="1" max="50" value="${r.servings || 4}"></label>
        <label>Préparation (min)<input type="number" name="prepTime" min="0" value="${r.prepTime ?? ''}"></label>
        <label>Cuisson (min)<input type="number" name="cookTime" min="0" value="${r.cookTime ?? ''}"></label>
      </div>
      <label>Ingrédients <small>(un par ligne, ex : 200 g de farine)</small>
        <textarea name="ingredients" rows="8">${esc((r.ingredients || []).map((i) => formatIngredient(i)).join('\n'))}</textarea></label>
      <label>Étapes <small>(une par ligne)</small>
        <textarea name="steps" rows="8">${esc((r.steps || []).join('\n'))}</textarea></label>
      <label>Étiquettes <small>(séparées par des virgules : végétarien, rapide, batch cooking…)</small>
        <input name="tags" value="${esc((r.tags || []).join(', '))}"></label>
      <label>Notes<textarea name="notes" rows="2">${esc(r.notes || '')}</textarea></label>
      <label>Image <small>(adresse web, facultatif)</small><input name="image" type="url" value="${esc(r.image || '')}"></label>
      <input type="hidden" name="source" value="${esc(r.source || '')}">
      <button class="btn primary" type="submit">Enregistrer</button>
    </form>`,
    { full: true }
  );
  sheet.dataset.id = r.id || '';
}

function importUrlModal() {
  openModal(`
    <div class="sheet-head"><h2>🌐 Importer depuis un site</h2><button class="x" data-action="close-modal">×</button></div>
    <p class="small">Copiez l’adresse d’une recette (Marmiton, 750g, CuisineAZ, Journal des Femmes…) depuis Safari et collez-la ici.</p>
    <form data-form="import-url" class="form">
      <input name="url" type="url" placeholder="https://www.marmiton.org/recettes/…" required autocomplete="off">
      <button class="btn primary" type="submit">Importer</button>
    </form>
    <p id="import-status" class="small muted"></p>`);
}

// ---------- Mode cuisine pas à pas

const cook = { recipe: null, step: 0, factor: 1, wake: null, timer: null, remaining: 0 };

async function requestWakeLock() {
  try {
    cook.wake = await navigator.wakeLock?.request('screen');
  } catch {}
}
function releaseWakeLock() {
  cook.wake?.release?.().catch(() => {});
  cook.wake = null;
}

function openCookMode(r) {
  cook.recipe = r;
  cook.step = 0;
  cook.factor = (state.detailServings || r.servings || 1) / (r.servings || 1);
  openModal('<div id="cook"></div>', { full: true });
  renderCook();
  requestWakeLock();
}

function renderCook() {
  const r = cook.recipe;
  const steps = r.steps || [];
  const total = steps.length;
  const i = cook.step;
  const el = $('#cook');
  if (!el) return;
  const text = steps[i] || '';
  const t = text.match(/(\d+)\s*(?:min\b|minutes?)/i);
  el.innerHTML = `
    <div class="sheet-head"><h2>${esc(r.title)}</h2><button class="x" data-action="close-modal">×</button></div>
    ${
      i < 0
        ? ''
        : total
        ? `<div class="progress"><div style="width:${((i + 1) / total) * 100}%"></div></div>
      <p class="muted">Étape ${i + 1} sur ${total}</p>
      <p class="cook-step">${esc(text)}</p>
      ${t ? `<button class="btn" data-action="start-timer" data-min="${t[1]}">⏲ Minuteur ${t[1]} min</button>` : ''}
      <p id="timer" class="timer">${cook.remaining > 0 ? fmtTimer(cook.remaining) : ''}</p>`
        : '<p>Cette recette n’a pas encore d’étapes.</p>'
    }
    <details class="cook-ings"><summary>Voir les ingrédients</summary>
      <ul>${(r.ingredients || []).map((x) => `<li>${esc(formatIngredient(x, cook.factor))}</li>`).join('')}</ul>
    </details>
    <div class="cook-nav">
      <button class="btn" data-action="cook-prev" ${i <= 0 ? 'disabled' : ''}>← Précédent</button>
      ${i < total - 1 ? '<button class="btn primary" data-action="cook-next">Suivant →</button>' : '<button class="btn primary" data-action="close-modal">Terminé 🎉</button>'}
    </div>`;
}

const fmtTimer = (s) => `${Math.floor(s / 60)}:${pad(s % 60)}`;

function startTimer(min) {
  clearInterval(cook.timer);
  cook.remaining = min * 60;
  const tick = () => {
    const el = $('#timer');
    if (el) el.textContent = cook.remaining > 0 ? fmtTimer(cook.remaining) : '⏰ Terminé !';
  };
  tick();
  cook.timer = setInterval(() => {
    cook.remaining -= 1;
    tick();
    if (cook.remaining <= 0) {
      clearInterval(cook.timer);
      beep();
      toast('⏰ Minuteur terminé !', 6000);
    }
  }, 1000);
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.4, 0.8].forEach((d) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.3, ctx.currentTime + d);
      o.start(ctx.currentTime + d);
      o.stop(ctx.currentTime + d + 0.25);
    });
  } catch {}
}

// ---------------------------------------------------------------- Actions

function parseLines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function generateShopping() {
  const meals = state.meals.filter((m) => m.recipeId && !m.prepared);
  if (!meals.length) {
    toast('Aucune recette à compter dans le menu de cette semaine.');
    return;
  }
  const all = [];
  let missing = 0;
  for (const m of meals) {
    const r = recipeById(m.recipeId);
    if (!r) {
      missing++;
      continue;
    }
    const factor = (m.servings || r.servings || 1) / (r.servings || 1);
    for (const i of r.ingredients || []) all.push({ ...i, qty: i.qty === null || i.qty === undefined ? null : i.qty * factor });
  }
  const items = aggregate(all);
  const oldAuto = state.shopping.filter((i) => i.source === 'auto');
  if (oldAuto.length && !confirm('Remplacer les articles générés précédemment ? (les articles ajoutés à la main sont conservés)')) return;
  const ops = [
    ...oldAuto.map((i) => ({ type: 'remove', name: 'shopping', id: i.id })),
    ...items.map((i) => ({
      type: 'add',
      name: 'shopping',
      id: state.store.newId('shopping'),
      data: { name: i.name, qty: i.qty === null ? null : Math.round(i.qty * 100) / 100, unit: i.unit, category: categorize(i.name), checked: false, source: 'auto', week: state.weekStart },
    })),
  ];
  run(state.store.bulk(ops));
  toast(`${items.length} article${items.length > 1 ? 's' : ''} dans la liste${missing ? ` (${missing} recette(s) introuvable(s))` : ''}.`);
  location.hash = '#shopping';
}

function normalizeIngredient(x) {
  if (!x) return null;
  if (typeof x === 'string') return parseIngredient(x);
  const qty = x.qty ?? x.quantity ?? null;
  return { qty: qty === null || qty === '' ? null : Number(qty), unit: x.unit || '', name: String(x.name || '').trim() };
}

// Importe un plan au format JSON (voir exemple-import.json)
async function importPlan(text) {
  let data;
  try {
    data = JSON.parse(String(text).trim().replace(/^```(?:json)?/, '').replace(/```$/, ''));
  } catch {
    throw new Error('Le texte collé n’est pas un JSON valide. Copiez bien tout le bloc donné par Claude.');
  }
  const ops = [];
  const refs = {};
  const existing = Object.fromEntries(state.recipes.map((r) => [normalize(r.title), r]));
  const counts = { recipes: 0, meals: 0, shopping: 0 };

  for (const r of data.recipes || []) {
    if (!r.title) continue;
    const id = state.store.newId('recipes');
    const recipe = {
      title: String(r.title),
      servings: Number(r.servings) || 4,
      prepTime: Number(r.prepTime) || null,
      cookTime: Number(r.cookTime) || null,
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      image: r.image || '',
      source: r.source || 'Claude',
      notes: r.notes || '',
      ingredients: (r.ingredients || []).map(normalizeIngredient).filter((i) => i && i.name),
      steps: (r.steps || []).map((s) => (typeof s === 'string' ? s : s.text || '')).filter(Boolean),
    };
    ops.push({ type: 'add', name: 'recipes', id, data: recipe });
    const entry = { id, ...recipe };
    if (r.ref) refs[r.ref] = entry;
    refs[normalize(r.title)] = entry;
    counts.recipes++;
  }

  let firstDate = null;
  for (const m of data.meals || []) {
    const slot = SLOT_ALIASES[normalize(m.slot)] || null;
    if (!slot || !/^\d{4}-\d{2}-\d{2}$/.test(m.date || '')) continue;
    const ref = m.recipe ?? m.recipeRef ?? '';
    const r = refs[ref] || refs[normalize(ref)] || existing[normalize(ref)] || null;
    ops.push({
      type: 'add',
      name: 'meals',
      id: state.store.newId('meals'),
      data: {
        date: m.date,
        slot,
        recipeId: r ? r.id : null,
        title: r ? r.title : String(m.title || ref || 'Repas'),
        servings: Number(m.servings) || defaultServings(),
        prepared: !!m.prepared,
      },
    });
    if (!firstDate || m.date < firstDate) firstDate = m.date;
    counts.meals++;
  }

  for (const s of data.shopping || []) {
    const i = normalizeIngredient(s);
    if (!i || !i.name) continue;
    ops.push({
      type: 'add',
      name: 'shopping',
      id: state.store.newId('shopping'),
      data: { ...i, category: (typeof s === 'object' && CATEGORIES.includes(s.category) && s.category) || categorize(i.name), checked: false, source: 'claude' },
    });
    counts.shopping++;
  }

  if (!ops.length) throw new Error('Rien à importer : le texte ne contient ni recettes, ni repas, ni courses.');
  await state.store.bulk(ops);
  if (firstDate) {
    state.weekStart = weekStartOf(fromKey(firstDate));
    watchWeek();
  }
  return counts;
}

async function exportData() {
  const [recipes, meals, shopping] = await Promise.all(['recipes', 'meals', 'shopping'].map((n) => state.store.getAll(n)));
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), recipes, meals, shopping }, null, 2)], { type: 'application/json' });
  const file = new File([blob], `menus-${todayKey()}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Sauvegarde menus' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const actions = {
  'close-modal': closeModal,
  'prev-week': () => shiftWeek(-7),
  'next-week': () => shiftWeek(7),
  'this-week': () => {
    state.weekStart = weekStartOf(new Date());
    watchWeek();
    render();
  },
  'add-meal': (el) => addMealModal(el.dataset.date, el.dataset.slot),
  'open-meal': (el) => {
    const m = state.meals.find((x) => x.id === el.dataset.id);
    if (m) mealModal(m);
  },
  'picker-servings': (el) => {
    const span = $('#picker-servings');
    const v = Math.max(1, Math.min(30, Number(span.dataset.value) + Number(el.dataset.delta)));
    span.dataset.value = v;
    span.textContent = v + ' pers.';
  },
  'pick-recipe': (el) => {
    const sheet = el.closest('.sheet');
    const r = recipeById(el.dataset.id);
    if (!r) return;
    run(
      state.store.add('meals', {
        date: sheet.dataset.date,
        slot: sheet.dataset.slot,
        recipeId: r.id,
        title: r.title,
        servings: Number($('#picker-servings').dataset.value) || defaultServings(),
        prepared: $('#picker-prepared').checked,
      })
    );
    closeModal();
  },
  'goto-recipe': (el) => {
    closeModal();
    location.hash = '#recipe/' + el.dataset.id;
  },
  'delete-meal': (el) => {
    run(state.store.remove('meals', el.closest('.sheet').dataset.id));
    closeModal();
  },
  'new-recipe': () => recipeFormModal({ servings: 4 }),
  'import-url': importUrlModal,
  'edit-recipe': () => recipeFormModal(recipeById(state.recipeId)),
  'delete-recipe': () => {
    const r = recipeById(state.recipeId);
    if (r && confirm(`Supprimer « ${r.title} » ?`)) {
      run(state.store.remove('recipes', r.id));
      location.hash = '#recipes';
    }
  },
  servings: (el) => {
    const r = recipeById(state.recipeId);
    state.detailServings = Math.max(1, Math.min(50, (state.detailServings || r.servings || 1) + Number(el.dataset.delta)));
    render();
  },
  'plan-recipe': () => planRecipeModal(recipeById(state.recipeId)),
  'cook-mode': () => openCookMode(recipeById(state.recipeId)),
  'cook-next': () => {
    cook.step = Math.min(cook.step + 1, (cook.recipe.steps || []).length - 1);
    renderCook();
  },
  'cook-prev': () => {
    cook.step = Math.max(cook.step - 1, 0);
    renderCook();
  },
  'start-timer': (el) => startTimer(Number(el.dataset.min)),
  'generate-shopping': generateShopping,
  'delete-item': (el) => run(state.store.remove('shopping', el.dataset.id)),
  'clear-checked': () => {
    const ids = state.shopping.filter((i) => i.checked).map((i) => i.id);
    run(state.store.bulk(ids.map((id) => ({ type: 'remove', name: 'shopping', id }))));
  },
  'clear-all': () => {
    if (!confirm('Effacer toute la liste de courses ?')) return;
    run(state.store.bulk(state.shopping.map((i) => ({ type: 'remove', name: 'shopping', id: i.id }))));
  },
  'share-list': async () => {
    const groups = {};
    for (const i of state.shopping.filter((x) => !x.checked)) (groups[i.category || 'Autre'] ||= []).push(itemLabel(i));
    const text = Object.entries(groups)
      .map(([c, l]) => `${c}\n${l.map((x) => '• ' + x).join('\n')}`)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Liste copiée.');
    } catch {
      toast('Copie impossible sur cet appareil.');
    }
  },
  'sign-out': () => run(state.store.signOut()),
  'reset-password': () => {
    const email = $('#login-form input[name=email]').value.trim();
    if (!email) return toast('Saisissez d’abord votre adresse e-mail.');
    state.store.resetPassword(email).then(() => toast('E-mail de réinitialisation envoyé.'), handleError);
  },
  'default-servings': (el) => {
    setSetting('servings', Math.max(1, Math.min(20, defaultServings() + Number(el.dataset.delta))));
    render();
  },
  'import-plan': async () => {
    try {
      const c = await importPlan($('#plan-json').value);
      $('#plan-json').value = '';
      toast(`Importé : ${c.recipes} recette(s), ${c.meals} repas, ${c.shopping} article(s).`, 5000);
      if (c.meals) location.hash = '#week';
    } catch (e) {
      handleError(e);
    }
  },
  export: () => exportData().catch(handleError),
};

function shiftWeek(n) {
  state.weekStart = addDays(state.weekStart, n);
  watchWeek();
  render();
}

const forms = {
  async login(form) {
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await state.store.signIn(form.email.value.trim(), form.password.value);
    } catch (e) {
      const code = e.code || '';
      toast(code.includes('invalid') || code.includes('wrong') || code.includes('user-not-found') ? 'E-mail ou mot de passe incorrect.' : 'Connexion impossible : ' + e.message, 5000);
      btn.disabled = false;
    }
  },
  'add-item'(form) {
    const text = form.item.value.trim();
    if (!text) return;
    const i = parseIngredient(text);
    run(state.store.add('shopping', { ...i, category: categorize(i.name), checked: false, source: 'manual' }));
    form.item.value = '';
  },
  'add-note'(form) {
    const note = form.note.value.trim();
    if (!note) return;
    const sheet = form.closest('.sheet');
    run(state.store.add('meals', { date: sheet.dataset.date, slot: sheet.dataset.slot, recipeId: null, title: note, servings: 0, prepared: $('#picker-prepared').checked }));
    closeModal();
  },
  'edit-meal'(form) {
    const id = form.closest('.sheet').dataset.id;
    const patch = { date: form.date.value, slot: form.slot.value, prepared: form.prepared.checked };
    if (form.servings) patch.servings = Number(form.servings.value) || defaultServings();
    if (form.title) patch.title = form.title.value.trim() || 'Note';
    run(state.store.update('meals', id, patch));
    closeModal();
  },
  'plan-recipe'(form) {
    const r = recipeById(form.closest('.sheet').dataset.id);
    run(state.store.add('meals', { date: form.date.value, slot: form.slot.value, recipeId: r.id, title: r.title, servings: Number(form.servings.value) || defaultServings(), prepared: form.prepared.checked }));
    closeModal();
    const monday = weekStartOf(fromKey(form.date.value));
    toast(`Ajouté au menu du ${dayTitle(form.date.value)}.`);
    if (monday !== state.weekStart) {
      state.weekStart = monday;
      watchWeek();
    }
  },
  'save-recipe'(form) {
    const id = form.closest('.sheet').dataset.id;
    const data = {
      title: form.title.value.trim(),
      servings: Number(form.servings.value) || 4,
      prepTime: Number(form.prepTime.value) || null,
      cookTime: Number(form.cookTime.value) || null,
      ingredients: parseLines(form.ingredients.value).map(parseIngredient).filter(Boolean),
      steps: parseLines(form.steps.value),
      tags: form.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      notes: form.notes.value.trim(),
      image: form.image.value.trim(),
      source: form.source.value,
    };
    if (id) {
      run(state.store.update('recipes', id, data));
      // le titre est recopié dans le menu pour rester lisible même si la recette est supprimée
      for (const m of state.meals.filter((x) => x.recipeId === id && x.title !== data.title)) run(state.store.update('meals', m.id, { title: data.title }));
      closeModal();
      toast('Recette enregistrée.');
    } else {
      const newId = state.store.addNow('recipes', data);
      closeModal();
      location.hash = '#recipe/' + newId;
    }
  },
  async 'import-url'(form) {
    const status = $('#import-status');
    const btn = form.querySelector('button');
    btn.disabled = true;
    status.textContent = 'Lecture de la page…';
    try {
      const recipe = await importFromUrl(form.url.value.trim());
      recipeFormModal(recipe);
      toast('Recette trouvée : vérifiez-la puis enregistrez.');
    } catch (e) {
      status.textContent = e.message;
      btn.disabled = false;
    }
  },
};

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('backdrop')) return closeModal();
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el, e);
  }
});

document.addEventListener('submit', (e) => {
  const fn = forms[e.target.dataset.form];
  if (fn) {
    e.preventDefault();
    fn(e.target);
  }
});

document.addEventListener('input', (e) => {
  const kind = e.target.dataset.input;
  if (kind === 'search') {
    state.search = e.target.value;
    $('#recipe-list').innerHTML = recipeListHtml();
  } else if (kind === 'picker-search') {
    $('#picker-list').innerHTML = pickerList(e.target.value);
  }
});

document.addEventListener('change', (e) => {
  const kind = e.target.dataset.change;
  if (kind === 'toggle-item') {
    run(state.store.update('shopping', e.target.dataset.id, { checked: e.target.checked }));
  } else if (kind === 'week-start') {
    setSetting('weekstart', e.target.value);
    state.weekStart = weekStartOf(new Date());
    watchWeek();
    toast('Réglage enregistré.');
  } else if (kind === 'import-file') {
    const file = e.target.files[0];
    if (file) file.text().then((t) => ($('#plan-json').value = t));
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('#cook')) requestWakeLock();
});

init();
