/**
 * The shop's LINE OA (plan 13.2): the one place that talks to LINE's Messaging API, so the rest of
 * the code is tested without it. LINE's own docs: every webhook body is signed with the channel
 * secret (x-line-signature = base64 HMAC-SHA256 of the raw body); push sends to one LINE; reply
 * answers a message for free; X-Line-Retry-Key makes a retried push arrive once.
 *
 * Settings (Cloudflare secrets, set by the owner in the dashboard — never in code):
 *   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, LINE_OA_ID (e.g. "@denair").
 * All three, or the shop is not connected and nothing is sent.
 * The practice copy may set LINE_FAKE="1": cards are written to the log instead of sent.
 */
import { isPracticeCopy } from "@l-shopee/core";

export interface LineEnv {
  SHOP?: { id: string };
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  LINE_OA_ID?: string;
  LINE_FAKE?: string;
  PRACTICE_COPY?: string;
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
}

export interface LineConfig {
  secret: string;
  token: string;
  oaId: string;
  /** Practice copy: log the cards, send nothing. */
  fake: boolean;
}

/**
 * The shop's OA, or null when it isn't connected. Only Den Air's OA exists so far: any other shop
 * is never connected, so it can never send from Den Air's OA.
 */
export function lineConfig(env: LineEnv): LineConfig | null {
  if (env.SHOP && env.SHOP.id !== "denair") return null;
  const secret = env.LINE_CHANNEL_SECRET?.trim();
  const token = env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  const oaId = env.LINE_OA_ID?.trim();
  if (!secret || !token || !oaId) return null;
  return { secret, token, oaId, fake: env.LINE_FAKE === "1" && isPracticeCopy(env) };
}

const enc = new TextEncoder();

function base64(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

/** Did LINE send this body? Compared in constant time. */
export async function verifyLineSignature(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = base64(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/**
 * sent — LINE has it (409 on a push = it already had this retry key) · retry — LINE busy or down,
 * try again later · dropped — LINE refused it for good (bad user, bad card); logged.
 */
export type SendOutcome = "sent" | "retry" | "dropped";

export interface LineClient {
  push(to: string, messages: unknown[], retryKey: string): Promise<SendOutcome>;
  reply(replyToken: string, messages: unknown[]): Promise<SendOutcome>;
}

const API = "https://api.line.me/v2/bot/message";

export function lineClient(config: LineConfig, fetchFn: typeof fetch = fetch): LineClient {
  if (config.fake) {
    const log = (what: string, messages: unknown[]) => {
      const alt = (messages as { altText?: string; text?: string }[]).map(
        (m) => m.altText ?? m.text,
      );
      console.log(`[line:practice] ${what}: ${alt.join(" | ")}`);
      return Promise.resolve<SendOutcome>("sent");
    };
    return {
      push: (to, messages) => log(`push to ${to}`, messages),
      reply: (_token, messages) => log("reply", messages),
    };
  }

  async function send(
    path: "push" | "reply",
    body: Record<string, unknown>,
    retryKey?: string,
  ): Promise<SendOutcome> {
    let res: Response;
    try {
      res = await fetchFn(`${API}/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          ...(retryKey ? { "x-line-retry-key": retryKey } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error(`[line] ${path} could not reach LINE:`, err);
      return "retry";
    }
    if (res.ok || (res.status === 409 && retryKey)) return "sent";
    if (res.status === 429 || res.status >= 500) return "retry";
    console.error(
      `[line] ${path} refused by LINE: ${res.status} ${await res.text().catch(() => "")}`,
    );
    return "dropped";
  }

  return {
    push: (to, messages, retryKey) => send("push", { to, messages }, retryKey),
    reply: (replyToken, messages) => send("reply", { replyToken, messages }),
  };
}

/**
 * The same card to the same LINE always carries the same retry key, so a retried push arrives once.
 * LINE wants a UUID; this is a version-4-shaped one made from the two ids.
 */
export async function retryKeyFor(eventId: string, lineUserId: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(`${eventId}:${lineUserId}`)),
  ).slice(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x40;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
