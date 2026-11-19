-- Search sync: every change to an indexed lot column enqueues the lot in the same transaction (transactional outbox).
-- A trigger, not application code, so no code path (bids, closing, moderation, seed) can forget it.
CREATE FUNCTION lots_enqueue_search() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (
    NEW.title, NEW.description, NEW.category_id, NEW.city_id, NEW.condition, NEW.start_price, NEW.buy_now_price,
    NEW.status, NEW.current_price, NEW.bid_count, NEW.ends_at, NEW.reserve_price
  ) IS DISTINCT FROM (
    OLD.title, OLD.description, OLD.category_id, OLD.city_id, OLD.condition, OLD.start_price, OLD.buy_now_price,
    OLD.status, OLD.current_price, OLD.bid_count, OLD.ends_at, OLD.reserve_price
  ) THEN
    INSERT INTO search_outbox (lot_id, created_at) VALUES (NEW.id, now());
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER lots_search_outbox AFTER INSERT OR UPDATE ON lots
  FOR EACH ROW EXECUTE FUNCTION lots_enqueue_search();
