/** School-local time formatting. Never fall back to the browser timezone. */

export function formatSchoolTime(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone }).format(date);
}

function schoolDayParts(
  iso: string,
  timeZone: string,
): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** "Today · 6:14 PM", "Tomorrow · 9:30 AM", or a dated fallback, all school-local. */
export function formatScheduledWhen(
  iso: string,
  timeZone: string,
  nowMs: number = Date.now(),
): string | null {
  const time = formatSchoolTime(iso, timeZone);
  if (!time) return null;
  const target = schoolDayParts(iso, timeZone);
  const today = schoolDayParts(new Date(nowMs).toISOString(), timeZone);
  const dayMs = 86_400_000;
  const targetDay = Date.UTC(Number(target.year), Number(target.month) - 1, Number(target.day));
  const todayDay = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day));
  const diffDays = Math.round((targetDay - todayDay) / dayMs);
  if (diffDays === 0) return `Today · ${time}`;
  if (diffDays === 1) return `Tomorrow · ${time}`;
  const date = new Intl.DateTimeFormat([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(new Date(iso));
  return `${date} · ${time}`;
}
