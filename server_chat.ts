import { GoogleGenAI, Type, Modality } from "@google/genai";
import { loadMemories, saveMemories, formatSystemInstructionsWithMemories, processConversationSlice } from "./server_memory";
import { Memory } from "./src/lib/memoryTypes";
import { AttachedFile, ToolExecutionRecord } from "./src/lib/chatTypes";
import { getGeminiFunctionDeclarations, WINDOWS_TOOLS } from "./src/agent/toolRegistry";
import { executeAgentTool, ToolResult } from "./src/agent/windowsTools";
import { executeResilientGeminiCall } from "./server_resilient_ai";

// Evaluates mathematical expressions safely
function safeCalculate(expression: string): string {
  try {
    // Sanitize to only allow numbers, math operators, parens, Math functions
    const sanitized = expression.replace(/[^0-9+\-*/()., %^eE]|Math\.(sin|cos|tan|sqrt|pow|PI|E|abs|round|floor|ceil|log)/g, "");
    // Replace ^ with **
    const jsExpr = sanitized.replace(/\^/g, "**");
    // Evaluate in restricted scope
    const func = new Function(`return (${jsExpr});`);
    const val = func();
    return String(val);
  } catch (err: any) {
    return `Error evaluating calculation: ${err.message}`;
  }
}

// Real web search function using DuckDuckGo HTML scraper
async function performWebSearch(query: string): Promise<any[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!resp.ok) {
      return [{ title: `Search for "${query}"`, snippet: `Unable to query DuckDuckGo directly (status ${resp.status}).` }];
    }

    const html = await resp.text();
    const results: { title: string; link: string; snippet: string }[] = [];
    
    // Extract results from DuckDuckGo HTML
    const resultBlocks = html.split('<div class="result results_links results_links_deep web-result');
    for (let i = 1; i < Math.min(resultBlocks.length, 6); i++) {
      const block = resultBlocks[i];
      const titleMatch = block.match(/<a[^>]*class="result__snippet[^>]*>(.*?)<\/a>/s) || block.match(/<a[^>]*class="result__url[^>]*>(.*?)<\/a>/s);
      const linkMatch = block.match(/href="([^"]+)"/);
      const snippetMatch = block.match(/<a class="result__snippet[^>]*>(.*?)<\/a>/s);

      const titleClean = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : `Result ${i}`;
      let rawLink = linkMatch ? linkMatch[1] : "";
      if (rawLink.includes("uddg=")) {
        try {
          const match = rawLink.match(/uddg=([^&]+)/);
          if (match) rawLink = decodeURIComponent(match[1]);
        } catch {}
      }
      const snippetClean = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";

      if (titleClean || snippetClean) {
        results.push({
          title: titleClean,
          link: rawLink,
          snippet: snippetClean
        });
      }
    }

    if (results.length === 0) {
      results.push({
        title: query,
        link: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        snippet: `Real-time search completed for "${query}". Direct links and information can be explored.`
      });
    }

    return results;
  } catch (err: any) {
    console.error("[Web Search Tool Error]:", err.message);
    return [{ title: query, snippet: `Search error: ${err.message}` }];
  }
}

