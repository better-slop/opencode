import { Effect } from "effect";

export type Ok<T> = {
  _tag: "Ok";
  value: T;
};

export type Err<E> = {
  _tag: "Err";
  error: E;
};

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { _tag: "Ok", value };
}

export function err<E>(error: E): Err<E> {
  return { _tag: "Err", error };
}

export function isOk<T, E>(res: Result<T, E>): res is Ok<T> {
  return res._tag === "Ok";
}

export function isErr<T, E>(res: Result<T, E>): res is Err<E> {
  return res._tag === "Err";
}

export function map<T, U, E>(res: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  if (res._tag === "Err") return res;
  return ok(fn(res.value));
}

export function flatMap<T, U, E1, E2>(
  res: Result<T, E1>,
  fn: (value: T) => Result<U, E2>,
): Result<U, E1 | E2> {
  if (res._tag === "Err") return res;
  return fn(res.value);
}

export function mapError<T, E1, E2>(
  res: Result<T, E1>,
  fn: (error: E1) => E2,
): Result<T, E2> {
  if (res._tag === "Ok") return res;
  return err(fn(res.error));
}

export async function tryPromise<T, E>(
  fn: () => Promise<T>,
  onError: (cause: unknown) => E,
): Promise<Result<T, E>> {
  return fn().then(ok).catch((cause) => err(onError(cause)));
}

export function toEffect<T, E>(res: Result<T, E>): Effect.Effect<T, E> {
  if (res._tag === "Ok") return Effect.succeed(res.value);
  return Effect.fail(res.error);
}

export async function runEffect<T, E>(eff: Effect.Effect<T, E>): Promise<Result<T, E>> {
  return Effect.runPromise(
    eff.pipe(
      Effect.match({
        onFailure: (error) => err(error),
        onSuccess: (value) => ok(value),
      }),
    ),
  );
}
