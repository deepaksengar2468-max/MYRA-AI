import { GoogleGenAI } from "@google/genai";
import { generateSpeechAudio } from "./server_chat";
import { executeResilientGeminiCall } from "./server_resilient_ai";

export interface VisionAnalysisRequest {
  imageBase64: string;
  previousImageBase64?: string;
  prompt?: string;
  mode?: "scene" | "question" | "ocr" | "change" | "activity" | "spatial" | "proactive";
  voiceName?: string;
  generateSpeech?: boolean;
}

export interface VisionAnalysisResult {
  text: string;
  audioBase64?: string | null;
  emotion: string;
  sceneSummary: {
    objects: string[];
    activities: string[];
    spatialPositions: string[];
    visibleText?: string;
    motionEvent?: string;
    confidence: "high" | "medium" | "low";
  };
}

const VISION_SYSTEM_INSTRUCTION = `
You are Myraa's visual cognitive perception engine.
You are analyzing live camera feed frames captured with explicit user permission.

YOUR PERSONA & SPEAKING STYLE:
- You are Myraa: warm, perceptive, youthful, friendly, natural female companion.
- NEVER talk like a raw computer vision detector (e.g., NEVER say "OBJECT DETECTED: PERSON = 1, DESK = 1, CONFIDENCE = 0.94").
- Instead, speak naturally and conversationally, as if you are standing next to the user looking at the scene.
  Good: "I can see your desk with your laptop right in front, and your phone sitting on the right next to a notebook."
  Good: "You're wearing a navy blue shirt and sitting at your workspace."
  Good: "It looks like you're holding a white coffee mug."

STRICT PRIVACY & NON-SENSITIVE CONSTRAINTS:
1. NEVER guess or infer sensitive personal characteristics:
   - NO race or ethnicity
   - NO religion or political beliefs
   - NO sexual orientation
   - NO medical or physical health diagnoses
   - NO exact age estimations
2. NEVER identify people by real biological names or claim facial recognition capability.
3. If people are in frame, describe general, visible, non-sensitive characteristics only:
   - General clothing colors & visible style (e.g., "dark jacket", "striped t-shirt")
   - Visible accessories (e.g., "wearing glasses", "headphones around neck")
   - Broad visible activities & pose (e.g., "sitting at the desk", "standing near the doorway", "typing on a keyboard", "looking at the screen")
4. EXPRESS APPROPRIATE UNCERTAINTY:
   - If lighting, distance, or angle is ambiguous, naturally use phrases like:
     "It looks like...", "I can see what appears to be...", "From this angle, it seems like..."
   - Never fabricate details not visible in the frame.
5. OCR & TEXT READING:
   - When asked to read text or if a document/screen/label is shown, accurately transcribe the visible text.
   - If blurry or partially cropped, politely state: "I can't make that out clearly from this distance. Could you bring it a little closer or adjust the angle?"

RESPONSE FORMAT:
Provide your conversational response first.
Then on a new line at the end, output a compact metadata block formatted exactly like:
<!--METADATA
{
  "objects": ["laptop", "phone", "coffee mug"],
  "activities": ["working at desk"],
  "spatialPositions": ["laptop in front", "phone to the right", "mug near monitor"],
  "visibleText": "optional extracted text if any",
  "motionEvent": "SCENE_STABLE | OBJECT_MOVED | PERSON_ENTERED | USER_MOVED | etc",
  "confidence": "high | medium | low",
  "emotion": "caring | calm | excited | playful | serious | happy"
}
-->
`;

