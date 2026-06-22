// ============================================================
//  sync.js — Autollenado del fixture y resultados del Mundial 2026
//  Lee los datos públicos de openfootball (sin API key) y los
//  mete/actualiza en tu tabla 'matches' de Supabase vía API REST.
//  No usa librerías externas: funciona en cualquier Node 18+.
//
//  Uso local:   node sync.js
//  En GitHub Actions: la clave llega por el Secret SUPABASE_SERVICE_ROLE.
// ============================================================

/* ================================================================
   ⬇⬇⬇  DATOS DE SUPABASE  ⬇⬇⬇
   La clave es la SECRETA (service_role), NO la publishable/anon.
   En GitHub va por Secret; en local puedes pegarla en el placeholder.
================================================================ */
const SUPABASE_URL          = "https://shvabecptbciujnpqjnx.supabase.co";
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || "PEGA_TU_SERVICE_ROLE_AQUI";
/* ================================================================ */

const SOURCE = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

// Inglés → [Español, código de 3 letras]
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

async function upsert(rows){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/matches?on_conflict=ext_id`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE,
      "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if(!res.ok){
    const t = await res.text();
    throw new Error(`HTTP ${res.status} — ${t.slice(0,300)}`);
  }
}

async function main(){
  if(SUPABASE_SERVICE_ROLE === "PEGA_TU_SERVICE_ROLE_AQUI"){
    console.error("✗ Falta la clave service_role (en el Secret de GitHub o en el archivo)."); process.exit(1);
  }
  console.log("Descargando fixture…");
  const data = await (await fetch(SOURCE)).json();
  const all = data.matches;

  const perGroup = {};
  const rows = all.map((m, i) => {
    const isGroup = m.round.startsWith("Matchday");
    const stage = isGroup ? "group" : (STAGE[m.round] || "group");
    const grp = isGroup && m.group ? m.group.replace("Group ","") : null;
    let matchday = null;
    if(isGroup){ perGroup[grp] = (perGroup[grp]||0)+1; matchday = Math.ceil(perGroup[grp]/2); }

    const h = team(m.team1), a = team(m.team2);
    const ko = toUTC(m.date, m.time);
    const ft = m.score && m.score.ft;
    const finished = Array.isArray(ft);
    const status = finished ? "finished" : (new Date(ko) <= new Date() ? "live" : "scheduled");

    return {
      ext_id: i + 1, stage, group_name: grp, matchday, slot: null,
      home_team: h.name, home_code: h.code, away_team: a.name, away_code: a.code,
      kickoff: ko,
      home_score: finished ? ft[0] : null, away_score: finished ? ft[1] : null,
      status, _stage: stage,
    };
  });

  const counters = {};
  const PREFIX = {r32:"R32", r16:"R16", qf:"QF", sf:"SF", final:"FINAL", third:"THIRD"};
  rows.forEach(r => {
    if(r._stage !== "group"){
      counters[r._stage] = (counters[r._stage]||0)+1;
      r.slot = `${PREFIX[r._stage]}-${counters[r._stage]}`;
    }
    delete r._stage;
  });

  console.log(`Sincronizando ${rows.length} partidos…`);
  await upsert(rows);

  const fin = rows.filter(r=>r.status==="finished").length;
  console.log(`✓ Listo. ${rows.length} partidos en la base (${fin} con resultado, ${rows.length-fin} pendientes).`);
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
