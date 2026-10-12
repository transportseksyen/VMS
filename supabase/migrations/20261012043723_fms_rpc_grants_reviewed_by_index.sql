begin;

-- Security-definer RPCs must not be callable by unauthenticated clients.
-- Functions retain their own role and agency checks for authenticated callers.
revoke execute on function public.fms_review_registry_change(uuid, text, text) from public, anon;
revoke execute on function public.fms_review_registry_record(text, uuid, text, text) from public, anon;
revoke execute on function public.fms_submit_registry_change(text, uuid, jsonb, text) from public, anon;

grant execute on function public.fms_review_registry_change(uuid, text, text) to authenticated;
grant execute on function public.fms_review_registry_record(text, uuid, text, text) to authenticated;
grant execute on function public.fms_submit_registry_change(text, uuid, jsonb, text) to authenticated;

-- Cover the reviewer foreign key flagged by the Supabase performance advisor.
create index if not exists fms_registry_change_requests_reviewed_by_idx
  on public.fms_registry_change_requests(reviewed_by);

commit;
