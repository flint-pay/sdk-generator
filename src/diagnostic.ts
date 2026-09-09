export class Diagnostic extends Error {
  constructor(
    public location: string,
    message: string,
  ) {
    super(`${location}: ${message}`);
    this.name = 'Diagnostic';
  }
}