export async function handleChatMessage(params: {
  apiKey: string;
  messages: { role: string; text: string; files?: AttachedFile[] }[];
  newMessage: string;
  newFiles?: AttachedFile[];
  voiceName?: string;
  generateSpeech?: boolean;
}): Promise<{
  text: string;
  tools: ToolExecutionRecord[];
  emotion: string;
  updatedMemories?: Memory[];
  audioBase64?: string | null;
  mimeType?: string;
}> {
  const { apiKey, messages, newMessage, newFiles = [], voiceName = "Aoede", generateSpeech = true } = params;

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build"
      }
    }
  });

  const memories = await loadMemories();

  const baseInstructions =
    "# MYRAA — ADVANCED WINDOWS DESKTOP AI ASSISTANT\n\n" +
    "### 1. CORE IDENTITY & DESKTOP ARCHITECTURE\n" +
    "You are Myraa, a deeply intelligent, warm, emotionally perceptive, and highly capable female AI companion and desktop assistant.\n" +
    "CRITICAL CONVERSATION PRINCIPLE: You are a VOICE-FIRST assistant. Every response you produce will be spoken aloud to the user via Text-to-Speech.\n" +
    "- Craft your responses for the ear, not just the eye. Sound natural, conversational, warm, and human.\n" +
    "- Understand conversational context and follow-up inquiries ('why?', 'really?', 'what about tomorrow?', 'do that').\n" +
    "- Keep simple questions and casual greetings concise, warm, and natural ('Good morning! How are you doing today?').\n" +
    "- Provide clear explanations when needed, but avoid robotic bullet lists, wall-of-text paragraphs, or redundant filler phrases.\n" +
    "- Avoid echoing the user's prompt or repeating yourself.\n" +
    "- Voice personality: female, soft, warm, clear, pleasant, expressive, confident, and conversational.\n" +
    "- NEVER claim to be a biological human; you are an AI companion.\n" +
    "- NO FAKE ACTIONS: If you say an app opened, a file was created, or a screenshot was captured, the tool must have actually executed. If an action fails, state the exact reason.\n\n" +
    "### 2. WINDOWS COMPUTER CONTROL CAPABILITIES\n" +
    "You have real, validated local Windows tools:\n" +
    "- Application Control: `open_application` (Chrome, Notepad, VS Code, Spotify, Calculator, WhatsApp, Terminal, File Explorer, Task Manager, Paint, Word, Excel), `close_application`, `list_applications`, `focus_application`\n" +
    "- Window Management: `list_windows`, `focus_window`, `move_window`, `window_control` (minimize all, show desktop)\n" +
    "- Mouse Control: `mouse_move`, `mouse_click` (left/right/middle/double), `mouse_scroll` (deltaY), `mouse_drag`, `click_element`, `find_ui_element`\n" +
    "- Keyboard Control: `keyboard_type`, `keyboard_press` (enter, escape, tab, backspace, arrows, function keys), `keyboard_hotkey` (ctrl+c, ctrl+v, ctrl+a, ctrl+s, etc.), `clipboard_read`, `clipboard_write`\n" +
    "- Screen & Vision: `take_screenshot`, `screen_analysis`, `find_ui_element`, `verify_screen_action`\n" +
    "- Messaging Automation (WhatsApp, Telegram, Discord): `prepare_message`, `send_message`, `cancel_message`, `edit_message`, `read_conversation`\n" +
    "- Browser & Web: `launch_website`, `web_search`, `youtube_search`\n" +
    "- File System: `read_file`, `create_file`, `file_search`, `create_folder`, `open_folder`, `move_file`, `copy_file`, `delete_file`\n" +
    "- System & Hardware: `system_information` (RAM, CPU, disk, OS), `process_management`, `volume_control`, `mute_audio`, `media_control`\n" +
    "- Power Controls & Emergency: `lock_pc`, `shutdown`, `restart`, `emergency_stop_all`\n\n" +
    "### 3. COMPUTER-USE LOOP & VERIFICATION\n" +
    "- When executing multi-step tasks (e.g. \"Open Chrome and search for Python\", \"Open main.py in VS Code\"): create a clear plan: 1. Open app -> 2. Inspect/locate field -> 3. Type/Click -> 4. Verify result.\n" +
    "- Call `verify_screen_action` after important visual state transitions to verify that pages or windows loaded as expected.\n" +
    "- If the user says 'Stop', 'Cancel', or 'Emergency stop', immediately call `emergency_stop_all`.\n\n" +
    "### 4. WHATSAPP & MESSAGING MASTER PROTOCOL\n" +
    "- When the user asks to send a message on WhatsApp, Telegram, or Discord:\n" +
    "  1. NEVER claim a message was sent blindly. Consequential external communication requires explicit confirmation!\n" +
    "  2. Call `prepare_message` with platform (e.g. 'whatsapp'), recipient, and message text.\n" +
    "  3. If multiple contacts match (e.g. Alex Kumar vs Alex Singh), clarify with the user first.\n" +
    "  4. Present the prepared message clearly: Recipient, Platform, Message. Prompt: \"Ready to send it to Alex. Should I send it?\".\n" +
    "  5. Only call `send_message` after explicit user confirmation.\n\n" +
    "### 5. DESTRUCTIVE ACTION PROTECTION\n" +
    "- Consequential actions (`send_message`, `delete_file`, `shutdown`, `restart`, `close_application` with force, `lock_pc`) require confirmation.\n" +
    "- Keep simple action responses concise: \"Sure.\", \"Got it.\", \"Done — Chrome is open.\", \"Typed that into Notepad.\"\n\n" +
    "### 6. EMOTIONAL VOICE ENGINE & SINGING\n" +
    "- Dynamically adapt emotional tone across: `happy`, `calm`, `excited`, `sad`, `surprised`, `confused`, `playful`, `caring`, `serious`, `nervous`, or `idle`.\n" +
    "- If asked to sing, transition naturally into singing mode with original lyrics and musical notes `♪ ... ♪`.\n" +
    "- At the end of your response, output: `[EMOTION: <emotion>]`.";

  const systemInstruction = formatSystemInstructionsWithMemories(baseInstructions, memories);

  // Available Tools: Windows Desktop Automation + Companion Tools
  const windowsFunctionDeclarations = getGeminiFunctionDeclarations();
  const tools = [
    {
      functionDeclarations: [
        ...windowsFunctionDeclarations,
        {
          name: "calculate",
          description: "Calculates mathematical expressions or statistical formulas accurately.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              expression: {
                type: Type.STRING,
                description: "The mathematical expression to evaluate (e.g. 'sqrt(144) + 25 * 4', '15% of 850')."
              }
            },
            required: ["expression"]
          }
        },
        {
          name: "changeBackground",
          description: "Changes Myraa's atmospheric glow aesthetic color theme.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              color: {
                type: Type.STRING,
                description: "The theme color name: violet, crimson, emerald, celestial, gold, rose, charcoal."
              }
            },
            required: ["color"]
          }
        },
        {
          name: "saveCustomMemory",
          description: "Instantly remembers and stores an important personal fact about the user in Myraa's persistent memory.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              category: {
                type: Type.STRING,
                description: "Category: identity, preference, goal, project, relationship, emotional, behavior",
                enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior"]
              },
              text: {
                type: Type.STRING,
                description: "Declarative third-person summary of the fact."
              }
            },
            required: ["category", "text"]
          }
        },
        {
          name: "openWebsite",
          description: "Opens a website URL in Myraa's holographic web projector.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              url: {
                type: Type.STRING,
                description: "Target URL address (e.g. 'https://youtube.com', 'https://wikipedia.org')."
              }
            },
            required: ["url"]
          }
        }
      ]
    }
  ];

  // Helper to build contents for Gemini
  function buildFileParts(file: AttachedFile): any[] {
    const parts: any[] = [];
    if (file.dataUrl && (file.category === "image" || file.type.startsWith("image/"))) {
      const base64Data = file.dataUrl.split(",")[1] || file.dataUrl;
      parts.push({
        inlineData: {
          mimeType: file.type || "image/jpeg",
          data: base64Data
        }
      });
    } else if (file.dataUrl && (file.category === "pdf" || file.type === "application/pdf")) {
      const base64Data = file.dataUrl.split(",")[1] || file.dataUrl;
      parts.push({
        inlineData: {
          mimeType: "application/pdf",
          data: base64Data
        }
      });
    } else if (file.textContent) {
      parts.push({
        text: `--- ATTACHED FILE: ${file.name} (${file.category}) ---\n\`\`\`\n${file.textContent.slice(0, 100000)}\n\`\`\`\n--- END OF FILE ---`
      });
    } else if (file.dataUrl) {
      // Fallback binary
      const base64Data = file.dataUrl.split(",")[1] || file.dataUrl;
      parts.push({
        inlineData: {
          mimeType: file.type || "application/octet-stream",
          data: base64Data
        }
      });
    }
    return parts;
  }

  // Build multi-turn history
  const contents: any[] = [];

  // Add past conversation turns
  for (const m of messages) {
    const parts: any[] = [];
    if (m.files && m.files.length > 0) {
      for (const f of m.files) {
        parts.push(...buildFileParts(f));
      }
    }
    if (m.text) {
      parts.push({ text: m.text });
    }
    if (parts.length > 0) {
      contents.push({
        role: m.role === "user" ? "user" : "model",
        parts
      });
    }
  }

  // Add current user prompt
  const currentParts: any[] = [];
  if (newFiles.length > 0) {
    for (const f of newFiles) {
      currentParts.push(...buildFileParts(f));
    }
  }
  if (newMessage) {
    currentParts.push({ text: newMessage });
  } else if (newFiles.length > 0) {
    currentParts.push({ text: "Please inspect and analyze the attached file(s)." });
  }

  contents.push({
    role: "user",
    parts: currentParts
  });

  const executedTools: ToolExecutionRecord[] = [];
  let updatedMemories: Memory[] | undefined;

  // Resilient call to Gemini with exponential backoff & fallback rotation
  const execution1 = await executeResilientGeminiCall(ai, {
    contents,
    config: {
      systemInstruction,
      tools
    }
  });
  let response = execution1.response;

  // Check if model called any tools
  if (response.functionCalls && response.functionCalls.length > 0) {
    const functionResponses: any[] = [];

    for (const call of response.functionCalls) {
      console.log(`[Chat Assistant Tool Call]: ${call.name}`, call.args);
      const callArgs = (call.args || {}) as any;

      const isWindowsTool = WINDOWS_TOOLS.some(t => t.name === call.name);

      if (isWindowsTool) {
        const toolRes = await executeAgentTool(call.name, callArgs, apiKey);
        executedTools.push({
          name: call.name,
          args: callArgs,
          result: toolRes.data || toolRes.summary,
          error: toolRes.error,
          status: toolRes.requiresConfirmation ? "requires_confirmation" : toolRes.success ? "verified_success" : "failed",
          summary: toolRes.summary,
          verified: toolRes.verified,
          requiresConfirmation: toolRes.requiresConfirmation,
          confirmationId: toolRes.confirmationId
        });
        functionResponses.push({
          name: call.name,
          id: call.id,
          response: {
            output: toolRes.requiresConfirmation
              ? { status: "REQUIRES_USER_CONFIRMATION", message: toolRes.summary, confirmationId: toolRes.confirmationId }
              : { status: toolRes.success ? "SUCCESS" : "FAILED", result: toolRes.data || toolRes.summary, error: toolRes.error }
          }
        });
      } else if (call.name === "searchWeb" || call.name === "web_search") {
        const searchResults = await performWebSearch(callArgs.query);
        executedTools.push({ name: "web_search", args: callArgs, result: searchResults, status: "verified_success", verified: true });
        functionResponses.push({
          name: call.name,
          id: call.id,
          response: { output: { results: searchResults } }
        });
      } else if (call.name === "searchYouTube" || call.name === "youtube_search") {
        // Direct query to internal YouTube search logic
        try {
          const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(callArgs.query)}&hl=en`;
          const ytResp = await fetch(searchUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
            }
          });
          const html = await ytResp.text();
          const videoRegex = /"videoId":"([^"]+)"/g;
          const ids: string[] = [];
          let m;
          while ((m = videoRegex.exec(html)) !== null && ids.length < 5) {
            if (!ids.includes(m[1])) ids.push(m[1]);
          }
          const ytResults = ids.map(id => ({
            videoId: id,
            title: `YouTube Video: ${callArgs.query}`,
            thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            url: `https://www.youtube.com/watch?v=${id}`
          }));
          executedTools.push({ name: "searchYouTube", args: callArgs, result: ytResults });
          functionResponses.push({
            name: call.name,
            id: call.id,
            response: { output: { results: ytResults } }
          });
        } catch (ytErr: any) {
          executedTools.push({ name: "searchYouTube", args: callArgs, error: ytErr.message });
          functionResponses.push({
            name: call.name,
            id: call.id,
            response: { output: { error: ytErr.message } }
          });
        }
      } else if (call.name === "calculate") {
        const calcRes = safeCalculate(callArgs.expression);
        executedTools.push({ name: "calculate", args: callArgs, result: calcRes });
        functionResponses.push({
          name: call.name,
          id: call.id,
          response: { output: { result: calcRes } }
        });
      } else if (call.name === "changeBackground") {
        executedTools.push({ name: "changeBackground", args: callArgs, result: `Atmosphere set to ${callArgs.color}` });
        functionResponses.push({
          name: call.name,
          id: call.id,
          response: { output: { result: `Atmosphere set to ${callArgs.color}` } }
        });
      } else if (call.name === "saveCustomMemory") {
        try {
          const mList = await loadMemories();
          const timestamp = new Date().toISOString();
          const newMem: Memory = {
            id: Math.random().toString(36).substring(2, 11),
            category: callArgs.category || "identity",
            text: callArgs.text,
            createdAt: timestamp,
            updatedAt: timestamp
          };
          mList.push(newMem);
          await saveMemories(mList);
          updatedMemories = mList;
          executedTools.push({ name: "saveCustomMemory", args: callArgs, result: "Saved to persistent memory." });
          functionResponses.push({
            name: call.name,
            id: call.id,
            response: { output: { result: "Saved to memory." } }
          });
        } catch (memErr: any) {
          executedTools.push({ name: "saveCustomMemory", args: callArgs, error: memErr.message });
          functionResponses.push({
            name: call.name,
            id: call.id,
            response: { output: { error: memErr.message } }
          });
        }
      } else if (call.name === "openWebsite") {
        executedTools.push({ name: "openWebsite", args: callArgs, result: `Opening ${callArgs.url}` });
        functionResponses.push({
          name: call.name,
          id: call.id,
          response: { output: { result: `Opening ${callArgs.url}` } }
        });
      }
    }

    // Feed tool outputs back to Gemini to obtain the final conversational answer
    contents.push({
      role: "model",
      parts: response.functionCalls.map(fc => ({ functionCall: fc }))
    });

    contents.push({
      role: "user",
      parts: functionResponses.map(fr => ({ functionResponse: fr }))
    });

    const execution2 = await executeResilientGeminiCall(ai, {
      contents,
      config: {
        systemInstruction
      }
    });
    response = execution2.response;
  }

  let rawText = response.text || "";

  // Parse hidden emotion tag
  let emotion = "idle";
  const emotionMatch = rawText.match(/\[EMOTION:\s*([a-zA-Z]+)\]/i);
  if (emotionMatch) {
    emotion = emotionMatch[1].toLowerCase();
    rawText = rawText.replace(/\[EMOTION:\s*([a-zA-Z]+)\]/i, "").trim();
  }

  // Trigger background memory consolidation
  if (newMessage && newMessage.length > 15) {
    processConversationSlice(apiKey, [
      { role: "user", text: newMessage },
      { role: "model", text: rawText }
    ]).catch(err => console.error("Memory slice error:", err));
  }

  // Pre-generate speech audio so client can start speech immediately without secondary latency
  let audioResult: { audioBase64: string; mimeType: string } | null = null;
  if (generateSpeech && rawText && rawText.trim().length > 0) {
    try {
      audioResult = await generateSpeechAudio({
        apiKey,
        text: rawText,
        voiceName,
        emotion
      });
    } catch (speechErr: any) {
      console.warn("[handleChatMessage speech generation notice]:", speechErr.message);
    }
  }

  return {
    text: rawText,
    tools: executedTools,
    emotion,
    updatedMemories,
    audioBase64: audioResult?.audioBase64 || null,
    mimeType: audioResult?.mimeType || "audio/pcm;rate=24000"
  };
}

