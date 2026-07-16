// Tiny hand-rolled reactive store — our alternative to a UI framework.
// Subscribe to be called on every change (and once immediately with current
// state). `set` accepts a partial merge or an updater function.

export type Listener<T> = (state: T) => void;

export class Store<T extends object> {
  private state: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  set(next: Partial<T> | ((prev: T) => T)): void {
    this.state =
      typeof next === 'function'
        ? (next as (prev: T) => T)(this.state)
        : { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Returns an unsubscribe function. Fires once immediately. */
  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
