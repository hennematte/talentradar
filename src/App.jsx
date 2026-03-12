import { useState, useRef, useCallback } from "react";

// ─── Backend URL ────────────────────────────────────────────────────
// Lokal: http://localhost:8000
// Produktion: https://api.talentradar.deinefirma.de
const API = import.meta?.env?.VITE_API_URL || "http://localhost:8000";

// ─── Helpers ────────────────────────────────────────────────────────
const post = async (path, body) => {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.detail || `Fehler ${r.status}`);
  }
  return r.json();
};

const toCSV = (jobs) => {
  const h = ["Rang","Score %","Jobtitel","Unternehmen","Ort","Quelle","URL","Match-Begründung","Fehlt"];
  const rows = jobs.map((j, i) =>
    [i+1, j.score ?? "", j.title ?? "", j.company ?? "", j.location ?? "",
     j.source ?? "", j.url ?? "", j.reasons ?? "", j.missing ?? ""]
    .map((v) => `"${String(v).replace(/"/g,'""')}"`)
  );
  return [h.map((v) => `"${v}"`), ...rows].map((r) => r.join(";")).join("\n");
};

const scoreColor = (s) => s >= 75 ? "#22c55e" : s >= 50 ? "#f59e0b" : "#f87171";

// ─── Design Tokens ───────────────────────────────────────────────────
const C = {
  bg: "#07090f", surf: "#0d1117", surf2: "#131c27", surf3: "#192232",
  border: "#1c2a3d", borderLight: "#243348",
  primary: "#e8a020", primaryDim: "rgba(232,160,32,0.12)",
  text: "#d8e2ef", muted: "#4d6075", faint: "#2a3a4d",
  success: "#22c55e", successDim: "rgba(34,197,94,0.1)",
  warn: "#f59e0b", warnDim: "rgba(245,158,11,0.1)",
  err: "#f87171", liColor: "#0a66c2", liDim: "rgba(10,102,194,0.12)",
};

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&family=JetBrains+Mono:wght@400;500&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:${C.surf}}::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}
input:focus{border-color:${C.primary}!important;outline:none}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.rhover:hover{background:${C.surf2}!important}
.bhover:hover{opacity:.82}
`;

const inp = {
  width:"100%", background:C.surf2, border:`1px solid ${C.border}`,
  borderRadius:8, padding:"12px 14px", color:C.text, fontSize:14,
  fontFamily:"'DM Sans',sans-serif", transition:"border-color .2s",
};
const btn = (bg, fg, ex={}) => ({
  background:bg, border:"none", borderRadius:8, padding:"12px 24px",
  color:fg, fontWeight:600, fontSize:14, cursor:"pointer",
  fontFamily:"'Syne',sans-serif", transition:"opacity .2s", ...ex,
});

const Logo = () => (
  <span style={{fontFamily:"'Syne'",fontWeight:800,letterSpacing:-.5}}>
    <span style={{color:C.primary}}>TALENT</span>
    <span style={{color:C.text}}>RADAR</span>
  </span>
);

const Tag = ({mono=false, children, color=C.muted, bg=C.surf2}) => (
  <span style={{
    fontSize:10, padding:"3px 9px", borderRadius:99,
    background:bg, color, fontFamily: mono ? "'JetBrains Mono'" : "'DM Sans'",
    letterSpacing: mono ? 0.5 : 0,
  }}>{children}</span>
);

// ════════════════════════════════════════════════════════════
export default function App() {
  const [screen, setScreen]     = useState("input");
  const [cv, setCv]             = useState({ base64:"", name:"" });
  const [cand, setCand]         = useState({
    name:"", email:"", city:"", radius:25, jobTitle:"",
    salaryMin:"", salaryMax:"", remote:"egal", availability:"",
  });
  const [parsed, setParsed]     = useState(null);
  const [jobs, setJobs]         = useState([]);
  const [log, setLog]           = useState([]);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy]         = useState(false);
  const [selected, setSelected] = useState(null);
  const [letters, setLetters]   = useState({});
  const [genCL, setGenCL]       = useState(false);
  const [filter, setFilter]     = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [stats, setStats]       = useState(null);
  const fileRef = useRef();
  const logRef  = useRef();

  const addLog = useCallback((msg, type="info") => {
    setLog((l) => [...l, { time: new Date().toLocaleTimeString("de-DE"), msg, type }]);
    setTimeout(() => { if (logRef.current) logRef.current.scrollTop = 9999; }, 50);
  }, []);

  const handleFile = (file) => {
    if (!file || file.type !== "application/pdf") {
      alert("Bitte nur PDF-Dateien hochladen."); return;
    }
    const reader = new FileReader();
    reader.onload = (e) => setCv({ base64: e.target.result.split(",")[1], name: file.name });
    reader.readAsDataURL(file);
  };

  // ── Haupt-Pipeline ──────────────────────────────────────────
  const runSearch = async () => {
    if (!cv.base64)  { alert("Bitte einen Lebenslauf hochladen (PDF)."); return; }
    if (!cand.city)  { alert("Bitte eine Stadt angeben."); return; }

    setBusy(true); setLog([]); setJobs([]); setProgress(0); setSelected(null);
    setScreen("processing");

    const base = {
      cv_base64: cv.base64, name: cand.name, email: cand.email,
      city: cand.city, radius: cand.radius, job_title: cand.jobTitle,
      salary_min: cand.salaryMin, salary_max: cand.salaryMax,
      remote: cand.remote, availability: cand.availability,
    };

    try {
      // ── 1. CV Parsen ──
      addLog("🔍 Analysiere Lebenslauf...");
      setProgress(10);
      const cvData = await post("/api/parse-cv", base);
      setParsed(cvData);
      if (!cand.name && cvData.name)           setCand((c) => ({...c, name: cvData.name}));
      if (!cand.jobTitle && cvData.primaryJobTitle) setCand((c) => ({...c, jobTitle: cvData.primaryJobTitle}));
      addLog(`✓ Profil erkannt: ${cvData.name || "Kandidat"} – ${cvData.primaryJobTitle}`, "success");
      addLog(`  Skills: ${(cvData.skills||[]).slice(0,6).join(", ")}`, "dim");
      setProgress(20);

      // Jobitel für die Suche aktualisieren
      base.job_title = cand.jobTitle || cvData.primaryJobTitle || "Fachkraft";

      // ── 2. Jobs scrapen ──
      addLog("🌐 Starte Job-Scraping (LinkedIn + Unternehmenswebsites)...");
      addLog("  ⏳ Das dauert 2–4 Minuten, bitte warten...", "dim");
      setProgress(25);

      const searchResult = await post("/api/search-jobs", base);

      if (searchResult.errors?.length) {
        searchResult.errors.forEach((e) => addLog(`⚠ ${e}`, "warn"));
      }

      setStats(searchResult.breakdown);
      addLog(`✓ LinkedIn: ${searchResult.breakdown?.linkedin || 0} Stellen`, "success");
      addLog(`✓ Unternehmenswebsites: ${searchResult.breakdown?.google || 0} Stellen`, "success");
      addLog(`  Gesamt nach Deduplizierung: ${searchResult.count}`, "dim");
      setProgress(62);

      if (!searchResult.jobs?.length) {
        addLog("❌ Keine Stellen gefunden. Bitte Apify-Konfiguration prüfen.", "error");
        setBusy(false); return;
      }

      // ── 3. KI-Matching ──
      addLog(`🤖 KI-Matching für ${searchResult.jobs.length} Stellen...`);
      setProgress(65);

      const profile = {
        jobtitel:       base.job_title,
        alternativTitel: cvData.alternativeTitles || [],
        skills:         cvData.skills || [],
        branchen:       cvData.industries || [],
        erfahrungJahre: cvData.experienceYears,
        ausbildung:     cvData.education,
        gehaltMin:      cand.salaryMin ? `${cand.salaryMin}€` : "k.A.",
        gehaltMax:      cand.salaryMax ? `${cand.salaryMax}€` : "k.A.",
        remoteWunsch:   cand.remote,
        verfuegbarAb:   cand.availability || "sofort",
        standort:       cand.city,
      };

      const matchResult = await post("/api/match-jobs", {
        jobs: searchResult.jobs, profile,
      });

      setJobs(matchResult.jobs);
      setProgress(100);
      addLog(`✅ Fertig! ${matchResult.jobs.length} Stellen bewertet.`, "success");
      addLog(`  Top-Match: ${matchResult.jobs[0]?.score ?? 0}% – ${matchResult.jobs[0]?.title ?? ""}`, "success");

      setTimeout(() => setScreen("results"), 1200);

    } catch (err) {
      addLog(`❌ Fehler: ${err.message}`, "error");
    }
    setBusy(false);
  };

  // ── Anschreiben generieren ──────────────────────────────────
  const generateCL = async (job) => {
    if (letters[job.id]) return;
    setGenCL(true);
    try {
      const result = await post("/api/generate-letter", {
        job_title: job.title, job_company: job.company,
        job_location: job.location, job_description: job.description || "",
        job_reasons: job.reasons || "",
        candidate_name: cand.name || parsed?.name || "Kandidat",
        candidate_email: cand.email || "",
        candidate_job_title: cand.jobTitle || parsed?.primaryJobTitle || "",
        candidate_skills: parsed?.skills || [],
        candidate_experience: parsed?.experienceYears || 0,
        candidate_industries: parsed?.industries || [],
        availability: cand.availability || "sofort",
      });
      setLetters((l) => ({...l, [job.id]: result.letter}));
    } catch (e) {
      setLetters((l) => ({...l, [job.id]: `Fehler: ${e.message}`}));
    }
    setGenCL(false);
  };

  // ── CSV Export ──────────────────────────────────────────────
  const exportCSV = () => {
    const csv = "\uFEFF" + toCSV(jobs);
    const blob = new Blob([csv], { type:"text/csv;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `talentradar-${cand.city}-${new Date().toISOString().slice(0,10)}.csv`,
    });
    a.click();
    URL.revokeObjectURL(url);
  };

  const filtered = jobs.filter((j) =>
    !filter || [j.title, j.company, j.location, j.source]
      .some((v) => (v||"").toLowerCase().includes(filter.toLowerCase()))
  );

  // ════════════════════════════════════════════════════════════
  // SCREEN: INPUT
  // ════════════════════════════════════════════════════════════
  if (screen === "input") return (
    <div style={{minHeight:"100vh", background:C.bg, fontFamily:"'DM Sans',sans-serif", color:C.text}}>
      <style>{FONTS}</style>

      {/* Header */}
      <div style={{height:58, padding:"0 28px", borderBottom:`1px solid ${C.border}`,
        display:"flex", alignItems:"center", gap:16, background:C.surf}}>
        <Logo />
        <div style={{width:1, height:18, background:C.border}} />
        <span style={{fontSize:13, color:C.muted}}>Neuer Kandidat</span>
        <div style={{marginLeft:"auto", fontSize:11, color:C.faint, fontFamily:"'JetBrains Mono'"}}>
          Backend: <span style={{color:C.primary}}>{API}</span>
        </div>
      </div>

      <div style={{maxWidth:980, margin:"0 auto", padding:"40px 28px",
        display:"grid", gridTemplateColumns:"1fr 1fr", gap:40}}>

        {/* ── Links: CV Upload ── */}
        <div>
          <Label>01 — Lebenslauf (PDF)</Label>

          {/* Drop Zone */}
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
            style={{
              border:`2px dashed ${cv.base64 ? C.primary : dragOver ? C.primary : C.border}`,
              borderRadius:12, padding:"36px 24px", textAlign:"center", cursor:"pointer",
              background: cv.base64 ? C.primaryDim : dragOver ? C.primaryDim : C.surf,
              transition:"all .2s", marginBottom:28,
            }}
          >
            {cv.base64 ? (
              <>
                <div style={{fontSize:28, marginBottom:8}}>📄</div>
                <div style={{color:C.primary, fontWeight:500, fontSize:14}}>{cv.name}</div>
                <div style={{fontSize:12, color:C.muted, marginTop:4}}>Klicken zum Austauschen</div>
              </>
            ) : (
              <>
                <div style={{fontSize:28, marginBottom:8, opacity:.4}}>📁</div>
                <div style={{color:C.text, fontSize:14}}>CV hier ablegen oder klicken</div>
                <div style={{fontSize:12, color:C.muted, marginTop:4}}>Nur PDF · Max. 10 MB</div>
              </>
            )}
          </div>
          <input ref={fileRef} type="file" accept=".pdf"
            onChange={(e) => handleFile(e.target.files[0])}
            style={{display:"none"}} />

          <Label>02 — Kontakt</Label>
          {[
            {key:"name",  label:"Vollständiger Name",         ph:"Max Mustermann"},
            {key:"email", label:"E-Mail (für Anschreiben)",   ph:"max@mustermann.de"},
          ].map((f) => (
            <Field key={f.key} label={f.label} placeholder={f.ph}
              value={cand[f.key]} onChange={(v) => setCand((c)=>({...c,[f.key]:v}))} />
          ))}
        </div>

        {/* ── Rechts: Suchparameter ── */}
        <div>
          <Label>03 — Suchparameter</Label>

          {[
            {key:"city",         label:"Stadt / Standort *",                        ph:"Berlin, Leverkusen, München..."},
            {key:"jobTitle",     label:"Jobtitel (opt. – wird aus CV erkannt)",      ph:"Buchhalter, Schweißer, Chemiker..."},
            {key:"availability", label:"Verfügbar ab",                              ph:"sofort / 01.04.2026"},
          ].map((f) => (
            <Field key={f.key} label={f.label} placeholder={f.ph}
              value={cand[f.key]} onChange={(v) => setCand((c)=>({...c,[f.key]:v}))} />
          ))}

          {/* Radius */}
          <div style={{marginBottom:18}}>
            <div style={{fontSize:11, color:C.muted, marginBottom:8, textTransform:"uppercase",
              letterSpacing:1.2, fontFamily:"'JetBrains Mono'"}}>
              Suchradius: <span style={{color:C.primary}}>{cand.radius} km</span>
            </div>
            <input type="range" min={10} max={100} step={5} value={cand.radius}
              onChange={(e) => setCand((c)=>({...c, radius:+e.target.value}))}
              style={{width:"100%", accentColor:C.primary, cursor:"pointer"}} />
            <div style={{display:"flex", justifyContent:"space-between",
              fontSize:11, color:C.faint, marginTop:4}}>
              <span>10 km</span><span>100 km</span>
            </div>
          </div>

          {/* Gehalt */}
          <div style={{marginBottom:18}}>
            <Label>Gehaltswunsch (€ brutto/Jahr)</Label>
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
              {[["salaryMin","Minimum"],["salaryMax","Maximum"]].map(([k,p]) => (
                <input key={k} value={cand[k]} placeholder={p}
                  onChange={(e) => setCand((c)=>({...c,[k]:e.target.value}))}
                  style={inp} />
              ))}
            </div>
          </div>

          {/* Remote */}
          <div style={{marginBottom:36}}>
            <Label>Remote-Wunsch</Label>
            <div style={{display:"flex", gap:8}}>
              {[["egal","Egal"],["remote","Remote"],["vor-ort","Vor Ort"]].map(([v,l]) => (
                <button key={v} onClick={() => setCand((c)=>({...c, remote:v}))}
                  style={{
                    flex:1, padding:"10px 0", borderRadius:8, cursor:"pointer",
                    fontSize:12, transition:"all .15s",
                    border:`1px solid ${cand.remote===v ? C.primary : C.border}`,
                    background: cand.remote===v ? C.primaryDim : C.surf2,
                    color: cand.remote===v ? C.primary : C.muted,
                  }}>{l}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={{borderTop:`1px solid ${C.border}`, padding:"18px 28px",
        display:"flex", justifyContent:"flex-end", background:C.surf}}>
        <button onClick={runSearch} className="bhover"
          style={btn(C.primary,"#000",{padding:"13px 40px", fontSize:15})}>
          SUCHE STARTEN →
        </button>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════
  // SCREEN: PROCESSING
  // ════════════════════════════════════════════════════════════
  if (screen === "processing") return (
    <div style={{minHeight:"100vh", background:C.bg, display:"flex",
      flexDirection:"column", alignItems:"center", justifyContent:"center",
      fontFamily:"'DM Sans',sans-serif", color:C.text}}>
      <style>{FONTS}</style>

      <div style={{width:640, padding:"0 24px", animation:"fadeIn .4s ease"}}>
        <div style={{fontSize:26, fontFamily:"'Syne'", marginBottom:4}}><Logo /></div>
        <div style={{color:C.muted, fontSize:13, marginBottom:28}}>
          {cand.name || "Kandidat"} ·{" "}
          <span style={{color:C.text}}>{cand.jobTitle || "Berufsfeld wird erkannt"}</span>
          {" "}· {cand.city} · {cand.radius} km Radius
        </div>

        {/* Progress Bar */}
        <div style={{background:C.surf2, borderRadius:999, height:4,
          marginBottom:32, overflow:"hidden"}}>
          <div style={{width:`${progress}%`, height:"100%",
            background:`linear-gradient(90deg,${C.primary},#f5c842)`,
            borderRadius:999, transition:"width .6s ease"}} />
        </div>

        {/* Log */}
        <div ref={logRef} style={{
          background:C.surf, border:`1px solid ${C.border}`, borderRadius:12,
          padding:"20px 24px", height:360, overflowY:"auto",
          fontFamily:"'JetBrains Mono'", fontSize:12, lineHeight:2,
        }}>
          {log.map((e, i) => (
            <div key={i} style={{display:"flex", gap:14,
              color: e.type==="error" ? C.err : e.type==="success" ? C.success
                   : e.type==="warn" ? C.warn : e.type==="dim" ? C.faint : C.muted}}>
              <span style={{opacity:.35, flexShrink:0}}>{e.time}</span>
              <span>{e.msg}</span>
            </div>
          ))}
          {busy && (
            <div style={{display:"flex", alignItems:"center", gap:8,
              color:C.primary, marginTop:8, animation:"pulse 1.5s ease infinite"}}>
              <div style={{width:10, height:10, border:`2px solid ${C.primary}`,
                borderTopColor:"transparent", borderRadius:"50%",
                animation:"spin .7s linear infinite", flexShrink:0}} />
              <span>Verarbeite...</span>
            </div>
          )}
        </div>

        <div style={{marginTop:14, fontSize:12, color:C.faint, textAlign:"center"}}>
          Scraping läuft auf deinem Backend · Apify + Claude API
        </div>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════
  // SCREEN: RESULTS
  // ════════════════════════════════════════════════════════════
  return (
    <div style={{minHeight:"100vh", background:C.bg,
      fontFamily:"'DM Sans',sans-serif", color:C.text}}>
      <style>{FONTS}</style>

      {/* Header */}
      <div style={{height:56, padding:"0 24px", borderBottom:`1px solid ${C.border}`,
        display:"flex", alignItems:"center", justifyContent:"space-between",
        background:C.surf, position:"sticky", top:0, zIndex:50}}>
        <div style={{display:"flex", alignItems:"center", gap:14}}>
          <Logo />
          <div style={{width:1, height:16, background:C.border}} />
          <span style={{fontSize:13, color:C.muted}}>
            <span style={{color:C.text}}>{cand.name || parsed?.name}</span>
            {" · "}{cand.city}{" · "}{cand.jobTitle || parsed?.primaryJobTitle}
          </span>
        </div>
        <div style={{display:"flex", gap:8}}>
          <button onClick={exportCSV} className="bhover"
            style={btn(C.surf2, C.text, {border:`1px solid ${C.border}`,
              padding:"7px 14px", fontSize:12})}>
            📥 CSV Export
          </button>
          <button onClick={() => {setScreen("input");setJobs([]);setParsed(null);setLetters({});}}
            className="bhover"
            style={btn("none", C.muted, {border:`1px solid ${C.border}`,
              padding:"7px 14px", fontSize:12})}>
            + Neuer Kandidat
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{padding:"18px 24px", borderBottom:`1px solid ${C.border}`,
        display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12}}>
        {[
          {label:"Gesamt",         val:jobs.length,                               col:C.text,      bg:C.surf},
          {label:"Top-Match ≥75%", val:jobs.filter(j=>j.score>=75).length,        col:C.success,   bg:C.successDim},
          {label:"LinkedIn",       val:jobs.filter(j=>j.source==="LinkedIn").length, col:C.liColor, bg:C.liDim},
          {label:"Unternehmensseiten", val:jobs.filter(j=>j.source!=="LinkedIn").length, col:C.primary, bg:C.primaryDim},
        ].map((s) => (
          <div key={s.label} style={{background:s.bg, border:`1px solid ${C.border}`,
            borderRadius:10, padding:"12px 18px"}}>
            <div style={{fontSize:24, fontWeight:800, color:s.col, fontFamily:"'Syne'"}}>{s.val}</div>
            <div style={{fontSize:10, color:C.muted, marginTop:2, textTransform:"uppercase", letterSpacing:.8}}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filter */}
      <div style={{padding:"12px 24px", borderBottom:`1px solid ${C.border}`, background:C.surf}}>
        <input value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder="🔍  Filtern nach Jobtitel, Unternehmen, Ort, Quelle..."
          style={{...inp, width:420, padding:"9px 14px", fontSize:13}} />
      </div>

      {/* Table + Drawer */}
      <div style={{padding:"20px 24px", paddingRight: selected ? 544 : 24}}>
        <div style={{background:C.surf, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden"}}>
          <table style={{width:"100%", borderCollapse:"collapse", fontSize:13}}>
            <thead>
              <tr style={{background:C.surf2}}>
                {["#","Score","Stelle","Unternehmen","Ort","Quelle",""].map((h) => (
                  <th key={h} style={{padding:"11px 16px", textAlign:"left", fontSize:10,
                    color:C.muted, fontWeight:600, textTransform:"uppercase", letterSpacing:1.2,
                    fontFamily:"'JetBrains Mono'", borderBottom:`1px solid ${C.border}`,
                    whiteSpace:"nowrap"}}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((job, i) => (
                <tr key={job.id} className="rhover"
                  onClick={() => setSelected(job)}
                  style={{borderBottom:`1px solid ${C.border}`, cursor:"pointer",
                    background: selected?.id===job.id ? C.surf2 : "transparent",
                    transition:"background .12s"}}>
                  <td style={{padding:"12px 16px", color:C.faint, fontFamily:"'JetBrains Mono'",
                    fontSize:11, width:36}}>{i+1}</td>

                  <td style={{padding:"12px 16px", width:110}}>
                    <div style={{display:"flex", alignItems:"center", gap:7}}>
                      <div style={{width:34, height:3, background:C.surf3, borderRadius:99, overflow:"hidden"}}>
                        <div style={{width:`${job.score}%`, height:"100%",
                          background:scoreColor(job.score), borderRadius:99}} />
                      </div>
                      <span style={{fontFamily:"'JetBrains Mono'", fontSize:12,
                        color:scoreColor(job.score), fontWeight:600, minWidth:34}}>
                        {job.score}%
                      </span>
                    </div>
                  </td>

                  <td style={{padding:"12px 16px", fontWeight:500, color:C.text}}>{job.title}</td>
                  <td style={{padding:"12px 16px", color:C.muted}}>{job.company}</td>
                  <td style={{padding:"12px 16px", color:C.muted, fontSize:12}}>{job.location}</td>

                  <td style={{padding:"12px 16px"}}>
                    <Tag mono color={job.source==="LinkedIn"?C.liColor:C.primary}
                      bg={job.source==="LinkedIn"?C.liDim:C.primaryDim}>
                      {job.source==="LinkedIn"?"in ":""}{job.source}
                    </Tag>
                  </td>

                  <td style={{padding:"12px 16px"}} onClick={(e)=>e.stopPropagation()}>
                    <div style={{display:"flex", gap:6}}>
                      <button className="bhover"
                        onClick={() => { setSelected(job); if(!letters[job.id]) generateCL(job); }}
                        style={{fontSize:11, padding:"4px 10px", borderRadius:6,
                          border:`1px solid ${C.border}`, background:"none", color:C.text, cursor:"pointer"}}>
                        📝
                      </button>
                      {job.url && (
                        <a href={job.url} target="_blank" rel="noopener noreferrer"
                          style={{fontSize:11, padding:"4px 10px", borderRadius:6, background:C.surf3,
                            border:`1px solid ${C.border}`, color:C.muted, textDecoration:"none"}}>
                          🔗
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length===0 && (
            <div style={{padding:"48px 0", textAlign:"center", color:C.muted, fontSize:14}}>
              {filter ? "Keine Treffer" : "Keine Stellen gefunden"}
            </div>
          )}
        </div>
      </div>

      {/* ── Detail Drawer ── */}
      {selected && (
        <div style={{position:"fixed", top:0, right:0, width:520, height:"100vh",
          background:C.surf, borderLeft:`1px solid ${C.border}`,
          overflowY:"auto", zIndex:200, animation:"fadeIn .2s ease"}}>

          <div style={{padding:"18px 22px", borderBottom:`1px solid ${C.border}`,
            display:"flex", justifyContent:"space-between", alignItems:"flex-start",
            position:"sticky", top:0, background:C.surf, zIndex:10}}>
            <div style={{flex:1, paddingRight:16}}>
              <div style={{fontSize:16, fontWeight:700, fontFamily:"'Syne'",
                lineHeight:1.3, marginBottom:4}}>{selected.title}</div>
              <div style={{fontSize:13, color:C.muted}}>
                {selected.company} · {selected.location}
              </div>
            </div>
            <button onClick={() => setSelected(null)}
              style={{background:"none", border:"none", color:C.muted,
                fontSize:18, cursor:"pointer", padding:4}}>✕</button>
          </div>

          <div style={{padding:22}}>
            {/* Score */}
            <div style={{background:C.surf2, border:`1px solid ${C.border}`,
              borderRadius:12, padding:18, marginBottom:18}}>
              <div style={{display:"flex", justifyContent:"space-between",
                alignItems:"flex-end", marginBottom:10}}>
                <span style={{fontSize:11, color:C.muted, fontFamily:"'JetBrains Mono'",
                  textTransform:"uppercase", letterSpacing:1}}>Match-Score</span>
                <span style={{fontSize:32, fontWeight:800, color:scoreColor(selected.score),
                  fontFamily:"'Syne'"}}>{selected.score}%</span>
              </div>
              <div style={{height:5, background:C.surf3, borderRadius:99,
                overflow:"hidden", marginBottom:12}}>
                <div style={{width:`${selected.score}%`, height:"100%",
                  background:scoreColor(selected.score), borderRadius:99,
                  transition:"width .5s"}} />
              </div>
              {selected.reasons && (
                <div style={{fontSize:13, color:C.success, display:"flex", gap:6, marginBottom:selected.missing?8:0}}>
                  <span style={{flexShrink:0}}>✓</span><span>{selected.reasons}</span>
                </div>
              )}
              {selected.missing && (
                <div style={{fontSize:13, color:C.warn, display:"flex", gap:6}}>
                  <span style={{flexShrink:0}}>⚠</span><span>Fehlt: {selected.missing}</span>
                </div>
              )}
            </div>

            {/* Actions */}
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:18}}>
              {selected.url && (
                <a href={selected.url} target="_blank" rel="noopener noreferrer"
                  className="bhover"
                  style={btn(C.surf2, C.text, {border:`1px solid ${C.border}`,
                    textDecoration:"none", textAlign:"center", fontSize:13})}>
                  🔗 Stelle öffnen
                </a>
              )}
              {cand.email && letters[selected.id] && (
                <a href={`mailto:?subject=${encodeURIComponent(`Bewerbung als ${selected.title}`)}&body=${encodeURIComponent(letters[selected.id])}`}
                  className="bhover"
                  style={btn(C.primary,"#000",{textDecoration:"none",textAlign:"center",fontSize:13})}>
                  ✉ Jetzt senden
                </a>
              )}
            </div>

            {/* Beschreibung */}
            {selected.description && (
              <div style={{marginBottom:18}}>
                <div style={{fontSize:11, color:C.muted, marginBottom:8,
                  textTransform:"uppercase", letterSpacing:1, fontFamily:"'JetBrains Mono'"}}>
                  Stellenbeschreibung
                </div>
                <div style={{fontSize:13, color:C.muted, lineHeight:1.7,
                  background:C.surf2, borderRadius:10, padding:14}}>
                  {selected.description.slice(0,400)}{selected.description.length>400?"...":""}
                </div>
              </div>
            )}

            {/* Anschreiben */}
            <div>
              <div style={{fontSize:11, color:C.muted, marginBottom:10,
                textTransform:"uppercase", letterSpacing:1, fontFamily:"'JetBrains Mono'"}}>
                Anschreiben
              </div>
              {!letters[selected.id] ? (
                <button onClick={() => generateCL(selected)} disabled={genCL}
                  className="bhover"
                  style={btn(C.primary,"#000",{width:"100%",
                    opacity:genCL?.6:1, cursor:genCL?"wait":"pointer"})}>
                  {genCL ? "⏳ Generiere..." : "📝 Anschreiben generieren"}
                </button>
              ) : (
                <div>
                  <div style={{display:"flex", justifyContent:"space-between", marginBottom:8}}>
                    <span style={{fontSize:12, color:C.success}}>✓ Bereit</span>
                    <div style={{display:"flex", gap:6}}>
                      <button onClick={() => navigator.clipboard.writeText(letters[selected.id])}
                        style={{fontSize:11, background:"none", border:`1px solid ${C.border}`,
                          borderRadius:6, padding:"3px 10px", color:C.muted, cursor:"pointer"}}>
                        Kopieren
                      </button>
                      <button onClick={() => { setLetters((l)=>{const n={...l};delete n[selected.id];return n;}); generateCL(selected); }}
                        style={{fontSize:11, background:"none", border:`1px solid ${C.border}`,
                          borderRadius:6, padding:"3px 10px", color:C.muted, cursor:"pointer"}}>
                        Neu
                      </button>
                    </div>
                  </div>
                  <div style={{background:C.surf2, border:`1px solid ${C.border}`,
                    borderRadius:10, padding:16, fontSize:13, color:C.text,
                    lineHeight:1.8, whiteSpace:"pre-wrap", maxHeight:480, overflowY:"auto"}}>
                    {letters[selected.id]}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Mini-Komponenten ──────────────────────────────────────────
const Label = ({children}) => (
  <div style={{fontSize:11, color:C.muted, marginBottom:10, textTransform:"uppercase",
    letterSpacing:1.2, fontFamily:"'JetBrains Mono'"}}>
    {children}
  </div>
);

const Field = ({label, placeholder, value, onChange}) => (
  <div style={{marginBottom:16}}>
    <label style={{display:"block", fontSize:11, color:C.muted, marginBottom:7,
      textTransform:"uppercase", letterSpacing:1, fontFamily:"'JetBrains Mono'"}}>
      {label}
    </label>
    <input value={value} onChange={(e)=>onChange(e.target.value)}
      placeholder={placeholder} style={inp} />
  </div>
);