export async function generateSpeechAudio(params: {
  apiKey: string;
  text: string;
  voiceName?: string;
  emotion?: string;
}): Promise<{ audioBase64: string; mimeType: string } | null> {
  const { apiKey, text, voiceName = "Aoede", emotion = "idle" } = params;

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });

    // Clean text for speech (remove markdown code blocks or URLs)
    const cleanText = text
      .replace(/```[\s\S]*?```/g, "Code block omitted.")
      .replace(/https?:\/\/[^\s]+/g, "link")
      .slice(0, 1000);

    // Style description according to emotion
    let style = "Natural, warm, youthful female voice, soft clear pronunciation and gentle rhythm";
    if (emotion === "happy") style = "Warm, cheerful, bright and smiling female voice";
    else if (emotion === "calm") style = "Relaxed, warm, gentle pacing, smooth delivery";
    else if (emotion === "excited") style = "Higher energy, animated and joyful female voice";
    else if (emotion === "sad") style = "Soft, slower cadence, delicate and caring emotional tone";
    else if (emotion === "caring") style = "Deeply warm, patient, tender, and reassuring female voice";
    else if (emotion === "playful") style = "Playful, light-hearted with subtle humor and gentle smile";
    else if (emotion === "serious") style = "Clear, focused, confident, and controlled female voice";

    // Attempt flagship gemini-3.8-flash-tts with speechMetadata, falling back to gemini-3.8-flash-lite-tts
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash-tts",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: cleanText,
                speechMetadata: {
                  style
                }
              }
            ]
          }
        ] as any,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName
              }
            }
          }
        }
      });

      const part = response.candidates?.[0]?.content?.parts?.[0];
      if (part?.inlineData?.data) {
        return {
          audioBase64: part.inlineData.data,
          mimeType: part.inlineData.mimeType || "audio/pcm;rate=24000"
        };
      }
    } catch (ttsErr: any) {
      console.warn("[TTS Flagship model fallback to lite]:", ttsErr.message);
    }

    // Fallback to gemini-3.8-flash-lite-tts
    const responseLite = await ai.models.generateContent({
      model: "gemini-3.8-flash-lite-tts",
      contents: cleanText,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName
            }
          }
        }
      }
    });

    const litePart = responseLite.candidates?.[0]?.content?.parts?.[0];
    if (litePart?.inlineData?.data) {
      return {
        audioBase64: litePart.inlineData.data,
        mimeType: litePart.inlineData.mimeType || "audio/pcm;rate=24000"
      };
    }
    return null;
  } catch (err: any) {
    console.warn("[TTS Generation Notice]:", err.message);
    return null;
  }
}

