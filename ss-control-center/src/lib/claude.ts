import Anthropic from "@anthropic-ai/sdk";

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "<api_key>") {
    throw new Error(
      "ANTHROPIC_API_KEY not configured. Set your real API key in .env"
    );
  }
  return new Anthropic({ apiKey });
}

function detectMediaType(
  base64: string
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("R0lG")) return "image/gif";
  if (base64.startsWith("UklG")) return "image/webp";
  return "image/png";
}

// Analyze one or more screenshots
export async function analyzeScreenshots(
  base64Images: string[],
  systemPrompt: string
) {
  const client = getClient();

  // Build content blocks: all images first, then the text prompt
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

  content.push({
    type: "text",
    text: systemPrompt,
  });

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in Claude response");
  }

  return JSON.parse(jsonMatch[0]);
}
