ALTER TABLE "booking_setting" ADD COLUMN "guest_data_retention_months" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_guest_detail" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_setting" ADD CONSTRAINT "booking_setting_guest_retention_check" CHECK ("booking_setting"."guest_data_retention_months" between 1 and 120);