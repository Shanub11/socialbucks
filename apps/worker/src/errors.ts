// apps/worker/src/errors.ts
//
// The only shape an error is allowed to take on its way to a log line
// (ADR-0006 R6): its class name and, when the driver exposes one, its code.
//
// The message is deliberately dropped. A Prisma connection error can quote the
// connection string, an HTTP error can quote a bearer token and a crypto error
// can quote key material - and a log line is the one place a secret survives
// forever. Name plus code is what an operator actually needs to act: 'is this
// pgboss circuit breaking', 'is this a unique violation' and so on.
//
// This file has no imports on purpose: main.ts loads it before anything else,
// and R10 keeps main.ts's static graph free of the database and the web app.

export interface ErrorDescription {
  errorName: string;
  /** Prisma's `code` (for example P2002) or any other string-coded error. */
  code?: string;
}

/** Never returns a message, a stack or any other free-form text. */
export function describeError(error: unknown): ErrorDescription {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? { errorName: error.name, code } : { errorName: error.name };
  }
  // A thrown non-Error (a rejected string, an object literal) has no useful
  // shape to report, and printing it would be printing arbitrary data.
  return { errorName: 'NonErrorThrown' };
}
