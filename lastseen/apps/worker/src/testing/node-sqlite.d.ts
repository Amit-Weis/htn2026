// Minimal ambient types so tests can use Node's built-in SQLite without pulling @types/node into the Worker build.
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
  }
}
