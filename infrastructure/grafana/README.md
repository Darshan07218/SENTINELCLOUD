# Grafana configuration lives in `k8s/base/monitoring/config/grafana/`

Since Phase 10, the Grafana datasources, dashboard provider and the four
SentinelCloud dashboards are kept in ONE place,
`k8s/base/monitoring/config/grafana/`. Kubernetes loads them into ConfigMaps
(Kustomize generators) and `docker-compose.yml` bind-mounts the same files.
Kustomize can't read files outside `k8s/`, which is why they live there
rather than here. See `docs/PHASE-10-MONITORING.md`.
