-- Setup for Codenames Game Database

-- 1. Create the rooms table
CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  theme TEXT NOT NULL DEFAULT 'General',
  language TEXT NOT NULL DEFAULT '中文'
);

-- Safely add new columns if table already existed without them
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS current_turn TEXT NOT NULL DEFAULT 'red';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS winner TEXT DEFAULT NULL;

-- 2. Create the cards table
CREATE TABLE IF NOT EXISTS cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  color TEXT NOT NULL, -- 'red', 'blue', 'neutral', 'assassin'
  is_revealed BOOLEAN DEFAULT FALSE,
  position INTEGER NOT NULL
);

-- 3. Enable row level security (RLS) but allow anonymous access for this game
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards ENABLE ROW LEVEL SECURITY;

-- Safely create policies
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rooms' AND policyname = 'Allow anonymous read rooms') THEN
        CREATE POLICY "Allow anonymous read rooms" ON rooms FOR SELECT USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rooms' AND policyname = 'Allow anonymous insert rooms') THEN
        CREATE POLICY "Allow anonymous insert rooms" ON rooms FOR INSERT WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rooms' AND policyname = 'Allow anonymous update rooms') THEN
        CREATE POLICY "Allow anonymous update rooms" ON rooms FOR UPDATE USING (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cards' AND policyname = 'Allow anonymous read cards') THEN
        CREATE POLICY "Allow anonymous read cards" ON cards FOR SELECT USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cards' AND policyname = 'Allow anonymous insert cards') THEN
        CREATE POLICY "Allow anonymous insert cards" ON cards FOR INSERT WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cards' AND policyname = 'Allow anonymous update cards') THEN
        CREATE POLICY "Allow anonymous update cards" ON cards FOR UPDATE USING (true);
    END IF;
END
$$;

-- 4. Turn on Realtime for both tables safely
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'rooms'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE rooms';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'cards'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE cards';
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Ignore errors if publication doesn't exist or already added
END
$$;
