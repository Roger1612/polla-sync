// ============================================================
//  sync.js — Fixture del Mundial 2026 (openfootball → Supabase)
//  Ahora convive con el live-sync:
//   • Upsert A: solo datos del fixture (equipos, horario). NUNCA toca
//     marcador ni estado → no pisa lo que pone el live-sync en vivo.
//   • Upsert B: solo resultados FINALES (red de seguridad por si el
//     live-sync se perdió algún partido).
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

async function upsert(rows, label){
  if(!rows.length) return;
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
  if(!res.ok){ throw new Error(`${label}: HTTP ${res.status} — ${(await res.text()).slice(0,200)}`); }
}

async function main(){
  if(SUPABASE_SERVICE_ROLE === "PEGA_TU_SERVICE_ROLE_AQUI"){
    console.error("✗ Falta la clave service_role."); process.exit(1);
  }
  console.log("Descargando fixture…");
  const all = (await (await fetch(SOURCE)).json()).matches;

  const perGroup = {};
  const meta = [];        // Upsert A: solo fixture (sin marcador ni estado)
  const finished = [];    // Upsert B: solo resultados finales

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
      finished.push({ ext_id, home_score: ft[0], away_score: ft[1], status: "finished" });
    }
  });

  // slots de eliminatorias (R32-1, QF-2, …)
  const counters = {}, PREFIX = {r32:"R32", r16:"R16", qf:"QF", sf:"SF", final:"FINAL", third:"THIRD"};
  meta.forEach(r => {
    if(r._stage !== "group"){ counters[r._stage] = (counters[r._stage]||0)+1; r.slot = `${PREFIX[r._stage]}-${counters[r._stage]}`; }
    delete r._stage;
  });

  console.log(`Sincronizando fixture (${meta.length}) y resultados finales (${finished.length})…`);
  await upsert(meta, "fixture");          // A: nunca toca marcador/estado en vivo
  await upsert(finished, "resultados");   // B: confirma finales

  console.log(`✓ Listo. Fixture ${meta.length} · finales ${finished.length}.`);
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
