CREATE TABLE "agency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"license_no" text NOT NULL,
	"contact_name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text NOT NULL,
	"whatsapp_number" text,
	"address" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"status_reason" text,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "agency_org_license_unique" UNIQUE("organization_id","license_no"),
	CONSTRAINT "agency_status_check" CHECK ("agency"."status" in ('PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED')),
	CONSTRAINT "agency_approval_check" CHECK ("agency"."status" <> 'APPROVED' or "agency"."approved_at" is not null),
	CONSTRAINT "agency_name_check" CHECK (char_length(btrim("agency"."name")) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "agency_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agency_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"full_name" text NOT NULL,
	"phone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"session_version" integer DEFAULT 1 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_user_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "agency_user_org_agency_id_unique" UNIQUE("organization_id","agency_id","id")
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"phone_verified_at" timestamp with time zone,
	"email" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"session_version" integer DEFAULT 1 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "customer_org_phone_unique" UNIQUE("organization_id","phone"),
	CONSTRAINT "customer_phone_check" CHECK ("customer"."phone" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "agency_quota" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"agency_id" uuid,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"max_persons" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agency_quota_range_check" CHECK ("agency_quota"."start_date" <= "agency_quota"."end_date"),
	CONSTRAINT "agency_quota_max_check" CHECK ("agency_quota"."max_persons" >= 0)
);
--> statement-breakpoint
CREATE TABLE "allocation_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"group_min" integer NOT NULL,
	"group_max" integer,
	"min_seats" integer DEFAULT 5 NOT NULL,
	"max_rooms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_rule_group_check" CHECK ("allocation_rule"."group_min" >= 1 and ("allocation_rule"."group_max" is null or "allocation_rule"."group_max" >= "allocation_rule"."group_min")),
	CONSTRAINT "allocation_rule_seats_check" CHECK ("allocation_rule"."min_seats" between 1 and 30),
	CONSTRAINT "allocation_rule_rooms_check" CHECK ("allocation_rule"."max_rooms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "booking_setting" (
	"organization_id" uuid NOT NULL,
	"hold_minutes" integer DEFAULT 10 NOT NULL,
	"request_hours" integer DEFAULT 24 NOT NULL,
	"quote_validity_hours" integer DEFAULT 48 NOT NULL,
	"individual_max_rooms" integer DEFAULT 5 NOT NULL,
	"individual_max_open_requests" integer DEFAULT 1 NOT NULL,
	"child_age_limit" integer DEFAULT 10 NOT NULL,
	"infant_age_limit" integer DEFAULT 2 NOT NULL,
	"child_default_side" text DEFAULT 'MOTHER' NOT NULL,
	"passport_min_validity_months" integer DEFAULT 6 NOT NULL,
	"details_reminder_days" integer DEFAULT 7 NOT NULL,
	"passport_image_retention_months" integer DEFAULT 12 NOT NULL,
	"whatsapp_number" text,
	"whatsapp_template" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "booking_setting_organization_id_pk" PRIMARY KEY("organization_id"),
	CONSTRAINT "booking_setting_hold_check" CHECK ("booking_setting"."hold_minutes" between 1 and 120),
	CONSTRAINT "booking_setting_request_check" CHECK ("booking_setting"."request_hours" between 1 and 168),
	CONSTRAINT "booking_setting_quote_check" CHECK ("booking_setting"."quote_validity_hours" between 1 and 720),
	CONSTRAINT "booking_setting_individual_check" CHECK ("booking_setting"."individual_max_rooms" between 1 and 50 and "booking_setting"."individual_max_open_requests" between 1 and 10),
	CONSTRAINT "booking_setting_age_check" CHECK ("booking_setting"."infant_age_limit" between 1 and 5 and "booking_setting"."child_age_limit" between "booking_setting"."infant_age_limit" and 18),
	CONSTRAINT "booking_setting_child_side_check" CHECK ("booking_setting"."child_default_side" in ('MOTHER', 'FATHER')),
	CONSTRAINT "booking_setting_passport_check" CHECK ("booking_setting"."passport_min_validity_months" between 0 and 24 and "booking_setting"."passport_image_retention_months" between 1 and 120),
	CONSTRAINT "booking_setting_reminder_check" CHECK ("booking_setting"."details_reminder_days" between 0 and 60),
	CONSTRAINT "booking_setting_whatsapp_check" CHECK ("booking_setting"."whatsapp_number" is null or "booking_setting"."whatsapp_number" ~ '^[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "extra_bed_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"max_per_room" integer NOT NULL,
	"max_per_booking" integer NOT NULL,
	"amount_halalas" integer NOT NULL,
	"vat_included" boolean NOT NULL,
	"allow_in_override_season" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extra_bed_policy_hotel_type_unique" UNIQUE("organization_id","hotel_id","room_type_id"),
	CONSTRAINT "extra_bed_policy_limits_check" CHECK ("extra_bed_policy"."max_per_room" between 0 and 5 and "extra_bed_policy"."max_per_booking" >= 0),
	CONSTRAINT "extra_bed_policy_amount_check" CHECK ("extra_bed_policy"."amount_halalas" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_quote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ref_no" text NOT NULL,
	"agency_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"booking_type" text NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"male_count" integer DEFAULT 0 NOT NULL,
	"female_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"amount_halalas" integer,
	"unit" text,
	"vat_included" boolean,
	"valid_until" timestamp with time zone,
	"requested_by_agency_user_id" uuid,
	"requested_by_user_id" uuid,
	"offered_by" uuid,
	"offered_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_quote_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "price_quote_org_ref_unique" UNIQUE("organization_id","ref_no"),
	CONSTRAINT "price_quote_org_id_agency_hotel_unique" UNIQUE("organization_id","id","agency_id","hotel_id"),
	CONSTRAINT "price_quote_type_check" CHECK ("price_quote"."booking_type" in ('FAMILY', 'GROUP')),
	CONSTRAINT "price_quote_status_check" CHECK ("price_quote"."status" in ('REQUESTED', 'OFFERED', 'ACCEPTED', 'EXPIRED', 'DECLINED')),
	CONSTRAINT "price_quote_unit_check" CHECK ("price_quote"."unit" is null or "price_quote"."unit" in ('PER_PERSON_NIGHT', 'PER_ROOM_NIGHT')),
	CONSTRAINT "price_quote_stay_check" CHECK ("price_quote"."check_in" < "price_quote"."check_out"),
	CONSTRAINT "price_quote_counts_check" CHECK ("price_quote"."male_count" >= 0 and "price_quote"."female_count" >= 0 and "price_quote"."total_count" >= 1),
	CONSTRAINT "price_quote_group_counts_check" CHECK (case when "price_quote"."booking_type" = 'GROUP' then "price_quote"."male_count" + "price_quote"."female_count" = "price_quote"."total_count" else "price_quote"."male_count" = 0 and "price_quote"."female_count" = 0 end),
	CONSTRAINT "price_quote_offer_check" CHECK (not "price_quote"."status" in ('OFFERED', 'ACCEPTED') or ("price_quote"."amount_halalas" is not null and "price_quote"."unit" is not null and "price_quote"."vat_included" is not null and "price_quote"."valid_until" is not null and "price_quote"."offered_at" is not null)),
	CONSTRAINT "price_quote_amount_check" CHECK ("price_quote"."amount_halalas" is null or "price_quote"."amount_halalas" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"price_type" text NOT NULL,
	"unit" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"amount_halalas" integer NOT NULL,
	"vat_included" boolean NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_org_hotel_id_unique" UNIQUE("organization_id","hotel_id","id"),
	CONSTRAINT "rate_price_type_check" CHECK ("rate"."price_type" in ('PUBLIC', 'AGENCY_DEFAULT')),
	CONSTRAINT "rate_unit_check" CHECK ("rate"."unit" in ('PER_PERSON_NIGHT', 'PER_ROOM_NIGHT')),
	CONSTRAINT "rate_range_check" CHECK ("rate"."start_date" <= "rate"."end_date"),
	CONSTRAINT "rate_amount_check" CHECK ("rate"."amount_halalas" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pii_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"fields" text[] NOT NULL,
	"purpose" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pii_access_log_actor_check" CHECK ("pii_access_log"."actor_kind" in ('staff', 'agency', 'customer', 'system')),
	CONSTRAINT "pii_access_log_subject_check" CHECK ("pii_access_log"."subject_type" in ('PILGRIM', 'BOOKING_GUEST_DETAIL', 'PASSPORT_SCAN'))
);
--> statement-breakpoint
CREATE TABLE "pilgrim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"gender" text NOT NULL,
	"nationality" text NOT NULL,
	"date_of_birth" date NOT NULL,
	"passport_no_encrypted" text NOT NULL,
	"passport_lookup" text NOT NULL,
	"passport_expiry" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pilgrim_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "pilgrim_org_passport_lookup_unique" UNIQUE("organization_id","passport_lookup"),
	CONSTRAINT "pilgrim_gender_check" CHECK ("pilgrim"."gender" in ('MALE', 'FEMALE')),
	CONSTRAINT "pilgrim_nationality_check" CHECK ("pilgrim"."nationality" ~ '^[A-Z]{3}$'),
	CONSTRAINT "pilgrim_lookup_check" CHECK ("pilgrim"."passport_lookup" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "booking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"booking_no" text NOT NULL,
	"booker_type" text NOT NULL,
	"agency_id" uuid,
	"customer_id" uuid,
	"created_by_user_id" uuid,
	"created_by_agency_user_id" uuid,
	"booking_type" text NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"male_count" integer DEFAULT 0 NOT NULL,
	"female_count" integer DEFAULT 0 NOT NULL,
	"child_count" integer DEFAULT 0 NOT NULL,
	"infant_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer NOT NULL,
	"child_side" text,
	"price_source" text NOT NULL,
	"quote_id" uuid,
	"status" text NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"receipt_token" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "booking_org_hotel_id_unique" UNIQUE("organization_id","hotel_id","id"),
	CONSTRAINT "booking_org_id_agency_unique" UNIQUE("organization_id","id","agency_id"),
	CONSTRAINT "booking_org_no_unique" UNIQUE("organization_id","booking_no"),
	CONSTRAINT "booking_receipt_token_unique" UNIQUE("receipt_token"),
	CONSTRAINT "booking_booker_type_check" CHECK ("booking"."booker_type" in ('AGENCY', 'INDIVIDUAL')),
	CONSTRAINT "booking_type_check" CHECK ("booking"."booking_type" in ('FAMILY', 'GROUP')),
	CONSTRAINT "booking_status_check" CHECK ("booking"."status" in ('HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
	CONSTRAINT "booking_price_source_check" CHECK ("booking"."price_source" in ('QUOTE', 'AGENCY_DEFAULT', 'PUBLIC')),
	CONSTRAINT "booking_child_side_enum_check" CHECK ("booking"."child_side" is null or "booking"."child_side" in ('MOTHER', 'FATHER')),
	CONSTRAINT "booking_booker_check" CHECK (("booking"."booker_type" = 'AGENCY' and "booking"."agency_id" is not null and "booking"."customer_id" is null) or ("booking"."booker_type" = 'INDIVIDUAL' and "booking"."customer_id" is not null and "booking"."agency_id" is null)),
	CONSTRAINT "booking_stay_check" CHECK ("booking"."check_in" < "booking"."check_out"),
	CONSTRAINT "booking_counts_check" CHECK ("booking"."male_count" >= 0 and "booking"."female_count" >= 0 and "booking"."child_count" >= 0 and "booking"."infant_count" >= 0 and "booking"."total_count" >= 1),
	CONSTRAINT "booking_group_counts_check" CHECK (case when "booking"."booking_type" = 'GROUP' then "booking"."male_count" + "booking"."female_count" + "booking"."child_count" = "booking"."total_count" else "booking"."male_count" = 0 and "booking"."female_count" = 0 and "booking"."child_count" = 0 end),
	CONSTRAINT "booking_child_side_check" CHECK ("booking"."child_count" = 0 or "booking"."child_side" is not null),
	CONSTRAINT "booking_quote_source_check" CHECK (("booking"."price_source" = 'QUOTE') = ("booking"."quote_id" is not null)),
	CONSTRAINT "booking_quote_agency_check" CHECK ("booking"."quote_id" is null or "booking"."booker_type" = 'AGENCY'),
	CONSTRAINT "booking_hold_expiry_check" CHECK (not "booking"."status" in ('HELD', 'REQUESTED') or "booking"."hold_expires_at" is not null),
	CONSTRAINT "booking_confirmed_expiry_check" CHECK (not "booking"."status" in ('CONFIRMED', 'IN_HOUSE', 'COMPLETED') or "booking"."hold_expires_at" is null),
	CONSTRAINT "booking_requested_check" CHECK ("booking"."status" <> 'REQUESTED' or "booking"."booker_type" = 'INDIVIDUAL'),
	CONSTRAINT "booking_confirmed_check" CHECK (not "booking"."status" in ('CONFIRMED', 'IN_HOUSE', 'COMPLETED') or ("booking"."confirmed_at" is not null and "booking"."receipt_token" is not null)),
	CONSTRAINT "booking_cancelled_check" CHECK (("booking"."status" = 'CANCELLED') = ("booking"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "booking_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"before_data" jsonb,
	"after_data" jsonb,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_change_actor_check" CHECK ("booking_change"."actor_kind" in ('staff', 'agency', 'customer', 'system'))
);
--> statement-breakpoint
CREATE TABLE "booking_guest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"slot_no" integer NOT NULL,
	"gender" text,
	"age_group" text NOT NULL,
	"is_extra_bed" boolean DEFAULT false NOT NULL,
	"pilgrim_id" uuid,
	"status" text DEFAULT 'PENDING_DETAILS' NOT NULL,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" uuid,
	"checked_out_at" timestamp with time zone,
	"checked_out_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_guest_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "booking_guest_org_booking_id_unique" UNIQUE("organization_id","booking_id","id"),
	CONSTRAINT "booking_guest_slot_unique" UNIQUE("organization_id","booking_id","slot_no"),
	CONSTRAINT "booking_guest_slot_check" CHECK ("booking_guest"."slot_no" >= 1),
	CONSTRAINT "booking_guest_gender_check" CHECK ("booking_guest"."gender" is null or "booking_guest"."gender" in ('MALE', 'FEMALE')),
	CONSTRAINT "booking_guest_age_group_check" CHECK ("booking_guest"."age_group" in ('ADULT', 'CHILD', 'INFANT')),
	CONSTRAINT "booking_guest_status_check" CHECK ("booking_guest"."status" in ('PENDING_DETAILS', 'READY', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW', 'REMOVED')),
	CONSTRAINT "booking_guest_infant_bed_check" CHECK (not ("booking_guest"."age_group" = 'INFANT' and "booking_guest"."is_extra_bed")),
	CONSTRAINT "booking_guest_check_in_check" CHECK ("booking_guest"."status" not in ('CHECKED_IN', 'CHECKED_OUT') or "booking_guest"."checked_in_at" is not null),
	CONSTRAINT "booking_guest_check_out_check" CHECK ("booking_guest"."status" <> 'CHECKED_OUT' or "booking_guest"."checked_out_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "booking_price_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"night" date NOT NULL,
	"kind" text NOT NULL,
	"room_type_id" uuid,
	"quantity" integer NOT NULL,
	"unit_amount_halalas" integer NOT NULL,
	"amount_halalas" integer NOT NULL,
	"vat_included" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_price_line_unique" UNIQUE NULLS NOT DISTINCT("organization_id","booking_id","night","kind","room_type_id"),
	CONSTRAINT "booking_price_line_kind_check" CHECK ("booking_price_line"."kind" in ('ROOM', 'PERSON', 'EXTRA_BED')),
	CONSTRAINT "booking_price_line_amount_check" CHECK ("booking_price_line"."quantity" >= 0 and "booking_price_line"."unit_amount_halalas" >= 0 and "booking_price_line"."amount_halalas" = "booking_price_line"."quantity" * "booking_price_line"."unit_amount_halalas")
);
--> statement-breakpoint
CREATE TABLE "booking_room" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"owner_agency_id" uuid,
	"owner_booking_id" uuid,
	"owner_key" text GENERATED ALWAYS AS (coalesce('a:' || owner_agency_id::text, 'b:' || owner_booking_id::text)) STORED NOT NULL,
	"occupancy" text NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"status" text NOT NULL,
	"extra_beds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_room_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "booking_room_org_booking_id_unique" UNIQUE("organization_id","booking_id","id"),
	CONSTRAINT "booking_room_owner_check" CHECK (num_nonnulls("booking_room"."owner_agency_id", "booking_room"."owner_booking_id") = 1),
	CONSTRAINT "booking_room_owner_self_check" CHECK ("booking_room"."owner_booking_id" is null or "booking_room"."owner_booking_id" = "booking_room"."booking_id"),
	CONSTRAINT "booking_room_occupancy_check" CHECK ("booking_room"."occupancy" in ('MALE', 'FEMALE', 'FAMILY')),
	CONSTRAINT "booking_room_status_check" CHECK ("booking_room"."status" in ('HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'RELEASED')),
	CONSTRAINT "booking_room_stay_check" CHECK ("booking_room"."check_in" < "booking_room"."check_out"),
	CONSTRAINT "booking_room_extra_beds_check" CHECK ("booking_room"."extra_beds" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "guest_stay" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"booking_guest_id" uuid NOT NULL,
	"booking_room_id" uuid NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_stay_range_check" CHECK ("guest_stay"."check_in" < "guest_stay"."check_out")
);
--> statement-breakpoint
CREATE TABLE "hotel_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"booking_id" uuid,
	"kind" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"done_at" timestamp with time zone,
	"done_by" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hotel_task_kind_check" CHECK ("hotel_task"."kind" in ('EXTRA_BED_SETUP', 'EXTRA_BED_REMOVAL')),
	CONSTRAINT "hotel_task_status_check" CHECK ("hotel_task"."status" in ('OPEN', 'DONE', 'CANCELLED')),
	CONSTRAINT "hotel_task_quantity_check" CHECK ("hotel_task"."quantity" between 1 and 5),
	CONSTRAINT "hotel_task_done_check" CHECK (("hotel_task"."status" = 'DONE') = ("hotel_task"."done_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "booking_guest_detail" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"booking_guest_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"gender" text,
	"nationality" text,
	"date_of_birth" date,
	"passport_no_encrypted" text,
	"passport_lookup" text,
	"passport_expiry" date,
	"details_encrypted" text,
	"entered_by_kind" text NOT NULL,
	"entered_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_guest_detail_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "booking_guest_detail_guest_unique" UNIQUE("organization_id","booking_guest_id"),
	CONSTRAINT "booking_guest_detail_org_booking_guest_id_unique" UNIQUE("organization_id","booking_id","booking_guest_id","id"),
	CONSTRAINT "booking_guest_detail_gender_check" CHECK ("booking_guest_detail"."gender" is null or "booking_guest_detail"."gender" in ('MALE', 'FEMALE')),
	CONSTRAINT "booking_guest_detail_nationality_check" CHECK ("booking_guest_detail"."nationality" is null or "booking_guest_detail"."nationality" ~ '^[A-Z]{3}$'),
	CONSTRAINT "booking_guest_detail_passport_check" CHECK (("booking_guest_detail"."passport_no_encrypted" is null) = ("booking_guest_detail"."passport_lookup" is null)),
	CONSTRAINT "booking_guest_detail_lookup_check" CHECK ("booking_guest_detail"."passport_lookup" is null or "booking_guest_detail"."passport_lookup" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "booking_guest_detail_entered_by_check" CHECK ("booking_guest_detail"."entered_by_kind" in ('staff', 'agency', 'customer', 'system'))
);
--> statement-breakpoint
CREATE TABLE "passport_scan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"booking_guest_id" uuid,
	"booking_guest_detail_id" uuid,
	"document_id" uuid NOT NULL,
	"method" text,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"extracted_encrypted" text,
	"confidence" jsonb,
	"failure_reason" text,
	"uploaded_by_kind" text NOT NULL,
	"uploaded_by_id" uuid,
	"reviewed_by_kind" text,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"delete_after" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passport_scan_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "passport_scan_document_unique" UNIQUE("organization_id","document_id"),
	CONSTRAINT "passport_scan_method_check" CHECK ("passport_scan"."method" is null or "passport_scan"."method" in ('MRZ', 'OCR', 'AI')),
	CONSTRAINT "passport_scan_status_check" CHECK ("passport_scan"."status" in ('QUEUED', 'PROCESSING', 'NEEDS_REVIEW', 'CONFIRMED', 'FAILED', 'DISCARDED')),
	CONSTRAINT "passport_scan_uploaded_by_check" CHECK ("passport_scan"."uploaded_by_kind" in ('staff', 'agency', 'customer', 'system')),
	CONSTRAINT "passport_scan_reviewed_by_check" CHECK ("passport_scan"."reviewed_by_kind" is null or "passport_scan"."reviewed_by_kind" in ('staff', 'agency', 'customer', 'system')),
	CONSTRAINT "passport_scan_detail_slot_check" CHECK ("passport_scan"."booking_guest_detail_id" is null or "passport_scan"."booking_guest_id" is not null),
	CONSTRAINT "passport_scan_confirmed_check" CHECK ("passport_scan"."status" <> 'CONFIRMED' or ("passport_scan"."booking_guest_detail_id" is not null and "passport_scan"."reviewed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "agency" ADD CONSTRAINT "agency_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_user" ADD CONSTRAINT "agency_user_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_user" ADD CONSTRAINT "agency_user_agency_fk" FOREIGN KEY ("organization_id","agency_id") REFERENCES "public"."agency"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_quota" ADD CONSTRAINT "agency_quota_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_quota" ADD CONSTRAINT "agency_quota_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_quota" ADD CONSTRAINT "agency_quota_agency_fk" FOREIGN KEY ("organization_id","agency_id") REFERENCES "public"."agency"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_rule" ADD CONSTRAINT "allocation_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_rule" ADD CONSTRAINT "allocation_rule_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_setting" ADD CONSTRAINT "booking_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extra_bed_policy" ADD CONSTRAINT "extra_bed_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extra_bed_policy" ADD CONSTRAINT "extra_bed_policy_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extra_bed_policy" ADD CONSTRAINT "extra_bed_policy_room_type_fk" FOREIGN KEY ("organization_id","room_type_id") REFERENCES "public"."room_type"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quote" ADD CONSTRAINT "price_quote_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quote" ADD CONSTRAINT "price_quote_agency_fk" FOREIGN KEY ("organization_id","agency_id") REFERENCES "public"."agency"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quote" ADD CONSTRAINT "price_quote_requested_by_agency_user_fk" FOREIGN KEY ("organization_id","agency_id","requested_by_agency_user_id") REFERENCES "public"."agency_user"("organization_id","agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quote" ADD CONSTRAINT "price_quote_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate" ADD CONSTRAINT "rate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate" ADD CONSTRAINT "rate_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate" ADD CONSTRAINT "rate_room_type_fk" FOREIGN KEY ("organization_id","room_type_id") REFERENCES "public"."room_type"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pii_access_log" ADD CONSTRAINT "pii_access_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilgrim" ADD CONSTRAINT "pilgrim_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_hotel_fk" FOREIGN KEY ("organization_id","hotel_id") REFERENCES "public"."hotel"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_agency_fk" FOREIGN KEY ("organization_id","agency_id") REFERENCES "public"."agency"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_customer_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customer"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_quote_fk" FOREIGN KEY ("organization_id","quote_id","agency_id","hotel_id") REFERENCES "public"."price_quote"("organization_id","id","agency_id","hotel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_created_by_agency_user_fk" FOREIGN KEY ("organization_id","agency_id","created_by_agency_user_id") REFERENCES "public"."agency_user"("organization_id","agency_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_change" ADD CONSTRAINT "booking_change_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_change" ADD CONSTRAINT "booking_change_booking_fk" FOREIGN KEY ("organization_id","booking_id") REFERENCES "public"."booking"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_guest" ADD CONSTRAINT "booking_guest_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_guest" ADD CONSTRAINT "booking_guest_booking_fk" FOREIGN KEY ("organization_id","booking_id") REFERENCES "public"."booking"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_guest" ADD CONSTRAINT "booking_guest_pilgrim_fk" FOREIGN KEY ("organization_id","pilgrim_id") REFERENCES "public"."pilgrim"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_price_line" ADD CONSTRAINT "booking_price_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_price_line" ADD CONSTRAINT "booking_price_line_booking_fk" FOREIGN KEY ("organization_id","booking_id") REFERENCES "public"."booking"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_price_line" ADD CONSTRAINT "booking_price_line_room_type_fk" FOREIGN KEY ("organization_id","room_type_id") REFERENCES "public"."room_type"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_room" ADD CONSTRAINT "booking_room_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_room" ADD CONSTRAINT "booking_room_booking_fk" FOREIGN KEY ("organization_id","hotel_id","booking_id") REFERENCES "public"."booking"("organization_id","hotel_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_room" ADD CONSTRAINT "booking_room_room_fk" FOREIGN KEY ("organization_id","hotel_id","room_id") REFERENCES "public"."room"("organization_id","hotel_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_room" ADD CONSTRAINT "booking_room_owner_agency_fk" FOREIGN KEY ("organization_id","booking_id","owner_agency_id") REFERENCES "public"."booking"("organization_id","id","agency_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_room" ADD CONSTRAINT "booking_room_owner_booking_fk" FOREIGN KEY ("organization_id","owner_booking_id") REFERENCES "public"."booking"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_stay" ADD CONSTRAINT "guest_stay_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_stay" ADD CONSTRAINT "guest_stay_guest_fk" FOREIGN KEY ("organization_id","booking_id","booking_guest_id") REFERENCES "public"."booking_guest"("organization_id","booking_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_stay" ADD CONSTRAINT "guest_stay_room_fk" FOREIGN KEY ("organization_id","booking_id","booking_room_id") REFERENCES "public"."booking_room"("organization_id","booking_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotel_task" ADD CONSTRAINT "hotel_task_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotel_task" ADD CONSTRAINT "hotel_task_room_fk" FOREIGN KEY ("organization_id","hotel_id","room_id") REFERENCES "public"."room"("organization_id","hotel_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotel_task" ADD CONSTRAINT "hotel_task_booking_fk" FOREIGN KEY ("organization_id","hotel_id","booking_id") REFERENCES "public"."booking"("organization_id","hotel_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_guest_detail" ADD CONSTRAINT "booking_guest_detail_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_guest_detail" ADD CONSTRAINT "booking_guest_detail_guest_fk" FOREIGN KEY ("organization_id","booking_id","booking_guest_id") REFERENCES "public"."booking_guest"("organization_id","booking_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passport_scan" ADD CONSTRAINT "passport_scan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passport_scan" ADD CONSTRAINT "passport_scan_booking_fk" FOREIGN KEY ("organization_id","booking_id") REFERENCES "public"."booking"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passport_scan" ADD CONSTRAINT "passport_scan_guest_fk" FOREIGN KEY ("organization_id","booking_id","booking_guest_id") REFERENCES "public"."booking_guest"("organization_id","booking_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passport_scan" ADD CONSTRAINT "passport_scan_detail_fk" FOREIGN KEY ("organization_id","booking_id","booking_guest_id","booking_guest_detail_id") REFERENCES "public"."booking_guest_detail"("organization_id","booking_id","booking_guest_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passport_scan" ADD CONSTRAINT "passport_scan_document_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."document_asset"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agency_user_org_email_unique" ON "agency_user" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "agency_user_agency_idx" ON "agency_user" USING btree ("organization_id","agency_id");--> statement-breakpoint
CREATE INDEX "agency_quota_hotel_idx" ON "agency_quota" USING btree ("organization_id","hotel_id");--> statement-breakpoint
CREATE INDEX "agency_quota_agency_idx" ON "agency_quota" USING btree ("organization_id","agency_id");--> statement-breakpoint
CREATE INDEX "allocation_rule_hotel_idx" ON "allocation_rule" USING btree ("organization_id","hotel_id");--> statement-breakpoint
CREATE INDEX "extra_bed_policy_room_type_idx" ON "extra_bed_policy" USING btree ("organization_id","room_type_id");--> statement-breakpoint
CREATE INDEX "price_quote_requested_by_idx" ON "price_quote" USING btree ("organization_id","agency_id","requested_by_agency_user_id");--> statement-breakpoint
CREATE INDEX "price_quote_agency_idx" ON "price_quote" USING btree ("organization_id","agency_id","created_at");--> statement-breakpoint
CREATE INDEX "price_quote_hotel_idx" ON "price_quote" USING btree ("organization_id","hotel_id");--> statement-breakpoint
CREATE INDEX "rate_hotel_type_idx" ON "rate" USING btree ("organization_id","hotel_id","room_type_id");--> statement-breakpoint
CREATE INDEX "rate_room_type_idx" ON "rate" USING btree ("organization_id","room_type_id");--> statement-breakpoint
CREATE INDEX "pii_access_log_subject_idx" ON "pii_access_log" USING btree ("organization_id","subject_type","subject_id","accessed_at");--> statement-breakpoint
CREATE INDEX "pii_access_log_actor_idx" ON "pii_access_log" USING btree ("organization_id","actor_kind","actor_id","accessed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_quote_once" ON "booking" USING btree ("organization_id","quote_id") WHERE "booking"."quote_id" is not null and "booking"."status" <> 'EXPIRED';--> statement-breakpoint
CREATE INDEX "booking_hotel_stay_idx" ON "booking" USING btree ("organization_id","hotel_id","check_in","check_out");--> statement-breakpoint
CREATE INDEX "booking_agency_idx" ON "booking" USING btree ("organization_id","agency_id");--> statement-breakpoint
CREATE INDEX "booking_customer_idx" ON "booking" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "booking_quote_idx" ON "booking" USING btree ("organization_id","quote_id","agency_id","hotel_id");--> statement-breakpoint
CREATE INDEX "booking_created_by_agency_user_idx" ON "booking" USING btree ("organization_id","agency_id","created_by_agency_user_id");--> statement-breakpoint
CREATE INDEX "booking_pending_expiry_idx" ON "booking" USING btree ("hold_expires_at") WHERE "booking"."status" in ('HELD', 'REQUESTED');--> statement-breakpoint
CREATE INDEX "booking_change_booking_idx" ON "booking_change" USING btree ("organization_id","booking_id","created_at");--> statement-breakpoint
CREATE INDEX "booking_guest_pilgrim_idx" ON "booking_guest" USING btree ("organization_id","pilgrim_id");--> statement-breakpoint
CREATE INDEX "booking_price_line_room_type_idx" ON "booking_price_line" USING btree ("organization_id","room_type_id");--> statement-breakpoint
CREATE INDEX "booking_room_booking_idx" ON "booking_room" USING btree ("organization_id","hotel_id","booking_id");--> statement-breakpoint
CREATE INDEX "booking_room_room_idx" ON "booking_room" USING btree ("organization_id","hotel_id","room_id","check_in");--> statement-breakpoint
CREATE INDEX "booking_room_hotel_stay_idx" ON "booking_room" USING btree ("organization_id","hotel_id","check_in","check_out");--> statement-breakpoint
CREATE INDEX "booking_room_owner_agency_idx" ON "booking_room" USING btree ("organization_id","booking_id","owner_agency_id");--> statement-breakpoint
CREATE INDEX "booking_room_owner_booking_idx" ON "booking_room" USING btree ("organization_id","owner_booking_id");--> statement-breakpoint
CREATE INDEX "guest_stay_guest_idx" ON "guest_stay" USING btree ("organization_id","booking_id","booking_guest_id");--> statement-breakpoint
CREATE INDEX "guest_stay_room_idx" ON "guest_stay" USING btree ("organization_id","booking_id","booking_room_id");--> statement-breakpoint
CREATE INDEX "guest_stay_room_claim_idx" ON "guest_stay" USING btree ("organization_id","booking_room_id");--> statement-breakpoint
CREATE INDEX "hotel_task_open_idx" ON "hotel_task" USING btree ("organization_id","hotel_id","status","due_date");--> statement-breakpoint
CREATE INDEX "hotel_task_room_idx" ON "hotel_task" USING btree ("organization_id","hotel_id","room_id");--> statement-breakpoint
CREATE INDEX "hotel_task_booking_idx" ON "hotel_task" USING btree ("organization_id","hotel_id","booking_id");--> statement-breakpoint
CREATE INDEX "booking_guest_detail_booking_idx" ON "booking_guest_detail" USING btree ("organization_id","booking_id","booking_guest_id");--> statement-breakpoint
CREATE INDEX "booking_guest_detail_lookup_idx" ON "booking_guest_detail" USING btree ("organization_id","passport_lookup");--> statement-breakpoint
CREATE INDEX "passport_scan_booking_idx" ON "passport_scan" USING btree ("organization_id","booking_id","booking_guest_id");--> statement-breakpoint
CREATE INDEX "passport_scan_detail_idx" ON "passport_scan" USING btree ("organization_id","booking_id","booking_guest_id","booking_guest_detail_id");--> statement-breakpoint
CREATE INDEX "passport_scan_retention_idx" ON "passport_scan" USING btree ("delete_after");--> statement-breakpoint
CREATE INDEX "role_permission_permission_idx" ON "role_permission" USING btree ("permission_key");--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------------
-- Hand-appended (MIGRATIONS.md rule (c)): what the Drizzle DSL cannot express. btree_gist already exists
-- (0001/0004/0005/0006) and is repeated defensively.
-- Stays are [check_in, check_out) (nights up to the night before check-out); seasons are inclusive
-- [start_date, end_date] night ranges, like capacity_period. Status lists below mirror
-- packages/contracts/constants/booking.ts (schemaInvariants.test.ts compares them).
-- ---------------------------------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
-- One price per hotel, room type, price type and unit on any night.
ALTER TABLE "rate" ADD CONSTRAINT "rate_no_overlap"
  EXCLUDE USING gist ("hotel_id" WITH =, "room_type_id" WITH =, "price_type" WITH =, "unit" WITH =, daterange("start_date", "end_date", '[]') WITH &&);--> statement-breakpoint
-- One quota per hotel and agency (or the default row, agency_id NULL) on any night.
ALTER TABLE "agency_quota" ADD CONSTRAINT "agency_quota_no_overlap"
  EXCLUDE USING gist ("hotel_id" WITH =, (coalesce("agency_id", '00000000-0000-0000-0000-000000000000'::uuid)) WITH =, daterange("start_date", "end_date", '[]') WITH &&);--> statement-breakpoint
-- One room-mix rule per hotel for any group size (group_max NULL = no upper bound).
ALTER TABLE "allocation_rule" ADD CONSTRAINT "allocation_rule_no_overlap"
  EXCLUDE USING gist ("hotel_id" WITH =, int4range("group_min", "group_max", '[]') WITH &&);--> statement-breakpoint
-- v7 §16: on overlapping nights a room has ONE owner (an agency, or one family/individual booking) and ONE
-- occupancy (men, women or a family), whatever bugs the application code may have; and one booking never
-- claims the same room twice for overlapping nights. Only claims that hold seats count: cancelled, expired,
-- completed and released claims never block a room. (An expired hold whose status was not swept yet still
-- blocks here: the hold transaction first expires such holds on the rooms it has locked, v7 §10.)
ALTER TABLE "booking_room" ADD CONSTRAINT "booking_room_one_owner"
  EXCLUDE USING gist ("room_id" WITH =, daterange("check_in", "check_out", '[)') WITH &&, "owner_key" WITH <>)
  WHERE ("status" IN ('HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE'));--> statement-breakpoint
ALTER TABLE "booking_room" ADD CONSTRAINT "booking_room_one_occupancy"
  EXCLUDE USING gist ("room_id" WITH =, daterange("check_in", "check_out", '[)') WITH &&, "occupancy" WITH <>)
  WHERE ("status" IN ('HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE'));--> statement-breakpoint
ALTER TABLE "booking_room" ADD CONSTRAINT "booking_room_no_duplicate"
  EXCLUDE USING gist ("booking_id" WITH =, "room_id" WITH =, daterange("check_in", "check_out", '[)') WITH &&)
  WHERE ("status" IN ('HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE'));--> statement-breakpoint
-- A pilgrim slot sleeps in one bed per night (a room move is two back-to-back stays).
ALTER TABLE "guest_stay" ADD CONSTRAINT "guest_stay_one_bed_per_night"
  EXCLUDE USING gist ("booking_guest_id" WITH =, daterange("check_in", "check_out", '[)') WITH &&);--> statement-breakpoint
-- A room claim's status IS its booking's status, unless the claim alone was RELEASED (a room move or date
-- change dropped it): every booking status change is copied to its unreleased claims, and a claim whose
-- status differs from its booking's is refused — the exclusion constraints and the seat count key off
-- booking_room.status, so the two can never drift apart.
CREATE FUNCTION booking_room_follow_booking_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.booking_room SET status = NEW.status, updated_at = now()
  WHERE organization_id = NEW.organization_id AND booking_id = NEW.id AND status <> 'RELEASED' AND status <> NEW.status;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER booking_status_to_rooms AFTER UPDATE OF status ON "booking"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION booking_room_follow_booking_status();--> statement-breakpoint
CREATE FUNCTION booking_room_status_matches_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  booking_status text;
BEGIN
  IF NEW.status = 'RELEASED' THEN RETURN NEW; END IF;
  SELECT b.status INTO booking_status FROM public.booking b WHERE b.organization_id = NEW.organization_id AND b.id = NEW.booking_id;
  IF booking_status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'a room claim''s status must be its booking''s status or RELEASED'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_room_status_matches_booking';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER booking_room_status_guard BEFORE INSERT OR UPDATE OF status ON "booking_room"
  FOR EACH ROW EXECUTE FUNCTION booking_room_status_matches_booking();--> statement-breakpoint
-- Containment (checked at COMMIT, so a date change may move a booking, its claims and stays in any order
-- inside one transaction): a stay lies within its room claim, and a room claim within its booking's stay.
-- Otherwise a stay could count seats on nights no exclusion constraint protects for its owner.
CREATE FUNCTION assert_booking_stays_contained(p_organization_id uuid, p_booking_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.booking_room br JOIN public.booking b ON b.organization_id = br.organization_id AND b.id = br.booking_id
    WHERE br.organization_id = p_organization_id AND br.booking_id = p_booking_id
      AND (br.check_in < b.check_in OR br.check_out > b.check_out)) THEN
    RAISE EXCEPTION 'a room claim must lie within its booking''s stay'
      USING ERRCODE = '23514', CONSTRAINT = 'booking_room_within_booking';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.guest_stay gs JOIN public.booking_room br ON br.organization_id = gs.organization_id AND br.id = gs.booking_room_id
    WHERE gs.organization_id = p_organization_id AND gs.booking_id = p_booking_id
      AND (gs.check_in < br.check_in OR gs.check_out > br.check_out)) THEN
    RAISE EXCEPTION 'a guest stay must lie within its room claim'
      USING ERRCODE = '23514', CONSTRAINT = 'guest_stay_within_claim';
  END IF;
END $$;--> statement-breakpoint
CREATE FUNCTION booking_stays_contained_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Separate statements: PL/pgSQL resolves NEW.booking_id only when that branch runs (booking has no such column).
  IF TG_TABLE_NAME = 'booking' THEN
    PERFORM assert_booking_stays_contained(NEW.organization_id, NEW.id);
  ELSE
    PERFORM assert_booking_stays_contained(NEW.organization_id, NEW.booking_id);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER booking_dates_contain_stays AFTER UPDATE OF check_in, check_out ON "booking"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_stays_contained_trigger();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER booking_room_contained AFTER INSERT OR UPDATE OF check_in, check_out, booking_id ON "booking_room"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_stays_contained_trigger();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER guest_stay_contained AFTER INSERT OR UPDATE ON "guest_stay"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_stays_contained_trigger();--> statement-breakpoint
-- booking_change and pii_access_log are append-only, like audit_log (0002).
CREATE FUNCTION forbid_row_update() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;--> statement-breakpoint
CREATE TRIGGER booking_change_no_update BEFORE UPDATE ON "booking_change"
  FOR EACH ROW EXECUTE FUNCTION forbid_row_update();--> statement-breakpoint
CREATE TRIGGER pii_access_log_no_update BEFORE UPDATE ON "pii_access_log"
  FOR EACH ROW EXECUTE FUNCTION forbid_row_update();--> statement-breakpoint
-- v7 §16: seats used per room and night — the ONE counting rule for the allocator, the locked hold
-- re-check, inventory-conflict checks and the occupancy calendar. A function rather than a view so the
-- night range is applied BEFORE stays are expanded into nights (a view's LATERAL generate_series cannot be
-- filtered first, so every call would expand the hotel's whole history). Nights `p_from`..`p_to`
-- inclusive; `p_room_ids` NULL = every room of the hotel. Rows only for room-nights with seats (sparse).
-- Infants (age_group INFANT) and removed slots never count. An expired pending hold stops counting at once,
-- before the sweep (now() is allowed here, not in a constraint); ticket 2: `coalesce(…, false)` keeps a
-- pending booking whose expiry is NULL COUNTED — three-valued logic would otherwise silently free its seats
-- (the CHECK booking_hold_expiry_check also forbids the NULL). Nights come from date arithmetic, never a
-- timestamp series, so the session time zone cannot shift them.
CREATE FUNCTION room_night_occupancy(p_organization_id uuid, p_hotel_id uuid, p_from date, p_to date, p_room_ids uuid[] DEFAULT NULL)
RETURNS TABLE (room_id uuid, night date, seats_used integer)
LANGUAGE sql STABLE AS $$
  SELECT br.room_id, gs.check_in + d.i AS night, count(*)::integer AS seats_used
  FROM public.booking_room br
  JOIN public.booking b ON b.organization_id = br.organization_id AND b.id = br.booking_id
  JOIN public.guest_stay gs ON gs.organization_id = br.organization_id AND gs.booking_room_id = br.id
  JOIN public.booking_guest g ON g.organization_id = gs.organization_id AND g.id = gs.booking_guest_id
  CROSS JOIN LATERAL generate_series(greatest(0, p_from - gs.check_in), least(gs.check_out - gs.check_in, p_to - gs.check_in + 1) - 1) AS d(i)
  WHERE br.organization_id = p_organization_id
    AND br.hotel_id = p_hotel_id
    AND (p_room_ids IS NULL OR br.room_id = ANY (p_room_ids))
    AND br.check_in <= p_to AND br.check_out > p_from
    AND gs.check_in <= p_to AND gs.check_out > p_from
    AND br.status IN ('HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE')
    AND g.age_group <> 'INFANT'
    AND g.status <> 'REMOVED'
    AND NOT (b.status IN ('HELD', 'REQUESTED') AND coalesce(b.hold_expires_at <= now(), false))
  GROUP BY br.room_id, gs.check_in + d.i
$$;
