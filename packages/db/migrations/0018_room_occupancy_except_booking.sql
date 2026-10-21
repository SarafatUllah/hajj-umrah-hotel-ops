-- Step 14d (v7 §12 date change): the seat count can leave one booking out. A date change plans the booking's new
-- nights as if its own seats were already free (it gives them up in the same transaction), so its search must not
-- count them. Otherwise the ONE counting rule of 0009 is unchanged; existing callers pass five arguments and keep
-- the default (nobody left out). A new parameter changes the signature: drop, then create.
DROP FUNCTION room_night_occupancy(uuid, uuid, date, date, uuid[]);--> statement-breakpoint
CREATE FUNCTION room_night_occupancy(p_organization_id uuid, p_hotel_id uuid, p_from date, p_to date, p_room_ids uuid[] DEFAULT NULL, p_except_booking_id uuid DEFAULT NULL)
RETURNS TABLE (room_id uuid, night date, seats_used integer)
LANGUAGE sql STABLE AS $$
  SELECT br.room_id, gs.check_in + d.i AS night, count(*)::integer AS seats_used
  FROM public.booking_room br
  JOIN public.booking b ON b.organization_id = br.organization_id AND b.id = br.booking_id
  JOIN public.guest_stay gs ON gs.organization_id = br.organization_id AND gs.booking_room_id = br.id
  JOIN public.booking_guest g ON g.organization_id = gs.organization_id AND g.id = gs.booking_guest_id
  CROSS JOIN LATERAL generate_series(greatest(0, p_from - gs.check_in), least(gs.check_out - gs.check_in, p_to - gs.check_in + 1) - 1) AS d(i)
  WHERE br.organization_id = p_organization_id
    AND br.hotel_id = p_hotel_id
    AND (p_room_ids IS NULL OR br.room_id = ANY (p_room_ids))
    AND (p_except_booking_id IS NULL OR br.booking_id <> p_except_booking_id)
    AND br.check_in <= p_to AND br.check_out > p_from
    AND gs.check_in <= p_to AND gs.check_out > p_from
    AND br.status IN ('HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE')
    AND g.age_group <> 'INFANT'
    AND g.status <> 'REMOVED'
    AND NOT (b.status IN ('HELD', 'REQUESTED') AND coalesce(b.hold_expires_at <= now(), false))
  GROUP BY br.room_id, gs.check_in + d.i
$$;
