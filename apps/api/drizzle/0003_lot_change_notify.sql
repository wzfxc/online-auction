-- Live updates bus: every change to the public state of a lot sends a NOTIFY on commit (never on rollback).
-- Postgres is the source of truth and the bus, so losing Redis cannot lose or reorder live updates.
-- When the leader changes the previous leader was outbid: that id travels in the payload for the private event.
-- The payload never carries money fields; consumers re-read the row and map it with explicit DTO mappers.
CREATE FUNCTION lots_notify_change() RETURNS trigger AS $$
BEGIN
  IF (NEW.status, NEW.current_price, NEW.bid_count, NEW.ends_at, NEW.last_seq, NEW.leader_id)
     IS DISTINCT FROM (OLD.status, OLD.current_price, OLD.bid_count, OLD.ends_at, OLD.last_seq, OLD.leader_id) THEN
    PERFORM pg_notify('lot_changed', json_build_object(
      'lotId', NEW.id,
      'outbidUserId', CASE WHEN OLD.leader_id IS NOT NULL AND NEW.leader_id IS DISTINCT FROM OLD.leader_id THEN OLD.leader_id END
    )::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER lots_change_notify AFTER UPDATE ON lots
  FOR EACH ROW EXECUTE FUNCTION lots_notify_change();
