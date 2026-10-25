-- Step 15b (customer account closure): a closed account keeps its row (bookings name it) without phone, name or
-- e-mail, so the number can sign up again as a new account. Existing rows are open (phone set, closed_at NULL).
ALTER TABLE "customer" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_closed_check" CHECK (("customer"."closed_at" is null) = ("customer"."phone" is not null) and ("customer"."closed_at" is null or not "customer"."is_active"));