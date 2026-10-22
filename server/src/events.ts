/** Something a device should know about now rather than the next time it asks. */
export interface ServerEvent {
  /** `places`: one of your devices moved your place. `books`: the library changed. */
  type: "places" | "books";
  data: Record<string, unknown>;
}

type Listener = (event: ServerEvent) => void;

/**
 * Who's listening for events (docs/SERVER.md, section 7: changes are
 * pushed, never polled), by person: a place moved reaches that person's
 * devices only; a book added reaches everyone.
 */
export class Events {
  private readonly listeners = new Map<string, Set<Listener>>();

  listen(personId: string, listener: Listener): () => void {
    let set = this.listeners.get(personId);
    if (!set) this.listeners.set(personId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(personId);
    };
  }

  toPerson(personId: string, event: ServerEvent): void {
    for (const listener of this.listeners.get(personId) ?? []) listener(event);
  }

  toEveryone(event: ServerEvent): void {
    for (const set of this.listeners.values()) for (const listener of set) listener(event);
  }
}
