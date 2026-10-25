CREATE TABLE "event_receipt" (
	"organization_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"handler" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_receipt_organization_id_event_id_handler_pk" PRIMARY KEY("organization_id","event_id","handler")
);
--> statement-breakpoint
ALTER TABLE "event_receipt" ADD CONSTRAINT "event_receipt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;