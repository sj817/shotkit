export class ShotKitError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ShotKitError';
    this.status = status;
  }
}
