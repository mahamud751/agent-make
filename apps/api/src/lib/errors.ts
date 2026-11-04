export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, "bad_request", msg, details);
export const unauthorized = (msg = "Unauthorized") => new AppError(401, "unauthorized", msg);
export const forbidden = (msg = "Forbidden") => new AppError(403, "forbidden", msg);
export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found`);
export const conflict = (msg: string) => new AppError(409, "conflict", msg);
export const paymentRequired = (msg: string) => new AppError(402, "plan_limit", msg);
export const tooMany = (msg = "Too many requests") => new AppError(429, "rate_limited", msg);
