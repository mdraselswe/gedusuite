# Legacy one-off scripts

These were written for the first shop's production database (backfills,
rate-card loads, data repairs). They are kept for history and for that shop's
own use; **they are not part of the product and a new installation never needs
them.** Each reads `.env.local` and writes to whatever `DATABASE_URL` points at,
so read a script before running it.
