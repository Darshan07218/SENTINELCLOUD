/**
 * Fine-grained authorization the gateway can't do: the gateway's role
 * check (services/gateway/src/routeAccessRules.js) only knows "is this
 * role allowed to write to /hospitals at all" — it has no idea which
 * hospital a HOSPITAL_ADMIN is actually supposed to manage. That check
 * lives here, against the specific :id in the URL.
 *
 * Rule: SYSTEM_ADMIN may modify any hospital. A HOSPITAL_ADMIN may only
 * modify a hospital whose managed_by_user_id matches their own user id
 * — including a hospital with no manager yet (managed_by_user_id IS
 * NULL) is intentionally NOT auto-claimable this way, to avoid two
 * different hospital admins racing to "adopt" an unclaimed hospital by
 * simply issuing a PATCH; assigning a manager is done explicitly via
 * PUT /hospitals/:id (which only SYSTEM_ADMIN or the existing manager
 * can call in the first place, so an unmanaged hospital can only be
 * claimed by a SYSTEM_ADMIN setting managed_by_user_id).
 */
export function requireHospitalOwnership(hospitalRepository) {
  return async (req, res, next) => {
    try {
      const hospital = await hospitalRepository.findById(req.params.id);
      if (!hospital) {
        return res.status(404).json({ error: { code: "NOT_FOUND", message: "Hospital not found." } });
      }

      if (req.user.role === "SYSTEM_ADMIN") {
        req.hospital = hospital;
        return next();
      }

      if (req.user.role === "HOSPITAL_ADMIN" && hospital.managedByUserId === req.user.id) {
        req.hospital = hospital;
        return next();
      }

      return res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: "You do not manage this hospital.",
        },
      });
    } catch (err) {
      next(err);
    }
  };
}
