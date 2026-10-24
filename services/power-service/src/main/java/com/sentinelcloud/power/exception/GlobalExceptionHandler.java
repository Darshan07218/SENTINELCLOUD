package com.sentinelcloud.power.exception;

import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Consistent JSON error envelope for the whole API — mirrors the
 * {@code { error: { code, message, details? } }} shape every Node.js
 * service in this project already uses.
 *
 * Phase 12: client mistakes (bad UUID in the path, missing or malformed
 * query parameter, unknown route, wrong HTTP method, concurrent edit) are
 * answered with 400/404/405/409 instead of falling into the catch-all as
 * 500s; unexpected errors are LOGGED (they used to be swallowed) but never
 * described to the client; and only messages written by this codebase are
 * echoed back — a library's IllegalArgumentException can carry internals.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(NotFoundException.class)
    public ResponseEntity<?> handleNotFound(NotFoundException e) {
        return errorResponse(HttpStatus.NOT_FOUND, "NOT_FOUND", e.getMessage(), null);
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<?> handleNoRoute(NoResourceFoundException e) {
        return errorResponse(HttpStatus.NOT_FOUND, "NOT_FOUND", "No such route.", null);
    }

    @ExceptionHandler(ConflictException.class)
    public ResponseEntity<?> handleConflict(ConflictException e) {
        return errorResponse(HttpStatus.CONFLICT, e.getCode(), e.getMessage(), null);
    }

    @ExceptionHandler(ObjectOptimisticLockingFailureException.class)
    public ResponseEntity<?> handleOptimisticLock(ObjectOptimisticLockingFailureException e) {
        return errorResponse(HttpStatus.CONFLICT, "CONCURRENT_UPDATE", "The record was changed by someone else. Reload and try again.", null);
    }

    @ExceptionHandler(ForbiddenException.class)
    public ResponseEntity<?> handleForbidden(ForbiddenException e) {
        return errorResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", e.getMessage(), null);
    }

    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<?> handleAccessDenied(AccessDeniedException e) {
        return errorResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", "You do not have permission to perform this action.", null);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<?> handleValidation(MethodArgumentNotValidException e) {
        List<Map<String, String>> details = e.getBindingResult().getFieldErrors().stream()
            .map(fe -> Map.of("field", fe.getField(), "message", fe.getDefaultMessage() == null ? "Invalid value" : fe.getDefaultMessage()))
            .collect(Collectors.toList());
        return errorResponse(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Request body failed validation.", details);
    }

    @ExceptionHandler({HandlerMethodValidationException.class, ConstraintViolationException.class})
    public ResponseEntity<?> handleParameterValidation(Exception e) {
        return errorResponse(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Request parameters failed validation.", null);
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<?> handleTypeMismatch(MethodArgumentTypeMismatchException e) {
        return errorResponse(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Parameter '" + e.getName() + "' has an invalid value.", null);
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public ResponseEntity<?> handleMissingParam(MissingServletRequestParameterException e) {
        return errorResponse(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Missing required parameter '" + e.getParameterName() + "'.", null);
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<?> handleMethod(HttpRequestMethodNotSupportedException e) {
        return errorResponse(HttpStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "This HTTP method is not supported here.", null);
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<?> handleUnreadable(HttpMessageNotReadableException e) {
        return errorResponse(HttpStatus.BAD_REQUEST, "INVALID_JSON", "Request body is not valid JSON.", null);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<?> handleIllegalArgument(IllegalArgumentException e) {
        StackTraceElement[] trace = e.getStackTrace();
        boolean ours = trace.length > 0 && trace[0].getClassName().startsWith("com.sentinelcloud.");
        return errorResponse(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", ours ? e.getMessage() : "Invalid request.", null);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<?> handleUnexpected(Exception e) {
        // Any other Spring MVC client error (415 unsupported media type, a
        // missing header, …) keeps its 4xx status instead of becoming a 500.
        if (e instanceof org.springframework.web.ErrorResponse er) {
            HttpStatus status = HttpStatus.resolve(er.getStatusCode().value());
            if (status != null && status.is4xxClientError()) {
                return errorResponse(status, "BAD_REQUEST", status.getReasonPhrase(), null);
            }
        }
        log.error("Unhandled exception", e);
        return errorResponse(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "An unexpected error occurred.", null);
    }

    private ResponseEntity<?> errorResponse(HttpStatus status, String code, String message, Object details) {
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("code", code);
        error.put("message", message);
        if (details != null) error.put("details", details);
        return ResponseEntity.status(status).body(Map.of("error", error));
    }
}
