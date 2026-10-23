import { z } from "zod";
import { FeeModeSchema, IsoTimestamp } from "./common.ts";
import { MoneySchema } from "../money.ts";

// POST/GET /v1/batches (CCR-18). Auth: api_key. Rows use the existing payment engine.

export const BATCH_STATUSES = [
	"open",
	"processing",
	"completed",
	"failed",
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export const BatchStatusSchema = z.enum(BATCH_STATUSES);

export const CreateBatchRowSchema = z
	.object({
		recipientId: z.string().min(1),
		endpointId: z.string().min(1),
		/** Send-side amount for the row quote (demo DF1). */
		amount: MoneySchema,
		externalId: z.string().min(1).max(200),
		profile: z.literal("batch"),
	})
	.strict();

export type CreateBatchRow = z.infer<typeof CreateBatchRowSchema>;

/**
 * Create a JSON batch. `feeMode` applies to every row’s quote (CCR-8/CCR-13).
 * Implementation must call the existing quote → payment create path once per row.
 */
export const CreateBatchRequestSchema = z
	.object({
		feeMode: FeeModeSchema,
		rows: z.array(CreateBatchRowSchema).min(1).max(50),
	})
	.strict();

export type CreateBatchRequest = z.infer<typeof CreateBatchRequestSchema>;

export const BatchTotalsSchema = z
	.object({
		count: z.number().int().nonnegative(),
	})
	.strict();

export const BatchSchema = z
	.object({
		id: z.string().min(1),
		organizationId: z.string().min(1),
		status: BatchStatusSchema,
		paymentIds: z.array(z.string().min(1)),
		totals: BatchTotalsSchema,
		createdAt: IsoTimestamp,
	})
	.strict();

export type Batch = z.infer<typeof BatchSchema>;
