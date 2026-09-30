CREATE TABLE "floor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "floor_org_hotel_id_unique" UNIQUE("organization_id","hotel_id","id"),
	CONSTRAINT "floor_hotel_level_unique" UNIQUE("hotel_id","level"),
	CONSTRAINT "floor_level_check" CHECK ("floor"."level" between -5 and 200)
);
--> statement-breakpoint
CREATE TABLE "room_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"default_physical_beds" integer NOT NULL,
	"default_sellable_capacity" integer NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_type_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "room_type_org_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "room_type_beds_check" CHECK ("room_type"."default_physical_beds" between 1 and 30),
	CONSTRAINT "room_type_sellable_check" CHECK ("room_type"."default_sellable_capacity" between 0 and 30)
);
--> statement-breakpoint
ALTER TABLE "floor" ADD CONSTRAINT "floor_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floor" ADD CONSTRAINT "floor_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_type" ADD CONSTRAINT "room_type_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;