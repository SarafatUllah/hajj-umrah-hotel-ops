CREATE TABLE "hotel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"city" text NOT NULL,
	"country" text DEFAULT 'SA' NOT NULL,
	"address" text,
	"phone" text,
	"email" text,
	"timezone" text DEFAULT 'Asia/Riyadh' NOT NULL,
	"currency" text DEFAULT 'SAR' NOT NULL,
	"check_in_time" time DEFAULT '15:00' NOT NULL,
	"check_out_time" time DEFAULT '12:00' NOT NULL,
	"license_reference" text,
	"ownership_type" text DEFAULT 'OWNED' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hotel_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "hotel_org_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "hotel_status_check" CHECK ("hotel"."status" in ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "hotel_ownership_check" CHECK ("hotel"."ownership_type" in ('OWNED', 'LEASED', 'CONTRACTED')),
	CONSTRAINT "hotel_currency_check" CHECK (char_length("hotel"."currency") = 3)
);
--> statement-breakpoint
CREATE TABLE "hotel_setting" (
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hotel_setting_organization_id_hotel_id_key_pk" PRIMARY KEY("organization_id","hotel_id","key")
);
--> statement-breakpoint
CREATE TABLE "user_hotel_access" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_hotel_access_user_id_hotel_id_pk" PRIMARY KEY("user_id","hotel_id")
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "all_hotels" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "hotel_id" uuid;--> statement-breakpoint
ALTER TABLE "hotel" ADD CONSTRAINT "hotel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotel_setting" ADD CONSTRAINT "hotel_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotel_setting" ADD CONSTRAINT "hotel_setting_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_hotel_access" ADD CONSTRAINT "user_hotel_access_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_hotel_access" ADD CONSTRAINT "user_hotel_access_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."app_user"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_hotel_access" ADD CONSTRAINT "user_hotel_access_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hotel_setting_org_hotel_idx" ON "hotel_setting" USING btree ("organization_id","hotel_id");--> statement-breakpoint
CREATE INDEX "user_hotel_access_hotel_idx" ON "user_hotel_access" USING btree ("organization_id","hotel_id");--> statement-breakpoint
CREATE INDEX "user_hotel_access_user_idx" ON "user_hotel_access" USING btree ("organization_id","user_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_hotel_time_idx" ON "audit_log" USING btree ("organization_id","hotel_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("organization_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE FUNCTION audit_log_forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log rows are immutable' USING ERRCODE = '55000';
END $$;--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_update();