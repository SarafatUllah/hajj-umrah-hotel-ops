CREATE TABLE "room_operational_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"ended_early_at" timestamp with time zone,
	"ended_early_by" uuid,
	"original_end_date" date,
	CONSTRAINT "room_block_kind_check" CHECK ("room_operational_block"."kind" in ('OPERATIONAL_BLOCK', 'MAINTENANCE', 'OUT_OF_SERVICE')),
	CONSTRAINT "room_block_range_check" CHECK ("room_operational_block"."start_date" <= "room_operational_block"."end_date"),
	CONSTRAINT "room_block_reason_check" CHECK (char_length(btrim("room_operational_block"."reason")) > 0),
	CONSTRAINT "room_block_ended_early_check" CHECK (("room_operational_block"."ended_early_at" is null) = ("room_operational_block"."original_end_date" is null) and ("room_operational_block"."ended_early_at" is null) = ("room_operational_block"."ended_early_by" is null)),
	CONSTRAINT "room_block_end_state_check" CHECK ("room_operational_block"."ended_early_at" is null or "room_operational_block"."cancelled_at" is null),
	CONSTRAINT "room_block_original_end_check" CHECK ("room_operational_block"."original_end_date" is null or "room_operational_block"."original_end_date" > "room_operational_block"."end_date")
);
--> statement-breakpoint
ALTER TABLE "room_operational_block" ADD CONSTRAINT "room_operational_block_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_operational_block" ADD CONSTRAINT "room_block_room_fk" FOREIGN KEY ("organization_id","hotel_id","room_id") REFERENCES "public"."room"("organization_id","hotel_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_block_org_hotel_idx" ON "room_operational_block" USING btree ("organization_id","hotel_id");--> statement-breakpoint
CREATE INDEX "room_block_room_idx" ON "room_operational_block" USING btree ("organization_id","hotel_id","room_id");--> statement-breakpoint
CREATE INDEX "room_block_dates_idx" ON "room_operational_block" USING btree ("organization_id","hotel_id","start_date","end_date");--> statement-breakpoint
-- Same-kind no-overlap (hand-appended; Drizzle has no EXCLUDE builder): one room may not have two
-- ACTIVE blocks of the SAME kind on one night; different kinds may overlap (display precedence
-- resolves them). Cancelled rows drop out of the constraint (partial, WHERE cancelled_at IS NULL).
-- It keys on end_date, so an ended-early block frees the nights after its new end. btree_gist
-- already exists (migrations 0001/0004/0005) and is repeated defensively, as in 0005.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "room_operational_block" ADD CONSTRAINT "room_block_no_overlap"
  EXCLUDE USING gist ("room_id" WITH =, "kind" WITH =, daterange("start_date", "end_date", '[]') WITH &&)
  WHERE ("cancelled_at" IS NULL);
