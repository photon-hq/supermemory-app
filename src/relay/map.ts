// Photon `message.received` event → one Supermemory document.
//
// Shapes from Photon's staging OpenAPI (`MessageReceivedEvent`, API version
// 2026-07-01): `{ id, type, apiVersion, source, timestamp, data: { projectId,
// object: Message } }`, where a received Message has `id`, `platform`,
// `space`, `sentBy` (a User snapshot), `content` and `timestamps.receivedAt`.
// Only what this mapping reads is typed here.

interface UserSnapshot {
  id?: unknown;
  handle?: unknown;
  metadata?: { displayName?: unknown };
}

interface Content {
  type?: unknown;
  text?: unknown;
  parts?: unknown;
}

interface ReceivedMessage {
  id?: unknown;
  platform?: unknown;
  status?: unknown;
  space?: { id?: unknown };
  sentBy?: UserSnapshot;
  content?: Content;
  createdAt?: unknown;
  timestamps?: { receivedAt?: unknown };
}

interface MessageEvent {
  id?: unknown;
  type?: unknown;
  data?: { projectId?: unknown; object?: ReceivedMessage };
}

export interface SupermemoryDocument {
  namespace: string;
  id: string;
  content: string;
  supportingContext: string;
  group: Record<string, string>;
  metadata: Record<string, string>;
  date?: string;
}

export type Mapped = { kind: "memory"; document: SupermemoryDocument } | { kind: "skip"; reason: string };

const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);

/** Supermemory namespaces are 1–100 of [A-Za-z0-9_:-]. */
export function namespaceFor(organizationId: string, userId: string): string {
  return `photon:${organizationId}:${userId}`.replace(/[^A-Za-z0-9_:-]/g, "_").slice(0, 100);
}

/** The words in a message: its text, or the text parts of a group. Attachments, reads and typing carry none. */
export function messageText(content: Content | undefined): string | undefined {
  if (!content) return undefined;
  if (content.type === "text") return str(content.text);
  if (content.type === "group" && Array.isArray(content.parts)) {
    const text = (content.parts as Content[])
      .map((part) => (part?.type === "text" ? str(part.text) : undefined))
      .filter((part): part is string => Boolean(part))
      .join("\n");
    return text || undefined;
  }
  return undefined;
}

export function mapMessageEvent(event: unknown, organizationId: string): Mapped {
  const e = event as MessageEvent;
  if (e?.type !== "message.received") return { kind: "skip", reason: `event type ${String(e?.type)}` };
  const message = e.data?.object;
  if (message?.status !== undefined && message.status !== "received") {
    return { kind: "skip", reason: `message status ${String(message.status)}` };
  }
  const messageId = str(message?.id);
  const senderId = str(message?.sentBy?.id);
  const projectId = str(e.data?.projectId);
  if (!messageId || !senderId || !projectId) return { kind: "skip", reason: "missing message, sender or project id" };

  const text = messageText(message?.content);
  if (!text) return { kind: "skip", reason: `no text (content type ${String(message?.content?.type)})` };

  const platform = str(message?.platform) ?? "unknown";
  const spaceId = str(message?.space?.id);
  const metadata: Record<string, string> = {
    source: "photon",
    organizationId,
    projectId,
    platform,
    messageId,
    senderId,
  };
  if (spaceId) metadata.spaceId = spaceId;

  return {
    kind: "memory",
    document: {
      namespace: namespaceFor(organizationId, senderId),
      // The Photon message id: Supermemory treats a repeat as an unchanged
      // duplicate, so a retried delivery never adds the message twice.
      id: `photon:${messageId}`.slice(0, 255),
      content: text,
      supportingContext:
        `Messages this person sent over ${platform} to an organization's agent on Photon. ` +
        "Remember durable facts about the sender: who they are, preferences, plans and commitments.",
      group: spaceId ? { conversation: spaceId } : {},
      metadata,
      date: str(message?.timestamps?.receivedAt) ?? str(message?.createdAt),
    },
  };
}
