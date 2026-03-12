"""
TalentRadar Backend – FastAPI
Zentrale API für CV-Parsing, Job-Scraping und KI-Matching
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import httpx
import asyncio
import os
import json
import anthropic
from datetime import date
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="TalentRadar API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Konfiguration (alle Keys zentral in .env) ──────────────────────
APIFY_KEY  = os.getenv("APIFY_KEY", "")
CLAUDE_KEY = os.getenv("CLAUDE_KEY", "")
APIFY_BASE = "https://api.apify.com/v2"

# Actor-Namen: einfach in .env ändern wenn einer blockiert wird
ACTORS = {
    "linkedin":          os.getenv("ACTOR_LINKEDIN",          "curious_coder/linkedin-jobs-scraper"),
    "linkedin_fallback": os.getenv("ACTOR_LINKEDIN_FALLBACK", "harshu/linkedin-jobs-scraper"),
    "google":            os.getenv("ACTOR_GOOGLE",            "apify/google-search-scraper"),
    "google_fallback":   os.getenv("ACTOR_GOOGLE_FALLBACK",   "apify/bing-search-scraper"),
}

claude = anthropic.Anthropic(api_key=CLAUDE_KEY)

# ── Städte-Umkreis Mapping ──────────────────────────────────────────
NEARBY = {
    "leverkusen":  ["Köln", "Düsseldorf", "Bergisch Gladbach", "Dormagen"],
    "köln":        ["Leverkusen", "Bonn", "Düsseldorf", "Bergisch Gladbach"],
    "düsseldorf":  ["Köln", "Duisburg", "Neuss", "Ratingen", "Mönchengladbach"],
    "münchen":     ["Augsburg", "Ingolstadt", "Freising", "Landshut"],
    "berlin":      ["Potsdam", "Brandenburg"],
    "hamburg":     ["Lübeck", "Lüneburg", "Buchholz", "Elmshorn"],
    "frankfurt":   ["Offenbach", "Darmstadt", "Wiesbaden", "Hanau", "Bad Homburg"],
    "stuttgart":   ["Ludwigsburg", "Esslingen", "Heilbronn", "Böblingen"],
    "dortmund":    ["Bochum", "Essen", "Hagen", "Castrop-Rauxel"],
    "essen":       ["Dortmund", "Bochum", "Duisburg", "Mülheim", "Oberhausen"],
    "nürnberg":    ["Erlangen", "Fürth", "Schwabach", "Ansbach"],
    "bremen":      ["Bremerhaven", "Oldenburg", "Delmenhorst"],
    "hannover":    ["Hildesheim", "Celle", "Wolfsburg", "Hameln"],
    "leipzig":     ["Halle", "Magdeburg", "Zwickau"],
    "dresden":     ["Chemnitz", "Zwickau", "Bautzen"],
    "karlsruhe":   ["Heidelberg", "Mannheim", "Pforzheim", "Baden-Baden"],
    "mannheim":    ["Heidelberg", "Karlsruhe", "Ludwigshafen", "Weinheim"],
    "augsburg":    ["München", "Ingolstadt", "Ulm"],
    "wuppertal":   ["Düsseldorf", "Köln", "Hagen", "Remscheid"],
    "bielefeld":   ["Paderborn", "Minden", "Detmold"],
    "bonn":        ["Köln", "Siegburg", "Sankt Augustin"],
    "münster":     ["Bielefeld", "Osnabrück", "Dortmund"],
}

BLOCKED_DOMAINS = [
    "stepstone.de", "indeed.com", "linkedin.com", "xing.com",
    "monster.de", "jobware.de", "karriere.de", "stellenanzeigen.de",
    "jobboerse.arbeitsagentur.de", "kimeta.de", "jobrapido.com",
    "hokify.de", "joblift.de"
]


# ── Hilfsfunktionen ─────────────────────────────────────────────────
def get_locations(city: str, radius: int) -> List[str]:
    key = city.lower().strip()
    near = NEARBY.get(key, [])
    count = 1 if radius <= 25 else 2 if radius <= 50 else 4
    return [city] + near[:count]


def deduplicate(jobs: List[dict]) -> List[dict]:
    seen = set()
    result = []
    for j in jobs:
        key = f"{j.get('title','').lower()[:30]}-{j.get('company','').lower()[:20]}"
        if key not in seen:
            seen.add(key)
            result.append(j)
    return result


def extract_company(url: str) -> str:
    try:
        from urllib.parse import urlparse
        host = urlparse(url).hostname or ""
        host = host.replace("www.", "")
        parts = host.split(".")
        return parts[-2].capitalize() if len(parts) >= 2 else parts[0]
    except Exception:
        return "Unbekannt"


def is_blocked(url: str) -> bool:
    return any(d in url for d in BLOCKED_DOMAINS)


async def apify_run(actor_id: str, input_data: dict, max_items: int = 100) -> List[dict]:
    encoded = actor_id.replace("/", "~")
    async with httpx.AsyncClient(timeout=360) as client:
        r = await client.post(
            f"{APIFY_BASE}/acts/{encoded}/runs?token={APIFY_KEY}",
            json=input_data,
        )
        data = r.json()
        run_id = data.get("data", {}).get("id")
        if not run_id:
            raise Exception(f"Run-Start fehlgeschlagen: {data.get('error', data)}")

        for _ in range(80):
            await asyncio.sleep(5)
            st = await client.get(f"{APIFY_BASE}/actor-runs/{run_id}?token={APIFY_KEY}")
            status = st.json().get("data", {}).get("status", "")
            if status == "SUCCEEDED":
                break
            if status in ["FAILED", "TIMED_OUT", "ABORTED"]:
                raise Exception(f"Run fehlgeschlagen: {status}")

        items_r = await client.get(
            f"{APIFY_BASE}/actor-runs/{run_id}/dataset/items"
            f"?token={APIFY_KEY}&clean=true&limit={max_items}"
        )
        items = items_r.json()
        return items if isinstance(items, list) else []


# ── Pydantic Models ─────────────────────────────────────────────────
class SearchRequest(BaseModel):
    cv_base64: str
    name: str = ""
    email: str = ""
    city: str
    radius: int = 25
    job_title: str = ""
    salary_min: str = ""
    salary_max: str = ""
    remote: str = "egal"
    availability: str = "sofort"


class MatchRequest(BaseModel):
    jobs: List[dict]
    profile: dict


class LetterRequest(BaseModel):
    job_title: str
    job_company: str
    job_location: str
    job_description: str = ""
    job_reasons: str = ""
    candidate_name: str
    candidate_email: str = ""
    candidate_job_title: str
    candidate_skills: List[str] = []
    candidate_experience: int = 0
    candidate_industries: List[str] = []
    availability: str = "sofort"


# ── Endpoints ────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "apify": bool(APIFY_KEY),
        "claude": bool(CLAUDE_KEY),
        "actors": ACTORS,
    }


@app.get("/api/config")
def get_config():
    """Gibt nicht-sensible Konfiguration ans Frontend"""
    return {
        "actors": ACTORS,
        "apify_configured": bool(APIFY_KEY),
        "claude_configured": bool(CLAUDE_KEY),
        "version": "1.0.0",
    }


@app.post("/api/parse-cv")
async def parse_cv(request: SearchRequest):
    """CV per Claude analysieren und Kandidatenprofil extrahieren"""
    if not CLAUDE_KEY:
        raise HTTPException(500, "CLAUDE_KEY nicht konfiguriert")
    try:
        msg = claude.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1500,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": "application/pdf",
                            "data": request.cv_base64,
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            "Analysiere diesen deutschen Lebenslauf genau. "
                            "Antworte AUSSCHLIESSLICH mit validem JSON ohne Backticks:\n"
                            "{\n"
                            '  "name": "Vollständiger Name des Kandidaten",\n'
                            '  "primaryJobTitle": "Haupt-Berufsbezeichnung",\n'
                            '  "alternativeTitles": ["bis zu 6 verwandte Berufsbezeichnungen"],\n'
                            '  "skills": ["bis zu 15 Hard Skills und Zertifikate"],\n'
                            '  "softSkills": ["bis zu 5 Soft Skills"],\n'
                            '  "industries": ["Branchen aus bisherigen Stationen"],\n'
                            '  "experienceYears": 5,\n'
                            '  "education": "Höchster Bildungsabschluss",\n'
                            '  "languages": ["Sprachen mit Niveau"],\n'
                            '  "summary": "Kurze Zusammenfassung in 2 Sätzen"\n'
                            "}"
                        ),
                    },
                ],
            }],
        )
        raw = msg.content[0].text.replace("```json", "").replace("```", "").strip()
        return json.loads(raw)
    except Exception as e:
        raise HTTPException(500, f"CV-Parsing Fehler: {e}")


@app.post("/api/search-jobs")
async def search_jobs(request: SearchRequest):
    """
    Parallel scraping: LinkedIn + Unternehmenswebsites via Google.
    Wenn LinkedIn fehlschlägt wird automatisch Fallback-Actor genutzt.
    """
    if not APIFY_KEY:
        raise HTTPException(500, "APIFY_KEY nicht konfiguriert")

    job_title = request.job_title or "Fachkraft"
    locations  = get_locations(request.city, request.radius)
    results    = {"linkedin": [], "google": [], "errors": []}

    # ── LinkedIn Scraping ──
    async def scrape_linkedin():
        actors_to_try = [ACTORS["linkedin"], ACTORS["linkedin_fallback"]]
        for actor in actors_to_try:
            if not actor:
                continue
            try:
                items = await apify_run(actor, {
                    "queries": [
                        {
                            "keywords": job_title,
                            "location": f"{loc}, Deutschland",
                            "datePosted": "pastWeek",
                        }
                        for loc in locations[:2]
                    ],
                    "maxItems": 80,
                    "scrapeJobDetails": False,
                }, max_items=80)

                results["linkedin"] = [
                    {
                        "id": f"li_{i}",
                        "title":   j.get("title") or j.get("jobTitle") or job_title,
                        "company": j.get("companyName") or j.get("company") or "Unbekannt",
                        "location": j.get("location") or request.city,
                        "url":     j.get("jobUrl") or j.get("url") or "",
                        "description": j.get("description") or j.get("jobDescription") or "",
                        "source":  "LinkedIn",
                        "postedAt": j.get("postedAt") or j.get("listedAt") or "",
                    }
                    for i, j in enumerate(items)
                ]
                return  # Erfolg – kein Fallback nötig

            except Exception as e:
                results["errors"].append(f"LinkedIn ({actor}): {e}")
                continue  # Nächsten Actor versuchen

    # ── Google / Unternehmenswebsites Scraping ──
    async def scrape_google():
        queries = (
            # Hauptsuchen – Unternehmenswebsites bevorzugen
            [
                f'"{job_title}" Stelle {loc} -site:stepstone.de -site:indeed.com '
                f'-site:linkedin.com -site:xing.com -site:monster.de'
                for loc in locations[:2]
            ]
            # Zusätzliche Variationen
            + [
                f'"{job_title}" Stellenanzeige {request.city} Karriere',
                f'"{job_title}" jobs {request.city} Bewerbung site:*.de',
            ]
        )

        actors_to_try = [ACTORS["google"], ACTORS["google_fallback"]]
        for actor in actors_to_try:
            if not actor:
                continue
            try:
                items = await apify_run(actor, {
                    "queries": "\n".join(queries),
                    "maxPagesPerQuery": 1,
                    "resultsPerPage": 10,
                    "languageCode": "de",
                    "countryCode": "de",
                }, max_items=120)

                all_results = []
                for r in items:
                    all_results.extend(
                        r.get("organicResults") or r.get("items") or []
                    )

                results["google"] = [
                    {
                        "id": f"goog_{i}",
                        "title":   item.get("title") or job_title,
                        "company": extract_company(item.get("url") or item.get("link") or ""),
                        "location": request.city,
                        "url":     item.get("url") or item.get("link") or "",
                        "description": item.get("description") or item.get("snippet") or "",
                        "source": "Unternehmenswebsite",
                    }
                    for i, item in enumerate(all_results)
                    if not is_blocked(item.get("url") or item.get("link") or "")
                ]
                return  # Erfolg

            except Exception as e:
                results["errors"].append(f"Google ({actor}): {e}")
                continue

    # Beide parallel ausführen
    await asyncio.gather(scrape_linkedin(), scrape_google())

    all_jobs = deduplicate(results["linkedin"] + results["google"])
    return {
        "jobs":   all_jobs,
        "errors": results["errors"],
        "count":  len(all_jobs),
        "breakdown": {
            "linkedin": len(results["linkedin"]),
            "google":   len(results["google"]),
        },
    }


@app.post("/api/match-jobs")
async def match_jobs(request: MatchRequest):
    """KI-Matching: Stellen gegen Kandidatenprofil bewerten"""
    if not CLAUDE_KEY:
        raise HTTPException(500, "CLAUDE_KEY nicht konfiguriert")

    BATCH_SIZE = 8
    scored = []

    for i in range(0, len(request.jobs), BATCH_SIZE):
        batch = request.jobs[i : i + BATCH_SIZE]

        prompt = (
            "Du bist ein erfahrener Personalberater in Deutschland. "
            "Bewerte diese Stellenanzeigen für den Kandidaten.\n\n"
            f"KANDIDATENPROFIL:\n{json.dumps(request.profile, ensure_ascii=False, indent=2)}\n\n"
            "STELLEN ZU BEWERTEN:\n"
            + "\n\n".join(
                f'[{idx}] Titel: "{j.get("title")}" | Firma: "{j.get("company")}" '
                f'| Ort: "{j.get("location")}" | Info: "{(j.get("description") or "")[:250]}"'
                for idx, j in enumerate(batch)
            )
            + "\n\nBewerte jede Stelle 0-100 (100 = perfekte Übereinstimmung).\n"
            "Berücksichtige: Berufsfeld, Skills, Standort, Branche, Erfahrungsniveau.\n"
            "Antworte NUR mit JSON-Array:\n"
            '[{"idx":0,"score":82,"reasons":"Exakter Jobtitel, Skills passen","missing":"SAP fehlt"}]'
        )

        try:
            msg = claude.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=800,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = msg.content[0].text.replace("```json", "").replace("```", "").strip()
            scores = json.loads(raw)
            for s in scores:
                idx = s.get("idx", 0)
                if idx < len(batch):
                    scored.append({
                        **batch[idx],
                        "score":   min(100, max(0, s.get("score", 45))),
                        "reasons": s.get("reasons", ""),
                        "missing": s.get("missing", ""),
                    })
        except Exception:
            # Fallback: alle ungescored weitergeben
            for j in batch:
                scored.append({**j, "score": 45, "reasons": "Manuell prüfen empfohlen", "missing": ""})

    scored.sort(key=lambda x: x.get("score", 0), reverse=True)
    return {"jobs": scored}


@app.post("/api/generate-letter")
async def generate_letter(req: LetterRequest):
    """Deutsches Anschreiben generieren (DIN 5008)"""
    if not CLAUDE_KEY:
        raise HTTPException(500, "CLAUDE_KEY nicht konfiguriert")

    today = date.today().strftime("%d.%m.%Y")

    prompt = (
        "Verfasse ein professionelles deutsches Bewerbungsanschreiben (Sie-Form, DIN 5008).\n\n"
        f"KANDIDAT: {req.candidate_name}\n"
        f"E-MAIL: {req.candidate_email or '—'}\n"
        f"STELLE: {req.job_title}\n"
        f"UNTERNEHMEN: {req.job_company}\n"
        f"ORT: {req.job_location}\n"
        f"STELLENBESCHREIBUNG: {req.job_description[:600]}\n\n"
        "KANDIDATENPROFIL:\n"
        f"- Jobtitel: {req.candidate_job_title}\n"
        f"- Erfahrung: {req.candidate_experience} Jahre\n"
        f"- Skills: {', '.join(req.candidate_skills[:8])}\n"
        f"- Branchen: {', '.join(req.candidate_industries)}\n"
        f"- Verfügbar: {req.availability}\n"
        f"- Match-Begründung: {req.job_reasons}\n\n"
        f"Vollständiges Anschreiben mit Datum {today}. "
        "Kein einziger Platzhalter in eckigen Klammern. "
        "Absatz 1: Motivation + Bezug zum Unternehmen. "
        "Absatz 2: Konkrete Qualifikationen mit Beispielen. "
        "Absatz 3: Mehrwert + Gesprächswunsch."
    )

    try:
        msg = claude.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1200,
            messages=[{"role": "user", "content": prompt}],
        )
        return {"letter": msg.content[0].text}
    except Exception as e:
        raise HTTPException(500, f"Anschreiben-Generierung fehlgeschlagen: {e}")
