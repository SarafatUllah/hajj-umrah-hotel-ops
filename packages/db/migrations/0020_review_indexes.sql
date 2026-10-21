DROP INDEX "booking_guest_detail_booking_idx";--> statement-breakpoint
DROP INDEX "passport_scan_booking_idx";--> statement-breakpoint
DROP INDEX "passport_scan_retention_idx";--> statement-breakpoint
CREATE INDEX "booking_created_idx" ON "booking" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "booking_hotel_created_idx" ON "booking" USING btree ("organization_id","hotel_id","created_at","id");--> statement-breakpoint
CREATE INDEX "booking_details_reminder_idx" ON "booking" USING btree ("organization_id","check_in","id") WHERE "booking"."status" = 'CONFIRMED' and "booking"."details_reminded_at" is null;--> statement-breakpoint
CREATE INDEX "booking_check_out_idx" ON "booking" USING btree ("organization_id","check_out","id");--> statement-breakpoint
CREATE INDEX "hotel_task_org_booking_idx" ON "hotel_task" USING btree ("organization_id","booking_id");--> statement-breakpoint
CREATE INDEX "passport_scan_retention_idx" ON "passport_scan" USING btree ("organization_id","delete_after");--> statement-breakpoint
-- Hand-appended (data, step 17): a passport photo's stored filename is never the one the uploader gave (it may name
-- the pilgrim, and it would outlive the image): every existing one becomes "passport" and its type's extension.
UPDATE "document_asset" AS d SET "original_filename" = 'passport' || CASE d."mime_type" WHEN 'image/png' THEN '.png' WHEN 'image/jpeg' THEN '.jpg' ELSE '' END
FROM "passport_scan" AS s
WHERE s."organization_id" = d."organization_id" AND s."document_id" = d."id";
