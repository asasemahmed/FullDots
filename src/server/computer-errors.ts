export type ComputerErrorStatus = 400 | 403 | 404 | 409 | 502 | 503;

export class ComputerError extends Error {
  constructor(
    readonly status: ComputerErrorStatus,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ComputerError';
  }
}
