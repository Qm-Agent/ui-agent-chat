import crypto from "node:crypto";

/**
 * 钉钉自定义机器人 webhook 推送工具。
 *
 * 参考 album-backend DingTalkUtil.sendMessageWebhook / sendMarkDownMessageWebhook：
 * 直接 POST 到完整 webhook URL，支持 text / markdown 消息。
 * 当机器人开启"加签"安全设置时，需要带上 timestamp + sign 拼接到 webhook。
 */

export interface DingtalkSendResult {
  ok: boolean;
  errcode?: number;
  errmsg?: string;
  raw?: unknown;
}

/**
 * 对启用加签的机器人计算签名：sign = Base64(HmacSHA256(timestamp + "\n" + secret, secret))，
 * 并对 sign 做 URL-encode。
 */
function buildSignedWebhook(webhookUrl: string, secret: string): string {
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac("sha256", secret).update(stringToSign).digest("base64");
  const sign = encodeURIComponent(hmac);
  const sep = webhookUrl.includes("?") ? "&" : "?";
  return `${webhookUrl}${sep}timestamp=${timestamp}&sign=${sign}`;
}

/**
 * 发送 markdown 消息到钉钉群机器人。
 */
export async function sendDingtalkMarkdown(
  webhookUrl: string,
  title: string,
  text: string,
  secret?: string
): Promise<DingtalkSendResult> {
  const finalUrl = secret ? buildSignedWebhook(webhookUrl, secret) : webhookUrl;
  const body = {
    msgtype: "markdown",
    markdown: { title, text }
  };
  try {
    const res = await fetch(finalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // 出站被防火墙拦截时 TCP 连接可能悬挂数分钟；通知在 finishInspectionRun
      // 之前被 await，无超时会让巡检 run 长时间停留在 running。10s 硬超时兜底。
      signal: AbortSignal.timeout(10_000)
    });
    const json = (await res.json().catch(() => undefined)) as
      | { errcode?: number; errmsg?: string }
      | undefined;
    const ok = res.ok && json?.errcode === 0;
    return { ok, errcode: json?.errcode, errmsg: json?.errmsg, raw: json };
  } catch (error) {
    return {
      ok: false,
      errmsg: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * 发送 text 消息到钉钉群机器人（测试推送用）。
 */
export async function sendDingtalkText(
  webhookUrl: string,
  content: string,
  secret?: string
): Promise<DingtalkSendResult> {
  const finalUrl = secret ? buildSignedWebhook(webhookUrl, secret) : webhookUrl;
  const body = {
    msgtype: "text",
    text: { content }
  };
  try {
    const res = await fetch(finalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // 同 sendDingtalkMarkdown：10s 硬超时，防止出站被拦时连接悬挂拖住调用方。
      signal: AbortSignal.timeout(10_000)
    });
    const json = (await res.json().catch(() => undefined)) as
      | { errcode?: number; errmsg?: string }
      | undefined;
    const ok = res.ok && json?.errcode === 0;
    return { ok, errcode: json?.errcode, errmsg: json?.errmsg, raw: json };
  } catch (error) {
    return {
      ok: false,
      errmsg: error instanceof Error ? error.message : String(error)
    };
  }
}
