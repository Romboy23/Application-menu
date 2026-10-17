// Import d'une recette depuis une page web (Marmiton, 750g, CuisineAZ, etc.)
// La plupart des sites de cuisine décrivent leurs recettes avec des données
// structurées "schema.org/Recipe" (JSON-LD) : on les lit directement.
import { proxyUrl } from './config.js';
import { parseIngredient } from './ingredients.js';

const PROXIES = [
  ...(proxyUrl ? [(u) => proxyUrl.replace(/\/$/, '') + '/?url=' + encodeURIComponent(u)] : []),
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
  (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
];

async function fetchWithTimeout(url, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchPage(url) {
  let lastError;
  for (const proxy of PROXIES) {
    try {
      const res = await fetchWithTimeout(proxy(url));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      if (html.includes('<')) return html;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error("Impossible de lire la page (" + (lastError?.message || 'erreur réseau') + ').');
}

export async function importFromUrl(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("L'adresse doit commencer par https://");
  const html = await fetchPage(url);
  const recipe = parseRecipeHtml(html);
  if (!recipe) throw new Error("Aucune recette trouvée sur cette page. Vous pouvez la saisir à la main.");
  recipe.source = url;
  return recipe;
}

export function parseRecipeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let json;
    try {
      json = JSON.parse(script.textContent.trim());
    } catch {
      continue;
    }
    const found = findRecipe(json);
    if (found) return toRecipe(found);
  }
  return null;
}

function isRecipe(node) {
  const t = node && node['@type'];
  return t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));
}

function findRecipe(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipe(n);
      if (r) return r;
    }
    return null;
  }
  if (isRecipe(node)) return node;
  if (node['@graph']) return findRecipe(node['@graph']);
  if (node.mainEntity) return findRecipe(node.mainEntity);
  return null;
}

const decoder = typeof document !== 'undefined' ? document.createElement('textarea') : null;
function clean(text) {
  if (text === null || text === undefined) return '';
  let s = String(text);
  if (decoder) {
    decoder.innerHTML = s.replace(/<[^>]+>/g, ' ');
    s = decoder.value;
  }
  return s.replace(/\s+/g, ' ').trim();
}

// "PT1H30M" -> 90
export function isoMinutes(value) {
  if (!value) return null;
  const m = String(value).match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return null;
  const total = (Number(m[1]) || 0) * 1440 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  return total || null;
}

function pickImage(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return pickImage(img[img.length > 1 ? img.length - 1 : 0]);
  return img.url || img.contentUrl || '';
}

function parseYield(y) {
  if (Array.isArray(y)) y = y.find((v) => /\d/.test(String(v))) ?? y[0];
  const m = String(y ?? '').match(/\d+/);
  return m ? Number(m[0]) : 4;
}

function flattenSteps(instr) {
  if (!instr) return [];
  if (typeof instr === 'string') {
    return clean(instr.replace(/<\/(p|li)>|<br\s*\/?>/gi, '\n'))
      ? instr
          .replace(/<\/(p|li)>|<br\s*\/?>/gi, '\n')
          .split(/\n+/)
          .map(clean)
          .filter(Boolean)
      : [];
  }
  if (Array.isArray(instr)) return instr.flatMap(flattenSteps);
  if (instr.itemListElement) {
    const inner = flattenSteps(instr.itemListElement);
    return instr['@type'] === 'HowToSection' && instr.name ? [clean(instr.name).toUpperCase() + ' :', ...inner] : inner;
  }
  if (instr.text) return [clean(instr.text)];
  if (instr.name) return [clean(instr.name)];
  return [];
}

function toList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.flatMap(toList);
  return String(v).split(',').map(clean).filter(Boolean);
}

function toRecipe(r) {
  const ingredients = (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : r.ingredients || [])
    .map(clean)
    .filter(Boolean)
    .map(parseIngredient)
    .filter(Boolean);
  const tags = [...new Set([...toList(r.recipeCategory), ...toList(r.recipeCuisine)].map((t) => t.toLowerCase()))].slice(0, 6);
  return {
    title: clean(r.name) || 'Recette importée',
    servings: parseYield(r.recipeYield),
    prepTime: isoMinutes(r.prepTime),
    cookTime: isoMinutes(r.cookTime) ?? (isoMinutes(r.totalTime) && !r.prepTime ? isoMinutes(r.totalTime) : null),
    image: pickImage(r.image),
    tags,
    ingredients,
    steps: flattenSteps(r.recipeInstructions),
  };
}
