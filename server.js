/**
 * SONGO — Serveur multijoueur distant
 * Lancer : node server.js
 * Port   : 3000
 *
 * Routes :
 *   POST /creer          → créer une partie, retourne { gameId, joueur: 1 }
 *   POST /rejoindre      → rejoindre une partie existante, retourne { joueur: 2 }
 *   GET  /etat/:gameId   → état complet de la partie (polling AJAX)
 *   POST /jouer          → jouer un coup { gameId, joueur, index }
 *   POST /reset          → réinitialiser la partie { gameId }
 */

const http = require('http');
const url  = require('url');

// ── Génération d'un ID unique ──────────────────────────────────────────────
function genId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ── Stockage en mémoire des parties (Map) ─────────────────────────────────
const parties = new Map();

// ── Structure d'une partie ─────────────────────────────────────────────────
function nouvellePartie(nom1) {
  return {
    plateau  : [5,5,5,5,5,5,5, 5,5,5,5,5,5,5],
    tourDe   : 1,
    scores   : { 1: 0, 2: 0 },
    noms     : { 1: nom1 || 'Joueur 1', 2: null },
    statut   : 'attente',   // 'attente' | 'en_cours' | 'termine'
    message  : '',
    gagnant  : 0,
    raison   : '',
    version  : 0,           // incrémenté à chaque changement (polling)
    creeLe   : Date.now()
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// LOGIQUE DU JEU (même algorithme que le client HTML)
// ══════════════════════════════════════════════════════════════════════════════

function campEstVide(plateau, joueur) {
  const [d, f] = joueur === 1 ? [0, 6] : [7, 13];
  for (let i = d; i <= f; i++) if (plateau[i] > 0) return false;
  return true;
}

function caseProtegeeAdverse(j) { return j === 1 ? 13 : 0; }
function case7Propre(j)          { return j === 1 ?  6 : 7; }

function coupVideCampAdverse(sim, j) {
  const [d, f] = j === 1 ? [7, 13] : [0, 6];
  for (let i = d; i <= f; i++) if (sim[i] > 0) return false;
  return true;
}

function simulerDistribution(plateauIn, dep) {
  let sim = [...plateauIn], g = sim[dep];
  sim[dep] = 0;
  let curr = dep, tc = g > 13;
  while (g > 0) { curr = (curr + 1) % 14; if (curr === dep) continue; sim[curr]++; g--; }
  return { plateauApres: sim, derniereCase: curr, tourComplet: tc };
}

function evaluerCaptureCascade(pActuel, derniere, tc, j) {
  let sim = [...pActuel], total = 0;
  const prot   = caseProtegeeAdverse(j);
  const estAdv = j === 1 ? (derniere >= 7 && derniere <= 13) : (derniere >= 0 && derniere <= 6);
  if (!estAdv) return { plateauApresCapture: sim, grainesGagnees: 0, message: '' };

  if (derniere === prot && tc) {
    let ss = [...sim]; ss[derniere]--;
    if (!coupVideCampAdverse(ss, j))
      return { plateauApresCapture: ss, grainesGagnees: 1, message: '' };
    return { plateauApresCapture: sim, grainesGagnees: 0, message: "Capture annulée : vider le camp adverse est interdit." };
  }

  let idx = derniere, premier = true;
  while (true) {
    const inAdv = j === 1 ? (idx >= 7 && idx <= 13) : (idx >= 0 && idx <= 6);
    if (!inAdv) break;
    const g = sim[idx];
    if (premier && idx === prot) break;
    if (g >= 2 && g <= 4) { total += g; sim[idx] = 0; idx = (idx + 13) % 14; premier = false; }
    else break;
  }
  if (total === 0) return { plateauApresCapture: pActuel, grainesGagnees: 0, message: '' };
  if (coupVideCampAdverse(sim, j))
    return { plateauApresCapture: pActuel, grainesGagnees: 0, message: "Capture annulée : vider le camp adverse est interdit." };
  return { plateauApresCapture: sim, grainesGagnees: total, message: '' };
}

function totalGrainesPlateau(plateau) {
  return plateau.reduce((s, v) => s + v, 0);
}

function coupNourritAdversaire(plateau, idx, j) {
  const { plateauApres } = simulerDistribution(plateau, idx);
  const [d, f] = j === 1 ? [7, 13] : [0, 6];
  for (let i = d; i <= f; i++) if (plateauApres[i] > 0) return true;
  return false;
}

function grainesDistribueesChezAdverse(plateau, idx, j) {
  const { plateauApres } = simulerDistribution(plateau, idx);
  const [d, f] = j === 1 ? [7, 13] : [0, 6];
  let t = 0;
  for (let i = d; i <= f; i++) t += plateauApres[i] - plateau[i];
  return Math.max(0, t);
}

function aDesCoupsPourNourrir(plateau, j) {
  const [d, f] = j === 1 ? [0, 6] : [7, 13];
  for (let i = d; i <= f; i++)
    if (plateau[i] > 0 && coupNourritAdversaire(plateau, i, j)) return true;
  return false;
}

function verifierInterditCase7(plateau, idx, j) {
  if (idx !== case7Propre(j)) return { interdit: false };
  const nb = grainesDistribueesChezAdverse(plateau, idx, j);
  if (nb === 1 || nb === 2) return { interdit: true, grainesTournees: nb };
  return { interdit: false };
}

// ── Exécuter un coup côté serveur ──────────────────────────────────────────
function appliquerCoup(partie, joueur, index) {
  const p = partie.plateau;
  const j = joueur;
  const adv = j === 1 ? 2 : 1;

  // Vérifications de base
  if (partie.statut !== 'en_cours') return { ok: false, err: "Partie non démarrée ou terminée." };
  if (partie.tourDe !== j)          return { ok: false, err: "Ce n'est pas votre tour." };
  if (p[index] === 0)               return { ok: false, err: "Cette case est vide." };

  const zoneJ1 = index >= 0 && index <= 6;
  const zoneJ2 = index >= 7 && index <= 13;
  if (j === 1 && !zoneJ1) return { ok: false, err: "Vous ne pouvez jouer que dans votre camp (bas)." };
  if (j === 2 && !zoneJ2) return { ok: false, err: "Vous ne pouvez jouer que dans votre camp (haut)." };

  // Solidarité
  if (campEstVide(p, adv) && aDesCoupsPourNourrir(p, j)) {
    if (!coupNourritAdversaire(p, index, j))
      return { ok: false, err: `Coup illégal ! Vous devez nourrir le camp adverse.` };
    const camp = j === 1 ? [0,1,2,3,4,5,6] : [7,8,9,10,11,12,13];
    const peut7 = camp.some(i => p[i] > 0 && grainesDistribueesChezAdverse(p, i, j) >= 7);
    if (peut7 && grainesDistribueesChezAdverse(p, index, j) < 7)
      return { ok: false, err: `Coup illégal ! Vous devez envoyer au moins 7 graines à l'adversaire.` };
  }

  // Interdiction de vider le camp adverse
  const { plateauApres: simVide } = simulerDistribution(p, index);
  if (coupVideCampAdverse(simVide, j)) {
    const camp = j === 1 ? [0,1,2,3,4,5,6] : [7,8,9,10,11,12,13];
    const ok = camp.some(i => i !== index && p[i] > 0 &&
      !coupVideCampAdverse(simulerDistribution(p, i).plateauApres, j));
    if (ok) return { ok: false, err: "Coup interdit ! Vous ne pouvez pas vider le camp adverse." };
  }

  // ── Distribution ──
  const { plateauApres, derniereCase, tourComplet } = simulerDistribution(p, index);
  partie.plateau = plateauApres;
  partie.message = '';

  // Interdit case 7
  const { interdit, grainesTournees } = verifierInterditCase7(p, index, j);
  if (interdit) {
    partie.scores[adv] += grainesTournees;
    let ar = grainesTournees;
    const [dA, fA] = j === 1 ? [7, 13] : [0, 6];
    for (let k = fA; k >= dA && ar > 0; k--) {
      const r = Math.min(partie.plateau[k], ar);
      partie.plateau[k] -= r; ar -= r;
    }
    partie.message = `Case 7 interdite ! ${grainesTournees} graine(s) restituée(s) à ${partie.noms[adv]}.`;
  }

  // Captures
  const res = evaluerCaptureCascade(partie.plateau, derniereCase, tourComplet, j);
  if (res.message) partie.message = res.message;
  if (res.grainesGagnees > 0) {
    partie.plateau = res.plateauApresCapture;
    partie.scores[j] += res.grainesGagnees;
  }

  // Fin ≥ 40
  if (partie.scores[1] >= 40 || partie.scores[2] >= 40) {
    const g = partie.scores[1] >= 40 ? 1 : 2;
    terminerPartie(partie, g, `${partie.noms[g]} a atteint 40 graines. Victoire !`);
    return { ok: true };
  }

  // Fin < 10 graines sur le plateau
  if (totalGrainesPlateau(partie.plateau) < 10) {
    for (let k = 0; k <= 6;  k++) { partie.scores[1] += partie.plateau[k]; partie.plateau[k] = 0; }
    for (let k = 7; k <= 13; k++) { partie.scores[2] += partie.plateau[k]; partie.plateau[k] = 0; }
    const g = partie.scores[1] > partie.scores[2] ? 1 : partie.scores[2] > partie.scores[1] ? 2 : 0;
    terminerPartie(partie, g, `Moins de 10 graines. J1:${partie.scores[1]} J2:${partie.scores[2]}`);
    return { ok: true };
  }

  // Changement de tour
  partie.tourDe = adv;

  // Solidarité impossible
  if (campEstVide(partie.plateau, adv) && !aDesCoupsPourNourrir(partie.plateau, j)) {
    const [dp, fp] = adv === 1 ? [0, 6] : [7, 13];
    for (let k = dp; k <= fp; k++) { partie.scores[adv] += partie.plateau[k]; partie.plateau[k] = 0; }
    const g = partie.scores[1] > partie.scores[2] ? 1 : partie.scores[2] > partie.scores[1] ? 2 : 0;
    terminerPartie(partie, g, `Solidarité impossible — ${partie.noms[adv]} ne peut plus jouer.`);
  }

  partie.version++;
  return { ok: true };
}

function terminerPartie(partie, gagnant, raison) {
  partie.statut  = 'termine';
  partie.gagnant = gagnant;
  partie.raison  = raison;
  partie.version++;
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVEUR HTTP (sans framework)
// ══════════════════════════════════════════════════════════════════════════════

function lireCorps(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end',  () => { try { resolve(JSON.parse(body || '{}')); } catch(e) { resolve({}); } });
    req.on('error', reject);
  });
}

function repondre(res, code, data) {
  const json = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type'                : 'application/json',
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(json);
}

const serveur = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Pré-vol CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin' : '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }

  // ── POST /creer ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/creer') {
    const body    = await lireCorps(req);
    const gameId  = genId();
    const partie  = nouvellePartie(body.nom || 'Joueur 1');
    parties.set(gameId, partie);
    console.log(`[+] Partie créée : ${gameId} par ${partie.noms[1]}`);
    return repondre(res, 200, { gameId, joueur: 1 });
  }

  // ── POST /rejoindre ──────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/rejoindre') {
    const body   = await lireCorps(req);
    const partie = parties.get(body.gameId);
    if (!partie)               return repondre(res, 404, { err: "Partie introuvable." });
    if (partie.noms[2])        return repondre(res, 400, { err: "Partie déjà complète." });
    if (partie.statut !== 'attente') return repondre(res, 400, { err: "Partie déjà commencée." });

    partie.noms[2]  = body.nom || 'Joueur 2';
    partie.statut   = 'en_cours';
    partie.version++;
    console.log(`[+] ${partie.noms[2]} a rejoint ${body.gameId}`);
    return repondre(res, 200, { joueur: 2, noms: partie.noms });
  }

  // ── GET /etat/:gameId ────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname.startsWith('/etat/')) {
    const gameId = pathname.split('/')[2];
    const partie = parties.get(gameId);
    if (!partie) return repondre(res, 404, { err: "Partie introuvable." });
    return repondre(res, 200, {
      plateau : partie.plateau,
      tourDe  : partie.tourDe,
      scores  : partie.scores,
      noms    : partie.noms,
      statut  : partie.statut,
      message : partie.message,
      gagnant : partie.gagnant,
      raison  : partie.raison,
      version : partie.version
    });
  }

  // ── POST /jouer ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/jouer') {
    const body   = await lireCorps(req);
    const partie = parties.get(body.gameId);
    if (!partie) return repondre(res, 404, { err: "Partie introuvable." });

    const resultat = appliquerCoup(partie, parseInt(body.joueur), parseInt(body.index));
    if (!resultat.ok) return repondre(res, 400, { err: resultat.err });
    return repondre(res, 200, {
      plateau : partie.plateau,
      tourDe  : partie.tourDe,
      scores  : partie.scores,
      statut  : partie.statut,
      message : partie.message,
      gagnant : partie.gagnant,
      raison  : partie.raison,
      version : partie.version
    });
  }

  // ── POST /reset ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/reset') {
    const body   = await lireCorps(req);
    const partie = parties.get(body.gameId);
    if (!partie) return repondre(res, 404, { err: "Partie introuvable." });

    partie.plateau = [5,5,5,5,5,5,5, 5,5,5,5,5,5,5];
    partie.tourDe  = 1;
    partie.scores  = { 1: 0, 2: 0 };
    partie.statut  = 'en_cours';
    partie.message = '';
    partie.gagnant = 0;
    partie.raison  = '';
    partie.version++;
    return repondre(res, 200, { ok: true });
  }

  // ── 404 par défaut ───────────────────────────────────────────────────────
  repondre(res, 404, { err: "Route inconnue." });
});

const PORT = process.env.PORT || 3000;
serveur.listen(PORT, () => {
  console.log(`\n🌍 Serveur Songo démarré sur http://localhost:${PORT}`);
  console.log(`   POST /creer          → créer une partie`);
  console.log(`   POST /rejoindre      → rejoindre une partie`);
  console.log(`   GET  /etat/:gameId   → état actuel (polling)`);
  console.log(`   POST /jouer          → jouer un coup`);
  console.log(`   POST /reset          → réinitialiser\n`);
});

// Nettoyage automatique des parties inactives > 2h
setInterval(() => {
  const limite = Date.now() - 2 * 3600 * 1000;
  for (const [id, p] of parties.entries()) {
    if (p.creeLe < limite) { parties.delete(id); console.log(`[-] Partie expirée supprimée : ${id}`); }
  }
}, 15 * 60 * 1000);
