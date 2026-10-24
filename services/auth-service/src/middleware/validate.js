/**
 * Wraps a Zod schema into an Express middleware. On success, replaces
 * req.body with the parsed (and coerced/trimmed/defaulted) value, so
 * downstream handlers can trust its shape completely. On failure,
 * responds 400 with a field-level error list — never touches the
 * route handler.
 */
function validationError(res, issues, message) {
  return res.status(400).json({
    error: {
      code: "VALIDATION_ERROR",
      message,
      details: issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    },
  });
}

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) return validationError(res, result.error.issues, "Request body failed validation.");
    req.body = result.data;
    next();
  };
}

// Phase 12: query strings are validated too (page/limit bounds etc.).
export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) return validationError(res, result.error.issues, "Query parameters failed validation.");
    req.validatedQuery = result.data;
    next();
  };
}

// Phase 12: `:id` must be a UUID. A malformed id used to reach Postgres,
// fail the uuid cast and come back as a 500 with a stack trace in the logs.
export function validateUuidParam(name, schema) {
  return (req, res, next) => {
    if (!schema.safeParse(req.params[name]).success) {
      return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: `Path parameter '${name}' must be a UUID.` } });
    }
    next();
  };
}
