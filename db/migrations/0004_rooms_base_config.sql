CREATE TABLE "room" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"room_number" text NOT NULL,
	"features" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_org_hotel_id_unique" UNIQUE("organization_id","hotel_id","id"),
	CONSTRAINT "room_hotel_number_unique" UNIQUE("hotel_id","room_number"),
	CONSTRAINT "room_number_check" CHECK (char_length(btrim("room"."room_number")) between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "room_base_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"physical_beds" integer NOT NULL,
	"sellable_capacity" integer NOT NULL,
	"origin" text DEFAULT 'MANUAL' NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_base_config_range_check" CHECK ("room_base_config"."valid_to" is null or "room_base_config"."valid_from" <= "room_base_config"."valid_to"),
	CONSTRAINT "room_base_config_beds_check" CHECK ("room_base_config"."physical_beds" between 1 and 30),
	CONSTRAINT "room_base_config_sellable_check" CHECK ("room_base_config"."sellable_capacity" between 0 and 30),
	CONSTRAINT "room_base_config_origin_check" CHECK ("room_base_config"."origin" in ('ROOM_TYPE_DEFAULT', 'MANUAL', 'BULK', 'SEED'))
);
--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_floor_fk" FOREIGN KEY ("organization_id","hotel_id","floor_id") REFERENCES "public"."floor"("organization_id","hotel_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_type_fk" FOREIGN KEY ("organization_id","room_type_id") REFERENCES "public"."room_type"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_base_config" ADD CONSTRAINT "room_base_config_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_base_config" ADD CONSTRAINT "room_base_config_room_fk" FOREIGN KEY ("organization_id","hotel_id","room_id") REFERENCES "public"."room"("organization_id","hotel_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_hotel_floor_idx" ON "room" USING btree ("organization_id","hotel_id","floor_id");--> statement-breakpoint
CREATE INDEX "room_type_idx" ON "room" USING btree ("organization_id","room_type_id");--> statement-breakpoint
CREATE INDEX "room_base_config_org_hotel_idx" ON "room_base_config" USING btree ("organization_id","hotel_id");--> statement-breakpoint
CREATE INDEX "room_base_config_room_idx" ON "room_base_config" USING btree ("organization_id","hotel_id","room_id");--> statement-breakpoint
-- Temporal integrity: no two base-config versions of the same room may cover overlapping nights.
-- btree_gist is required for a GiST exclusion constraint that mixes an equality column (room_id)
-- with a range operator (daterange &&) — created here, in the migration that needs it (per the
-- project's "extensions are created inside the migration that needs them" rule).
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "room_base_config" ADD CONSTRAINT "room_base_config_no_overlap"
  EXCLUDE USING gist ("room_id" WITH =, daterange("valid_from", "valid_to", '[]') WITH &&);