/**
 * Centralized Gemini AI Configuration and Resilient Execution Engine
 *
 * Requirements:
 * - Handle HTTP 503 / UNAVAILABLE gracefully with exponential backoff retry.
 * - Automatic model fallback chain: Primary -> Fallback 1 -> Fallback 2 -> Fallback 3.
 * - Separate API error categories (401 Auth, 403 Permission, 429 Quota, 503 Unavailable, Network).
 * - Never log sensitive API keys or user credentials.
 * - Compatible with @google/genai SDK model names.
 */

import { GoogleGenAI } from "@google/genai";

export interface AIModelConfig {
  primaryModel: string;
  fallbackModels: string[];
  maxRetriesPerModel: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_AI_CONFIG: AIModelConfig = {
  // Primary model: gemini-3.8-flash as standard modern model
  primaryModel: process.env.PRIMARY_MODEL || process.env.AI_MODEL || "gemini-3.8-flash",
  // Compatible verified fallback models in priority order
  // gemini-robotics-er-2-preview has full tool & multimodal capabilities and high availability
  fallbackModels: [
    "gemini-robotics-er-2-preview",
    "gemini-flash-latest",
    "gemini-3.1-flash-lite",
    "gemma-4-26b-a4b-it"
  ],
  maxRetriesPerModel: Number(process.env.MAX_RETRIES) || 2,
  initialBackoffMs: 600,
  maxBackoffMs: 2000,
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS) || 25000
};

export interface AIRequestOptions {
  contents: any[];
  config?: any;
  onStatusUpdate?: (status: string) => void;
}

export interface AIExecutionResult {
  text: string;
  response: any;
  modelUsed: string;
  retriesAttempted: number;
  fallbackUsed: boolean;
}

export interface ClassifiedAIError {
  type: "UNAVAILABLE_503" | "QUOTA_429" | "AUTH_401" | "PERMISSION_403" | "SERVER_500" | "NETWORK" | "UNKNOWN";
  statusCode: number;
  message: string;
  userFriendlyMessage: string;
  retryable: boolean;
  originalError?: any;
}

/**
 * Classifies an error from the Gemini API or network layer.
 * Does not expose raw JSON or internal stack traces to end users.
 */
export function classifyAIError(err: any): ClassifiedAIError {
  let rawMsg = (err?.message || "").toString();
  let statusCode = Number(err?.status || err?.statusCode || err?.code || 0);
  let errStatus = (err?.statusText || "").toString().toUpperCase();

  // Inspect if the error message is a stringified JSON (common in @google/genai ApiError)
  if (rawMsg.includes("{") && rawMsg.includes("}")) {
    try {
      const jsonStart = rawMsg.indexOf("{");
      const jsonEnd = rawMsg.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        const parsed = JSON.parse(rawMsg.slice(jsonStart, jsonEnd + 1));
        if (parsed?.error) {
          statusCode = Number(parsed.error.code || statusCode);
          errStatus = (parsed.error.status || errStatus).toUpperCase();
          if (parsed.error.message) {
            rawMsg = parsed.error.message;
          }
        }
      }
    } catch {
      // Keep rawMsg
    }
  }

  // Check 503 / UNAVAILABLE / High demand / Overloaded
  if (
    statusCode === 503 ||
    errStatus === "UNAVAILABLE" ||
    rawMsg.includes("503") ||
    rawMsg.includes("UNAVAILABLE") ||
    rawMsg.includes("high demand") ||
    rawMsg.includes("spikes in demand") ||
    rawMsg.includes("overloaded") ||
    rawMsg.includes("temporarily unavailable")
  ) {
    return {
      type: "UNAVAILABLE_503",
      statusCode: 503,
      message: "The AI model is temporarily experiencing high demand.",
      userFriendlyMessage: "My AI service is temporarily experiencing high traffic. Please try again in a moment.",
      retryable: true,
      originalError: err
    };
  }

  // Check 401 / Invalid API Key
  if (
    statusCode === 401 ||
    rawMsg.includes("401") ||
    rawMsg.includes("API_KEY_INVALID") ||
    rawMsg.includes("invalid api key") ||
    rawMsg.includes("API key not valid")
  ) {
    return {
      type: "AUTH_401",
      statusCode: 401,
      message: "API key is invalid or not configured properly.",
      userFriendlyMessage: "Gemini API key is invalid or expired. Please check your key in the Settings panel.",
      retryable: false,
      originalError: err
    };
  }

  // Check 429 / RESOURCE_EXHAUSTED / Rate limit
  if (
    statusCode === 429 ||
    errStatus === "RESOURCE_EXHAUSTED" ||
    rawMsg.includes("429") ||
    rawMsg.includes("RESOURCE_EXHAUSTED") ||
    rawMsg.includes("rate limit") ||
    rawMsg.includes("quota")
  ) {
    return {
      type: "QUOTA_429",
      statusCode: 429,
      message: "API rate limit or quota exceeded.",
      userFriendlyMessage: "AI request limit temporarily reached. Please give it a few seconds before asking again.",
      retryable: true,
      originalError: err
    };
  }

  // Check 403 / PERMISSION_DENIED
  if (
    statusCode === 403 ||
    errStatus === "PERMISSION_DENIED" ||
    rawMsg.includes("403") ||
    rawMsg.includes("PERMISSION_DENIED")
  ) {
    return {
      type: "PERMISSION_403",
      statusCode: 403,
      message: "Permission denied for this model or feature.",
      userFriendlyMessage: "Access permissions required for this model tier. Switching to a compatible model tier...",
      retryable: false,
      originalError: err
    };
  }

  // Check Network / Offline
  if (
    rawMsg.includes("fetch failed") ||
    rawMsg.includes("ECONNREFUSED") ||
    rawMsg.includes("ETIMEDOUT") ||
    rawMsg.includes("ENOTFOUND") ||
    rawMsg.includes("network") ||
    rawMsg.includes("offline")
  ) {
    return {
      type: "NETWORK",
      statusCode: 0,
      message: "Network connection error.",
      userFriendlyMessage: "Cannot reach network services right now. Please check your internet connection.",
      retryable: true,
      originalError: err
    };
  }

  // Remote 500 / Internal error
  if (statusCode >= 500) {
    return {
      type: "SERVER_500",
      statusCode: statusCode || 500,
      message: "Remote server encountered an error.",
      userFriendlyMessage: "Remote AI service encountered a temporary error. Retrying with backup model...",
      retryable: true,
      originalError: err
    };
  }

  return {
    type: "UNKNOWN",
    statusCode: statusCode || 500,
    message: rawMsg || "Unknown AI error occurred.",
    userFriendlyMessage: "My AI engine ran into a temporary issue. Please tap retry in a moment.",
    retryable: false,
    originalError: err
  };
}

