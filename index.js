import express from "express";
import fetch from "node-fetch";
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import axios from "axios";

const app = express();
const port = process.env.PORT || 10000;

// ENV Variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WP_URL = process.env.WP_URL; // e.g. https://sarkariresultwallah.com
const WP_USER = process.env.WP_USER;
const WP_APP_PASS = process.env.WP_APP_PASS;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const rssParser = new Parser();

// ✅ 1. Sources Collect
async function fetchSources() {
  const jobs = [];

  // (A) Rojgar Result (RSS)
  try {
    const feed = await rssParser.parseURL("https://rojgarresult.in/feed/");
    feed.items.forEach(item => {
      jobs.push({
        title: item.title,
        url: item.link,
        raw: item.contentSnippet
      });
    });
  } catch (err) {
    console.error("RojgarResult fetch error", err);
  }

  // (B) Sarkari Result (RSS)
  try {
    const feed = await rssParser.parseURL("https://www.sarkariresult.com/feed/");
    feed.items.forEach(item => {
      jobs.push({
        title: item.title,
        url: item.link,
        raw: item.contentSnippet
      });
    });
  } catch (err) {
    console.error("SarkariResult fetch error", err);
  }

  // (C) Jagran Jobs (Scraping)
  try {
    const html = await (await fetch("https://www.jagran.com/jobs")).text();
    const $ = cheerio.load(html);
    $("a").each((i, el) => {
      const text = $(el).text();
      const link = $(el).attr("href");
      if (text.includes("भर्ती") && link) {
        jobs.push({ title: text, url: link, raw: "" });
      }
    });
  } catch (err) {
    console.error("Jagran fetch error", err);
  }

  // (D) Amar Ujala Jobs (Scraping)
  try {
    const html = await (await fetch("https://www.amarujala.com/jobs")).text();
    const $ = cheerio.load(html);
    $("a").each((i, el) => {
      const text = $(el).text();
      const link = $(el).attr("href");
      if (text.includes("भर्ती") && link) {
        jobs.push({ title: text, url: link, raw: "" });
      }
    });
  } catch (err) {
    console.error("AmarUjala fetch error", err);
  }

  return jobs.slice(0, 5); // Test ke liye 5 hi jobs
}

// ✅ 2. AI से Analyze (मेरे जैसे जवाब)
async function analyzeJob(job) {
  const prompt = `
नीचे दिए गए raw data से एक साफ-सुथरा जॉब पोस्ट तैयार करो:
Title: ${job.title}
URL: ${job.url}
Raw: ${job.raw}

Output JSON दो, इस format में:
{
  "unique_id": "string",
  "title": "string",
  "content_html": "string (HTML format with tables for dates, fees, etc)",
  "source_link": "string"
}
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // या gpt-4.1-mini
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (err) {
    console.error("AI Analysis error", err);
    return null;
  }
}

// ✅ 3. WordPress पर Auto Post
async function publishToWordPress(job) {
  try {
    const res = await axios.post(
      `${WP_URL}/wp-json/wp/v2/posts`,
      {
        title: job.title,
        content: job.content_html,
        status: "draft", // "publish" भी कर सकते हो
      },
      {
        auth: { username: WP_USER, password: WP_APP_PASS }
      }
    );
    return res.data;
  } catch (err) {
    console.error("WordPress publish error", err.response?.data || err.message);
    return null;
  }
}

// ✅ 4. Main Endpoint
app.get("/check-jobs", async (req, res) => {
  try {
    const sources = await fetchSources();
    const analyzed = [];

    for (const job of sources) {
      const aj = await analyzeJob(job);
      if (aj) {
        const wpPost = await publishToWordPress(aj);
        analyzed.push({ job: aj.title, wp: wpPost?.id || "not published" });
      }
    }

    res.json({ status: "success", data: analyzed });
  } catch (err) {
    console.error("Check-jobs error", err);
    res.json({ status: "error", message: err.message });
  }
});

app.listen(port, () => {
  console.log(`Middleware running on port ${port}`);
});
