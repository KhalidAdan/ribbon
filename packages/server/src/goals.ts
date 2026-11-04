import type { DatabaseSync } from "node:sqlite";
import { newerGoal, NO_GOAL, type DailyGoal } from "@ribbon/core/goal";

/** Each person's daily goal (packages/core/src/goal.ts), in the database: the one chosen later stands. */
export class Goals {
  constructor(private readonly db: DatabaseSync) {}

  /** The person's goal; off when they never chose one. */
  of(personId: string): DailyGoal {
    const row = this.db.prepare("SELECT minutes, chosen_at FROM person_goal WHERE person_id = ?").get(personId);
    return row ? { minutes: Number(row.minutes), chosenAt: String(row.chosen_at) } : NO_GOAL;
  }

  /** Keep a goal a device chose, unless the one kept was chosen later. The goal that stands. */
  choose(personId: string, goal: DailyGoal): DailyGoal {
    const kept = this.of(personId);
    const stands = newerGoal(kept, goal);
    if (stands === goal && goal.chosenAt) {
      this.db
        .prepare("INSERT INTO person_goal (person_id, minutes, chosen_at) VALUES (?, ?, ?) ON CONFLICT (person_id) DO UPDATE SET minutes = excluded.minutes, chosen_at = excluded.chosen_at")
        .run(personId, goal.minutes, goal.chosenAt);
    }
    return stands;
  }
}
