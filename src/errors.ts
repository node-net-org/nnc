/**
 * Exit codes and the error type commands throw (docs/cli.md §10).
 */

export const EXIT = Object.freeze({
  ok: 0,
  rpcError: 1,
  usage: 2,
  connection: 3,
  readOnly: 4,
  protocol: 5,
  /** Ctrl-C cancelled the command (the shell convention, 128 + SIGINT). */
  cancelled: 130,
});

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure to report to the user as a message, with the exit code it maps to. */
export class CliError extends Error {
  override name = 'CliError';
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode = EXIT.usage) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function usageError(message: string): CliError {
  return new CliError(message, EXIT.usage);
}
