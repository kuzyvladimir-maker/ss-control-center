/**
 * GET /api/settings/telegram-discover
 *
 * One-shot helper that calls Telegram's getUpdates and surfaces the chat /
 * topic IDs Vladimir needs to set TELEGRAM_ALERT_CHAT_ID and
 * TELEGRAM_ALERT_THREAD_ID for the new "Джеки control центр" group + topic
 * routing.
 *
 * Flow Vladimir runs once:
 *   1. Add the bot to the group as an admin so it can read group messages.
 *   2. Enable Topics in the group settings (if not already on).
 *   3. Create / open the topic he wants alerts to land in.
 *   4. Send any plain message in that topic so getUpdates has something to
 *      report.
 *   5. Hit the "Discover Telegram IDs" button on /settings — this endpoint
 *      returns the latest distinct (chat_id, message_thread_id, chat_title,
 *      topic_name) tuples seen.
 *   6. Copy the desired pair into Vercel env vars and redeploy.
 *
 * Admin-only — the endpoint surfaces internal group titles that shouldn't
 * leak to logged-in non-admin users.
 *
 * Notes:
 *   - Telegram's getUpdates only returns updates received since the last
 *     poll if a webhook isn't set. We use offset=-100 to fetch the last
 *     batch regardless.
 *   - For a webhook-enabled bot this endpoint will return an empty list;
 *     in that case the bot would need to be flipped to polling mode to
 *     read updates, which we don't do here. We surface the underlying
 *     Telegram error in `error` instead so the UI can show it.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-server";

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  date: number;
  text?: string;
  from?: { first_name?: string; username?: string };
  chat: {
    id: number;
    title?: string;
    type: string;
    is_forum?: boolean;
  };
  reply_to_message?: {
    forum_topic_created?: { name: string };
    message_thread_id?: number;
  };
  forum_topic_created?: { name: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

interface ChatTopicEntry {
  chatId: number;
  chatTitle: string;
  chatType: string;
  hasTopics: boolean;
  threadId: number | null;
  topicName: string | null;
  lastMessageAt: string;
  lastMessageText: string;
  lastMessageFrom: string;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === "<bot_token>") {
    return NextResponse.json(
      { error: "TELEGRAM_BOT_TOKEN is not configured." },
      { status: 400 }
    );
  }

  // offset=-100 asks Telegram for the most recent ~100 updates without
  // advancing the consumer cursor (so this stays read-only).
  const res = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?offset=-100&timeout=0`,
    { cache: "no-store" }
  );
  const json = (await res.json()) as {
    ok: boolean;
    result?: TelegramUpdate[];
    description?: string;
  };
  if (!json.ok) {
    return NextResponse.json(
      {
        error:
          json.description ||
          "Telegram returned an error. If a webhook is configured for this bot, polling getUpdates is blocked — see the helper notes.",
      },
      { status: 502 }
    );
  }

  // Collapse updates to one entry per (chat_id, thread_id). Keep the most
  // recent message text per pair so Vladimir can recognise which group +
  // topic each row corresponds to.
  const seen = new Map<string, ChatTopicEntry>();
  for (const upd of json.result ?? []) {
    const m = upd.message ?? upd.channel_post;
    if (!m) continue;
    const threadId = m.message_thread_id ?? null;
    const key = `${m.chat.id}|${threadId ?? "none"}`;
    const topicName =
      m.forum_topic_created?.name ??
      m.reply_to_message?.forum_topic_created?.name ??
      null;
    const prev = seen.get(key);
    const entry: ChatTopicEntry = {
      chatId: m.chat.id,
      chatTitle: m.chat.title ?? "(direct message)",
      chatType: m.chat.type,
      hasTopics: m.chat.is_forum === true,
      threadId,
      topicName: topicName ?? prev?.topicName ?? null,
      lastMessageAt: new Date(m.date * 1000).toISOString(),
      lastMessageText: (m.text ?? "").slice(0, 140),
      lastMessageFrom:
        m.from?.username ?? m.from?.first_name ?? "(unknown)",
    };
    // Keep the freshest message per chat/topic pair.
    if (!prev || new Date(prev.lastMessageAt) < new Date(entry.lastMessageAt)) {
      seen.set(key, entry);
    }
  }

  const entries = Array.from(seen.values()).sort((a, b) =>
    b.lastMessageAt.localeCompare(a.lastMessageAt)
  );

  return NextResponse.json({
    current: {
      defaultChatId: process.env.TELEGRAM_CHAT_ID ?? null,
      alertChatId: process.env.TELEGRAM_ALERT_CHAT_ID ?? null,
      alertThreadId: process.env.TELEGRAM_ALERT_THREAD_ID ?? null,
      procurementChatId: process.env.TELEGRAM_PROCUREMENT_CHAT_ID ?? null,
    },
    discovered: entries,
    instructions:
      entries.length === 0
        ? "No recent updates. Add the bot to the group as admin, open the desired topic, send any message in it, then refresh."
        : "Pick the row whose chatTitle + topicName matches the destination you want. Set TELEGRAM_ALERT_CHAT_ID = chatId and TELEGRAM_ALERT_THREAD_ID = threadId in Vercel.",
  });
}
