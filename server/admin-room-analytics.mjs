const dayMs = 86_400_000;
const beijingOffsetMs = 8 * 3_600_000;
const followUpDays = { d1: 1, d7: 7, d30: 30 };

const localDay = (time) => Math.floor((time + beijingOffsetMs) / dayMs);
const dayLabel = (day) => new Date(day * dayMs).toISOString().slice(0, 10);
const startOfDay = (day) => day * dayMs - beijingOffsetMs;
const iso = (time) => new Date(time).toISOString();

function nextBucket(day, period) {
  if (period === 7) return day + 1;
  const date = new Date(day * dayMs);
  if (period === 30) return day + 7 - ((date.getUTCDay() + 6) % 7);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / dayMs;
}

function reportBuckets(start, end, period) {
  const byDay = new Map();
  const retention = [];
  const trend = [];
  for (let first = start; first < end;) {
    const next = Math.min(end, nextBucket(first, period));
    const span = { start: dayLabel(first), end: dayLabel(next - 1) };
    const active = { ...span, activated: 0, d1: counts(), d7: counts(), d30: counts() };
    const changes = { ...span, created: 0, closed: 0 };
    retention.push(active);
    trend.push(changes);
    for (let day = first; day < next; day += 1) byDay.set(day, { active, changes });
    first = next;
  }
  return { byDay, retention, trend };
}

const counts = () => ({ eligible: 0, returned: 0 });
const stateCounts = () => ({ waiting: 0, none: 0, creator: 0, guest: 0, both: 0, unknown: 0 });

function chatState(creator, guest, missingHistory) {
  if (creator && guest) return 'both';
  if (missingHistory) return 'unknown';
  if (creator) return 'creator';
  return guest ? 'guest' : 'none';
}

function medianMinutes(times) {
  if (times.length === 0) return null;
  times.sort((a, b) => a - b);
  const upper = Math.floor(times.length / 2);
  const lower = Math.floor((times.length - 1) / 2);
  return Math.round((times[lower] + times[upper]) / 120_000);
}

