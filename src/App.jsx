import { useEffect, useState } from "react";

export default function App() {
  const [status, setStatus] = useState("lädt...");

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL}/api/health`)
      .then((r) => r.json())
      .then((data) => setStatus(JSON.stringify(data)))
      .catch((err) => setStatus("Fehler: " + err.message));
  }, []);

  return (
    <div style={{ padding: 40, fontFamily: "Arial, sans-serif" }}>
      <h1>TalentRadar Test</h1>
      <p>Frontend läuft.</p>
      <p>Backend-Status:</p>
      <pre>{status}</pre>
    </div>
  );
}
