-- CreateTable
CREATE TABLE "inbound_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inbound_webhook_deliveries_receivedAt_idx" ON "inbound_webhook_deliveries"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_webhook_deliveries_connectionId_deliveryId_key" ON "inbound_webhook_deliveries"("connectionId", "deliveryId");
