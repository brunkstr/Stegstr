/**
 * Payment attachments on notes. A note can carry Lightning invoices and Cashu
 * tokens as tags; the same strings pasted into the content are recognised too,
 * so notes from other clients work.
 *
 *   ["bolt11", "<invoice>"]     a request to be paid
 *   ["cashu",  "<token>"]       bearer ecash: whoever redeems first has it
 */
import type { NostrEvent } from "../types";
import { looksLikeInvoice } from "./bolt11";
import { looksLikeCashuToken } from "./cashu";

export type PaymentAttachment = { type: "bolt11"; value: string } | { type: "cashu"; value: string };

export const TAG_BOLT11 = "bolt11";
export const TAG_CASHU = "cashu";

export function attachmentTags(list: PaymentAttachment[]): string[][] {
  return list.map((a) => [a.type === "bolt11" ? TAG_BOLT11 : TAG_CASHU, a.value]);
}

export function paymentAttachmentsFromEvent(ev: Pick<NostrEvent, "tags" | "content">): PaymentAttachment[] {
  const out: PaymentAttachment[] = [];
  const seen = new Set<string>();
  const add = (a: PaymentAttachment) => { const k = a.type + ":" + a.value; if (!seen.has(k)) { seen.add(k); out.push(a); } };
  for (const t of ev.tags ?? []) {
    if (t[0] === TAG_BOLT11 && typeof t[1] === "string" && looksLikeInvoice(t[1])) add({ type: "bolt11", value: t[1].replace(/^lightning:/i, "").toLowerCase() });
    if (t[0] === TAG_CASHU && typeof t[1] === "string" && looksLikeCashuToken(t[1])) add({ type: "cashu", value: t[1].replace(/^cashu:/i, "") });
  }
  for (const word of (ev.content ?? "").split(/\s+/)) {
    const w = word.replace(/[),.;:!?]+$/, "");
    if (looksLikeInvoice(w)) add({ type: "bolt11", value: w.replace(/^lightning:/i, "").toLowerCase() });
    else if (looksLikeCashuToken(w)) add({ type: "cashu", value: w.replace(/^cashu:/i, "") });
  }
  return out;
}

/** Strip raw invoice/token strings out of displayed text; they are rendered as cards instead. */
export function contentWithoutPayments(content: string): string {
  return content
    .split(/(\s+)/)
    .map((w) => (looksLikeInvoice(w.replace(/[),.;:!?]+$/, "")) || looksLikeCashuToken(w.replace(/[),.;:!?]+$/, "")) ? "" : w))
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
