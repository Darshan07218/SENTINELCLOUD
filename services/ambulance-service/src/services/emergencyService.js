export function createEmergencyService({ emergencyRepository, dispatchService }) {
  return {
    async createEmergency(data, createdByUserId) {
      const emergency = await emergencyRepository.create(data, createdByUserId);
      return dispatchService.dispatchForNewEmergency(emergency);
    },

    async getEmergency(id) {
      return emergencyRepository.findById(id);
    },

    async listEmergencies({ page, limit, status }) {
      const { emergencies, total } = await emergencyRepository.list({ page, limit, status });
      return {
        emergencies,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      };
    },

    async listActiveEmergencies() {
      return emergencyRepository.findActive();
    },

    async completeEmergency(id) {
      return dispatchService.completeEmergency(id);
    },

    async cancelEmergency(id) {
      return dispatchService.cancelEmergency(id);
    },
  };
}