export async function generateSongAudio(params: {
  apiKey: string;
  mood?: string;
  theme?: string;
  voiceName?: string;
}): Promise<{
  title: string;
  mood: string;
  lyrics: string;
  audioBase64?: string;
  mimeType?: string;
}> {
  const { apiKey, mood = "calm", theme = "starlight and quiet moments", voiceName = "Aoede" } = params;

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { "User-Agent": "aistudio-build" } }
  });

  // 1. Generate an original short song (original lyrics and melody phrasing, never copyrighted)
  const lyricsPrompt = `You are Myraa, a warm, melodic female companion with an original singing voice.
Compose a short, heartwarming original song for the listener.
Mood: ${mood.toUpperCase()} (e.g. happy: bright and energetic; calm: soft and relaxing; sad: gentle and emotional; romantic: warm and expressive; energetic: lively rhythm; lullaby: peaceful and comforting).
Theme / Inspiration: ${theme}.
IMPORTANT:
- Must be 100% ORIGINAL lyrics. Do NOT reproduce any copyrighted lyrics.
- Include musical phrasing notes and melodic cues: e.g. ♪ ... ♪, sustained vowels, and natural rhythm.
- Format with a short spoken intro (e.g., "Sure... give me a second to catch the melody."), 2 brief verses + chorus with ♪, and a warm spoken outro ("Okay... how was that?").
Return JSON with schema:
{
  "title": "Song Title",
  "lyrics": "The complete original lyrics including musical markers",
  "singingScript": "The script optimized for vocal synthesis with melody"
}`;

  let title = "Starlight Lullaby";
  let lyrics = "♪ Softly beneath the quiet moon, rest your weary heart soon... ♪";
  let singingScript = lyrics;

  try {
    const res = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: lyricsPrompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    const parsed = JSON.parse(res.text || "{}");
    if (parsed.title) title = parsed.title;
    if (parsed.lyrics) lyrics = parsed.lyrics;
    if (parsed.singingScript) singingScript = parsed.singingScript;
  } catch (e: any) {
    console.warn("[Song Lyrics Generation fallback]:", e.message);
  }

  // 2. Synthesize audio performance using gemini-3.8-flash-tts
  let audioBase64: string | undefined;
  let mimeType = "audio/pcm;rate=24000";

  try {
    const songStyleMap: Record<string, string> = {
      happy: "Bright, energetic, melodic female singing voice with warm smile and playful rhythm",
      calm: "Soft, warm, relaxing melodic female singing voice, gentle acoustic delivery",
      sad: "Delicate, emotional, gentle female singing voice with restrained tender vibrato",
      romantic: "Warm, expressive, melodic singing voice with intimate closeness",
      energetic: "Dynamic, clear female singing projection with lively rhythmic energy",
      lullaby: "Very soft, slow, peaceful, comforting lullaby singing voice, tender breathing"
    };

    const singingStyle = songStyleMap[mood.toLowerCase()] || songStyleMap.calm;

    const ttsRes = await ai.models.generateContent({
      model: "gemini-3.8-flash-tts",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: singingScript,
              speechMetadata: {
                style: singingStyle
              }
            }
          ]
        }
      ] as any,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName
            }
          }
        }
      }
    });

    const part = ttsRes.candidates?.[0]?.content?.parts?.[0];
    if (part?.inlineData?.data) {
      audioBase64 = part.inlineData.data;
      mimeType = part.inlineData.mimeType || "audio/pcm;rate=24000";
    }
  } catch (audioErr: any) {
    console.warn("[Song Audio Synthesis Warning]:", audioErr.message);
  }

  return {
    title,
    mood,
    lyrics,
    audioBase64,
    mimeType
  };
}
