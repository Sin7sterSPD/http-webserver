import type { ZodType } from "zod";
import type { AppHandler, ValidationTarget } from "./types.js";

export function zValidator<T>(
  target: ValidationTarget,
  schema: ZodType<T>,
): AppHandler {
  return async (c, next) => {
    const input =
      target === "json"
        ? await c.req.json<unknown>()
        : target === "query"
          ? c.req.queries()
          : c.req.params();

    const result = await schema.safeParseAsync(input);
    if (!result.success) {
      return c.status(400).json({
        error: "Validation failed",
        target,
        issues: result.error.issues,
      });
    }

    c.setValid(target, result.data);
    await next();
  };
}
