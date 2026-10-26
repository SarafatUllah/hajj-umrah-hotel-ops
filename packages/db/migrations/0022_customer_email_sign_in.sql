-- D-P2-68 (customer sign-in by e-mail): a customer signs in with a phone or a verified e-mail; a sign-in code goes to
-- a phone or an address. Existing customers are phone accounts and stay valid. `customer.email` is now always stored
-- normalized: no code path ever wrote it, so the backfill below only guards hand-entered rows (contact e-mails trimmed
-- and lower-cased; a malformed one, or one left on a closed account, cleared). Nothing is marked verified.
ALTER TABLE "customer" DROP CONSTRAINT "customer_closed_check";--> statement-breakpoint
ALTER TABLE "otp_challenge" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "otp_challenge" ADD COLUMN "email" text;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_org_verified_email_unique" ON "customer" USING btree ("organization_id","email") WHERE "customer"."email_verified_at" is not null;--> statement-breakpoint
CREATE INDEX "otp_challenge_email_idx" ON "otp_challenge" USING btree ("organization_id","email","created_at") WHERE "otp_challenge"."email" is not null;--> statement-breakpoint
UPDATE "customer" SET "email" = lower(btrim("email")) WHERE "email" IS NOT NULL;--> statement-breakpoint
UPDATE "customer" SET "email" = NULL WHERE "email" IS NOT NULL AND ("closed_at" IS NOT NULL OR char_length("email") > 254 OR "email" !~ '^[^@\s]+@[^@\s]+$');--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_email_check" CHECK ("customer"."email" is null or ("customer"."email" = lower(btrim("customer"."email")) and char_length("customer"."email") <= 254 and "customer"."email" ~ '^[^@\s]+@[^@\s]+$'));--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_email_verified_check" CHECK ("customer"."email_verified_at" is null or "customer"."email" is not null);--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_closed_check" CHECK (("customer"."closed_at" is null) = ("customer"."phone" is not null or "customer"."email_verified_at" is not null) and ("customer"."closed_at" is null or (not "customer"."is_active" and "customer"."email" is null)));--> statement-breakpoint
ALTER TABLE "otp_challenge" ADD CONSTRAINT "otp_challenge_destination_check" CHECK (num_nonnulls("otp_challenge"."phone", "otp_challenge"."email") = 1);--> statement-breakpoint
ALTER TABLE "otp_challenge" ADD CONSTRAINT "otp_challenge_email_check" CHECK ("otp_challenge"."email" is null or ("otp_challenge"."email" = lower(btrim("otp_challenge"."email")) and char_length("otp_challenge"."email") <= 254 and "otp_challenge"."email" ~ '^[^@\s]+@[^@\s]+$'));