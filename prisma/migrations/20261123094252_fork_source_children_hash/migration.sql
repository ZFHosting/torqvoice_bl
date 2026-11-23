-- AlterTable
ALTER TABLE "source_records" ADD COLUMN     "childrenHash" TEXT;

-- CreateIndex
CREATE INDEX "source_records_organizationId_source_table_id_idx" ON "source_records"("organizationId", "source", "table", "id");
