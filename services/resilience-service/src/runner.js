/**
 * Resilience drill engine: runs ONE scenario at a time through the five
 * stages the Resilience Demo page shows:
 *
 *   NORMAL → FAILURE → DETECTION → RECOVERY → RESTORED
 *
 * A scenario only moves to the next stage when the cluster has ACTUALLY
 * reached it (pod NotReady, container restarted, replacement pod ready,
 * HPA scaled out, broker back…), observed through the Kubernetes API.
 * Nothing is advanced on a timer. If the platform never recovers, the
 * run fails with a timeout that says what it was waiting for, which is
 * itself an honest demo result.
 *
 * Every run ends in cleanup (faults cleared, HPA settings restored,
 * load stopped), whether it completed, failed or was aborted.
 */

export const STAGES = Object.freeze(["NORMAL", "FAILURE", "DETECTION", "RECOVERY", "RESTORED"]);

export class AbortedError extends Error {
  constructor() {
    super("drill aborted by an administrator");
    this.name = "AbortedError";
  }
}

export class WaitTimeoutError extends Error {
  constructor(description, timeoutMs) {
    super(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${description}`);
    this.name = "WaitTimeoutError";
  }
}

let runCounter = 0;

export class Run {
  constructor(scenario, { startedBy = null, now = Date.now, minStageDisplayMs = 0 } = {}) {
    runCounter += 1;
    this.now = now;
    // Some steps happen within the same second (a crashed container's
    // endpoint is removed at once, the kubelet restarts it a moment later).
    // So the audience can actually SEE each stage, the API presents every
    // stage for at least this long. Only the presentation is paced: the
    // real stage drives the drill, and every timestamp stays the real one.
    this.minStageDisplayMs = minStageDisplayMs;
    this.id = `drill-${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${runCounter}`;
    this.scenarioId = scenario.id;
    this.title = scenario.title;
    this.target = scenario.target;
    this.demonstrates = scenario.demonstrates;
    this.startedBy = startedBy;
    this.status = "running"; // running | completed | failed | aborted
    this.startedAt = new Date(now()).toISOString();
    this.endedAt = null;
    this.stage = null;
    this.stages = STAGES.map((s) => ({ stage: s, enteredAt: null, summary: null, evidence: null, banner: null }));
    this.banner = { level: "normal", headline: "PREPARING", detail: `Preparing ${scenario.title}…` };
    this.timeline = [];
    this.view = null;
    this.summary = null;
    this.error = null;
    this.abortController = new AbortController();
  }

  setStage(stage, { summary, evidence = null, banner } = {}) {
    if (!STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
    const at = new Date(this.now()).toISOString();
    this.stage = stage;
    const entry = this.stages.find((s) => s.stage === stage);
    entry.enteredAt = at;
    entry.summary = summary || null;
    entry.evidence = evidence;
    if (banner) this.banner = banner;
    entry.banner = this.banner;
    this.timeline.push({ at, stage, kind: "stage", source: "resilience-service", message: summary || stage, evidence });
  }

  log(message, { source = "resilience-service", evidence = null, kind = "info" } = {}) {
    this.timeline.push({ at: new Date(this.now()).toISOString(), stage: this.stage, kind, source, message, evidence });
    if (this.timeline.length > 300) this.timeline.splice(0, this.timeline.length - 300);
  }

  stageTime(stage) {
    const s = this.stages.find((x) => x.stage === stage);
    return s?.enteredAt ? Date.parse(s.enteredAt) : null;
  }

  /**
   * The stage to present now if pacing holds back the real one, else null.
   * Stage i is shown from max(its real time, previous shown-from + min).
   */
  presentedStage() {
    if (!this.minStageDisplayMs) return null;
    const entered = this.stages.filter((s) => s.enteredAt).map((s) => ({ ...s, t: Date.parse(s.enteredAt) })).sort((a, b) => a.t - b.t);
    if (entered.length < 2) return null;
    const now = this.now();
    let from = entered[0].t;
    for (let i = 1; i < entered.length; i += 1) {
      const next = Math.max(entered[i].t, from + this.minStageDisplayMs);
      if (now < next) return { stage: entered[i - 1].stage, banner: entered[i - 1].banner, cut: entered[i].t };
      from = next;
    }
    return null;
  }

  toJSON() {
    const { abortController, now, minStageDisplayMs, ...rest } = this;
    const elapsedSec = ((this.endedAt ? Date.parse(this.endedAt) : now()) - Date.parse(this.startedAt)) / 1000;
    const out = { ...rest, elapsedSec: Math.round(elapsedSec * 10) / 10 };
    const shown = this.status === "running" ? this.presentedStage() : null;
    if (shown) {
      // Present an earlier stage a little longer; later entries appear when its time is up.
      out.stage = shown.stage;
      out.banner = shown.banner;
      out.stages = this.stages.map((s) => (s.enteredAt && Date.parse(s.enteredAt) >= shown.cut ? { ...s, enteredAt: null, summary: null, evidence: null } : s));
      out.timeline = this.timeline.filter((e) => Date.parse(e.at) < shown.cut);
    }
    return out;
  }
}

/** Abortable sleep. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new AbortedError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Polls `check` until it returns a truthy value (which is returned), or times out. */
export async function waitFor(ctx, description, check, { timeoutMs, intervalMs = ctx.cfg.pollMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ctx.signal.aborted) throw new AbortedError();
    let value = null;
    try {
      value = await check();
    } catch (err) {
      // Transient API errors (e.g. the API server briefly busy) shouldn't end the drill.
      ctx.lastCheckError = err.message;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new WaitTimeoutError(description, timeoutMs);
    await sleep(intervalMs, ctx.signal);
  }
}

export class ConflictError extends Error {}
export class UnavailableError extends Error {}

export class ResilienceEngine {
  /**
   * @param {object} deps
   * @param {Array} deps.scenarios      scenario definitions (see scenarios.js)
   * @param {object|null} deps.k8s      Kubernetes client, or null when not running in Kubernetes
   * @param {object} deps.rabbit        RabbitMQ management client
   * @param {Function} deps.request     HTTP client (httpRequest)
   * @param {object} deps.cfg           timings + chaosToken
   */
  constructor({ scenarios, k8s, rabbit, request, cfg, now = Date.now, onRunFinished = () => {} }) {
    Object.assign(this, { scenarioList: scenarios, k8s, rabbit, request, cfg, now, onRunFinished });
    this.run = null;
    this.promise = null;
  }

  availability() {
    if (!this.k8s) {
      return {
        orchestrator: "none",
        available: false,
        reason:
          "resilience-service is not running inside Kubernetes. The drills demonstrate Kubernetes self-healing (probes, restarts, " +
          "replica recovery, autoscaling), so they need the Kubernetes deployment (docs/PHASE-9-KUBERNETES.md). Under Docker " +
          "Compose there is no orchestrator to detect and recover, which is exactly the point the demo makes.",
      };
    }
    if (!this.cfg.chaosToken) {
      return { orchestrator: "kubernetes", available: false, reason: "No CHAOS_TOKEN configured: add RESILIENCE_CHAOS_TOKEN to secrets.env (see secrets.env.example) and re-apply." };
    }
    return { orchestrator: "kubernetes", available: true, reason: null };
  }

  scenarios() {
    const avail = this.availability();
    return {
      ...avail,
      scenarios: this.scenarioList.map(({ id, title, description, target, demonstrates, estimatedSeconds, mechanism }) => ({
        id, title, description, target, demonstrates, estimatedSeconds, mechanism,
      })),
    };
  }

  /** True from start() until cleanup has FINISHED (not just until the run's status changes). */
  isRunning() {
    return this.busy === true;
  }

  current() {
    return this.run ? this.run.toJSON() : null;
  }

  start(scenarioId, { startedBy = null } = {}) {
    const avail = this.availability();
    if (!avail.available) throw new UnavailableError(avail.reason);
    if (this.isRunning()) throw new ConflictError(`a drill is already running (${this.run.title}); abort it or wait for it to finish`);
    const scenario = this.scenarioList.find((s) => s.id === scenarioId);
    if (!scenario) throw new Error(`unknown scenario "${scenarioId}"`);

    const run = new Run(scenario, { startedBy, now: this.now, minStageDisplayMs: this.cfg.minStageDisplayMs ?? 0 });
    this.run = run;
    this.busy = true;
    const ctx = {
      run,
      k8s: this.k8s,
      rabbit: this.rabbit,
      request: this.request,
      cfg: this.cfg,
      state: {},
      signal: run.abortController.signal,
      sleep: (ms) => sleep(ms, run.abortController.signal),
    };

    const sample = async () => {
      try {
        run.view = await scenario.observe(ctx);
      } catch (err) {
        ctx.lastObserveError = err.message;
      }
    };
    const sampler = setInterval(sample, this.cfg.sampleMs);

    this.promise = (async () => {
      run.log(`Drill started by ${startedBy || "an administrator"}: ${scenario.title}`, { kind: "start" });
      try {
        await scenario.run(ctx);
        run.status = "completed";
        run.log("Drill complete: the platform returned to its normal state on its own.", { kind: "end" });
      } catch (err) {
        if (err instanceof AbortedError) {
          run.status = "aborted";
          run.error = err.message;
          run.log("Drill aborted: cleaning up.", { kind: "end" });
        } else {
          run.status = "failed";
          run.error = err.message;
          run.banner = { level: "failed", headline: "DRILL DID NOT COMPLETE", detail: err.message };
          run.log(`Drill stopped: ${err.message}`, { kind: "error" });
        }
      } finally {
        clearInterval(sampler);
        try {
          await scenario.cleanup(ctx);
          run.log("Cleanup done: injected faults cleared, temporary settings restored, load stopped.", { kind: "cleanup" });
        } catch (err) {
          run.log(`Cleanup problem (check manually): ${err.message}`, { kind: "error" });
        }
        await sample();
        run.endedAt = new Date(this.now()).toISOString();
        this.busy = false;
        this.onRunFinished(run);
      }
    })();
    return run;
  }

  abort() {
    if (!this.isRunning()) return false;
    this.run.abortController.abort();
    return true;
  }

  /** Resolves when the current run (if any) has fully finished, including cleanup. */
  async settled() {
    if (this.promise) await this.promise;
  }
}
