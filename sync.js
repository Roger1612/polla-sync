// ============================================================
//  sync.js — Fixture del Mundial 2026 (openfootball → Supabase)
//  Convive con el live-sync:
//   • Upsert A (fixture): equipos y horario. NUNCA toca marcador
//     ni estado → no pisa lo que pone el live-sync en vivo.
//   • PATCH B (finales): solo actualiza el resultado de los partidos
//     ya terminados (nunca crea filas) → red de seguridad.
// ============================================================

const SUPABASE_URL          = "https://shvabecptbciujnpqjnx.supabase.co";
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || "PEGA_TU_SERVICE_ROLE_AQUI";

const SOURCE = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

const TEAMS = {
  "Algeria":["Argelia","ALG"], "Argentina":["Argentina","ARG"], "Australia":["Australia","AUS"],
  "Austria":["Austria","AUT"], "Belgium":["Bélgica","BEL"], "Bosnia & Herzegovina":["Bosnia y Herzegovina","BIH"],
  "Brazil":["Brasil","BRA"], "Canada":["Canadá","CAN"], "Cape Verde":["Cabo Verde","CPV"],
  "Colombia":["Colombia","COL"], "Croatia":["Croacia","CRO"], "Curaçao":["Curazao","CUW"],
  "Czech Republic":["Chequia","CZE"], "DR Congo":["RD Congo","COD"], "Ecuador":["Ecuador","ECU"],
  "Egypt":["Egipto","EGY"], "England":["Inglaterra","ENG"], "France":["Francia","FRA"],
  "Germany":["Alemania","GER"], "Ghana":["Ghana","GHA"], "Haiti":["Haití","HAI"],
  "Iran":["Irán","IRN"], "Iraq":["Irak","IRQ"], "Ivory Coast":["Costa de Marfil","CIV"],
  "Japan":["Japón","JPN"], "Jordan":["Jordania","JOR"], "Mexico":["México","MEX"],
  "Morocco":["Marruecos","MAR"], "Netherlands":["Países Bajos","NED"], "New Zealand":["Nueva Zelanda","NZL"],
  "Norway":["Noruega","NOR"], "Panama":["Panamá","PAN"], "Paraguay":["Paraguay","PAR"],
  "Portugal":["Portugal","POR"], "Qatar":["Qatar","QAT"], "Saudi Arabia":["Arabia Saudita","KSA"],
  "Scotland":["Escocia","SCO"], "Senegal":["Senegal","SEN"], "South Africa":["Sudáfrica","RSA"],
  "South Korea":["Corea del Sur","KOR"], "Spain":["España","ESP"], "Sweden":["Suecia","SWE"],
  "Switzerland":["Suiza","SUI"], "Tunisia":["Túnez","TUN"], "Turkey":["Türkiye","TUR"],
  "USA":["Estados Unidos","USA"], "Uruguay":["Uruguay","URU"], "Uzbekistan":["Uzbekistán","UZB"],
};

const STAGE = {
  "Round of 32":"r32", "Round of 16":"r16", "Quarter-final":"qf",
  "Semi-final":"sf", "Match for third place":"third", "Final":"final",
};

function team(token){
  if(TEAMS[token]) return {name:TEAMS[token][0], code:TEAMS[token][1]};
  if(/^[12][A-L]$/.test(token)) return {name:`${token[0]}° Grupo ${token[1]}`, code:token};
  if(/^3/.test(token))          return {name:`3° (${token.slice(1)})`, code:"3°"};
  if(/^W\d+/.test(token))       return {name:`Ganador ${token.slice(1)}`, code:token};
  if(/^RU\d+/.test(token))      return {name:`Perdedor ${token.slice(2)}`, code:token};
  return {name:token, code:"—"};
}

function toUTC(date, time){
  const m = time.match(/(\d{1,2}):(\d{2})\s*UTC([+-]\d{1,2})/);
  if(!m) return new Date(`${date}T${time}:00Z`).toISOString();
  const [,hh,mm,off] = m;
  const sign = off[0], abs = String(Math.abs(parseInt(off,10))).padStart(2,"0");
  return new Date(`${date}T${hh.padStart(2,"0")}:${mm}:00${sign}${abs}:00`).toISOString();
}

const AUTH = {
  "apikey": SUPABASE_SERVICE_ROLE,
  "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE,
  "Content-Type": "application/json",
};

// Upsert A — fixture (crea/actualiza meta; trae todas las columnas obligatorias)
async function upsertMeta(rows){
  if(!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/matches?on_conflict=ext_id`, {
    method: "POST",
    headers: { ...AUTH, "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if(!res.ok){ throw new Error(`fixture: HTTP ${res.status} — ${(await res.text()).slice(0,200)}`); }
}

// PATCH B — resultados finales (SOLO actualiza filas existentes; nunca crea)
async function patchFinished(rows){
  for(const r of rows){
    const res = await fetch(`${SUPABASE_URL}/rest/v1/matches?ext_id=eq.${r.ext_id}`, {
      method: "PATCH",
      headers: { ...AUTH, "Prefer": "return=minimal" },
      body: JSON.stringify({ home_score: r.home_score, away_score: r.away_score, status: "finished" }),
    });
    if(!res.ok){ throw new Error(`resultado ext_id ${r.ext_id}: HTTP ${res.status} — ${(await res.text()).slice(0,150)}`); }
  }
}

async function main(){
  if(SUPABASE_SERVICE_ROLE === "PEGA_TU_SERVICE_ROLE_AQUI"){
    console.error("✗ Falta la clave service_role."); process.exit(1);
  }
  console.log("Descargando fixture…");
  const all = (await (await fetch(SOURCE)).json()).matches;

  const perGroup = {};
  const meta = [];        // A: fixture
  const finished = [];    // B: finales

  all.forEach((m, i) => {
    const ext_id = i + 1;
    const isGroup = m.round.startsWith("Matchday");
    const stage = isGroup ? "group" : (STAGE[m.round] || "group");
    const grp = isGroup && m.group ? m.group.replace("Group ","") : null;
    let matchday = null;
    if(isGroup){ perGroup[grp] = (perGroup[grp]||0)+1; matchday = Math.ceil(perGroup[grp]/2); }

    const h = team(m.team1), a = team(m.team2);
    meta.push({
      ext_id, stage, group_name: grp, matchday, slot: null,
      home_team: h.name, home_code: h.code, away_team: a.name, away_code: a.code,
      kickoff: toUTC(m.date, m.time), _stage: stage,
    });

    const ft = m.score && m.score.ft;
    if(Array.isArray(ft)){
      finished.push({ ext_id, home_score: ft[0], away_score: ft[1] });
    }
  });

  const counters = {}, PREFIX = {r32:"R32", r16:"R16", qf:"QF", sf:"SF", final:"FINAL", third:"THIRD"};
  meta.forEach(r => {
    if(r._stage !== "group"){ counters[r._stage] = (counters[r._stage]||0)+1; r.slot = `${PREFIX[r._stage]}-${counters[r._stage]}`; }
    delete r._stage;
  });

  console.log(`Sincronizando fixture (${meta.length}) y resultados finales (${finished.length})…`);
  await upsertMeta(meta);       // A: fixture (no toca marcador/estado en vivo)
  await patchFinished(finished); // B: confirma finales (solo actualiza)

  console.log(`✓ Listo. Fixture ${meta.length} · finales ${finished.length}.`);
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
