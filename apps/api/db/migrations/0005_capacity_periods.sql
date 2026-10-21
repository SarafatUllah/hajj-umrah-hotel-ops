CREATE TABLE "capacity_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capacity_period_org_hotel_id_unique" UNIQUE("organization_id","hotel_id","id"),
	CONSTRAINT "capacity_period_dates_unique" UNIQUE("id","start_date","end_date"),
	CONSTRAINT "capacity_period_hotel_name_unique" UNIQUE("hotel_id","name"),
	CONSTRAINT "capacity_period_range_check" CHECK ("capacity_period"."start_date" <= "capacity_period"."end_date"),
	CONSTRAINT "capacity_period_kind_check" CHECK ("capacity_period"."kind" in ('HAJJ', 'RAMADAN', 'SPECIAL'))
);
--> statement-breakpoint
CREATE TABLE "room_capacity_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"physical_beds" integer NOT NULL,
	"sellable_capacity" integer NOT NULL,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_override_period_room_unique" UNIQUE("period_id","room_id"),
	CONSTRAINT "room_override_beds_check" CHECK ("room_capacity_override"."physical_beds" between 1 and 30),
	CONSTRAINT "room_override_sellable_check" CHECK ("room_capacity_override"."sellable_capacity" between 0 and 30)
);
--> statement-breakpoint
ALTER TABLE "capacity_period" ADD CONSTRAINT "capacity_period_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_period" ADD CONSTRAINT "capacity_period_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_capacity_override" ADD CONSTRAINT "room_capacity_override_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_capacity_override" ADD CONSTRAINT "room_override_room_fk" FOREIGN KEY ("organization_id","hotel_id","room_id") REFERENCES "public"."room"("organization_id","hotel_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_capacity_override" ADD CONSTRAINT "room_override_period_fk" FOREIGN KEY ("organization_id","hotel_id","period_id") REFERENCES "public"."capacity_period"("organization_id","hotel_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_capacity_override" ADD CONSTRAINT "room_override_period_dates_fk" FOREIGN KEY ("period_id","valid_from","valid_to") REFERENCES "public"."capacity_period"("id","start_date","end_date") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "room_override_org_hotel_idx" ON "room_capacity_override" USING btree ("organization_id","hotel_id");--> statement-breakpoint
CREATE INDEX "room_override_room_idx" ON "room_capacity_override" USING btree ("organization_id","hotel_id","room_id");--> statement-breakpoint
CREATE INDEX "room_override_period_idx" ON "room_capacity_override" USING btree ("organization_id","hotel_id","period_id");--> statement-breakpoint
CREATE INDEX "room_override_period_dates_idx" ON "room_capacity_override" USING btree ("period_id","valid_from","valid_to");--> statement-breakpoint
-- Temporal integrity: no two overrides of the same room may cover overlapping nights, even across
-- DIFFERENT capacity periods. btree_gist already exists (created in migration 0004) but is repeated
-- here defensively (IF NOT EXISTS) since this migration also needs it and must not assume load order.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "room_capacity_override" ADD CONSTRAINT "room_override_no_overlap"
  EXCLUDE USING gist ("room_id" WITH =, daterange("valid_from", "valid_to", '[]') WITH &&);