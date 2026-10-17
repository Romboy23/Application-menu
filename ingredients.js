// Analyse, mise à l'échelle, regroupement et classement des ingrédients.

const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };

const END = '(?=[\\s.,;:)]|$)';

// [unité canonique, expression reconnue en début de texte]
const UNIT_PATTERNS = [
  ['c. à s.', new RegExp('^(?:cuill[eè]res?\\s+(?:à|a)\\s+soupe|c\\.?\\s?(?:à|a)\\.?\\s?s\\.?|càs|cas|cs|cuil\\.?\\s?(?:à|a)\\s?s\\.?)' + END, 'i')],
  ['c. à c.', new RegExp('^(?:cuill[eè]res?\\s+(?:à|a)\\s+caf[ée]|c\\.?\\s?(?:à|a)\\.?\\s?c\\.?|càc|cac|cc|cuil\\.?\\s?(?:à|a)\\s?c\\.?)' + END, 'i')],
  ['kg', new RegExp('^(?:kg|kilos?|kilogrammes?)' + END, 'i')],
  ['mg', new RegExp('^mg' + END, 'i')],
  ['g', new RegExp('^(?:g|gr|grammes?)' + END, 'i')],
  ['ml', new RegExp('^(?:ml|millilitres?)' + END, 'i')],
  ['cl', new RegExp('^(?:cl|centilitres?)' + END, 'i')],
  ['dl', new RegExp('^(?:dl|décilitres?)' + END, 'i')],
  ['l', new RegExp('^(?:l|litres?)' + END, 'i')],
  ['cuillère', new RegExp('^cuill[eè]res?' + END, 'i')],
  ['pincée', new RegExp('^pinc[ée]es?' + END, 'i')],
  ['tranche', new RegExp('^tranches?' + END, 'i')],
  ['gousse', new RegExp('^gousses?' + END, 'i')],
  ['boîte', new RegExp('^bo[iî]tes?' + END, 'i')],
  ['sachet', new RegExp('^sachets?' + END, 'i')],
  ['paquet', new RegExp('^paquets?' + END, 'i')],
  ['barquette', new RegExp('^barquettes?' + END, 'i')],
  ['pot', new RegExp('^pots?' + END, 'i')],
  ['verre', new RegExp('^verres?' + END, 'i')],
  ['tasse', new RegExp('^tasses?' + END, 'i')],
  ['bol', new RegExp('^bols?' + END, 'i')],
  ['botte', new RegExp('^bottes?' + END, 'i')],
  ['bouquet', new RegExp('^bouquets?' + END, 'i')],
  ['brin', new RegExp('^brins?' + END, 'i')],
  ['branche', new RegExp('^branches?' + END, 'i')],
  ['feuille', new RegExp('^feuilles?' + END, 'i')],
  ['morceau', new RegExp('^morceaux?' + END, 'i')],
  ['filet', new RegExp('^filets?' + END, 'i')],
  ['poignée', new RegExp('^poign[ée]es?' + END, 'i')],
  ['boule', new RegExp('^boules?' + END, 'i')],
  ['bouteille', new RegExp('^bouteilles?' + END, 'i')],
  ['brique', new RegExp('^briques?' + END, 'i')],
];

const PLURALS = { morceau: 'morceaux' };
const NO_PLURAL = new Set(['kg', 'g', 'mg', 'ml', 'cl', 'dl', 'l', 'c. à s.', 'c. à c.']);

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(text) {
  const t = text.trim();
  if (FRACTIONS[t] !== undefined) return FRACTIONS[t];
  let m = t.match(/^(\d+)\s*([½¼¾⅓⅔⅛])$/);
  if (m) return Number(m[1]) + FRACTIONS[m[2]];
  m = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const QTY_RE = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+\s*[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛]|\d+(?:[.,]\d+)?)(?:\s*(?:à|-|–)\s*\d+(?:[.,]\d+)?)?\s*/;