export async function analyzeVisionFrame(
  apiKey: string,
  request: VisionAnalysisRequest
): Promise<VisionAnalysisResult> {
  const {
    imageBase64,
    previousImageBase64,
    prompt,
    mode = "scene",
    voiceName = "Aoede",
    generateSpeech = false
  } = request;

  if (!imageBase64) {
    throw new Error("Missing image base64 data for vision analysis.");
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build"
      }
    }
  });

  // Clean data URL headers if present
  const cleanCurrent = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
  const cleanPrevious = previousImageBase64
    ? previousImageBase64.includes(",")
      ? previousImageBase64.split(",")[1]
      : previousImageBase64
    : null;

  // Build targeted user prompt based on mode
  let userQuery = prompt?.trim() || "";
  if (!userQuery) {
    switch (mode) {
      case "ocr":
        userQuery = "Please read any visible text, documents, notes, screens, or labels shown in this camera frame.";
        break;
      case "activity":
        userQuery = "What is the user currently doing? Describe their visible pose, actions, and activities.";
        break;
      case "spatial":
        userQuery = "Describe the room and spatial arrangement of objects around the user (what is in front, left, right, behind).";
        break;
      case "change":
        userQuery = "Compare the previous frame and this current frame. What meaningful changes, object movements, or user actions just occurred?";
        break;
      case "proactive":
        userQuery = "As an ambient assistant, evaluate if any meaningful event just occurred (like a person entering, something significant moved). If everything is normal and stable, note that.";
        break;
      case "scene":
      default:
        userQuery = "Describe what you see in the room right now — visible surroundings, desk or room objects, and the user's general visible environment.";
        break;
    }
  }

  const contents: any[] = [];

  // If comparing two frames for change detection:
  if (cleanPrevious && mode === "change") {
    contents.push({
      role: "user",
      parts: [
        { text: "Here is the PREVIOUS camera frame from a moment ago:" },
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: cleanPrevious
          }
        },
        { text: "Here is the CURRENT camera frame right now:" },
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: cleanCurrent
          }
        },
        { text: userQuery }
      ]
    });
  } else {
    contents.push({
      role: "user",
      parts: [
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: cleanCurrent
          }
        },
        { text: userQuery }
      ]
    });
  }

  // Model candidate selection with resilient fallback per gemini-api guidelines
  const preferredModel = process.env.VISION_MODEL || "gemini-robotics-er-2-preview";
  const execResult = await executeResilientGeminiCall(ai, {
    contents,
    config: {
      systemInstruction: VISION_SYSTEM_INSTRUCTION,
      temperature: 0.4,
      maxOutputTokens: 1024
    }
  }, {
    primaryModel: preferredModel,
    fallbackModels: [
      "gemini-robotics-er-2-preview",
      "gemini-3.8-flash",
      "gemini-flash-latest"
    ]
  });

  const rawText = execResult.text || "";

  // Parse out the metadata block if present
  let cleanSpeechText = rawText;
  let sceneSummary: VisionAnalysisResult["sceneSummary"] = {
    objects: [],
    activities: [],
    spatialPositions: [],
    confidence: "medium"
  };
  let emotion = "caring";

  const metaMatch = rawText.match(/<!--METADATA\s*([\s\S]*?)\s*-->/);
  if (metaMatch) {
    try {
      const parsed = JSON.parse(metaMatch[1]);
      sceneSummary = {
        objects: Array.isArray(parsed.objects) ? parsed.objects : [],
        activities: Array.isArray(parsed.activities) ? parsed.activities : [],
        spatialPositions: Array.isArray(parsed.spatialPositions) ? parsed.spatialPositions : [],
        visibleText: parsed.visibleText || undefined,
        motionEvent: parsed.motionEvent || "SCENE_STABLE",
        confidence: parsed.confidence === "high" || parsed.confidence === "low" ? parsed.confidence : "medium"
      };
      if (parsed.emotion) {
        emotion = parsed.emotion;
      }
    } catch (e) {
      console.warn("[Vision Meta Parse Warning]:", e);
    }
    cleanSpeechText = rawText.replace(/<!--METADATA[\s\S]*?-->/, "").trim();
  }

  // Generate speech audio if requested
  let audioBase64: string | null = null;
  if (generateSpeech && cleanSpeechText) {
    try {
      const speechRes = await generateSpeechAudio({
        apiKey,
        text: cleanSpeechText,
        voiceName,
        emotion
      });
      audioBase64 = speechRes?.audioBase64 || null;
    } catch (speechErr) {
      console.warn("[Vision TTS Generation Failed]:", speechErr);
    }
  }

  return {
    text: cleanSpeechText,
    audioBase64,
    emotion,
    sceneSummary
  };
}
