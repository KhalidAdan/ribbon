import { dayOf, minutesByDay, type Spent } from "./stats";

/**
 * A daily goal: so many minutes a day with your books, listening or
 * reading, as Apple Books keeps one. Met, the apps say so for a moment,
 * with how many days in a row it's been met. Off at 0 minutes. It's the
 * person's, the same on every device: kept on the server and on the
 * machine, the one chosen later standing.
 */
export interface DailyGoal {
  minutes: number;
  /** When it was chosen, ISO; null for the goal nobody chose (off). */
  chosenAt: string | null;
}

export const NO_GOAL: DailyGoal = { minutes: 0, chosenAt: null };

/** The goals there are to choose from, in minutes; 0 is off. */
export const GOAL_CHOICES = [0, 5, 10, 15, 20, 30, 45, 60] as const;

/** Which of two goals stands: the one chosen later. */
export function newerGoal(a: DailyGoal, b: DailyGoal): DailyGoal {
  const at = (g: DailyGoal) => (g.chosenAt ? Date.parse(g.chosenAt) : -Infinity);
  return at(b) > at(a) ? b : a;
}

export interface GoalToday {
  /** Time with your books today, listening and reading, with what's going on now. */
  todayMs: number;
  met: boolean;
  /** Days in a row the goal was met, ending today, or yesterday while today isn't met yet. */
  streakDays: number;
}

/**
 * Today against the goal, on the person's own days (`tzOffsetMin`, as
 * `getTimezoneOffset` gives it): the time kept so far, and `liveMs` of
 * listening or reading going on now that isn't kept yet.
 */
export function goalToday(spent: readonly Spent[], goalMinutes: number, nowMs: number, tzOffsetMin: number, liveMs = 0): GoalToday {
  const byDay = minutesByDay(spent, tzOffsetMin);
  const today = dayOf(nowMs, tzOffsetMin);
  byDay.set(today, (byDay.get(today) ?? 0) + Math.max(0, liveMs));
  const goalMs = goalMinutes * 60_000;
  const met = (day: number) => goalMs > 0 && (byDay.get(day) ?? 0) >= goalMs;
  let streakDays = 0;
  for (let d = met(today) ? today : today - 1; met(d); d--) streakDays++;
  return { todayMs: byDay.get(today) ?? 0, met: met(today), streakDays };
}

/**
 * Whether to say the goal was met, now: only when it was seen not met
 * earlier today here, and met by time spent here (`here`: going on now, or
 * a stretch that has just ended), so a goal met on another device, or
 * before this one started, isn't announced again; and once a day.
 */
export class GoalWatch {
  private belowOn: number | null = null;

  constructor(private celebratedOn: number | null = null) {}

  /** Today, as it stands now: true when it has just been met, to be said. */
  see(today: GoalToday, nowMs: number, tzOffsetMin: number, here: boolean): boolean {
    const day = dayOf(nowMs, tzOffsetMin);
    if (!today.met) {
      this.belowOn = day;
      return false;
    }
    // Met by another device's time: theirs to say.
    if (!here) this.belowOn = null;
    if (this.belowOn !== day || this.celebratedOn === day) return false;
    this.celebratedOn = day;
    return true;
  }

  /** The day it was last said, to keep between starts. */
  get celebrated(): number | null {
    return this.celebratedOn;
  }
}
