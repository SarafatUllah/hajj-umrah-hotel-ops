CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "user_role" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
UPDATE "user_role" ur SET "organization_id" = u."organization_id" FROM "app_user" u WHERE u."id" = ur."user_id";--> statement-breakpoint
DELETE FROM "user_role" ur USING "role" r WHERE r."id" = ur."role_id" AND r."organization_id" <> ur."organization_id";--> statement-breakpoint
ALTER TABLE "user_role" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_org_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_org_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "user_role" DROP CONSTRAINT "user_role_user_id_app_user_id_fk";
--> statement-breakpoint
ALTER TABLE "user_role" DROP CONSTRAINT "user_role_role_id_role_id_fk";
--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_org_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."app_user"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_org_role_fk" FOREIGN KEY ("organization_id","role_id") REFERENCES "public"."role"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_role_user_idx" ON "user_role" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "user_role_role_idx" ON "user_role" USING btree ("organization_id","role_id");
