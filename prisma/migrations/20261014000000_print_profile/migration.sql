-- Print templates become per-workspace settings. Additive only.
ALTER TABLE "Workspace" ADD COLUMN "printProfile" JSONB;

-- The first workspace's gift tag and leaflet used to be fixed in code. Carry
-- its wording across as data so its paperwork prints exactly as before once the
-- code stops knowing about it. Selected by what it is (its own website), not by
-- name or id, and only if nobody has set a profile yet.
UPDATE "Workspace"
SET "printProfile" = jsonb_build_object(
  'facebook', 'facebook.com/gedushop',
  'whatsapp', '01552-958606',
  'tagline', 'শিশুর জন্য যা কিছু দরকার',
  'headline', E'বাচ্চাদের খেলনা ও\nবেবি কেয়ারের সবকিছু',
  'giftLead', '🎁 ছোট্ট একটি উপহার, আমাদের পক্ষ থেকে ভালোবাসার নিদর্শন।',
  'giftQuote', 'একবারের বিশ্বাস, বারবারের ভালোবাসা।',
  'giftThanks', 'GeduShop পরিবারের অংশ হওয়ার জন্য আন্তরিক ধন্যবাদ। আশা করি উপহারটি আপনার ভালো লাগবে। আবারও আপনার পরবর্তী অর্ডারে আপনাকে স্বাগত!',
  'giftClosing', '💜 আপনার সোনামণির হাসিমুখই আমাদের সবচেয়ে বড় পাওয়া!'
)
WHERE "printProfile" IS NULL
  AND "websiteUrl" ILIKE '%gedushop.com%';
