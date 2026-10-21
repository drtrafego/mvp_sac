ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS instagram_inbox_placement text NOT NULL DEFAULT 'general';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'settings_instagram_inbox_placement_check'
  ) THEN
    ALTER TABLE settings
      ADD CONSTRAINT settings_instagram_inbox_placement_check
      CHECK (instagram_inbox_placement IN ('general', 'exclusive'));
  END IF;
END $$;
