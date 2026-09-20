import type { Unsubscribe } from "./types";

/** Tiny typed event source shared by the mock and web implementations. */
export class Emitter<T> {
  private readonly cbs = new Set<(v: T) => void>();
  on(cb: (v: T) => void): Unsubscribe {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  emit(v: T) {
    for (const cb of [...this.cbs]) cb(v);
  }
  get size() {
    return this.cbs.size;
  }
}
