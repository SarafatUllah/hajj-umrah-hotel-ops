CREATE TABLE "document_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "document_asset_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "document_asset_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "document_asset_size_check" CHECK ("document_asset"."size_bytes" between 1 and 10485760),
	CONSTRAINT "document_asset_mime_check" CHECK ("document_asset"."mime_type" in ('application/pdf', 'image/png', 'image/jpeg'))
);
--> statement-breakpoint
CREATE TABLE "hotel_document" (
	"document_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hotel_document_document_id_pk" PRIMARY KEY("document_id"),
	CONSTRAINT "hotel_document_type_check" CHECK ("hotel_document"."doc_type" in ('LICENSE', 'CONTRACT', 'INSURANCE', 'PERMIT', 'OTHER'))
);
--> statement-breakpoint
ALTER TABLE "document_asset" ADD CONSTRAINT "document_asset_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotel_document" ADD CONSTRAINT "hotel_document_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotel_document" ADD CONSTRAINT "hotel_document_asset_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."document_asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotel_document" ADD CONSTRAINT "hotel_document_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hotel_document_hotel_idx" ON "hotel_document" USING btree ("organization_id","hotel_id");--> statement-breakpoint
CREATE INDEX "hotel_document_asset_idx" ON "hotel_document" USING btree ("organization_id","document_id");