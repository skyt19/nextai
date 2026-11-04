-- AlterTable
ALTER TABLE "packages" ADD COLUMN "reference_model_id" TEXT;
ALTER TABLE "packages" ADD COLUMN "package_selling_price_thb" DECIMAL NOT NULL DEFAULT 51.00;
