FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn -B dependency:go-offline
COPY src ./src
RUN mvn -B clean package -DskipTests

FROM eclipse-temurin:21-jre-alpine AS runtime
WORKDIR /app
# Phase 9: dedicated unprivileged user with a NUMERIC uid, so the
# Kubernetes pod securityContext (runAsNonRoot: true) can verify it.
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
# Spring Boot's repackaged jar is the only *.jar in target/ (the plain one
# is *.jar.original), so the version in pom.xml isn't hardcoded here.
COPY --from=build /app/target/*.jar app.jar

EXPOSE 8085
# Liveness, not /health: the aggregate includes RabbitMQ, and a broker
# outage must not mark a perfectly healthy JVM "unhealthy". Spring Boot +
# Flyway + Hibernate can take over a minute on a cold, throttled machine.
HEALTHCHECK --interval=10s --timeout=3s --start-period=90s --retries=5 \
  CMD wget -qO- http://localhost:8085/health/liveness || exit 1

# Phase 9: size the heap from the CONTAINER's memory limit, not the
# node's RAM. Java 21 is container-aware, but its default max heap is
# only 25% of the limit — too small for Spring Boot + JPA inside a
# 768Mi pod; see the sizing note below for the exact split between heap and
# non-heap. ExitOnOutOfMemoryError makes an OOM crash the JVM so the
# kubelet restarts the pod cleanly, instead of limping along broken.
# Engineering review: 55% heap plus explicit caps on the non-heap areas.
# With 65% and uncapped metaspace/code cache, heap + non-heap could reach
# the 768Mi limit under load and the kernel OOM-killed the pod (exit 137)
# instead of the JVM failing cleanly.
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=55.0 -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=64m -Xss512k -XX:+ExitOnOutOfMemoryError"

USER 1001:1001

ENTRYPOINT ["java", "-jar", "app.jar"]
