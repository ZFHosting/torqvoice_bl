-- AlterTable
ALTER TABLE "source_records" ADD COLUMN     "loadedHash" TEXT,
ADD COLUMN     "localEntity" TEXT,
ADD COLUMN     "localId" TEXT;

-- CreateIndex
CREATE INDEX "source_records_organizationId_localEntity_localId_idx" ON "source_records"("organizationId", "localEntity", "localId");
