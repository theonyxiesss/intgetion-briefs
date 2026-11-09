-- Morning-brief tables in their final shape (platform migration 0032 and the brief
-- columns of later ones), taken from a database migrated to the latest platform
-- state, with the default slots and settings row. On a live database every statement
-- is a no-op and existing slot times are kept. Safe to run again.

CREATE TABLE IF NOT EXISTS public.brief_deliveries (
    user_id uuid NOT NULL,
    audience text NOT NULL,
    slot_date date NOT NULL,
    slot_id text NOT NULL,
    item_ids text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brief_deliveries_audience_check CHECK ((audience = ANY (ARRAY['candidate'::text, 'employer'::text])))
);

ALTER TABLE ONLY public.brief_deliveries FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.brief_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slot_id text NOT NULL,
    slot_date date NOT NULL,
    dry_run boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    checked integer DEFAULT 0 NOT NULL,
    sent integer DEFAULT 0 NOT NULL,
    empty integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    error text,
    checked_employers integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.brief_runs FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.brief_settings (
    id boolean DEFAULT true NOT NULL,
    paused boolean DEFAULT false NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brief_settings_single_row CHECK (id)
);

ALTER TABLE ONLY public.brief_settings FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.brief_slots (
    id text NOT NULL,
    timezone text NOT NULL,
    local_time text DEFAULT '08:00'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brief_slots_id_check CHECK ((id = ANY (ARRAY['americas'::text, 'europe'::text, 'cis'::text]))),
    CONSTRAINT brief_slots_time_check CHECK ((local_time ~ '^([01][0-9]|2[0-3]):(00|15|30|45)$'::text))
);

ALTER TABLE ONLY public.brief_slots FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brief_deliveries_pkey') THEN
    ALTER TABLE public.brief_deliveries ADD CONSTRAINT brief_deliveries_pkey PRIMARY KEY (user_id, audience, slot_date);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brief_runs_pkey') THEN
    ALTER TABLE public.brief_runs ADD CONSTRAINT brief_runs_pkey PRIMARY KEY (id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brief_settings_pkey') THEN
    ALTER TABLE public.brief_settings ADD CONSTRAINT brief_settings_pkey PRIMARY KEY (id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brief_slots_pkey') THEN
    ALTER TABLE public.brief_slots ADD CONSTRAINT brief_slots_pkey PRIMARY KEY (id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS brief_runs_live_once_idx ON public.brief_runs USING btree (slot_id, slot_date) WHERE (NOT dry_run);

CREATE INDEX IF NOT EXISTS brief_runs_started_idx ON public.brief_runs USING btree (started_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brief_deliveries_slot_id_fkey') THEN
    ALTER TABLE public.brief_deliveries ADD CONSTRAINT brief_deliveries_slot_id_fkey FOREIGN KEY (slot_id) REFERENCES public.brief_slots(id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brief_deliveries_user_id_fkey') THEN
    ALTER TABLE public.brief_deliveries ADD CONSTRAINT brief_deliveries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brief_runs_slot_id_fkey') THEN
    ALTER TABLE public.brief_runs ADD CONSTRAINT brief_runs_slot_id_fkey FOREIGN KEY (slot_id) REFERENCES public.brief_slots(id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brief_settings_updated_by_fkey') THEN
    ALTER TABLE public.brief_settings ADD CONSTRAINT brief_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brief_slots_updated_by_fkey') THEN
    ALTER TABLE public.brief_slots ADD CONSTRAINT brief_slots_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END
$$;

ALTER TABLE public.brief_deliveries ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brief_deliveries' AND policyname = 'brief_deliveries_anon_deny') THEN
    CREATE POLICY brief_deliveries_anon_deny ON public.brief_deliveries TO anon USING (false) WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brief_deliveries' AND policyname = 'brief_deliveries_app_rw_all') THEN
    CREATE POLICY brief_deliveries_app_rw_all ON public.brief_deliveries TO app_rw USING (true) WITH CHECK (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brief_deliveries' AND policyname = 'brief_deliveries_authenticated_deny') THEN
    CREATE POLICY brief_deliveries_authenticated_deny ON public.brief_deliveries TO authenticated USING (false) WITH CHECK (false);
  END IF;
END
$$;

ALTER TABLE public.brief_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brief_runs' AND policyname = 'brief_runs_anon_deny') THEN
    CREATE POLICY brief_runs_anon_deny ON public.brief_runs TO anon USING (false) WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brief_runs' AND policyname = 'brief_runs_app_rw_all') THEN
    CREATE POLICY brief_runs_app_rw_all ON public.brief_runs TO app_rw USING (true) WITH CHECK (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brief_runs' AND policyname = 'brief_runs_authenticated_deny') THEN
    CREATE POLICY brief_runs_authenticated_deny ON public.brief_runs TO authenticated USING (false) WITH CHECK (false);
  END IF;
END
$$;

ALTER TABLE public.brief_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brief_settings' AND policyname = 'brief_settings_anon_deny') THEN
    CREATE POLICY brief_settings_anon_deny ON public.brief_settings TO anon USING (false) WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brief_settings' AND policyname = 'brief_settings_app_rw_all') THEN
    CREATE POLICY brief_settings_app_rw_all ON public.brief_settings TO app_rw USING (true) WITH CHECK (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brief_settings' AND policyname = 'brief_settings_authenticated_deny') THEN
    CREATE POLICY brief_settings_authenticated_deny ON public.brief_settings TO authenticated USING (false) WITH CHECK (false);
  END IF;
END
$$;

ALTER TABLE public.brief_slots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brief_slots' AND policyname = 'brief_slots_anon_deny') THEN
    CREATE POLICY brief_slots_anon_deny ON public.brief_slots TO anon USING (false) WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brief_slots' AND policyname = 'brief_slots_app_rw_all') THEN
    CREATE POLICY brief_slots_app_rw_all ON public.brief_slots TO app_rw USING (true) WITH CHECK (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'brief_slots' AND policyname = 'brief_slots_authenticated_deny') THEN
    CREATE POLICY brief_slots_authenticated_deny ON public.brief_slots TO authenticated USING (false) WITH CHECK (false);
  END IF;
END
$$;

-- Default slots and the settings row. On a live database RLS is already forced;
-- lift it for the seed so the owner can insert, then restore it.
ALTER TABLE public.brief_slots NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.brief_settings NO FORCE ROW LEVEL SECURITY;

INSERT INTO public.brief_slots (id, timezone, local_time) VALUES
  ('americas', 'America/Chicago', '08:00'),
  ('europe', 'Europe/Berlin', '08:00'),
  ('cis', 'Europe/Moscow', '08:00')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.brief_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.brief_slots FORCE ROW LEVEL SECURITY;
ALTER TABLE public.brief_settings FORCE ROW LEVEL SECURITY;
