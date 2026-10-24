/**
 * Wraps a Zod schema into an Express middleware. On success, replaces
 * req.body with the parsed (and coerced/trimmed/defaulted) value, so
 * downstream handlers can trust its shape completely. On failure,
 * responds 400 with a field-level error list — never touches the
 * route handler.
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body failed validation.",
          details: result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }
    req.body = result.data;
    next();
  };
}

/**
 * Same idea as validateBody, but for query string parameters — used
 * for GET /hospitals/near?lat=&lng=&radiusKm=, where Express gives us
 * everything as strings and Zod's z.coerce.* handles the type
 * conversion + validation in one step.
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Query parameters failed validation.",
          details: result.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }
    req.query = result.data;
    next();
  };
}
