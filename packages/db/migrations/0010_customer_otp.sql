CREATE TABLE "otp_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_challenge_phone_check" CHECK ("otp_challenge"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "otp_challenge_attempts_check" CHECK ("otp_challenge"."attempts" >= 0),
	CONSTRAINT "otp_challenge_hash_check" CHECK ("otp_challenge"."code_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "otp_challenge" ADD CONSTRAINT "otp_challenge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "otp_challenge_phone_idx" ON "otp_challenge" USING btree ("organization_id","phone","created_at");--> statement-breakpoint
CREATE INDEX "otp_challenge_expiry_idx" ON "otp_challenge" USING btree ("expires_at");