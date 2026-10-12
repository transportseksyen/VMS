-- Supabase recommends keeping extensions out of the exposed public schema.
CREATE SCHEMA IF NOT EXISTS extensions;
ALTER EXTENSION btree_gist SET SCHEMA extensions;
