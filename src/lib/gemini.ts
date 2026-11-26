import { GoogleGenAI } from "@google/genai";
import { env } from "./db";

export const DEFAULT_MODEL = "gemini-3.5-flash-lite";

let client: GoogleGenAI | undefined;

export async function gemini() {
  if (!client) {
    const apiKey = (await env()).GOOGLE_AI_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_AI_API_KEY が設定されていません");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

export async function modelName() {
  return (await env()).AI_MODEL || DEFAULT_MODEL;
}
