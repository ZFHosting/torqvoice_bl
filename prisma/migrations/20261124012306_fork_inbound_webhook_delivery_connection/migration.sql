-- fork (M7): a delivery goes with its connection. Deliveries whose connection is already gone are removed first,
-- or the key couldn't be added.
DELETE FROM "inbound_webhook_deliveries" AS d
WHERE NOT EXISTS (SELECT 1 FROM "integration_connections" AS c WHERE c."id" = d."connectionId");

-- AddForeignKey
ALTER TABLE "inbound_webhook_deliveries" ADD CONSTRAINT "inbound_webhook_deliveries_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