export function createRoomAnalytics(db) {
  const roomFacts = db.prepare(`
    WITH message_facts AS (
      SELECT msg.room_id,
        MAX(sender.role = 'creator') AS creator_ever,
        MAX(sender.role = 'joiner') AS guest_ever,
        MAX(sender.device_id IS NULL) AS unknown_sender,
        MIN(CASE WHEN sender.role = 'creator' AND msg.accepted_at >= r.sealed_at THEN msg.accepted_at END) AS first_creator,
        MIN(CASE WHEN sender.role = 'joiner' AND msg.accepted_at >= r.sealed_at THEN msg.accepted_at END) AS first_guest,
        MAX(CASE WHEN msg.accepted_at >= ?1 AND msg.accepted_at < ?2 THEN 1 ELSE 0 END) AS active,
        MAX(CASE WHEN msg.accepted_at >= ?1 AND msg.accepted_at < ?2 AND sender.role = 'creator' THEN 1 ELSE 0 END) AS creator_active,
        MAX(CASE WHEN msg.accepted_at >= ?1 AND msg.accepted_at < ?2 AND sender.role = 'joiner' THEN 1 ELSE 0 END) AS guest_active,
        GROUP_CONCAT(DISTINCT CASE WHEN r.next_seq = r.message_count
          AND msg.accepted_at >= ?1 AND msg.accepted_at < ?2 AND msg.accepted_at >= r.sealed_at
          THEN date(msg.accepted_at, '+8 hours') END) AS days_active
      FROM messages msg
      JOIN rooms r ON r.room_id = msg.room_id
      LEFT JOIN members sender ON sender.room_id = msg.room_id AND sender.device_id = msg.sender_device_id
      WHERE msg.count_unread = 1 AND msg.accepted_at <= ?3
      GROUP BY msg.room_id
    )
    SELECT r.created_at, r.sealed_at,
      COALESCE(lifecycle.closed, 0) AS closed,
      CASE WHEN lifecycle.closed = 1 THEN (
        SELECT MAX(revoked_at) FROM members WHERE room_id = r.room_id AND status = 'revoked'
      ) END AS closed_at,
      (r.next_seq <> r.message_count OR COALESCE(facts.unknown_sender, 0)) AS missing_history,
      facts.creator_ever, facts.guest_ever, facts.first_creator, facts.first_guest,
      facts.active, facts.creator_active, facts.guest_active, facts.days_active
    FROM rooms r
    LEFT JOIN chamber_lifecycle lifecycle ON lifecycle.room_id = r.room_id
    LEFT JOIN message_facts facts ON facts.room_id = r.room_id
    WHERE r.created_at <= ?3
  `);
  const featureCounts = db.prepare(`
    SELECT
      (SELECT COUNT(DISTINCT room_id) FROM blobs
        WHERE completed = 1 AND updated_at >= ?1 AND updated_at < ?2) AS attachments,
      (SELECT COUNT(*) FROM (
        SELECT room_id, role FROM members WHERE status = 'active'
        GROUP BY room_id, role HAVING COUNT(*) >= 2
      )) AS multiDeviceSeats,
      (SELECT COUNT(*) FROM (
        SELECT DISTINCT m.room_id, m.role FROM push_subscriptions p
        JOIN members m ON m.room_id = p.room_id AND m.device_id = p.device_id
        WHERE m.status = 'active'
      )) AS pushSeats,
      (SELECT COUNT(*) FROM (
        SELECT a.room_id, a.owner_role FROM private_archives_v2 a
        JOIN rooms r ON r.room_id = a.room_id
        WHERE EXISTS (SELECT 1 FROM private_archive_objects_v2 o WHERE o.archive_id = a.id)
        UNION
        SELECT m.room_id, m.role FROM recovery_backups b
        JOIN members m ON m.room_id = b.room_id AND m.device_id = b.device_id
        WHERE b.active = 1
      )) AS backupSeats
  `);

  return (period, now = new Date()) => {
    if (![7, 30, 90].includes(period)) throw new Error('INVALID_ADMIN_FILTER');
    const lastDay = localDay(now.getTime());
    const firstDay = lastDay - period;
    const start = startOfDay(firstDay);
    const end = startOfDay(lastDay);
    const at = now.toISOString();
    const range = [iso(start), iso(end)];
    const { byDay, retention, trend } = reportBuckets(firstDay, lastDay, period);
    const stock = { waiting: 0, joined: 0, closed: 0 };
    const activity = { created: 0, joined: 0, active: 0, bilateralActive: 0, partial: false };
    const join24 = { eligible: 0, joined: 0 };
    const joinTimes = [];
    const funnel = { eligible: 0, joined: 0, firstMessage: 0, bilateral: 0, unknown: 0 };
    const states = { stock: stateCounts(), cohort: stateCounts() };

    for (const room of roomFacts.iterate(...range, at)) {
      const created = Date.parse(room.created_at);
      const joined = Date.parse(room.sealed_at);
      const closed = Date.parse(room.closed_at);
      const hasJoined = Number.isFinite(joined);
      const stockStatus = room.closed ? 'closed' : hasJoined ? 'joined' : 'waiting';
      stock[stockStatus] += 1;
      if (!room.closed) {
        const status = hasJoined ? chatState(room.creator_ever, room.guest_ever, room.missing_history) : 'waiting';
        states.stock[status] += 1;
      }
      const closedBucket = byDay.get(localDay(closed));
      if (closedBucket) closedBucket.changes.closed += 1;
      const createdBucket = byDay.get(localDay(created));
      if (createdBucket) {
        createdBucket.changes.created += 1;
        activity.created += 1;
        if (created + dayMs <= end) {
          join24.eligible += 1;
          if (joined < created + dayMs) join24.joined += 1;
        }
        const deadline = created + 7 * dayMs;
        if (deadline <= end) {
          funnel.eligible += 1;
          let status = 'waiting';
          if (joined < deadline) {
            funnel.joined += 1;
            const creator = Date.parse(room.first_creator) < deadline;
            const guest = Date.parse(room.first_guest) < deadline;
            if (creator || guest) funnel.firstMessage += 1;
            status = chatState(creator, guest, room.missing_history);
            if (status === 'both') funnel.bilateral += 1;
            if (status === 'unknown') funnel.unknown += 1;
          }
          states.cohort[status] += 1;
        }
      }
      if (joined >= start && joined < end) {
        activity.joined += 1;
        joinTimes.push(joined - created);
      }
      const bilateral = Boolean(room.creator_active && room.guest_active);
      if (room.active) activity.active += 1;
      if (bilateral) activity.bilateralActive += 1;
      if (room.missing_history && !bilateral && created < end && !(closed < start)) activity.partial = true;

      if (room.missing_history) continue;
      const activation = room.first_creator && room.first_guest
        ? Math.min(Date.parse(room.first_creator), Date.parse(room.first_guest))
        : Date.parse(room.first_creator ?? room.first_guest);
      const activationDay = localDay(activation);
      const cohort = byDay.get(activationDay)?.active;
      if (!cohort) continue;
      cohort.activated += 1;
      const activeDays = new Set(room.days_active?.split(','));
      for (const [key, days] of Object.entries(followUpDays)) {
        const target = activationDay + days;
        if (target >= lastDay) continue;
        cohort[key].eligible += 1;
        if (activeDays.has(dayLabel(target))) cohort[key].returned += 1;
      }
    }

    return { period, start: dayLabel(firstDay), end: dayLabel(lastDay - 1), at,
      stock, activity, join24, medianJoinMinutes: medianMinutes(joinTimes), funnel, states, retention, trend,
      features: featureCounts.get(...range) };
  };
}
