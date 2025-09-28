import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/download", async (req, res) => {
  let { tiktokUrl } = req.body || {};
  if (!tiktokUrl) return res.status(400).json({ error: "No TikTok URL provided" });

  // Expand short TikTok links
  try {
    const followResp = await fetch(tiktokUrl, { method: "GET" });
    if (followResp && followResp.url) {
      tiktokUrl = followResp.url;
      console.log("Expanded short URL to:", tiktokUrl);
    }
  } catch (expandErr) {
    console.warn("Could not expand short URL:", expandErr.message);
  }

  try {
    const providerBase = "https://tiktokdl-api-1.onrender.com"; // your API
    const providerUrl = `${providerBase}/download?url=${encodeURIComponent(tiktokUrl)}`;

    const apiResp = await fetch(providerUrl, { method: "GET" });

    if (!apiResp.ok) {
      const txt = await apiResp.text();
      return res.status(502).json({ error: "Upstream API error", details: txt });
    }

    const contentType = apiResp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = await apiResp.json();
      const downloadUrl = json.downloadUrl || json.video || json.url || json.data?.video;
      if (!downloadUrl) return res.status(502).json({ error: "No download link", full: json });
      return res.json({ downloadUrl });
    }

    res.setHeader("Content-Type", contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="tiktok_video.mp4"`);
    apiResp.body.pipe(res);

  } catch (err) {
    console.error("Error contacting provider:", err);
    return res.status(500).json({ error: "Server error contacting provider" });
  }
});

app.listen(PORT, () => console.log(`✅ Frontend server running on port ${PORT}`));
