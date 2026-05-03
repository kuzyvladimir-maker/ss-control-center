const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendTelegramMessage(text: string) {
  return sendTelegramMessageTo(CHAT_ID, text);
}

/**
 * Send a message to an arbitrary Telegram chat (so Procurement alerts can
 * target a separate chat / topic from the default one). No-ops if the bot
 * token or the resolved chat id is missing.
 */
export async function sendTelegramMessageTo(
  chatId: string | undefined,
  text: string,
  options?: { messageThreadId?: number }
) {
  if (!BOT_TOKEN || !chatId || BOT_TOKEN === "<bot_token>") {
    console.log("[Telegram] Skipping (not configured):", text);
    return { sent: false, reason: "not-configured" as const };
  }

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (options?.messageThreadId) {
    body.message_thread_id = options.messageThreadId;
  }

  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error("[Telegram] Error:", err);
    return { sent: false, reason: "send-failed" as const, error: err };
  }
  return { sent: true } as const;
}
