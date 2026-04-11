/**
 * AI vision helper — analyze one or more base64-encoded screenshots with
 * automatic fallback between Claude (primary) and OpenAI (fallback).
 * Both providers return a JSON object parsed from the first `{…}` block in
 * their text response, matching the schema defined by systemPrompt.
 *
 * Usage:
 *   const result = await analyzeImagesWithFallback(images, WALMART_PROMPT);
 *
 * Throws only if ALL providers fail. Individual provider errors are logged
 * but swallowed so the next provider gets a chance.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getAIConfig } from "@/lib/ai-config";

function detectMediaType(
  base64: string
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("R0lG")) return "image/gif";
  if (base64.startsWith("UklG")) return "image/webp";
  return "image/png";
}

async function callClaudeVision(
  base64Images: string[],
  systemPrompt: string,
  model: string
): Promise<unknown> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const content: Anthropic.MessageCreateParams["messages"][0]["content"] = [];
  for (const img of base64Images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: detectMediaType(img),
        data: img,
      },
    });
  }
  content.push({ type: "text", text: systemPrompt });

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }
  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in Claude response");
  return JSON.parse(jsonMatch[0]);
}

async function callOpenAIVision(
  base64Images: string[],
  systemPrompt: string,
  model: string
): Promise<unknown> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
    base64Images.map((img) => {
      const mediaType = detectMediaType(img);
      const url = img.startsWith("data:")
        ? img
        : `data:${mediaType};base64,${img}`;
      return {
        type: "image_url",
        image_url: { url },
      };
    });
  content.push({
    type: "text",
    text: "Analyse these screenshots per the system prompt and return JSON only.",
  });

  const response = await client.chat.completions.create({
    model,
    max_tokens: 2000,
    temperature: 0.3,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content },
    ],
  });

  const text = response.choices[0]?.message?.content || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON found in OpenAI response");
  return JSON.parse(jsonMatch[0]);
}

export async function analyzeImagesWithFallback(
  base64Images: string[],
  systemPrompt: string
): Promise<unknown> {
  const config = await getAIConfig();
  if (config.providerChain.length === 0) {
    throw new Error(
      "No AI providers configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY."
    );
  }

  let lastError = "";
  for (const provider of config.providerChain) {
    const model =
      provider === "claude" ? config.claudeModel : config.openaiModel;
    try {
      console.log(`[AI-Vision] Trying ${provider} (${model})…`);
      const result =
        provider === "claude"
          ? await callClaudeVision(base64Images, systemPrompt, model)
          : await callOpenAIVision(base64Images, systemPrompt, model);
      console.log(`[AI-Vision] Success with ${provider}`);
      return result;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.error(`[AI-Vision] ${provider} failed: ${lastError}`);
    }
  }

  throw new Error(`All AI providers failed. Last error: ${lastError}`);
}
