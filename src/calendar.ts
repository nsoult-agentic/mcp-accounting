/**
 * Work calendar — calculates business days, week ranges, and hours.
 *
 * Default: Mon–Fri, 8 hrs/day. No automatic holiday exclusions.
 * Days off (sick, vacation, holiday) are subtracted when provided.
 */

export interface DayOff {
  date: string; // YYYY-MM-DD
  type: string; // sick | vacation | holiday | other
  note?: string;
}

export interface WorkCalendarResult {
  workDays: number;
  weekRanges: string[]; // e.g., ["04/01 - 04/04", "04/07 - 04/11", ...]
  totalHours: number;
  hoursPerDay: number;
  daysOff: DayOff[];
  businessDaysInMonth: number; // before subtracting days off
}

/**
 * Calculate work calendar for a given month.
 */
export function calculateWorkCalendar(
  year: number,
  month: number, // 1-12
  daysOff: DayOff[] = [],
  hoursPerDay = 8,
): WorkCalendarResult {
  const offSet = new Set(daysOff.map((d) => d.date));

  // Collect all weekdays in the month
  const allWeekdays: Date[] = [];
  const workDates: Date[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month - 1, day);
    const dow = date.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends

    allWeekdays.push(date);
    const iso = formatISO(date);
    if (!offSet.has(iso)) {
      workDates.push(date);
    }
  }

  // Group consecutive work days into week ranges
  const weekRanges = groupIntoWeekRanges(workDates);

  return {
    workDays: workDates.length,
    weekRanges,
    totalHours: workDates.length * hoursPerDay,
    hoursPerDay,
    daysOff: daysOff.filter((d) => {
      // Only include days off that fall within this month
      const [y, m] = d.date.split("-").map(Number);
      return y === year && m === month;
    }),
    businessDaysInMonth: allWeekdays.length,
  };
}

/**
 * Group consecutive work dates into "MM/DD - MM/DD" ranges.
 * A new range starts when there's a gap of >2 days (i.e., not just a weekend).
 */
function groupIntoWeekRanges(dates: Date[]): string[] {
  if (dates.length === 0) return [];

  const ranges: string[] = [];
  let rangeStart = dates[0];
  let prev = dates[0];

  for (let i = 1; i < dates.length; i++) {
    const curr = dates[i];
    const diffDays = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);

    // Any gap > 1 calendar day means a new range (weekends = 3 days, mid-week day off = 2 days)
    if (diffDays > 1) {
      ranges.push(formatRange(rangeStart, prev));
      rangeStart = curr;
    }

    prev = curr;
  }
  ranges.push(formatRange(rangeStart, prev));

  return ranges;
}

function formatRange(start: Date, end: Date): string {
  const s = formatMMDD(start);
  const e = formatMMDD(end);
  return s === e ? s : `${s} - ${e}`;
}

function formatMMDD(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

function formatISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * Generate the invoice description string from week ranges.
 * Matches existing format: "{Month} Hours Worked\n{range1}\n{range2}\n..."
 */
export function formatInvoiceDescription(
  monthName: string,
  weekRanges: string[],
): string {
  return `${monthName} Hours Worked\n${weekRanges.join("\n")}`;
}

/**
 * Month name from number.
 */
export function monthName(month: number): string {
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return names[month - 1] || "Unknown";
}
