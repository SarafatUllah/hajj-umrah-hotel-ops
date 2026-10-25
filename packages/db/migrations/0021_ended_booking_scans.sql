-- Backfill (data, step 17e): a booking that will not happen needs no passport photo. Since step 17e a cancellation
-- or a lapse makes its scans due at once (their reading cleared, `delete_after` that day); scans of bookings that had
-- already ended keep the retention set at upload — they become due now, so the next sweep deletes their images.
UPDATE "passport_scan" AS s
SET "extracted_encrypted" = NULL,
    "delete_after" = LEAST(COALESCE(s."delete_after", (now() AT TIME ZONE 'UTC')::date), (now() AT TIME ZONE 'UTC')::date),
    "updated_at" = now()
FROM "booking" AS b
WHERE b."organization_id" = s."organization_id" AND b."id" = s."booking_id" AND b."status" IN ('CANCELLED', 'EXPIRED');
