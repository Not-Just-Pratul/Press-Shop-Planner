import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind CSS class names with conflict resolution */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Calculate the duration in minutes between two "HH:mm" time strings.
 * Handles overnight shifts (e.g. "22:00" → "06:00" = 480 mins).
 *
 * @returns Duration in minutes, or 0 if inputs are invalid.
 */
export function calculateDuration(start: string, end: string): number {
  if (!start || !end) return 0;

  const [startHour, startMin] = start.split(':').map(Number);
  const [endHour, endMin] = end.split(':').map(Number);

  if (isNaN(startHour) || isNaN(startMin) || isNaN(endHour) || isNaN(endMin)) {
    return 0;
  }

  const startTotalMins = startHour * 60 + startMin;
  let endTotalMins = endHour * 60 + endMin;

  // Overnight shift: add 24 hours
  if (endTotalMins < startTotalMins) {
    endTotalMins += 24 * 60;
  }

  return endTotalMins - startTotalMins;
}

/**
 * Format a shift-relative minute offset into a 12-hour clock time string.
 *
 * @param shiftStartTime - Shift start in "HH:mm" format (default "09:00")
 * @param minutesFromStart - Minutes elapsed since shift start
 * @returns Formatted time string like "1:30 PM"
 */
export function formatMinutesToClockTime(
  shiftStartTime: string = '09:00',
  minutesFromStart: number,
): string {
  const [startHour, startMinute] = (shiftStartTime || '09:00').split(':').map(Number);
  const totalMins =
    (isNaN(startHour) ? 9 : startHour) * 60 +
    (isNaN(startMinute) ? 0 : startMinute) +
    minutesFromStart;

  const date = new Date();
  date.setHours(Math.floor(totalMins / 60) % 24, totalMins % 60, 0, 0);

  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
