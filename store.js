// Couche de données : Firebase (synchronisé en temps réel) ou mode démo (local).
import { firebaseConfig } from './config.js';

export const isDemo = !firebaseConfig.apiKey;

export async function createStore() {
  return isDemo ? createLocalStore() : createFirebaseStore();
}

// ---------------------------------------------------------------- Firebase

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

async function createFirebaseStore() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(FB + 'firebase-app.js'),
    import(FB + 'firebase-auth.js'),
    import(FB + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(firebaseConfig);
  const a = auth.getAuth(app);
  await auth.setPersistence(a, auth.browserLocalPersistence);
  let db;
  try {
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(app);
  }
  const col = (name) => fs.collection(db, name);
  const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const now = () => Date.now();

  return {
    mode: 'firebase',
    onAuth: (cb) => auth.onAuthStateChanged(a, (u) => cb(u ? { email: u.email } : null)),
    signIn: (email, password) => auth.signInWithEmailAndPassword(a, email, password),
    resetPassword: (email) => auth.sendPasswordResetEmail(a, email),
    signOut: () => auth.signOut(a),

    watch(name, cb, onError) {
      return fs.onSnapshot(col(name), (snap) => cb(docs(snap)), onError);
    },
    watchMeals(from, to, cb, onError) {
      const q = fs.query(col('meals'), fs.where('date', '>=', from), fs.where('date', '<=', to));
      return fs.onSnapshot(q, (snap) => cb(docs(snap)), onError);
    },
    async add(name, data) {
      const ref = await fs.addDoc(col(name), { ...data, createdAt: now(), updatedAt: now() });
      return ref.id;
    },
    // Version sans attente : renvoie l'identifiant tout de suite (utile hors ligne)
    addNow(name, data) {
      const ref = fs.doc(col(name));
      fs.setDoc(ref, { ...data, createdAt: now(), updatedAt: now() });
      return ref.id;
    },
    update: (name, id, patch) => fs.updateDoc(fs.doc(db, name, id), { ...patch, updatedAt: now() }),
    remove: (name, id) => fs.deleteDoc(fs.doc(db, name, id)),
    async getAll(name) {
      return docs(await fs.getDocs(col(name)));
    },
    async bulk(ops) {
      // ops: [{type:'add'|'update'|'remove', name, id?, data?}] — par paquets de 400
      for (let i = 0; i < ops.length; i += 400) {
        const batch = fs.writeBatch(db);
        for (const op of ops.slice(i, i + 400)) {
          if (op.type === 'add') batch.set(op.id ? fs.doc(db, op.name, op.id) : fs.doc(col(op.name)), { ...op.data, createdAt: now(), updatedAt: now() });
          if (op.type === 'update') batch.update(fs.doc(db, op.name, op.id), { ...op.data, updatedAt: now() });
          if (op.type === 'remove') batch.delete(fs.doc(db, op.name, op.id));
        }
        await batch.commit();
      }
    },
    newId: (name) => fs.doc(col(name)).id,
  };
}

// ---------------------------------------------------------------- Mode démo

const KEY = 'menu-demo-v1';

function createLocalStore() {
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || null;
    } catch {
      return null;
    }
  };
  let data = load() || seed();
  const listeners = new Set();
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {}
    listeners.forEach((l) => l());
  };
  // Simule le temps réel entre deux onglets du même navigateur
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      data = load() || data;
      listeners.forEach((l) => l());
    }
  });
  const list = (name) => Object.entries(data[name] || {}).map(([id, v]) => ({ id, ...v }));
  const subscribe = (fn) => {
    listeners.add(fn);
    queueMicrotask(fn);
    return () => listeners.delete(fn);
  };
  const newId = () => Math.random().toString(36).slice(2, 12);
  const add = (name, d, id = newId()) => {
    data[name] = data[name] || {};
    data[name][id] = { ...d, createdAt: Date.now(), updatedAt: Date.now() };
    return id;
  };

  return {
    mode: 'demo',
    onAuth: (cb) => {
      queueMicrotask(() => cb({ email: 'mode démo' }));
      return () => {};
    },
    signIn: async () => {},
    resetPassword: async () => {},
    signOut: async () => {
      if (confirm('Effacer toutes les données de démonstration ?')) {
        data = seed();
        save();
      }
    },
    watch: (name, cb) => subscribe(() => cb(list(name))),
    watchMeals: (from, to, cb) => subscribe(() => cb(list('meals').filter((m) => m.date >= from && m.date <= to))),
    async add(name, d) {
      const id = add(name, d);
      save();
      return id;
    },
    addNow(name, d) {
      const id = add(name, d);
      save();
      return id;
    },
    async update(name, id, patch) {
      if (data[name]?.[id]) data[name][id] = { ...data[name][id], ...patch, updatedAt: Date.now() };
      save();
    },
    async remove(name, id) {
      if (data[name]) delete data[name][id];
      save();
    },
    getAll: async (name) => list(name),
    async bulk(ops) {
      for (const op of ops) {
        if (op.type === 'add') add(op.name, op.data, op.id);
        if (op.type === 'update' && data[op.name]?.[op.id]) data[op.name][op.id] = { ...data[op.name][op.id], ...op.data };
        if (op.type === 'remove' && data[op.name]) delete data[op.name][op.id];
      }
      save();
    },
    newId,
  };
}

function seed() {
  return {
    recipes: {
      demo1: {
        title: 'Gratin de pâtes au jambon (exemple)',
        servings: 4,
        prepTime: 15,
        cookTime: 25,
        tags: ['exemple', 'rapide'],
        image: '',
        source: '',
        ingredients: [
          { qty: 400, unit: 'g', name: 'pâtes' },
          { qty: 4, unit: 'tranche', name: 'jambon' },
          { qty: 20, unit: 'cl', name: 'crème fraîche' },
          { qty: 100, unit: 'g', name: 'gruyère râpé' },
          { qty: null, unit: '', name: 'sel' },
          { qty: null, unit: '', name: 'poivre' },
        ],
        steps: [
          'Préchauffer le four à 200 °C.',
          'Faire cuire les pâtes dans une grande casserole d’eau salée, en les gardant un peu fermes.',
          'Couper le jambon en petits morceaux.',
          'Mélanger les pâtes égouttées, le jambon et la crème. Saler et poivrer.',
          'Verser dans un plat à gratin et couvrir de gruyère.',
          'Enfourner 20 à 25 minutes, jusqu’à ce que le dessus soit bien doré.',
        ],
        createdAt: 0,
      },
      demo2: {
        title: 'Porridge banane et cannelle (exemple)',
        servings: 2,
        prepTime: 5,
        cookTime: 5,
        tags: ['exemple', 'petit-déjeuner'],
        image: '',
        source: '',
        ingredients: [
          { qty: 80, unit: 'g', name: 'flocons d’avoine' },
          { qty: 40, unit: 'cl', name: 'lait' },
          { qty: 1, unit: '', name: 'banane' },
          { qty: 1, unit: 'pincée', name: 'cannelle' },
          { qty: 1, unit: 'c. à s.', name: 'miel' },
        ],
        steps: [
          'Verser les flocons et le lait dans une casserole.',
          'Chauffer à feu moyen 4 à 5 minutes en remuant, jusqu’à ce que le mélange épaississe.',
          'Couper la banane en rondelles.',
          'Servir dans deux bols avec la banane, la cannelle et un filet de miel.',
        ],
        createdAt: 0,
      },
    },
    meals: {},
    shopping: {},
  };
}
