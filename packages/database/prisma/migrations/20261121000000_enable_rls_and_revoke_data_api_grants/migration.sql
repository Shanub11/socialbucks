-- ============================================================
-- Migration: enable_rls_and_revoke_data_api_grants
-- Date:      2026-11-21
--
-- Supabase exposes the public schema through its Data API using the roles
-- anon and authenticated.  An audit showed every public table had RLS off
-- and full privileges granted to both roles.  This migration makes every
-- environment consistent by:
--
--   1. Enabling Row Level Security on every ordinary and partitioned table
--      in schema public (including _prisma_migrations).
--   2. Revoking all table privileges from anon and authenticated and
--      removing their default privileges on new tables.
--
-- No policies are created: the two roles have zero access.  The app and
-- worker connect as the table owner (postgres), which bypasses RLS, so
-- this migration has no effect on the owner role.
--
-- CI and local test databases are plain PostgreSQL where anon and
-- authenticated do not exist.  Every statement that names either role is
-- guarded by an existence check so the migration succeeds everywhere.
--
-- Safe to re-run: ENABLE ROW LEVEL SECURITY is a no-op when already
-- enabled, REVOKE is a no-op when nothing is granted, and ALTER DEFAULT
-- PRIVILEGES REVOKE is idempotent.
-- ============================================================

DO $$
DECLARE
  _tbl record;
  _role text;
BEGIN
  -- 1. Enable RLS on every ordinary (r) and partitioned (p) table in public.
  FOR _tbl IN
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', _tbl.table_name);
  END LOOP;

  -- 2. Revoke Data-API role privileges (only if the role exists).
  FOREACH _role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = _role) THEN
      FOR _tbl IN
        SELECT c.relname AS table_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p')
      LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', _tbl.table_name, _role);
      END LOOP;

      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', _role);
    END IF;
  END LOOP;
END;
$$;
