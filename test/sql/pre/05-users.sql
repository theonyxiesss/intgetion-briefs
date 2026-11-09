DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN CREATE ROLE app_rw; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- As on Supabase: API roles can reach the public schema; RLS decides the rows.
GRANT USAGE ON SCHEMA public TO app_rw, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO app_rw;

-- Platform users and Telegram accounts (CI only; the platform owns them).

-- Shared types: created only when missing (other modules use them too).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'platform_role') THEN
    CREATE TYPE public.platform_role AS ENUM ('user', 'admin');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
    CREATE TYPE public.user_status AS ENUM ('active', 'suspended', 'deleted', 'banned');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.telegram_accounts (
    telegram_id bigint NOT NULL,
    user_id uuid NOT NULL,
    username text,
    linked_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.telegram_accounts FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    auth_uid uuid NOT NULL,
    platform_role public.platform_role DEFAULT 'user'::public.platform_role NOT NULL,
    status public.user_status DEFAULT 'active'::public.user_status NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    terms_accepted_at timestamp with time zone NOT NULL,
    terms_version text NOT NULL,
    marketing_opt_in boolean DEFAULT false NOT NULL,
    last_active_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT users_locale_check CHECK ((locale = ANY (ARRAY['en'::text, 'ru'::text, 'es'::text, 'pt-BR'::text, 'de'::text, 'fr'::text, 'it'::text])))
);

ALTER TABLE ONLY public.users FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'telegram_accounts_pkey') THEN
    ALTER TABLE public.telegram_accounts ADD CONSTRAINT telegram_accounts_pkey PRIMARY KEY (telegram_id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'telegram_accounts_user_id_key') THEN
    ALTER TABLE public.telegram_accounts ADD CONSTRAINT telegram_accounts_user_id_key UNIQUE (user_id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_auth_uid_key') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_auth_uid_key UNIQUE (auth_uid);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_pkey') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
  END IF;
END
$$;

CREATE OR REPLACE TRIGGER users_set_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'telegram_accounts_user_id_fkey') THEN
    ALTER TABLE public.telegram_accounts ADD CONSTRAINT telegram_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;
END
$$;

ALTER TABLE public.telegram_accounts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'telegram_accounts' AND policyname = 'telegram_accounts_anon_deny') THEN
    CREATE POLICY telegram_accounts_anon_deny ON public.telegram_accounts TO anon USING (false) WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'telegram_accounts' AND policyname = 'telegram_accounts_app_rw_all') THEN
    CREATE POLICY telegram_accounts_app_rw_all ON public.telegram_accounts TO app_rw USING (true) WITH CHECK (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'telegram_accounts' AND policyname = 'telegram_accounts_authenticated_deny') THEN
    CREATE POLICY telegram_accounts_authenticated_deny ON public.telegram_accounts TO authenticated USING (false) WITH CHECK (false);
  END IF;
END
$$;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_anon_deny') THEN
    CREATE POLICY users_anon_deny ON public.users TO anon USING (false) WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_app_rw_all') THEN
    CREATE POLICY users_app_rw_all ON public.users TO app_rw USING (true) WITH CHECK (true);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_authenticated_deny') THEN
    CREATE POLICY users_authenticated_deny ON public.users TO authenticated USING (false) WITH CHECK (false);
  END IF;
END
$$;
