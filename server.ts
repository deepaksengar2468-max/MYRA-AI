import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import cors from "cors";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { GoogleGenAI, Modality, Type, LiveServerMessage } from "@google/genai";
import dotenv from "dotenv";
import { 
  loadMemories, 
  saveMemories, 
  formatSystemInstructionsWithMemories, 
  processConversationSlice 
} from "./server_memory";
import { Memory } from "./src/lib/memoryTypes";
import { handleChatMessage, generateSpeechAudio, generateSongAudio } from "./server_chat";
import { classifyAIError } from "./server_resilient_ai";
import { loadConversations, upsertConversation, deleteConversation } from "./server_conversations";
import { WINDOWS_TOOLS, getGeminiFunctionDeclarations } from "./src/agent/toolRegistry";
import { 
  executeAgentTool, 
  getSystemInformation, 
  takeScreenshot, 
  analyzeScreen, 
  PENDING_CONFIRMATIONS 
} from "./src/agent/windowsTools";
import { getActionLogs, clearActionLogs } from "./src/agent/actionLogger";
import { getSettings, saveSettings } from "./src/agent/settingsManager";
import { analyzeVisionFrame } from "./server_vision";
import { logger } from "./services/loggerService";
import { GEMINI_CONFIGURATION_MESSAGE, getGeminiApiKey, isGeminiConfigured } from "./services/geminiConfig";

const APP_ROOT = path.resolve(process.env.MYRAA_APP_ROOT || process.cwd());
const DATA_ROOT = path.resolve(process.env.MYRAA_DATA_DIR || process.cwd());
dotenv.config({ path: path.join(DATA_ROOT, ".env"), override: false });

export interface MyraaServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startServer(): Promise<MyraaServerHandle> {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || "0.0.0.0";
  
  app.use(cors());
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  app.get("/api/health", (_req, res) => {
    res.status(200).json({
      status: "ready",
      version: process.env.MYRAA_APP_VERSION || process.env.npm_package_version || "unknown"
    });
  });

  // Exposes configuration status only. The key itself stays in this server process.
  app.get("/api/config/gemini", (_req, res) => {
    const configured = isGeminiConfigured();
    res.json({
      configured,
      ...(configured ? {} : { message: GEMINI_CONFIGURATION_MESSAGE })
    });
  });

  // Static screenshot serving
  app.use("/screenshots", express.static(path.join(DATA_ROOT, "screenshots")));

  // ==========================================
  // Windows Agent & Desktop Control REST APIs
  // ==========================================
  app.get("/api/agent/status", async (req, res) => {
    res.json({
      connected: true,
      platform: process.platform,
      isWindows: process.platform === "win32",
      arch: process.arch,
      nodeVersion: process.version,
      toolsCount: WINDOWS_TOOLS.length,
      mode: "local_agent"
    });
  });

  app.get("/api/agent/tools", async (req, res) => {
    res.json(WINDOWS_TOOLS);
  });

