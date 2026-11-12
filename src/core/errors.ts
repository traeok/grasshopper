export class GhopError extends Error {
  constructor(message: string, readonly exitCode: 1 | 3 | 4 | 5 = 1) {
    super(message);
    this.name = new.target.name;
  }
}

export class EgressBlockedError extends GhopError {
  constructor(readonly categories: string[]) {
    super(`Egress guard stopped this request (${categories.join(", ")}). Nothing was sent.`, 3);
  }
}

export class OmpError extends GhopError {
  constructor(message: string, readonly status?: number) {
    super(message, 4);
  }
}