// "200 g de farine" -> { qty: 200, unit: 'g', name: 'farine' }
export function parseIngredient(line) {
  let text = String(line || '').replace(/\s+/g, ' ').trim().replace(/^[-•*]\s*/, '');
  if (!text) return null;
  let qty = null;
  let unit = '';
  const q = text.match(QTY_RE);
  if (q) {
    qty = parseNumber(q[1]);
    text = text.slice(q[0].length);
  }
  for (const [canon, re] of UNIT_PATTERNS) {
    const m = text.match(re);
    if (m) {
      // "g" seul n'est une unité que s'il suit une quantité
      if (qty === null && ['g', 'l', 'cs', 'cc'].includes(m[0].toLowerCase())) break;
      unit = canon;
      text = text.slice(m[0].length).replace(/^\.\s*/, '').trim();
      break;
    }
  }
  if (unit || qty !== null) text = text.replace(/^(?:de\s+|d['’]\s*|des\s+)/i, '');
  const name = text.trim();
  if (!name) return { qty: null, unit: '', name: String(line).trim() };
  return { qty, unit, name };
}

export function formatQty(qty) {
  if (qty === null || qty === undefined || qty === '') return '';
  const rounded = qty >= 10 ? Math.round(qty) : Math.round(qty * 100) / 100;
  const known = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
  const whole = Math.floor(rounded);
  const frac = Math.round((rounded - whole) * 100) / 100;
  if (known[frac]) return (whole ? whole + ' ' : '') + known[frac];
  return String(rounded).replace('.', ',');
}

function formatUnit(unit, qty) {
  if (!unit) return '';
  if (qty > 1 && !NO_PLURAL.has(unit)) return PLURALS[unit] || unit + 's';
  return unit;
}

export function formatIngredient(ing, factor = 1) {
  if (!ing) return '';
  const qty = ing.qty !== null && ing.qty !== undefined ? ing.qty * factor : null;
  const parts = [];
  if (qty !== null) parts.push(formatQty(qty));
  if (ing.unit) {
    parts.push(formatUnit(ing.unit, qty));
    parts.push(/^[aeiouyéèêàâîïôûœh]/i.test(ing.name) ? "d'" + ing.name : 'de ' + ing.name);
  } else {
    parts.push(ing.name);
  }
  return parts.join(' ');
}

// Conversion vers une unité de base pour pouvoir additionner
const BASE = { kg: ['g', 1000], g: ['g', 1], mg: ['g', 0.001], l: ['ml', 1000], dl: ['ml', 100], cl: ['ml', 10], ml: ['ml', 1] };

// Additionne une liste d'ingrédients [{qty, unit, name}] et renvoie la liste regroupée
export function aggregate(ingredients) {
  const map = new Map();
  for (const ing of ingredients) {
    if (!ing || !ing.name) continue;
    let qty = ing.qty;
    let unit = ing.unit || '';
    if (BASE[unit] && qty !== null && qty !== undefined) {
      qty = qty * BASE[unit][1];
      unit = BASE[unit][0];
    }
    const key = singularKey(ing.name) + '|' + unit;
    const prev = map.get(key);
    if (prev) {
      if (qty !== null && qty !== undefined) prev.qty = (prev.qty || 0) + qty;
    } else {
      map.set(key, { name: ing.name.trim(), unit, qty: qty ?? null });
    }
  }
  return [...map.values()].map((it) => {
    if (it.unit === 'g' && it.qty >= 1000) return { ...it, unit: 'kg', qty: it.qty / 1000 };
    if (it.unit === 'ml' && it.qty >= 1000) return { ...it, unit: 'l', qty: it.qty / 1000 };
    if (it.unit === 'ml' && it.qty >= 10 && it.qty % 10 === 0) return { ...it, unit: 'cl', qty: it.qty / 10 };
    return it;
  });
}

export const CATEGORIES = [
  'Fruits & légumes',
  'Viandes & poissons',
  'Crèmerie & frais',
  'Boulangerie',
  'Épicerie',
  'Surgelés',
  'Boissons',
  'Hygiène & maison',
  'Autre',
];

const CATEGORY_WORDS = {
  'Fruits & légumes': 'pomme, poire, banane, orange, clementine, mandarine, citron, citron vert, pamplemousse, tomate, tomate cerise, carotte, oignon, ail, echalote, salade, laitue, courgette, aubergine, poivron, champignon, pomme de terre, patate, patate douce, epinard, brocoli, chou, chou-fleur, poireau, haricot vert, concombre, avocat, fraise, framboise, myrtille, cerise, persil, coriandre, basilic, ciboulette, menthe, thym, laurier, romarin, estragon, aneth, courge, potiron, butternut, celeri, radis, petit pois, mangue, ananas, kiwi, raisin, peche, nectarine, abricot, prune, melon, pasteque, gingembre, legume, fruit, navet, betterave, fenouil, endive, mache, roquette, asperge, artichaut',
  'Viandes & poissons': 'poulet, blanc de poulet, cuisse de poulet, boeuf, porc, veau, agneau, dinde, canard, jambon, lardon, saucisse, steak, steak hache, viande hachee, viande, filet mignon, chorizo, bacon, saumon, thon, cabillaud, poisson, crevette, moule, colin, merlu, truite, sardine, lieu, maquereau, escalope, roti, merguez, chipolata',
  'Crèmerie & frais': 'lait, beurre, creme, creme fraiche, fromage, yaourt, oeuf, mozzarella, parmesan, gruyere, emmental, comte, chevre, feta, ricotta, mascarpone, fromage blanc, skyr, pate feuilletee, pate brisee, pate sablee, pate a pizza, raclette, reblochon, tofu',
  'Boulangerie': 'pain, baguette, brioche, tortilla, wrap, pain de mie, pain burger',
  'Épicerie': 'farine, sucre, sucre roux, sucre glace, sel, poivre, huile, huile d olive, vinaigre, riz, pate, spaghetti, penne, tagliatelle, coquillette, lasagne, lentille, pois chiche, haricot rouge, semoule, quinoa, boulgour, levure, chocolat, cacao, miel, confiture, moutarde, sauce, sauce soja, bouillon, cube, epice, cumin, paprika, curry, curcuma, cannelle, muscade, conserve, flocon, flocons d avoine, avoine, cereale, amande, noisette, noix, cajou, raisin sec, lait de coco, tomate concassee, coulis de tomate, concentre de tomate, puree de tomate, tomates pelees, maizena, fecule, vanille, extrait de vanille, biscuit, cornichon, olive, ketchup, mayonnaise, pesto, graine, sirop d erable',
  'Surgelés': 'surgele, glace, frites',
  'Boissons': 'eau, jus, jus d orange, vin, vin blanc, vin rouge, biere, cafe, the, sirop',
  'Hygiène & maison': 'papier, essuie-tout, sac poubelle, lessive, liquide vaisselle, eponge, savon, shampoing, dentifrice, papier toilette',
};

function singularKey(name) {
  return normalize(name)
    .split(' ')
    .map((w) => (w.length > 3 ? w.replace(/(s|x)$/, '') : w))
    .join(' ');
}

const KEYWORDS = Object.entries(CATEGORY_WORDS)
  .flatMap(([cat, list]) => list.split(',').map((w) => [singularKey(w), cat]))
  .sort((a, b) => b[0].length - a[0].length)
  .map(([kw, cat]) => [new RegExp('(^|[\\s-])' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\s-]|$)'), cat]);

export function categorize(name) {
  const n = singularKey(name);
  for (const [re, cat] of KEYWORDS) if (re.test(n)) return cat;
  return 'Autre';
}