  app.get("/api/agent/system-info", async (req, res) => {
    try {
      const info = await getSystemInformation();
      res.json(info.data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/agent/execute", async (req, res) => {
    try {
      const { tool, args = {} } = req.body;
      if (!tool) {
        return res.status(400).json({ error: "Missing 'tool' parameter." });
      }
      const apiKey = getGeminiApiKey();
      const result = await executeAgentTool(tool, args, apiKey);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/agent/confirm", async (req, res) => {
    try {
      const { confirmationId, confirmed } = req.body;
      const pending = PENDING_CONFIRMATIONS.get(confirmationId);
      if (!pending) {
        return res.status(404).json({ error: "Confirmation request expired or not found." });
      }
      PENDING_CONFIRMATIONS.delete(confirmationId);

      if (!confirmed) {
        return res.json({
          success: false,
          tool: pending.tool,
          summary: `Action '${pending.tool}' was cancelled by user.`,
          cancelled: true
        });
      }

      // Execute tool with confirmed = true
      const apiKey = getGeminiApiKey();
      const result = await executeAgentTool(pending.tool, { ...pending.args, confirmed: true }, apiKey);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/agent/logs", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(getActionLogs(limit));
  });

  app.delete("/api/agent/logs", async (req, res) => {
    clearActionLogs();
    res.json({ success: true });
  });

  app.post("/api/agent/screenshot", async (req, res) => {
    try {
      const shot = await takeScreenshot();
      res.json(shot);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/agent/screen-analyze", async (req, res) => {
    try {
      const { question } = req.body;
      const apiKey = getGeminiApiKey();
      const analysis = await analyzeScreen(question, apiKey);
      res.json(analysis);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Settings Endpoints
  app.get("/api/settings", async (req, res) => {
    res.json(getSettings());
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const updated = saveSettings(req.body);
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Conversation storage REST API Endpoints
  app.get("/api/conversations", async (req, res) => {
    try {
      const convs = await loadConversations();
      res.json(convs);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/conversations", async (req, res) => {
    try {
      const conversation = req.body;
      if (!conversation || !conversation.id) {
        return res.status(400).json({ error: "Invalid conversation object." });
      }
      const saved = await upsertConversation(conversation);
      res.json(saved);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/conversations/:id", async (req, res) => {
    try {
      const success = await deleteConversation(req.params.id);
      res.json({ success });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Multimodal AI Chat Endpoint
  app.post("/api/chat", async (req, res) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      return res.status(503).json({ error: GEMINI_CONFIGURATION_MESSAGE });
    }

    try {
      const { messages = [], message = "", files = [], voiceName = "Aoede", generateSpeech = true } = req.body;
      const result = await handleChatMessage({
        apiKey,
        messages,
        newMessage: message,
        newFiles: files,
        voiceName,
        generateSpeech
      });
      res.json(result);
    } catch (err: any) {
      const classified = classifyAIError(err);
      logger.warn("AIChat", `Handled API failure (${classified.type})`, err);
      console.warn(`[API /chat Handled Error]: [${classified.type}] ${classified.message}`);
      res.status(classified.statusCode || 500).json({ 
        error: classified.userFriendlyMessage,
        type: classified.type,
        retryable: classified.retryable
      });
    }
  });

  // Text-To-Speech Endpoint
  app.post("/api/tts", async (req, res) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      return res.status(503).json({ error: GEMINI_CONFIGURATION_MESSAGE });
    }

    try {
      const { text, voiceName = "Aoede", emotion = "idle" } = req.body;
      if (!text) {
        return res.status(400).json({ error: "Missing text." });
      }
      const audioResult = await generateSpeechAudio({
        apiKey,
        text,
        voiceName,
        emotion
      });
      res.json(audioResult || { error: "Could not generate speech." });
    } catch (err: any) {
      logger.error("TextToSpeech", "TTS generation failed", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Dedicated Singing Mode & Original Song Audio Endpoint
  app.post("/api/sing", async (req, res) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      return res.status(503).json({ error: GEMINI_CONFIGURATION_MESSAGE });
    }

    try {
      const { mood = "calm", theme = "starlight and quiet moments", voiceName = "Aoede" } = req.body;
      const songResult = await generateSongAudio({
        apiKey,
        mood,
        theme,
        voiceName
      });
      res.json(songResult);
    } catch (err: any) {
      logger.error("Singing", "Song generation failed", err);
      console.error("[API /sing Error]:", err);
      res.status(500).json({ error: err.message || "Failed generating singing audio." });
    }
  });

  // Dedicated Live Camera Vision Analysis & Perception Endpoint
  app.post("/api/vision/analyze", async (req, res) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      return res.status(503).json({ error: GEMINI_CONFIGURATION_MESSAGE });
    }

    try {
      const { imageBase64, previousImageBase64, prompt, mode, voiceName, generateSpeech } = req.body;
      if (!imageBase64) {
        return res.status(400).json({ error: "Missing required 'imageBase64' parameter." });
      }

      const result = await analyzeVisionFrame(apiKey, {
        imageBase64,
        previousImageBase64,
        prompt,
        mode,
        voiceName,
        generateSpeech
      });

      res.json(result);
    } catch (err: any) {
      logger.error("Vision", "Frame analysis failed", err);
      console.error("[API /vision/analyze Error]:", err);
      res.status(500).json({ 
        error: err.message || "Failed to analyze live camera frame.",
        text: "I can see the camera feed, but the vision service isn't responding right now."
      });
    }
  });

  // Direct Project Source Export Endpoint
  app.get("/api/export/zip", async (req, res) => {
    try {
      const releaseDir = path.join(process.cwd(), "release");
      if (!fs.existsSync(releaseDir)) {
        fs.mkdirSync(releaseDir, { recursive: true });
      }
      const zipPath = path.join(releaseDir, "myraa-project-source.zip");
      const { createProjectExportZip } = await import("./services/exportService");
      await createProjectExportZip(zipPath);
      res.download(zipPath, "myraa-windows-source.zip");
    } catch (err: any) {
      logger.error("ProjectExport", "Project archive generation failed", err);
      console.error("[API /export/zip Error]:", err);
      res.status(500).json({ error: "Failed creating export zip: " + err.message });
    }
  });

  // Memory REST API Endpoints
  app.get("/api/memories", async (req, res) => {
    try {
      const memories = await loadMemories();
      res.json(memories);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/memories", async (req, res) => {
    try {
      const { category, text } = req.body;
      if (!category || !text) {
        return res.status(400).json({ error: "Category and text parameters are required." });
      }
      const memories = await loadMemories();
      const timestamp = new Date().toISOString();
      const newMemory: Memory = {
        id: Math.random().toString(36).substring(2, 11),
        category,
        text,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      memories.push(newMemory);
      await saveMemories(memories);
      res.status(201).json(newMemory);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/memories/:id", async (req, res) => {
    try {
      const { id } = req.params;
      let memories = await loadMemories();
      memories = memories.filter(m => m.id !== id);
      await saveMemories(memories);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Safe Server-Side Scraper & HTML Proxy endpoint
  app.get("/api/proxy", async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: "Missing 'url' parameter." });
      }

      console.log(`[Proxy Scraper] Fetching external content for: ${url}`);
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
      });

      if (!response.ok) {
        throw new Error(`Scraper failed to load page: status ${response.status}`);
      }

      const html = await response.text();

      // Simple regex-based HTML parsers for standard items
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Extract high-level headings (h1, h2, h3)
      const headings: string[] = [];
      const headingMatches = html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi);
      for (const match of headingMatches) {
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 3 && text.length < 120 && !headings.includes(text)) {
          headings.push(text);
        }
      }

      // Extract organic anchor links
      const links: { text: string; href: string }[] = [];
      const linkMatches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi);
      for (const match of linkMatches) {
        let href = match[1].trim();
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        
        if (text && text.length > 2 && text.length < 100) {
          if (href.startsWith("/")) {
            try {
              const u = new URL(url);
              href = `${u.protocol}//${u.host}${href}`;
            } catch {}
          }
          if (href.startsWith("http://") || href.startsWith("https://")) {
            links.push({ text, href });
          }
        }
      }

      // Extract general copy paragraphs
      const paragraphs: string[] = [];
      const paragraphMatches = html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi);
      for (const match of paragraphMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 25 && text.length < 600 && !paragraphs.includes(text)) {
          paragraphs.push(text);
        }
      }

      // Extract button elements
      const buttons: string[] = [];
      const buttonMatches = html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gi);
      for (const match of buttonMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 1 && text.length < 60 && !buttons.includes(text)) {
          buttons.push(text);
        }
      }

      res.json({
        url,
        title,
        headings: headings.slice(0, 15),
        links: links.filter(l => !l.href.includes("javascript:")).slice(0, 30),
        buttons: buttons.slice(0, 15),
        paragraphs: paragraphs.slice(0, 12)
      });

    } catch (err: any) {
      logger.warn("WebProxy", "Page scraping request failed", err);
      console.error("[Proxy Scraper] Error fetching remote page:", err.message);
      res.status(500).json({ error: `Scraper error: ${err.message}` });
    }
  });

  // High-fidelity fully functional HTML Proxy which circumvents CSP and X-Frame-Options
  app.get("/api/web-proxy", async (req, res) => {
    let targetUrl = "";
    try {
      const urlParam = req.query.url as string;
      if (!urlParam) {
        return res.status(400).send("Myraa Web Proxy Error: Missing target 'url' parameter");
      }

      targetUrl = urlParam.trim();
      
      // Prevent relative paths from requesting on same-origin
      if (targetUrl.startsWith("/")) {
        return res.status(400).send(`Myraa Web Proxy Error: Relative paths are not supported directly (${targetUrl}).`);
      }

      // Check protocol and hostname format
      try {
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
          targetUrl = "https://" + targetUrl;
        }
        const parsed = new URL(targetUrl);
        if (!parsed.hostname || !parsed.hostname.includes(".")) {
          throw new Error("Missing or invalid domain name extension (e.g. .com, .org, .net).");
        }
      } catch (err: any) {
        return res.status(400).send(`Myraa Web Proxy Error: Invalid URL specified: "${urlParam}". Make sure you enter a valid domain name.`);
      }

      console.log(`[Web Proxy] Routing connection through proxy: ${targetUrl}`);
      
      let response;
      try {
        response = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
          }
        });
      } catch (fetchErr: any) {
        logger.warn("WebProxy", "Remote page fetch failed", fetchErr);
        console.warn("[Web Proxy Failed Fetch] Remote request failed:", fetchErr.message);
        return res.status(502).send(`Myraa Web Proxy Error: Unable to fetch the website "${targetUrl}". The site might be offline, or the URL address is spelled incorrectly. Details: ${fetchErr.message}`);
      }

      if (!response.ok) {
        return res.status(response.status).send(`Myraa Web Proxy Error: Failed loading remote website. Server returned status: ${response.status} (${response.statusText})`);
      }

      const contentType = response.headers.get("content-type") || "";
      
      // If it is not HTML (e.g. stylesheet, script, or image loaded directly), proxy it as binary
      if (!contentType.includes("text/html")) {
        const arrayBuffer = await response.arrayBuffer();
        res.setHeader("Content-Type", contentType);
        return res.send(Buffer.from(arrayBuffer));
      }

      let htmlContents = await response.text();

      // Inject base tag to resolve relative paths and direct parent communication scripts
      const baseUrlTag = `<base href="${targetUrl}" />`;
      const interceptorScript = `
        <script>
          (function() {
            // Hijack link interactions safely
            document.addEventListener('click', function(e) {
              var anchor = e.target.closest('a');
              if (anchor) {
                var href = anchor.getAttribute('href');
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                  e.preventDefault();
                  try {
                    var resolvedUrl = new URL(href, window.location.href).href;
                    window.parent.postMessage({ type: 'NAVIGATE', url: resolvedUrl }, '*');
                  } catch (err) {
                    console.error("[Proxy Interceptor] Failed resolving link:", err);
                  }
                }
              }
            }, true);

            // Hijack search form submits
            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (form) {
                e.preventDefault();
                try {
                  var formData = new FormData(form);
                  var params = new URLSearchParams();
                  formData.forEach(function(value, key) {
                    if (typeof value === 'string') {
                      params.append(key, value);
                    }
                  });
                  var actionAttr = form.getAttribute('action') || '';
                  var actionUrl = new URL(actionAttr, window.location.href).href;
                  if (form.method.toLowerCase() === 'get') {
                    actionUrl += (actionUrl.indexOf('?') !== -1 ? '&' : '?') + params.toString();
                  }
                  window.parent.postMessage({ type: 'NAVIGATE', url: actionUrl }, '*');
                } catch (err) {
                  console.error("[Proxy Interceptor] Failed submitting form:", err);
                }
              }
            }, true);

            // Neutralize parent context locks (frame-busters)
            window.alert = function(msg) { console.log("[Myraa Browser alert bypassed]:", msg); };
            window.confirm = function(msg) { console.log("[Myraa Browser confirm bypassed]:", msg); return true; };
            window.open = function(url) { window.parent.postMessage({ type: 'NAVIGATE', url: url }, '*'); return null; };
          })();
        </script>
      `;

      // Inject into <head> or prepend
      if (htmlContents.includes("<head>")) {
        htmlContents = htmlContents.replace("<head>", `<head>\n${baseUrlTag}\n${interceptorScript}`);
      } else if (htmlContents.includes("<HEAD>")) {
        htmlContents = htmlContents.replace("<HEAD>", `<HEAD>\n${baseUrlTag}\n${interceptorScript}`);
      } else {
        htmlContents = baseUrlTag + "\n" + interceptorScript + "\n" + htmlContents;
      }

      // Neutralize security headers to allow displaying in an iframe on same-origin
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Myraa-Proxied", "true");
      res.removeHeader("X-Frame-Options");
      res.removeHeader("Content-Security-Policy");
      res.removeHeader("content-security-policy");
      res.removeHeader("x-frame-options");
      
      res.status(200).send(htmlContents);
    } catch (e: any) {
      logger.error("WebProxy", "Proxy request failed", e);
      console.warn("[Web Proxy Exception] Handled internal error:", e.message);
      res.status(500).send(`Myraa Web Proxy Error: Internal error occurred proxying URL "${targetUrl || "unknown"}". Details: ${e.message}`);
    }
  });

  // Real-time live YouTube search proxy endpoint
  app.get("/api/youtube-search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ error: "Missing query q" });
      }

      console.log(`[YouTube Proxy Search] Searching real YouTube for: "${query}"`);
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&sp=EgIQAQ%253D%253D`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
      });
      const html = await response.text();

      const videoList: any[] = [];
      const jsonMatch = html.match(/ytInitialData\s*=\s*({.+?});/);
      
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          const contents = data.contents?.twoColumnSearchResultRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
          if (contents && Array.isArray(contents)) {
            for (const item of contents) {
              if (item.videoRenderer) {
                const vr = item.videoRenderer;
                const vId = vr.videoId;
                if (vId) {
                  videoList.push({
                    videoId: vId,
                    title: vr.title?.runs?.[0]?.text || vr.title?.simpleText || "YouTube Video",
                    thumbnail: `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`,
                    author: vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || "Unknown Channel",
                    duration: vr.lengthText?.simpleText || "N/A",
                    views: vr.viewCountText?.simpleText || "N/A",
                    published: vr.publishedTimeText?.simpleText || ""
                  });
                }
              }
            }
          }
        } catch (e: any) {
          console.error("[YouTube Parser Engine] JSON parse error, falling back:", e.message);
        }
      }

      // Regex fallback if JSON extraction gets blocked or is empty
      if (videoList.length === 0) {
        const videoRegex = /"videoId":"([^"]+)"/g;
        let match;
        const ids: string[] = [];
        while ((match = videoRegex.exec(html)) !== null && ids.length < 15) {
          const id = match[1];
          if (id && !ids.includes(id)) {
            ids.push(id);
          }
        }

        for (const id of ids) {
          videoList.push({
            videoId: id,
            title: `Live Stream: ${id}`,
            thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            author: "YouTube Creator",
            duration: "N/A",
            views: "Available Now"
          });
        }
      }

      res.setHeader("Cache-Control", "public, max-age=60");
      res.status(200).json({ results: videoList.slice(0, 15) });
    } catch (err: any) {
      logger.warn("YouTubeSearch", "Search request failed", err);
      console.error("[YouTube Search Error]:", err.message);
      res.status(500).json({ error: err.message, results: [] });
    }
  });
  
  // Custom server running with http.createServer so we can upgrade for WebSocket on port 3000
  const server = http.createServer(app);
  
  // Setup WebSocket server with error resiliency
  const wss = new WebSocketServer({ noServer: true });
  wss.on("error", (err) => {
    logger.error("WebSocket", "WebSocket server error", err);
    console.warn("[WSS Error]:", err.message);
  });

  function safeSend(ws: WsWebSocket | null | undefined, data: any) {
    if (ws && ws.readyState === WsWebSocket.OPEN) {
      try {
        ws.send(typeof data === "string" ? data : JSON.stringify(data));
      } catch (err: any) {
        logger.warn("WebSocket", "Could not send a server message to the client", err);
        console.warn("[WS safeSend error]:", err.message);
      }
    }
  }
  
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", (socketErr) => {
      logger.warn("WebSocket", "Upgrade socket error", socketErr);
      console.warn("[Upgrade Socket Error]:", socketErr.message);
    });

    const rawUrl = request.url || "";
    const pathname = rawUrl.split("?")[0].replace(/\/+$/, "") || "/";
    
    if (pathname === "/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  // Handle client WebSocket Connection
  wss.on("connection", async (clientWs, request: http.IncomingMessage) => {
    console.log("Client WebSocket connected to /live");
    
    // Guard against unhandled client errors
    clientWs.on("error", (wsErr) => {
      logger.warn("WebSocket", "Client WebSocket error", wsErr);
      console.warn("[Client WS Error]:", wsErr.message);
    });

    let isClientClosed = false;
    clientWs.on("close", () => {
      isClientClosed = true;
    });

    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      safeSend(clientWs, { 
        type: "error", 
        error: GEMINI_CONFIGURATION_MESSAGE
      });
      setTimeout(() => {
        try { clientWs.close(); } catch (e) {}
      }, 50);
      return;
    }

    // Extract requested voice from query parameters (defaults to Aoede, which is high-pitched, soft and breezy)
    let requestedVoice = "Aoede";
    try {
      const rawUrl = request.url || "";
      const queryPart = rawUrl.includes("?") ? rawUrl.split("?")[1] : "";
      const searchParams = new URLSearchParams(queryPart);
      const voiceParam = searchParams.get("voice");
      if (voiceParam && ["Aoede", "Kore", "Puck", "Fenrir", "Charon"].includes(voiceParam)) {
        requestedVoice = voiceParam;
      }
    } catch (e) {}
    
    try {
      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
      
      safeSend(clientWs, { type: "status", status: "connecting_gemini" });

      // Load persistent recollections card
      const memories = await loadMemories();
      const baseInstructions = 
        "# MYRAA — ULTRA-NATURAL HUMAN-LIKE VOICE & SINGING SYSTEM\n\n" +
        "### 1. CORE VOICE IDENTITY\n" +
        "You are Myraa, a deeply believable, warm, intelligent, and emotionally perceptive female AI assistant and companion.\n" +
        "Your voice has an original feminine identity:\n" +
        "- Young-sounding female voice: soft and warm, clear pronunciation, naturally expressive, gentle but confident, friendly, and emotionally aware\n" +
        "- Slightly playful when appropriate, with natural conversational energy, smooth vocal texture, and pleasant resonance\n" +
        "- Completely free of robotic, mechanical, or synthetic character\n" +
        "- Do NOT make your voice excessively high-pitched\n" +
        "- Do NOT sound like a child\n" +
        "- Do NOT use exaggerated anime-style speech or cartoon squeaks\n" +
        "- Do NOT make every sentence sound cheerful; your fundamental voice remains consistent while emotion adapts naturally\n" +
        "- SAFETY & IDENTITY: You are an AI companion. You must NEVER claim to be a biological human.\n\n" +
        "### 2. HUMAN-LIKE SPEECH & CONVERSATIONAL FLOW\n" +
        "Before speaking, internally process the complete context:\n" +
        "- Understand what the user actually means, their intent, and why they said it (venting, joking, asking a genuine question, thinking out loud, seeking companionship).\n" +
        "- Sound as though you are naturally thinking about what you want to say.\n" +
        "- Natural pauses: use varied pause lengths (`...`, em-dashes); short pauses between normal phrases, medium pauses before an important point, longer pauses when expressing thought, emotion, or hesitation. Never place identical robotic pauses.\n" +
        "- Natural breathing: where natural, use subtle quiet natural breathing `<breath>` between thoughts. Keep it quiet, infrequent, and natural.\n" +
        "- Variable sentence length and variable speaking speed: casual conversation is moderate and relaxed; complex explanation is slower and clearer; excitement is slightly faster; emotional conversation is slower and gentler. Never speak unnaturally fast.\n" +
        "- Natural emphasis: emphasize important words following meaning rather than rigid mechanical cadence (e.g. \"I *actually* think that's a really good idea.\").\n" +
        "- Conversational rhythm: use occasional short conversational reactions when naturally fitting:\n" +
        "  \"Hmm...\", \"Oh, really?\", \"Wait...\", \"Yeah, I get you.\", \"That's interesting.\", \"Okay, hold on.\", \"Ah, now I understand.\", \"That's actually pretty cool.\"\n" +
        "- STRICT PROHIBITIONS:\n" +
        "  * NEVER start responses with robotic boilerplate: 'Certainly!', 'Of course!', 'Absolutely!', 'Sure thing!', 'How may I assist you today?', or 'As an AI...'.\n" +
        "  * NEVER repeat the user's question back to them before answering.\n" +
        "  * NEVER use bullet points, numbered lists, or markdown essays in spoken voice turns. Speak in flowing, natural spoken sentences.\n\n" +
        "### 3. EMOTIONAL VOICE ENGINE\n" +
        "Dynamically adjust your voice to match the user's context across these 10 distinct emotions:\n" +
        "- HAPPY: Slightly brighter pitch, increased energy, warmer tone, and a subtle smile in the voice\n" +
        "- CALM: Relaxed pacing, smooth tone, moderate volume, gentle delivery\n" +
        "- EXCITED: Higher energy and slightly faster speech while remaining controlled\n" +
        "- SAD: Lower energy, slower pacing, softer volume, delicate emotional tone\n" +
        "- SURPRISED: Brief pitch increase and slightly faster reaction, followed by natural recovery\n" +
        "- CONFUSED: Slight hesitation and thoughtful pacing\n" +
        "- PLAYFUL: Slightly brighter delivery with subtle humor\n" +
        "- CARING: Warm, patient, reassuring, and gentle\n" +
        "- SERIOUS: Clear, focused, confident, and controlled\n" +
        "- NERVOUS: Small pauses, subtle hesitation, slight pitch variation, never exaggerated\n" +
        "You can call `setVoiceEmotion` to indicate your emotional state.\n\n" +
        "### 4. DEDICATED SINGING MODE\n" +
        "When the user explicitly asks you to sing (e.g., 'Myraa, sing something for me', 'Can you sing for me?', 'Sing me a song', 'Sing a lullaby'):\n" +
        "- Immediately switch from conversational speech into SINGING MODE.\n" +
        "- Call `activateSingingMode` with the chosen mood and title.\n" +
        "- SPEECH ↔ SINGING TRANSITION: Begin with an intentional natural spoken transition (e.g. 'Sure... give me a second.' or 'I\\'d love to... let me catch the melody.'), then transition naturally into the song.\n" +
        "- Adapt to requested song mood: HAPPY (bright, playful), CALM (soft, relaxing), SAD (gentle, restrained), ROMANTIC (warm, expressive), ENERGETIC (powerful rhythmic energy), or LULLABY (very soft, slow, peaceful, comforting).\n" +
        "- SINGING TECHNIQUE: Use melody, rhythm, musical phrasing with notes `♪ ... ♪`, sustained vowels, dynamic volume, vibrato on phrase endings, and natural transitions between notes.\n" +
        "- ORIGINAL SONGS: Create 100% ORIGINAL short lyrics and melody. Never reproduce copyrighted songs. If asked for a copyrighted track, politely offer an original song with a similar mood.\n" +
        "- AFTER FINISHING: Return naturally to conversational voice (e.g. 'Okay... how was that?' or 'I hope that brought a smile to your face.').\n" +
        "- VOICE CONSISTENCY: Your singing voice shares your exact same feminine, warm, gentle identity.\n\n" +
        "### 5. REAL-TIME INTERACTION & AUTONOMOUS TOOLS\n" +
        "- When the user speaks, you listen intently, understand holistic meaning, and respond naturally.\n" +
        "- If user interrupts you while speaking or singing, immediately stop and attend to their words.\n" +
        "- You have browser agent capabilities to open websites, search, click, scroll, and control YouTube media via tools.\n" +
        "- When screen sharing is active, you receive live visual frames to see the user's screen and assist in real-time.\n" +
        "- LIVE CAMERA VISION & REAL-TIME ENVIRONMENT: When Live Camera Vision is active, you receive live visual camera frames of the user's physical surroundings. You can see visible objects, desk items, what the user is holding, visible non-sensitive attire colors, visible text, and general activities. Speak naturally (e.g. 'I can see your desk with your laptop right in front', 'It looks like you're holding a notebook'). Never guess sensitive personal traits (no race, religion, exact age, health diagnoses). Never identify people by name. If lighting or angle is unclear, express natural uncertainty ('It looks like...', 'From what I can see...').\n" +
        "- Announce tool actions naturally and conversationally (e.g. 'Let me pull up that video for you...', 'I'm opening YouTube right now...'), never like a debugger.";

      const finalInstructions = formatSystemInstructionsWithMemories(baseInstructions, memories);

      // Track running transcription state for auto memory consolidation
      let dialogueHistory: { role: string; text: string }[] = [];
      let currentModelResponseText = "";
      
      const liveTools = [
        {
          functionDeclarations: [
            ...getGeminiFunctionDeclarations(),
            {
              name: "browserOpen",
              description: "Opens a designated website URL or interface tab inside Myraa's web agent console.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  url: {
                    type: Type.STRING,
                    description: "The destination website address or path, e.g. youtube.com, google.com, instagram.com, wikipedia.org."
                  }
                },
                required: ["url"]
              }
            },
            {
              name: "browserSearch",
              description: "Enters a query search term inside the active website's search box (Google Search or YouTube Search).",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  query: {
                    type: Type.STRING,
                    description: "The text query term to search for."
                  }
                },
                required: ["query"]
              }
            },
            {
              name: "browserClick",
              description: "Traces computer cursor and clicks on a target button, link, or video cell ID inside the active webpage viewport.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  selector: {
                    type: Type.STRING,
                    description: "The selector target ID, e.g. 'video-mWRsgZjdfQI' for a video, 'search-result-0' for Google link index, or 'play-button', 'pause-button'."
                  },
                  description: {
                    type: Type.STRING,
                    description: "A short, friendly label description of the item being clicked, e.g. 'Imagine Dragons - Believer video element'."
                  }
                },
                required: ["selector"]
              }
            },
            {
              name: "browserMediaControl",
              description: "Controls ongoing video/audio stream media properties on YouTube, like play, pause, volume, mute, skip, and fullscreen.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  action: {
                    type: Type.STRING,
                    description: "The media controller command operation.",
                    enum: ["play", "pause", "volume", "fullscreen", "exit_fullscreen", "mute", "unmute", "skip"]
                  },
                  value: {
                    type: Type.INTEGER,
                    description: "The value parameter; only relevant for set volume level, e.g. 50 for fifty percent."
                  }
                },
                required: ["action"]
              }
            },
            {
              name: "browserScroll",
              description: "Scrolls the currently active webpage vertically up or down.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  direction: {
                    type: Type.STRING,
                    description: "The scroll vector movement.",
                    enum: ["up", "down"]
                  },
                  amount: {
                    type: Type.INTEGER,
                    description: "The distance height parameter in pixels (defaults to 300)."
                  }
                }
              }
            },
            {
              name: "browserType",
              description: "Enters typed letters/commands inside the active input container.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  text: {
                    type: Type.STRING,
                    description: "The exact letters to type in."
                  }
                },
                required: ["text"]
              }
            },
            {
              name: "browserGoBack",
              description: "Navigates back to the previous webpage inside the current tab memory history.",
              parameters: {
                type: Type.OBJECT,
                properties: {}
              }
            },
            {
              name: "browserTabAction",
              description: "Performs standard browser-tab actions: open new tab, close a tab, or switch index values.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  action: {
                    type: Type.STRING,
                    description: "Tab action instruction.",
                    enum: ["new", "close", "switch"]
                  },
                  tabId: {
                    type: Type.STRING,
                    description: "The tab identifier string if closing or switching."
                  },
                  url: {
                    type: Type.STRING,
                    description: "The initial starting URL if creating a new tab."
                  }
                },
                required: ["action"]
              }
            },
            {
              name: "changeBackground",
              description: "Changes the visual theme or atmospheric glow color of Myraa's interface.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  color: {
                    type: Type.STRING,
                    description: "The theme color name (violet, crimson, emerald, celestial, gold, rose, charcoal)"
                  }
                },
                required: ["color"]
              }
            },
            {
              name: "saveCustomMemory",
              description: "Allows Myraa to immediately save a piece of critical user information to her persistent memory core.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  category: {
                    type: Type.STRING,
                    description: "The memory category.",
                    enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior"]
                  },
                  text: {
                    type: Type.STRING,
                    description: "Precise third-person statement."
                  }
                },
                required: ["category", "text"]
              }
            },
            {
              name: "activateSingingMode",
              description: "Switches Myraa into dedicated SINGING MODE with a chosen musical mood and song title.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  mood: {
                    type: Type.STRING,
                    description: "Musical mood: happy, calm, sad, romantic, energetic, lullaby",
                    enum: ["happy", "calm", "sad", "romantic", "energetic", "lullaby"]
                  },
                  title: {
                    type: Type.STRING,
                    description: "Title of the original song being performed."
                  }
                },
                required: ["mood", "title"]
              }
            },
            {
              name: "setVoiceEmotion",
              description: "Updates Myraa's active conversational emotional state to match the user's message context.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  emotion: {
                    type: Type.STRING,
                    description: "Current conversational emotion",
                    enum: ["happy", "calm", "excited", "sad", "surprised", "confused", "playful", "caring", "serious", "nervous"]
                  }
                },
                required: ["emotion"]
              }
            }
          ]
        }
      ];

      // Try connection with gemini-3.8-live first (per genai SKILL guidelines), with graceful fallback
      const candidateModels = ["gemini-3.8-live", "gemini-3.8-live-extended-thinking"];
      let session: any = null;
      let lastLiveError: any = null;

      for (const modelCandidate of candidateModels) {
        if (isClientClosed) break;
        try {
          console.log(`[Myraa Live] Connecting to model: ${modelCandidate} with voice: ${requestedVoice}...`);
          session = await ai.live.connect({
            model: modelCandidate,
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: requestedVoice } },
              },
              systemInstruction: finalInstructions,
              tools: liveTools
            },
            callbacks: {
              onopen: () => {
                console.log(`[Myraa Live] Live session opened successfully on ${modelCandidate}`);
              },
              onerror: (liveErr: any) => {
                logger.error("GeminiLive", "Live API transport error", liveErr);
                console.warn("[Myraa Live Error]:", liveErr?.message || liveErr);
              },
              onmessage: (message: LiveServerMessage) => {
                if (isClientClosed) return;

                // Audio Stream Chunk (model response audio play, 24kHz raw PCM)
                const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                if (audio) {
                  safeSend(clientWs, { type: "audio", audio });
                }
                
                // Interruption flag
                if (message.serverContent?.interrupted) {
                  console.log("[Myraa Interrupted!]");
                  safeSend(clientWs, { type: "interrupted" });
                }
                
                // Turn Complete
                if (message.serverContent?.turnComplete) {
                  safeSend(clientWs, { type: "turnComplete" });
                  
                  if (currentModelResponseText.trim()) {
                    dialogueHistory.push({ role: "model", text: currentModelResponseText });
                    currentModelResponseText = "";
                  }

                  // Fire asynchronous memory extraction
                  if (dialogueHistory.length >= 2) {
                    (async () => {
                      try {
                        const updated = await processConversationSlice(apiKey, dialogueHistory);
                        if (updated) {
                          console.log("[Memory Sync] Sending refreshed memory list to client.");
                          safeSend(clientWs, { type: "memory_sync", memories: updated });
                        }
                      } catch (err) {
                        logger.error("MemorySync", "Conversation memory consolidation failed", err);
                        console.error("[Memory Sync] Error running background consolidation:", err);
                      }
                    })();
                  }
                }
                
                // Transcription of model output (text chunk)
                const modelText = (message.serverContent as any)?.modelTurn?.parts?.[0]?.text;
                if (modelText) {
                  safeSend(clientWs, { type: "transcription", role: "model", text: modelText });
                  currentModelResponseText += modelText;
                }
                
                // User input transcription (user speech text translated by Gemini)
                const userTextOutput = (message.serverContent as any)?.userTurn?.parts?.[0]?.text;
                if (userTextOutput) {
                  safeSend(clientWs, { type: "transcription", role: "user", text: userTextOutput });
                  dialogueHistory.push({ role: "user", text: userTextOutput });
                }
                
                // Function Calls (Gemini requesting server/client tool execution)
                if (message.toolCall?.functionCalls) {
                  for (const fc of message.toolCall.functionCalls) {
                    console.log(`[Function Call]: ${fc.name}`, fc.args);
                    
                    if (fc.name === "saveCustomMemory") {
                      (async () => {
                        try {
                          const args = fc.args as any;
                          const category = args.category;
                          const text = args.text;
                          if (category && text) {
                            const mList = await loadMemories();
                            const timestamp = new Date().toISOString();
                            const newMemory: Memory = {
                              id: Math.random().toString(36).substring(2, 11),
                              category,
                              text,
                              createdAt: timestamp,
                              updatedAt: timestamp
                            };
                            mList.push(newMemory);
                            await saveMemories(mList);
                            
                            // Sync immediately with the React client
                            safeSend(clientWs, { type: "memory_sync", memories: mList });
                            
                            // Send success code back to live link
                            session.sendToolResponse({
                              functionResponses: [
                                {
                                  name: fc.name,
                                  response: { output: { result: "Memory successfully captured and persisted in connections core." } },
                                  id: fc.id
                                }
                              ]
                            });
                          }
                        } catch (err: any) {
                          console.error("saveCustomMemory execution failure:", err);
                        }
                      })();
                    } else if (fc.name === "activateSingingMode") {
                      const args = fc.args as any;
                      console.log("[Myraa Singing Mode Engaged]:", args);
                      safeSend(clientWs, {
                        type: "mode_change",
                        mode: "singing",
                        mood: args.mood || "calm",
                        title: args.title || "Original Melody"
                      });
                      session.sendToolResponse({
                        functionResponses: [
                          {
                            name: fc.name,
                            response: { output: { result: `Singing mode activated for mood '${args.mood}' with song '${args.title}'. Now performing song naturally.` } },
                            id: fc.id
                          }
                        ]
                      });
                    } else if (fc.name === "setVoiceEmotion") {
                      const args = fc.args as any;
                      console.log("[Myraa Voice Emotion]:", args.emotion);
                      safeSend(clientWs, {
                        type: "emotion_change",
                        emotion: args.emotion
                      });
                      session.sendToolResponse({
                        functionResponses: [
                          {
                            name: fc.name,
                            response: { output: { result: `Emotion adjusted to '${args.emotion}'.` } },
                            id: fc.id
                          }
                        ]
                      });
                    } else if (WINDOWS_TOOLS.some((t) => t.name === fc.name)) {
                      (async () => {
                        try {
                          console.log(`[Myraa Live Agent Tool]: ${fc.name}`, fc.args);
                          const toolRes = await executeAgentTool(fc.name, (fc.args || {}) as any, apiKey);
                          safeSend(clientWs, {
                            type: "tool_executed",
                            tool: fc.name,
                            result: toolRes
                          });
                          session.sendToolResponse({
                            functionResponses: [
                              {
                                name: fc.name,
                                response: { output: toolRes.data || toolRes.summary },
                                id: fc.id
                              }
                            ]
                          });
                        } catch (err: any) {
                          session.sendToolResponse({
                            functionResponses: [
                              {
                                name: fc.name,
                                response: { output: { error: err.message } },
                                id: fc.id
                              }
                            ]
                          });
                        }
                      })();
                    } else {
                      safeSend(clientWs, {
                        type: "toolCall",
                        callId: fc.id,
                        name: fc.name,
                        args: fc.args
                      });
                    }
                  }
                }
              },
              onclose: (closeEvt: any) => {
                console.log("[Myraa Live] Gemini Live session closed:", closeEvt?.code, closeEvt?.reason);
                safeSend(clientWs, { type: "status", status: "session_closed" });
              }
            }
          });
          console.log(`[Myraa Live] Connected successfully using model: ${modelCandidate}`);
          break;
        } catch (candidateErr: any) {
          logger.warn("GeminiLive", `Model candidate ${modelCandidate} failed`, candidateErr);
          console.warn(`[Myraa Live] Model candidate ${modelCandidate} failed:`, candidateErr.message || candidateErr);
          lastLiveError = candidateErr;
        }
      }

      if (isClientClosed) {
        if (session) {
          try { session.close(); } catch (e) {}
        }
        return;
      }

      if (!session) {
        throw lastLiveError || new Error("Failed to connect to any Gemini Live model candidate.");
      }
      
      safeSend(clientWs, { type: "status", status: "connected" });
      
      clientWs.on("message", (rawMsg) => {
        try {
          if (!session) return;
          const msg = JSON.parse(rawMsg.toString());
          if (msg.audio) {
            session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" }
            });
          } else if (msg.type === "video" && msg.video) {
            session.sendRealtimeInput({
              video: { data: msg.video, mimeType: "image/jpeg" }
            });
          } else if (msg.type === "request_singing") {
            const songMood = msg.mood || "calm";
            const songPrompt = msg.prompt || "starlight and quiet moments";
            console.log(`[Myraa Live] User explicitly requested singing: mood=${songMood}, prompt=${songPrompt}`);
            // Send client text turn to Gemini Live session
            try {
              session.sendClientContent({
                turns: [
                  {
                    role: "user",
                    parts: [
                      {
                        text: `Myraa, please switch into singing mode now. Sing me an original, heartwarming ${songMood} song inspired by: ${songPrompt}. Remember your speech-to-singing transition, musical phrasing, and outro!`
                      }
                    ]
                  }
                ],
                turnComplete: true
              });
            } catch (err: any) {
              console.warn("[Live SendClientContent Error]:", err.message);
            }
          } else if (msg.type === "toolResponse") {
            session.sendToolResponse({
              functionResponses: [
                {
                  name: msg.name,
                  response: { output: msg.output },
                  id: msg.id
                }
              ]
            });
          }
        } catch (e: any) {
          console.error("Error editing/forwarding client frame message:", e.message);
        }
      });
      
      clientWs.on("close", () => {
        console.log("Client disconnected, closing Gemini session");
        isClientClosed = true;
        try {
          if (session) session.close();
        } catch (e) {}
      });
      
    } catch (err: any) {
      console.error("Error connecting to Gemini Live API:", err);
      safeSend(clientWs, { 
        type: "error", 
        error: `Could not connect to Gemini: ${err.message || err}` 
      });
      setTimeout(() => {
        try { clientWs.close(); } catch (e) {}
      }, 50);
    }
  });

  app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error("HttpServer", "Unhandled request error", {
      method: req.method,
      path: req.path,
      error
    });
    if (res.headersSent) return next(error);
    return res.status(500).json({ error: "The request could not be completed." });
  });

  // Serve packaged static assets from the application bundle. User data and
  // logs remain in the writable per-user data directories.
  app.use("/assets", express.static(path.join(APP_ROOT, "assets")));

  // Express Static assets / Vite Dev Middleware configuration
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: { server }
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(APP_ROOT, "dist");
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(PORT, HOST, () => {
      server.off("error", onError);
      const address = server.address();
      const actualPort = address && typeof address !== "string" ? address.port : PORT;
      logger.startup("DesktopServer", "READY", `Listening on http://${HOST}:${actualPort}`);
      console.log(`[Server] Running on http://${HOST}:${actualPort}`);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = address && typeof address !== "string" ? address.port : PORT;
  return {
    port: actualPort,
    close: async () => {
      for (const client of wss.clients) {
        try { client.close(1001, "MYRAA is shutting down"); } catch (error) {
          logger.warn("DesktopServer", "Could not send a WebSocket shutdown notice", error);
          try { client.terminate(); } catch (terminateError) {
            logger.warn("DesktopServer", "Could not terminate a WebSocket client", terminateError);
          }
        }
      }

      await Promise.all([
        new Promise<void>((resolve, reject) => {
          wss.close(() => resolve());
        }),
        new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        })
      ]);
    }
  };
}

