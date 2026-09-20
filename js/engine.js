const SEGMENTS = ["aFeed", "bFeed", "preheater", "mixer", "reactor", "separator", "product"];

const COOLING_CAPACITY = {
  primary: 65,
  backup: 52,
  emergency: 145,
};

const LIMITS = {
  warn: { temperature: 190, pressure: 2.3, purity: 97 },
  protect: { temperature: 200, pressure: 2.5, purity: 95 },
  trip: { temperature: 205, pressure: 2.6, purity: 92 },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function makeParcel(aFlow, bFlow, temperature, pressure, purity, age = 0) {
  return {
    aFlow,
    bFlow,
    temperature,
    pressure,
    purity,
    age,
  };
}

function steadyParcelQueue(delay, parcel) {
  return Array.from({ length: delay }, () => clone(parcel));
}

function shiftPipeline(queue, parcel, delay) {
  const next = [...queue, parcel];
  if (next.length > delay) {
    return {
      output: next.shift(),
      queue: next,
    };
  }
  return {
    output: null,
    queue: next,
  };
}

function mix(aParcel, bParcel, temperature, pressure) {
  const aFlow = aParcel ? aParcel.aFlow : 0;
  const bFlow = bParcel ? bParcel.bFlow : 0;
  const weightedPurity =
    aFlow * (aParcel ? aParcel.purity : 0) + bFlow * (bParcel ? bParcel.purity : 0);
  const purity = aFlow + bFlow > 0 ? weightedPurity / (aFlow + bFlow) : 0;
  return makeParcel(aFlow, bFlow, temperature, pressure, purity);
}

function createInitialState() {
  const feedParcel = makeParcel(50, 50, 25, 1.45, 100);
  const reactorParcel = makeParcel(50, 50, 180, 1.45, 99.4);
  const productParcel = makeParcel(50, 50, 50, 1.45, 99.4);

  return {
    t: 0,
    phase: "normal",
    controls: {
      valveA: 0.5,
      valveB: 0.5,
      load: 1,
      cooling: "primary",
    },
    effective: {
      valveA: 0.5,
      valveB: 0.5,
      load: 1,
      cooling: "primary",
    },
    reactor: {
      temperature: 180,
      pressure: 1.45,
      heatLoad: 55,
      coolingLoad: 55,
    },
    segments: {
      aFeed: {
        label: "A进料",
        delay: 2,
        queue: steadyParcelQueue(2, makeParcel(50, 0, 25, 1.45, 100)),
        current: clone(feedParcel),
      },
      bFeed: {
        label: "B进料",
        delay: 2,
        queue: steadyParcelQueue(2, makeParcel(0, 50, 25, 1.45, 100)),
        current: clone(feedParcel),
      },
      preheater: {
        label: "预热器",
        delay: 3,
        queue: steadyParcelQueue(3, reactorParcel),
        current: clone(reactorParcel),
      },
      mixer: {
        label: "混合器",
        delay: 0,
        queue: [],
        current: clone(reactorParcel),
      },
      reactor: {
        label: "反应器",
        delay: 3,
        queue: steadyParcelQueue(3, reactorParcel),
        current: clone(reactorParcel),
      },
      separator: {
        label: "分离精制",
        delay: 5,
        queue: steadyParcelQueue(5, productParcel),
        current: clone(productParcel),
      },
      product: {
        label: "成品纯度",
        delay: 0,
        queue: [],
        current: clone(productParcel),
      },
    },
    alerts: [],
    protection: {
      coolingForced: false,
      loadShed: false,
      divert: false,
      relief: false,
    },
    recovery: null,
    stable: true,
    stableAt: 0,
    lastChangeAt: 0,
    stableFor: 0,
    events: [
      {
        t: 0,
        level: "info",
        phase: "normal",
        text: "装置处于稳态：进料比例1:1，温度180℃，压力1.45MPa，纯度99.4%。",
      },
    ],
  };
}

function createStore() {
  const state = createInitialState();
  const lastValid = {
    valveA: state.controls.valveA,
    valveB: state.controls.valveB,
    load: state.controls.load,
    cooling: state.controls.cooling,
  };
  const rootSnapshot = snapshotState(state);
  const plans = [
    {
      id: 1,
      name: "基准方案",
      parentId: null,
      status: "active",
      createdAt: 0,
      rootSnapshot,
    },
  ];

  return {
    state,
    lastValid,
    plans,
    nextPlanId: 2,
  };
}

function snapshotState(state) {
  return clone(state);
}

function addEvent(state, level, text) {
  state.events.unshift({
    t: state.t,
    level,
    phase: state.phase,
    text,
  });
  state.events = state.events.slice(0, 120);
}

function setAlert(state, key, active, level, text) {
  const existing = state.alerts.find((alert) => alert.key === key);
  if (existing) {
    if (!active) {
      state.alerts = state.alerts.filter((alert) => alert.key !== key);
    }
    return;
  }
  if (active) {
    state.alerts.push({ key, level, text });
    addEvent(state, level, text);
  }
}

function updateStage(state) {
  if (state.phase === "protection" || state.phase === "esd" || state.phase === "recovery") {
    return;
  }

  if (state.alerts.length > 0) {
    if (state.phase === "normal") {
      addEvent(state, "warning", "进入预警阶段：仍可操作，但异常参数正在沿流程传播。");
    }
    state.phase = "warning";
  } else {
    if (state.phase === "warning") {
      addEvent(state, "info", "预警解除：装置回到正常阶段。");
    }
    state.phase = "normal";
  }
}

function moveToward(current, target, maxStep) {
  if (Math.abs(target - current) <= maxStep) {
    return target;
  }
  return current + Math.sign(target - current) * maxStep;
}

function coolingCapacity(circuit, temperature, emergencyActive) {
  if (circuit === "emergency" || emergencyActive) {
    return clamp(78 + (temperature - 165) * 1.25, 0, COOLING_CAPACITY.emergency);
  }

  const base = COOLING_CAPACITY[circuit] || COOLING_CAPACITY.primary;
  const lowTemperatureBoost = 0;
  const temperaturePenalty = Math.max(0, temperature - 190) * 0.4;
  return Math.max(0, base - temperaturePenalty) + (emergencyActive ? 18 : 0);
}

function updateEffectiveControls(state) {
  const requested = state.controls;
  const effective = state.effective;

  if (state.phase === "esd") {
    effective.valveA = moveToward(effective.valveA, 0, 1);
    effective.valveB = moveToward(effective.valveB, 0, 1);
    effective.load = moveToward(effective.load, 0, 1);
    effective.cooling = "emergency";
    return;
  }

  if (state.phase === "recovery") {
    effective.valveA = moveToward(effective.valveA, requested.valveA, 0.04);
    effective.valveB = moveToward(effective.valveB, requested.valveB, 0.04);
    effective.load = moveToward(effective.load, requested.load, 0.025);
  } else {
    effective.valveA = moveToward(effective.valveA, requested.valveA, 0.08);
    effective.valveB = moveToward(effective.valveB, requested.valveB, 0.08);
    effective.load = moveToward(effective.load, requested.load, 0.03);
  }

  const useEmergencyCooling = state.protection.coolingForced || requested.cooling === "emergency";
  effective.cooling = useEmergencyCooling ? "emergency" : requested.cooling;

  if (state.protection.loadShed && state.phase !== "recovery") {
    effective.load = Math.min(effective.load, 0.35);
  }
}

function updateAlerts(state, productParcel) {
  const { temperature, pressure } = state.reactor;
  const purity = productParcel ? productParcel.purity : state.segments.product.current.purity;

  setAlert(
    state,
    "temperatureWarn",
    temperature >= LIMITS.warn.temperature,
    "warning",
    `温度预警：反应器温度${temperature.toFixed(1)}℃达到预警线。`
  );
  setAlert(
    state,
    "pressureWarn",
    pressure >= LIMITS.warn.pressure,
    "warning",
    `压力预警：反应器压力${pressure.toFixed(2)}MPa达到预警线。`
  );
  setAlert(
    state,
    "purityWarn",
    purity <= LIMITS.warn.purity,
    "warning",
    `质量预警：下游成品纯度${purity.toFixed(1)}%低于预警线。`
  );
}

function activateReactorProtection(
  state,
  temperature,
  pressure,
  previousTemperature,
  previousPressure,
  purity
) {
  if (state.phase !== "normal" && state.phase !== "warning" && state.phase !== "protection") {
    return;
  }

  const highTemperature =
    temperature >= LIMITS.protect.temperature ||
      (previousTemperature !== null && temperature - previousTemperature >= 4.5);
  const highPressure =
    pressure >= LIMITS.protect.pressure ||
    (previousPressure !== null && pressure - previousPressure >= 0.08);
  const lowPurity =
    purity !== null && purity <= LIMITS.protect.purity && !state.protection.divert;

  if (highTemperature || highPressure) {
    if (!state.protection.coolingForced) {
      addEvent(state, "protection", "保护介入：自动切入紧急冷却回路。");
    }
    state.protection.coolingForced = true;
  }

  if (highTemperature) {
    if (!state.protection.loadShed) {
      addEvent(state, "protection", "保护介入：同步降低负荷至35%，削减反应热输入。");
    }
    state.protection.loadShed = true;
  }

  if (highPressure) {
    if (!state.protection.loadShed) {
      addEvent(state, "protection", "保护介入：打开泄压能力。");
    }
    state.protection.relief = true;
  }

  if (lowPurity) {
    if (!state.protection.divert) {
      addEvent(state, "protection", "保护介入：成品转入不合格罐，防止污染合格产品。");
    }
    state.protection.divert = true;
  }

  if (
    state.protection.coolingForced ||
    state.protection.loadShed ||
    state.protection.divert
  ) {
    state.phase = "protection";
  }
}

function checkTrip(state) {
  const temperature = state.reactor.temperature;
  const pressure = state.reactor.pressure;
  const purity = state.segments.product.current.purity;
  const severeTemperature = temperature >= LIMITS.trip.temperature;
  const severePressure = pressure >= LIMITS.trip.pressure;
  const severePurity = purity <= LIMITS.trip.purity && !state.protection.divert;

  if (severeTemperature || severePressure || severePurity) {
    triggerShutdown(state, severeTemperature, severePressure, severePurity);
  }
}

function predictedHeatLoad(parcel, state) {
  const totalIn = parcel.aFlow + parcel.bFlow;
  const ratio =
    parcel.aFlow > 0.01 && parcel.bFlow > 0.01
      ? Math.max(parcel.aFlow, parcel.bFlow) / Math.min(parcel.aFlow, parcel.bFlow)
      : 99;
  const ratioError = Math.max(0, ratio - 1);

  return (
    (totalIn > 0.1
      ? 65 *
        (0.35 + state.effective.load * 0.65) *
        (1 + ratioError * 0.25)
      : 0) +
    Math.max(0, state.reactor.temperature - 190) * 0.9 +
    Math.max(0, state.reactor.temperature - 200) * 1.2
  );
}

function triggerShutdown(state, severeTemperature, severePressure, severePurity) {
  state.phase = "esd";
  state.recovery = null;
  state.protection.coolingForced = true;
  state.protection.loadShed = true;
  state.protection.relief = true;
  state.protection.divert = true;
  state.lastChangeAt = state.t;

  const reasons = [];
  if (severeTemperature) reasons.push("温度失控");
  if (severePressure) reasons.push("压力累积超限");
  if (severePurity) reasons.push("下游质量严重异常");
  addEvent(state, "danger", `紧急停车：${reasons.join("、")}，进料切断、紧急冷却与泄压投入。`);
}

function reactParcel(parcel, state) {
  const totalIn = parcel.aFlow + parcel.bFlow;
  const ratio =
    parcel.aFlow > 0.01 && parcel.bFlow > 0.01
      ? Math.max(parcel.aFlow, parcel.bFlow) / Math.min(parcel.aFlow, parcel.bFlow)
      : 99;
  const ratioError = Math.max(0, ratio - 1);
  const load = state.effective.load;
  const temperature = state.reactor.temperature;

  const heatLoad =
    ((totalIn > 0.1
      ? 65 * (0.8 + load * 0.2) * (1 + ratioError * 0.25)
      : 0) + Math.max(0, 180 - temperature) * (state.phase === "recovery" ? 2 : 0)) +
    Math.max(0, temperature - 190) * 0.9 +
    Math.max(0, temperature - 200) * 1.2;

  const emergencyActive = state.effective.cooling === "emergency" || state.protection.coolingForced;
  const coolingLoad = coolingCapacity(state.effective.cooling, temperature, emergencyActive);
  const netHeat = heatLoad - coolingLoad;

  const nextTemperature = clamp(
    temperature +
      netHeat * 0.18 +
      (state.phase === "recovery" ? 0 : (180 - temperature) * 0.08),
    20,
    260
  );

  const gasLoad = totalIn * (0.72 + load * 0.7) + Math.max(0, temperature - 180) * 0.55;
  const pressureDrivenOutlet =
    state.reactor.pressure < 1.45
      ? Math.max(0, (1.45 - state.reactor.pressure) * 500)
      : (state.reactor.pressure - 1.45) * 65;
  const outletCapacity =
    totalIn * 0.72 + 70 - pressureDrivenOutlet +
    (state.protection.relief || state.phase === "esd" ? 22 : 0) -
    Math.max(0, temperature - 200) * 0.35;
  const pressureGap = state.reactor.pressure - 1.45;
  const nextPressure = clamp(
    state.reactor.pressure +
      (gasLoad - outletCapacity) * 0.001 -
      (state.phase === "recovery" ? 0 : pressureGap * 0.018),
    0.05,
    4
  );

  const thermalPurityPenalty =
    Math.max(0, temperature - 185) * 0.22 +
    Math.max(0, temperature - 200) * 0.55 +
    ratioError * 2.1 +
    Math.abs(load - 1) * 1.2 +
    Math.max(0, nextPressure - 2.1) * 2.4;
  const reactorPurity = clamp(99.4 - thermalPurityPenalty, 82, 99.5);

  state.reactor.heatLoad = heatLoad;
  state.reactor.coolingLoad = coolingLoad;
  state.reactor.temperature = nextTemperature;
  state.reactor.pressure = nextPressure;

  return makeParcel(
    parcel.aFlow,
    parcel.bFlow,
    nextTemperature,
    nextPressure,
    reactorPurity
  );
}

function separateParcel(parcel, state) {
  const totalFlow = parcel.aFlow + parcel.bFlow;
  const flowPenalty = Math.max(0, totalFlow - 105) * 0.04;
  const pressurePenalty = Math.max(0, parcel.pressure - 1.45) * 0.12;
  const offSpec = state.protection.divert || state.phase === "esd";
  const purity = clamp(parcel.purity - flowPenalty - pressurePenalty, 82, 99.5);
  const temperature = clamp(parcel.temperature - 125 - (offSpec ? 4 : 0), 20, 140);
  const pressure = clamp(parcel.pressure * 0.16, 0.05, 0.8);
  return makeParcel(parcel.aFlow, parcel.bFlow, temperature, pressure, purity);
}

function checkStability(state, oldTemperature, oldPressure, previousProductPurity, productParcel) {
  const productPurity = productParcel ? productParcel.purity : previousProductPurity;
  const totalFeed = state.effective.valveA + state.effective.valveB;
  const flowNearTarget =
    Math.abs(state.effective.valveA - state.controls.valveA) < 0.005 &&
    Math.abs(state.effective.valveB - state.controls.valveB) < 0.005 &&
    Math.abs(state.effective.load - state.controls.load) < 0.005;
  const temperatureStable =
    Math.abs(state.reactor.temperature - oldTemperature) < 0.08 &&
    Math.abs(state.reactor.temperature - 180) < 8;
  const pressureStable =
    Math.abs(state.reactor.pressure - oldPressure) < 0.01 &&
    Math.abs(state.reactor.pressure - 1.45) < 0.15;
  const purityStable = Math.abs(productPurity - previousProductPurity) < 0.035;
  const noTransientProtection = state.phase !== "protection" && state.phase !== "esd";

  return (
    totalFeed > 0.3 &&
    flowNearTarget &&
    temperatureStable &&
    pressureStable &&
    purityStable &&
    noTransientProtection
  );
}

function tickState(inputState) {
  const state = clone(inputState);
  state.t += 1;
  updateEffectiveControls(state);

  const oldTemperature = inputState.reactor.temperature;
  const oldPressure = inputState.reactor.pressure;
  const previousProductPurity = inputState.segments.product.current.purity;

  const feedScale = 100;
  const aFlow = state.effective.valveA * feedScale * state.effective.load;
  const bFlow = state.effective.valveB * feedScale * state.effective.load;

  const aInput = makeParcel(aFlow, 0, 25, 1.45, 100);
  const bInput = makeParcel(0, bFlow, 25, 1.45, 100);
  const aResult = shiftPipeline(state.segments.aFeed.queue, aInput, 2);
  const bResult = shiftPipeline(state.segments.bFeed.queue, bInput, 2);
  state.segments.aFeed.queue = aResult.queue;
  state.segments.bFeed.queue = bResult.queue;
  state.segments.aFeed.current = aResult.output || aInput;
  state.segments.bFeed.current = bResult.output || bInput;

  const mixed = mix(
    state.segments.aFeed.current,
    state.segments.bFeed.current,
    78,
    1.45
  );
  state.segments.mixer.current = mixed;
  state.segments.mixer.queue = [clone(mixed)];

  const preheatResult = shiftPipeline(state.segments.preheater.queue, mixed, 3);
  state.segments.preheater.queue = preheatResult.queue;
  state.segments.preheater.current = preheatResult.output
    ? makeParcel(
        preheatResult.output.aFlow,
        preheatResult.output.bFlow,
        125,
        1.45,
        preheatResult.output.purity
      )
    : state.segments.preheater.current;

  const reactorInput = preheatResult.output || state.segments.preheater.current;
  if (state.phase === "normal" || state.phase === "warning") {
    const currentCooling = coolingCapacity(
      state.effective.cooling,
      state.reactor.temperature,
      state.protection.coolingForced
    );
    const forecastHeat = predictedHeatLoad(reactorInput, state);
    const projectedTemperature =
      state.reactor.temperature +
      (forecastHeat - currentCooling) * 0.18;
    activateReactorProtection(
      state,
      projectedTemperature,
      state.reactor.pressure,
      oldTemperature,
      oldPressure,
      null
    );
    updateEffectiveControls(state);
  }
  const reactorOutput = reactParcel(reactorInput, state);
  const reactorResult = shiftPipeline(state.segments.reactor.queue, reactorOutput, 3);
  state.segments.reactor.queue = reactorResult.queue;
  state.segments.reactor.current = reactorResult.output || state.segments.reactor.current;

  const separatorInput = reactorResult.output || state.segments.reactor.current;
  const separatorOutput = separateParcel(separatorInput, state);
  const separatorResult = shiftPipeline(state.segments.separator.queue, separatorOutput, 5);
  state.segments.separator.queue = separatorResult.queue;
  state.segments.separator.current = separatorResult.output || state.segments.separator.current;

  state.segments.product.current = clone(state.segments.separator.current);
  state.segments.product.queue = [clone(state.segments.product.current)];

  updateAlerts(state, state.segments.product.current);
  updateStage(state);
  activateReactorProtection(
    state,
    state.reactor.temperature,
    state.reactor.pressure,
    oldTemperature,
    oldPressure,
    state.segments.product.current.purity
  );
  checkTrip(state);

  if (state.phase === "protection") {
    const safe =
      state.reactor.temperature < 188 &&
      state.reactor.pressure < 2.1 &&
      state.segments.product.current.purity > 97.5;
    if (safe) {
      const requestedCoolingIsAdequate = state.controls.cooling !== "backup";
      state.protection.coolingForced = !requestedCoolingIsAdequate;
      state.protection.loadShed = false;
      state.protection.relief = false;
      state.protection.divert = false;
      state.phase = requestedCoolingIsAdequate ? "normal" : "protection";
      addEvent(
        state,
        requestedCoolingIsAdequate ? "info" : "warning",
        requestedCoolingIsAdequate
          ? "保护动作解除：关键参数回到正常范围。"
          : "备用回路仍不足，紧急冷却保持介入；请恢复主冷却或降低负荷。"
      );
    } else {
      const severeTemperature = state.reactor.temperature >= LIMITS.trip.temperature;
      const severePressure = state.reactor.pressure >= LIMITS.trip.pressure;
      const severePurity =
        state.segments.product.current.purity <= LIMITS.trip.purity &&
        !state.protection.divert;

      if (severeTemperature || severePressure || severePurity) {
        triggerShutdown(state, severeTemperature, severePressure, severePurity);
      }
    }
  }

  if (state.phase === "recovery" && state.recovery) {
    advanceRecovery(state);
  }

  const stableNow = checkStability(
    state,
    oldTemperature,
    oldPressure,
    previousProductPurity,
    state.segments.product.current
  );
  state.stable = stableNow;
  if (stableNow && inputState.stable) {
    state.stableFor = inputState.stableFor + 1;
  } else if (stableNow) {
    state.stableFor = 1;
  } else {
    state.stableAt = state.t;
    state.stableFor = 0;
  }

  return state;
}

function beginRecovery(store) {
  const state = store.state;
  if (state.phase !== "esd") {
    return { ok: false, error: "只有紧急停车后的装置可以发起恢复。" };
  }
  if (state.reactor.temperature > 188 || state.reactor.pressure > 2.0) {
    return { ok: false, error: "温度或压力尚未降到恢复允许窗口，请继续紧急冷却和泄压。" };
  }

  state.phase = "recovery";
  state.effective.valveA = 0;
  state.effective.valveB = 0;
  state.effective.load = 0;
  state.controls.valveA = store.lastValid.valveA;
  state.controls.valveB = store.lastValid.valveB;
  state.controls.load = Math.min(store.lastValid.load, 0.8);
  state.controls.cooling = "emergency";
  state.effective.cooling = "emergency";
  state.recovery = {
    startedAt: state.t,
    confirmedAt: null,
  };
  state.lastChangeAt = state.t;
  addEvent(state, "info", "恢复生产：先切断进料并保持紧急冷却，随后低负荷平稳爬坡。");
  return { ok: true };
}

function advanceRecovery(state) {
  if (
    state.recovery.confirmedAt === null &&
    state.reactor.temperature <= 188 &&
    state.reactor.pressure <= 2.0
  ) {
    state.recovery.confirmedAt = state.t;
    addEvent(state, "info", "恢复确认：装置已降压降温，开始低负荷进料。");
  }

  if (
    state.recovery.confirmedAt !== null &&
    state.reactor.temperature < 168 &&
    state.reactor.pressure < 1.2
  ) {
    state.protection.coolingForced = false;
    state.controls.cooling = "primary";
    state.effective.cooling = "primary";
  }

  const readyToRamp =
    state.recovery.confirmedAt !== null;

  if (!readyToRamp && state.recovery.confirmedAt === null) {
    state.effective.valveA = 0;
    state.effective.valveB = 0;
    state.effective.load = 0;
    return;
  }

  if (
    state.effective.load >= state.controls.load - 0.005 &&
    Math.abs(state.effective.valveA - state.controls.valveA) < 0.01 &&
    Math.abs(state.effective.valveB - state.controls.valveB) < 0.01 &&
    state.reactor.temperature >= 166 &&
    state.reactor.temperature < 184 &&
    state.reactor.pressure >= 1.32 &&
    state.reactor.pressure < 1.6 &&
    state.segments.product.current.purity >= 98.5 &&
    state.t - state.recovery.confirmedAt > 12
  ) {
    state.phase = "normal";
    state.protection.coolingForced = false;
    state.protection.loadShed = false;
    state.protection.relief = false;
    state.protection.divert = false;
    state.controls.cooling = "primary";
    state.effective.cooling = "primary";
    state.recovery = null;
    state.stableAt = state.t;
    addEvent(state, "success", "恢复生产完成：装置回到正常生产阶段。");
  }
}

function activePlan(store) {
  return store.plans.find((plan) => plan.status === "active");
}

function afterTick(store) {
  const plan = activePlan(store);
  if (
    plan &&
    store.state.phase === "normal" &&
    store.state.stable &&
    store.state.t - store.state.lastChangeAt >= 10
  ) {
    store.lastValid = {
      valveA: store.state.controls.valveA,
      valveB: store.state.controls.valveB,
      load: store.state.controls.load,
      cooling: store.state.controls.cooling,
    };
  }
}

function tick(store) {
  store.state = tickState(store.state);
  afterTick(store);
  return store.state;
}

function applyAction(store, action, value) {
  const state = store.state;

  if (state.phase === "esd") {
    return { ok: false, error: "紧急停车阶段不能直接调整阀门或负荷，请先执行恢复流程。" };
  }

  if (state.phase === "recovery") {
    return { ok: false, error: "恢复爬坡由恢复程序控制，不能手动改变进料、负荷或冷却。" };
  }

  if (action === "setValveA" || action === "setValveB") {
    const key = action === "setValveA" ? "valveA" : "valveB";
    const next = clamp(Number(value), 0, 1);
    if (!Number.isFinite(next)) {
      return { ok: false, error: "阀门开度必须是0到1之间的数字。" };
    }
    state.controls[key] = next;
    state.lastChangeAt = state.t;
    addEvent(
      state,
      "info",
      `${key === "valveA" ? "A" : "B"}阀开度设定为${Math.round(next * 100)}%。`
    );
    return { ok: true };
  }

  if (action === "setLoad") {
    const next = clamp(Number(value), 0.35, 1.1);
    if (!Number.isFinite(next)) {
      return { ok: false, error: "负荷必须是35%到110%之间的数字。" };
    }
    state.controls.load = next;
    state.lastChangeAt = state.t;
    addEvent(state, "info", `生产负荷设定为${Math.round(next * 100)}%。`);
    return { ok: true };
  }

  if (action === "switchCooling") {
    if (!COOLING_CAPACITY[value]) {
      return { ok: false, error: "未知冷却回路。" };
    }
    state.controls.cooling = value;
    state.lastChangeAt = state.t;
    const labels = {
      primary: "主冷却回路",
      backup: "备用冷却回路",
      emergency: "紧急冷却回路",
    };
    addEvent(state, "info", `冷却回路切换为${labels[value]}，能力变化从反应器开始体现。`);
    return { ok: true };
  }

  return { ok: false, error: "不支持的操作。" };
}

function restoreSnapshot(store, snapshot, text) {
  store.state = clone(snapshot);
  addEvent(store.state, "info", text);
  return store.state;
}

function createPlanAtStablePoint(store, name) {
  const state = store.state;
  const current = activePlan(store);

  if (!current) {
    return { ok: false, error: "没有可分支的尝试。" };
  }
  if (!state.stable || state.phase === "protection" || state.phase === "esd") {
    return { ok: false, error: "只能在非保护、非停车的稳定点生成新方案。" };
  }

  const snapshot = snapshotState(state);
  current.status = "branched";
  const plan = {
    id: store.nextPlanId++,
    name: name || `方案 ${store.nextPlanId - 1}`,
    parentId: current.id,
    status: "active",
    createdAt: state.t,
    rootSnapshot: snapshot,
  };
  store.plans.push(plan);
  addEvent(state, "success", `已从当前稳定点生成新方案：${plan.name}。原方案保留且不会被覆盖。`);
  return { ok: true, plan };
}

function abandonActiveAttempt(store) {
  const current = activePlan(store);
  if (!current) {
    return { ok: false, error: "当前没有可放弃的尝试。" };
  }

  const snapshot = current.rootSnapshot;
  const failedName = current.name;
  current.status = "failed";
  restoreSnapshot(
    store,
    snapshot,
    `失败尝试 ${failedName} 已回滚到其稳定起点，最后有效配置未被覆盖。`
  );

  const continuation = {
    id: store.nextPlanId++,
    name: `稳定点继续 ${store.nextPlanId - 1}`,
    parentId: current.id,
    status: "active",
    createdAt: store.state.t,
    rootSnapshot: snapshotState(store.state),
  };
  store.plans.push(continuation);
  return { ok: true, plan: continuation };
}

function restoreLastValidConfig(store) {
  const state = store.state;
  if (state.phase === "recovery") {
    return { ok: false, error: "恢复程序进行中不能替换爬坡配置。" };
  }

  state.controls = { ...store.lastValid };
  state.lastChangeAt = state.t;
  addEvent(
    state,
    "success",
    "已调用最后一次有效配置；若装置已停车，请继续执行降压降温和恢复生产。"
  );
  return { ok: true };
}

const api = {
  SEGMENTS,
  COOLING_CAPACITY,
  LIMITS,
  createInitialState,
  createStore,
  snapshotState,
  tickState,
  tick,
  applyAction,
  beginRecovery,
  createPlanAtStablePoint,
  abandonActiveAttempt,
  restoreLastValidConfig,
  activePlan,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}

if (typeof window !== "undefined") {
  window.ProcessEngine = api;
}
