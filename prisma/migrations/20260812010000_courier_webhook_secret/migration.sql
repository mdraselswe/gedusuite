-- Steadfast's webhook form asks for a callback URL and a bearer auth token.
-- The token in the URL says which workspace a call is about; this says the
-- caller is really the courier, so a URL leaking through a proxy log does not
-- hand anyone the ability to write delivery statuses.
ALTER TABLE "Courier" ADD COLUMN "webhookSecret" TEXT;
