CREATE TABLE "rate_limit_bucket" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer NOT NULL,
	CONSTRAINT "rate_limit_bucket_hits_check" CHECK ("rate_limit_bucket"."hits" >= 1)
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "totp_pending_secret" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "session_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "role" ADD COLUMN "requires_two_factor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_totp_consistency" CHECK (("app_user"."totp_secret" is null) = ("app_user"."totp_enabled_at" is null));--> statement-breakpoint
-- Backfill (hand-appended): existing organizations' Super Admin and Hotel Manager roles require two-factor
-- authentication, exactly as the seed defines them (packages/contracts/constants/roles.ts); with
-- STAFF_2FA_ENFORCEMENT=required-roles their holders must enrol at the next sign-in.
UPDATE "role" SET "requires_two_factor" = true WHERE "key" IN ('SUPER_ADMIN', 'HOTEL_MANAGER');
