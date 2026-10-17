// ⚙️ Configuration de l'application.
//
// Tant que "apiKey" est vide, l'application fonctionne en MODE DÉMO :
// les données restent sur le téléphone et ne sont PAS partagées.
//
// Pour activer la synchronisation entre vos deux iPhone, collez ici la
// configuration de votre projet Firebase (voir GUIDE.md, étape 3).
// Ces valeurs sont publiques : elles peuvent être mises sur GitHub sans risque,
// la sécurité est assurée par les règles Firestore (firestore.rules).

export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

// Optionnel : adresse de votre propre relais pour importer des recettes
// depuis un site web (voir GUIDE.md, étape 6). Laissez vide pour utiliser
// les relais publics gratuits.
// Exemple : 'https://menu-proxy.votre-nom.workers.dev'
export const proxyUrl = '';
