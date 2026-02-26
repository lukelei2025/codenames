CREATE TABLE IF NOT EXISTS turn_click_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  turn_team TEXT NOT NULL CHECK (turn_team IN ('red', 'blue')),
  card_word TEXT NOT NULL,
  card_color TEXT NOT NULL CHECK (card_color IN ('red', 'blue', 'neutral', 'assassin')),
  is_correct BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turn_click_logs_room_created_at
  ON turn_click_logs(room_id, created_at);

ALTER TABLE turn_click_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE tablename = 'turn_click_logs'
        AND policyname = 'Allow anonymous read turn_click_logs'
    ) THEN
        CREATE POLICY "Allow anonymous read turn_click_logs"
          ON turn_click_logs
          FOR SELECT
          USING (true);
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE tablename = 'turn_click_logs'
        AND policyname = 'Allow anonymous insert turn_click_logs'
    ) THEN
        CREATE POLICY "Allow anonymous insert turn_click_logs"
          ON turn_click_logs
          FOR INSERT
          WITH CHECK (true);
    END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'turn_click_logs'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE turn_click_logs';
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Ignore errors if publication doesn't exist or already added
END
$$;
