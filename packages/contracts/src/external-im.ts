import { z } from "zod";

export const imAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  content_type: z.string(),
  size: z.number().int().nonnegative(),
  source_ref: z.string().min(1),
  content_base64: z
    .string()
    .max(24 * 1024 * 1024)
    .optional(),
});

export const imInboundMessageSchema = z.object({
  connector_id: z.string().min(1),
  external_account_id: z.string().min(1),
  external_conversation_id: z.string().min(1),
  external_message_id: z.string().min(1),
  sender: z.object({
    id: z.string().min(1),
    display_name: z.string().min(1),
  }),
  text: z.string(),
  attachments: z.array(imAttachmentSchema),
  reply_correlation: z.string().optional(),
  received_at: z.iso.datetime({ offset: true }),
});
export type ImInboundMessage = z.infer<typeof imInboundMessageSchema>;

export const imInboxDeliverySchema = z.object({
  session_id: z.string().min(1).optional(),
  message: imInboundMessageSchema,
});
export type ImInboxDelivery = z.infer<typeof imInboxDeliverySchema>;

export const imDeliveryReceiptSchema = z.object({
  runtime_session_id: z.string().min(1),
  runtime_receipt_id: z.string().min(1),
  duplicate: z.boolean(),
});
export type ImDeliveryReceipt = z.infer<typeof imDeliveryReceiptSchema>;
