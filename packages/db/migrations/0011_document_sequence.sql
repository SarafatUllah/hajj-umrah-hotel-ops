CREATE TABLE "document_sequence" (
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"year" integer NOT NULL,
	"last_value" integer NOT NULL,
	CONSTRAINT "document_sequence_organization_id_kind_year_pk" PRIMARY KEY("organization_id","kind","year"),
	CONSTRAINT "document_sequence_kind_check" CHECK ("document_sequence"."kind" in ('QUOTE', 'BOOKING')),
	CONSTRAINT "document_sequence_year_check" CHECK ("document_sequence"."year" between 2000 and 2200),
	CONSTRAINT "document_sequence_value_check" CHECK ("document_sequence"."last_value" >= 1)
);
--> statement-breakpoint
ALTER TABLE "document_sequence" ADD CONSTRAINT "document_sequence_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;