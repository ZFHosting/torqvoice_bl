-- AlterTable
ALTER TABLE "quote_labor" ADD COLUMN     "completed" BOOLEAN,
ADD COLUMN     "costHours" DOUBLE PRECISION,
ADD COLUMN     "costRate" DOUBLE PRECISION,
ADD COLUMN     "discountAmount" DOUBLE PRECISION,
ADD COLUMN     "jobId" TEXT,
ADD COLUMN     "lineKind" TEXT,
ADD COLUMN     "sourceExtra" JSONB,
ADD COLUMN     "technicianId" TEXT;

-- AlterTable
ALTER TABLE "quote_parts" ADD COLUMN     "discountAmount" DOUBLE PRECISION,
ADD COLUMN     "jobId" TEXT,
ADD COLUMN     "lineKind" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "sourceExtra" JSONB;

-- AlterTable
ALTER TABLE "service_labor" ADD COLUMN     "completed" BOOLEAN,
ADD COLUMN     "costHours" DOUBLE PRECISION,
ADD COLUMN     "costRate" DOUBLE PRECISION,
ADD COLUMN     "discountAmount" DOUBLE PRECISION,
ADD COLUMN     "jobId" TEXT,
ADD COLUMN     "lineKind" TEXT,
ADD COLUMN     "sourceExtra" JSONB,
ADD COLUMN     "technicianId" TEXT;

-- AlterTable
ALTER TABLE "service_parts" ADD COLUMN     "discountAmount" DOUBLE PRECISION,
ADD COLUMN     "jobId" TEXT,
ADD COLUMN     "lineKind" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "sourceExtra" JSONB;

-- CreateTable
CREATE TABLE "source_records" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'shopmonkey',
    "table" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "remoteUpdatedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remoteDeletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "serviceRecordId" TEXT,
    "quoteId" TEXT,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "authorizationStatus" TEXT,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "lumpSum" BOOLEAN NOT NULL DEFAULT false,
    "fixedPrice" DOUBLE PRECISION,
    "deferredDate" TIMESTAMP(3),
    "deferredReason" TEXT,
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "work_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contacts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "marketingOptIn" BOOLEAN,
    "subscribed" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_record_meta" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "serviceRecordId" TEXT NOT NULL,
    "sourceStatus" TEXT,
    "serviceWriterUserId" TEXT,
    "serviceWriterName" TEXT,
    "mileageOut" INTEGER,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorizedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "fullyPaidAt" TIMESTAMP(3),
    "purchaseOrderNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_record_meta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_shifts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "technicianId" TEXT NOT NULL,
    "clockIn" TIMESTAMP(3) NOT NULL,
    "clockOut" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'app',
    "sourceRemoteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "technician_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "serviceUserId" TEXT NOT NULL,
    "createdById" TEXT,
    "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_idempotency_keys" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deleted_records" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,

    CONSTRAINT "deleted_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_records_organizationId_table_remoteId_idx" ON "source_records"("organizationId", "table", "remoteId");

-- CreateIndex
CREATE INDEX "source_records_organizationId_updatedAt_id_idx" ON "source_records"("organizationId", "updatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "source_records_connectionId_table_remoteId_key" ON "source_records"("connectionId", "table", "remoteId");

-- CreateIndex
CREATE INDEX "work_jobs_serviceRecordId_idx" ON "work_jobs"("serviceRecordId");

-- CreateIndex
CREATE INDEX "work_jobs_quoteId_idx" ON "work_jobs"("quoteId");

-- CreateIndex
CREATE INDEX "work_jobs_organizationId_updatedAt_id_idx" ON "work_jobs"("organizationId", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "customer_contacts_customerId_idx" ON "customer_contacts"("customerId");

-- CreateIndex
CREATE INDEX "customer_contacts_organizationId_updatedAt_id_idx" ON "customer_contacts"("organizationId", "updatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_record_meta_serviceRecordId_key" ON "service_record_meta"("serviceRecordId");

-- CreateIndex
CREATE INDEX "service_record_meta_organizationId_updatedAt_id_idx" ON "service_record_meta"("organizationId", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "technician_shifts_technicianId_clockIn_idx" ON "technician_shifts"("technicianId", "clockIn");

-- CreateIndex
CREATE INDEX "technician_shifts_organizationId_clockIn_idx" ON "technician_shifts"("organizationId", "clockIn");

-- CreateIndex
CREATE INDEX "technician_shifts_organizationId_updatedAt_id_idx" ON "technician_shifts"("organizationId", "updatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_serviceUserId_key" ON "api_keys"("serviceUserId");

-- CreateIndex
CREATE INDEX "api_keys_organizationId_idx" ON "api_keys"("organizationId");

-- CreateIndex
CREATE INDEX "api_idempotency_keys_createdAt_idx" ON "api_idempotency_keys"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_idempotency_keys_apiKeyId_key_key" ON "api_idempotency_keys"("apiKeyId", "key");

-- CreateIndex
CREATE INDEX "deleted_records_organizationId_deletedAt_idx" ON "deleted_records"("organizationId", "deletedAt");

-- CreateIndex
CREATE INDEX "deleted_records_organizationId_entityType_deletedAt_idx" ON "deleted_records"("organizationId", "entityType", "deletedAt");

-- CreateIndex
CREATE INDEX "quote_labor_jobId_idx" ON "quote_labor"("jobId");

-- CreateIndex
CREATE INDEX "quote_labor_technicianId_idx" ON "quote_labor"("technicianId");

-- CreateIndex
CREATE INDEX "quote_parts_jobId_idx" ON "quote_parts"("jobId");

-- CreateIndex
CREATE INDEX "service_labor_jobId_idx" ON "service_labor"("jobId");

-- CreateIndex
CREATE INDEX "service_labor_technicianId_idx" ON "service_labor"("technicianId");

-- CreateIndex
CREATE INDEX "service_parts_jobId_idx" ON "service_parts"("jobId");

-- AddForeignKey
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_jobs" ADD CONSTRAINT "work_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_jobs" ADD CONSTRAINT "work_jobs_serviceRecordId_fkey" FOREIGN KEY ("serviceRecordId") REFERENCES "service_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_jobs" ADD CONSTRAINT "work_jobs_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_record_meta" ADD CONSTRAINT "service_record_meta_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_record_meta" ADD CONSTRAINT "service_record_meta_serviceRecordId_fkey" FOREIGN KEY ("serviceRecordId") REFERENCES "service_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_shifts" ADD CONSTRAINT "technician_shifts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_shifts" ADD CONSTRAINT "technician_shifts_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_serviceUserId_fkey" FOREIGN KEY ("serviceUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deleted_records" ADD CONSTRAINT "deleted_records_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_parts" ADD CONSTRAINT "quote_parts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "work_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_labor" ADD CONSTRAINT "quote_labor_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "work_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_labor" ADD CONSTRAINT "quote_labor_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_parts" ADD CONSTRAINT "service_parts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "work_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_labor" ADD CONSTRAINT "service_labor_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "work_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_labor" ADD CONSTRAINT "service_labor_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE;
