-- Lost prospects' client files are kept 12 months, then deleted (docs/plan.md §1.149 owner decision
-- q14; §1.220, C7). The Worker has no DELETE on client_file (0066 grants SELECT, INSERT, UPDATE),
-- and gets none: this one function deletes only files past that age, and the hourly retention job
-- (apps/api) calls it. A client fact goes with its file (client_fact.file_id ON DELETE CASCADE), and
-- a deal that named the file keeps its own row with client_file_id set to null (ON DELETE SET NULL).
--
-- A lost prospect's file: it never became a client (client_id is null), at least one deal names it,
-- every deal that names it closed without a sale (outcome `lost` or `no`), and the last of them
-- closed more than 12 months ago. A file with an open, won or "not now" deal, or with no deal at
-- all, is kept.
-- DECISION: `no` (they said no) counts as lost; `not_now` doesn't (they may come back).
-- DECISION: the age is fixed here, not passed in, so the caller can't purge sooner. At most 500
-- files a call; the job calls again on its next hour.
--
-- SECURITY DEFINER, so it runs as the migrating owner (BYPASSRLS); `row_security = off` makes it
-- fail rather than delete from a filtered view if that is ever not so. It writes its own audit row
-- (invariant 14): `client_file.purge_lost`, by the system, naming the files' ids, never their
-- content. Nothing changes for the previous Worker: no table, column or grant is touched.
CREATE FUNCTION app_purge_lost_prospect_files() RETURNS uuid[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  purged uuid[];
BEGIN
  WITH lost AS (
    SELECT f.id
    FROM public.client_file f
    JOIN public.deal d ON d.client_file_id = f.id
    WHERE f.client_id IS NULL
    GROUP BY f.id
    HAVING bool_and(d.outcome IN ('lost', 'no'))
      AND bool_and(d.closed_at IS NOT NULL)
      AND max(d.closed_at) < now() - interval '12 months'
    ORDER BY f.id
    LIMIT 500
  ), gone AS (
    DELETE FROM public.client_file f USING lost WHERE f.id = lost.id
    RETURNING f.id
  )
  SELECT coalesce(array_agg(id ORDER BY id), '{}'::uuid[]) INTO purged FROM gone;
  IF cardinality(purged) > 0 THEN
    INSERT INTO public.audit_event (tenant_id, actor_kind, action, outcome, target)
    VALUES (NULL, 'system', 'client_file.purge_lost', 'ok',
      jsonb_build_object('fileIds', to_jsonb(purged), 'count', cardinality(purged)));
  END IF;
  RETURN purged;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_lost_prospect_files() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_purge_lost_prospect_files() TO cs_runtime;