/**
 * Resiliently generates content using Gemini, with:
 * - Exponential backoff on 503 / 429
 * - Seamless fallback model rotation
 * - Tool adaptation for text-only fallbacks
 * - Strict timeout protection
 */
export async function executeResilientGeminiCall(
  ai: GoogleGenAI,
  options: AIRequestOptions,
  customConfig?: Partial<AIModelConfig>
): Promise<AIExecutionResult> {
  const config: AIModelConfig = { ...DEFAULT_AI_CONFIG, ...customConfig };
  const modelsToAttempt = [
    config.primaryModel,
    ...config.fallbackModels.filter(m => m !== config.primaryModel)
  ];

  let totalRetries = 0;
  let lastClassifiedError: ClassifiedAIError | null = null;

  for (let modelIndex = 0; modelIndex < modelsToAttempt.length; modelIndex++) {
    const currentModel = modelsToAttempt[modelIndex];
    const isFallback = modelIndex > 0;

    if (isFallback) {
      console.log(`[AI] Switching to fallback model: ${currentModel}`);
      options.onStatusUpdate?.(`Switching to backup model (${currentModel})...`);
    } else {
      console.log(`[AI] Calling model: ${currentModel}`);
    }

    // Adapt configuration based on model capabilities
    // (e.g. gemma is an instruction text model, tools must be removed from config to prevent error)
    let callConfig = options.config;
    if (currentModel.startsWith("gemma") && callConfig?.tools) {
      const { tools, ...restConfig } = callConfig;
      callConfig = restConfig;
    }

    const maxRetries = isFallback ? 0 : config.maxRetriesPerModel;
    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        if (attempt > 0) {
          console.log(`[AI] Retry attempt ${attempt} on model ${currentModel}`);
          options.onStatusUpdate?.("Myraa is reconnecting...");
        }

        // Call Gemini generateContent with timeout protection
        const callPromise = ai.models.generateContent({
          model: currentModel,
          contents: options.contents,
          config: callConfig
        });

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let response: any;
        try {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error("Request timed out waiting for AI response.")), config.requestTimeoutMs);
          });

          response = await Promise.race([callPromise, timeoutPromise]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }

        // Success!
        if (isFallback) {
          console.log(`[AI] Fallback model ${currentModel} succeeded.`);
        }

        return {
          text: response.text || "",
          response,
          modelUsed: currentModel,
          retriesAttempted: totalRetries,
          fallbackUsed: isFallback
        };

      } catch (rawError: any) {
        totalRetries++;
        const classified = classifyAIError(rawError);
        lastClassifiedError = classified;

        console.warn(`[AI] Model notice on ${currentModel} (attempt ${attempt + 1}/${maxRetries + 1}): [${classified.type}] ${classified.message}`);

        // If error is 401 Auth, do NOT retry; fail fast so the user can fix key
        if (classified.type === "AUTH_401") {
          throw new Error(classified.userFriendlyMessage);
        }

        // If error is 503 or 429 or 500, back off if we still have attempts left on this model
        if (classified.retryable && attempt < maxRetries) {
          const delayMs = Math.min(
            config.initialBackoffMs * Math.pow(2, attempt) + Math.random() * 200,
            config.maxBackoffMs
          );
          console.log(`[AI] Waiting ${Math.round(delayMs)}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          attempt++;
          continue;
        }

        // If model attempts exhausted or non-retryable for this specific model, break to try NEXT model in fallback chain
        console.warn(`[AI] ${isFallback ? 'Fallback' : 'Primary'} model ${currentModel} unavailable after ${attempt + 1} attempt(s). Trying next candidate.`);
        break;
      }
    }
  }

  // If every model in the fallback chain failed:
  const finalMessage = lastClassifiedError?.userFriendlyMessage || 
    "My AI service is temporarily unavailable. Please try again in a moment.";

  console.error(`[AI] ❌ All ${modelsToAttempt.length} candidate models failed.`);
  throw new Error(finalMessage);
}