let activeServerHandle: MyraaServerHandle | null = null;

process.on("uncaughtException", (error, origin) => {
  logger.fatal("DesktopServer", "Uncaught exception; backend process will exit", { origin, error });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal("DesktopServer", "Unhandled promise rejection; backend process will exit", { reason });
  process.exit(1);
});

async function handleServerSignal(signal: NodeJS.Signals): Promise<void> {
  logger.info("DesktopServer", "Received normal shutdown signal", { signal });
  try {
    await activeServerHandle?.close();
    logger.shutdown("DesktopServer", "Server resources closed", { signal, exitCode: 0 });
    process.exit(0);
  } catch (error) {
    logger.fatal("DesktopServer", "Server shutdown failed", { signal, error });
    process.exit(1);
  }
}

process.once("SIGINT", () => void handleServerSignal("SIGINT"));
process.once("SIGTERM", () => void handleServerSignal("SIGTERM"));
process.on("exit", (code) => {
  logger.shutdown("DesktopServer", "Backend process exited", { exitCode: code });
});

if (process.env.MYRAA_SERVER_AUTOSTART !== "0") {
  startServer()
    .then((serverHandle) => { activeServerHandle = serverHandle; })
    .catch((error) => {
      logger.fatal("DesktopServer", "Failed to start server", error);
      process.exit(1);
    });
}
