import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Calculate duration in minutes between two "HH:mm" time strings.
 */
export const calculateDuration = (start: string, end: string): number => {
  if (!start || !end) return 0;

  const [startHour, startMin] = start.split(':').map(Number);
  const [endHour, endMin] = end.split(':').map(Number);

  if (isNaN(startHour) || isNaN(startMin) || isNaN(endHour) || isNaN(endMin)) {
    return 0;
  }

  let startTotalMins = startHour * 60 + startMin;
  let endTotalMins = endHour * 60 + endMin;

  if (endTotalMins < startTotalMins) {
    // Overnight shift: add 24 hours (1440 minutes)
    endTotalMins += 24 * 60;
  }

  return endTotalMins - startTotalMins;
};

/**
 * Format total shift minutes (e.g. 90) into clock time string (e.g. "10:30 AM")
 * based on shift start time (e.g. "09:00").
 */
export const formatMinutesToClockTime = (shiftStartTime: string = "09:00", minutesFromStart: number): string => {
  const [startHour, startMinute] = (shiftStartTime || "09:00").split(':').map(Number);
  const totalMins = (isNaN(startHour) ? 9 : startHour) * 60 + (isNaN(startMinute) ? 0 : startMinute) + minutesFromStart;

  const date = new Date();
  date.setHours(Math.floor(totalMins / 60) % 24, totalMins % 60, 0, 0);

  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
};
