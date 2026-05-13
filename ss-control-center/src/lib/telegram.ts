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

/**
 * Account Health Critical Alerts channel.
 *
 * Reads TELEGRAM_ALERT_CHAT_ID; falls back to the default TELEGRAM_CHAT_ID
 * when the alert-specific chat isn't configured yet (so we don't lose
 * alerts during setup — Vladimir can split into a dedicated chat later).
 * Returns the Telegram message id when sent so the caller can persist it
 * on the CriticalAlert row.
 */
export async function sendCriticalAlert(text: string): Promise<{
  sent: boolean;
  messageId?: string;
  reason?: string;
}> {
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID || CHAT_ID;
  if (!BOT_TOKEN || !chatId || BOT_TOKEN === "<bot_token>") {
    console.log("[Telegram alert] Skipping (not configured):", text);
    return { sent: false, reason: "not-configured" };
  }
  if (!process.env.TELEGRAM_ALERT_CHAT_ID) {
    // One-line breadcrumb so Vladimir sees that alerts are going to the
    // shared chat — easy signal to set a dedicated chat id later.
    console.warn(
      "[Telegram alert] Using TELEGRAM_CHAT_ID fallback (TELEGRAM_ALERT_CHAT_ID not set)"
    );
  }
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    console.error("[Telegram alert] Error:", err);
    return { sent: false, reason: "send-failed" };
  }
  const data = (await res.json()) as {
    ok?: boolean;
    result?: { message_id?: number };
  };
  return { sent: true, messageId: String(data.result?.message_id ?? "") };
}
