import fs from "fs/promises";
import path from "path";
import { Conversation } from "./src/lib/chatTypes";

const CONVERSATION_FILE = path.join(process.cwd(), "conversations.json");

export async function loadConversations(): Promise<Conversation[]> {
  try {
    const data = await fs.readFile(CONVERSATION_FILE, "utf-8");
    return JSON.parse(data) as Conversation[];
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return [];
    }
    console.error("[Conversation Storage] Error loading conversations:", error);
    return [];
  }
}

export async function saveConversations(conversations: Conversation[]): Promise<void> {
  try {
    await fs.writeFile(CONVERSATION_FILE, JSON.stringify(conversations, null, 2), "utf-8");
  } catch (error) {
    console.error("[Conversation Storage] Error writing conversation file:", error);
  }
}

export async function upsertConversation(conversation: Conversation): Promise<Conversation> {
  const conversations = await loadConversations();
  const existingIdx = conversations.findIndex(c => c.id === conversation.id);
  
  if (existingIdx >= 0) {
    conversations[existingIdx] = conversation;
  } else {
    conversations.unshift(conversation);
  }
  
  // Cap history to 50 conversations to avoid uncontrolled growth
  const trimmed = conversations.slice(0, 50);
  await saveConversations(trimmed);
  return conversation;
}

export async function deleteConversation(id: string): Promise<boolean> {
  let conversations = await loadConversations();
  const initialLen = conversations.length;
  conversations = conversations.filter(c => c.id !== id);
  if (conversations.length !== initialLen) {
    await saveConversations(conversations);
    return true;
  }
  return false;
}
