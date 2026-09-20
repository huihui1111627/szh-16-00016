(function () {
  const engine = window.ProcessEngine;
  let store = engine.createStore();
  let timer = null;

  const $ = (id) => document.getElementById(id);

  const elements = {
    clock: $("clock"),
    stepBtn: $("stepBtn"),
    runBtn: $("runBtn"),
    resetBtn: $("resetBtn"),
    stageTitle: $("stageTitle"),
    stageDescription: $("stageDescription"),
    stableBadge: $("stableBadge"),
    alerts: $("alerts"),
    processFlow: $("processFlow"),
    valveA: $("valveA"),
    valveB: $("valveB"),
    load: $("load"),
    valveALabel: $("valveALabel"),
    valveBLabel: $("valveBLabel"),
    loadLabel: $("loadLabel"),
    heatLoad: $("heatLoad"),
    coolingLoad: $("coolingLoad"),
    reactorTemperature: $("reactorTemperature"),
    reactorPressure: $("reactorPressure"),
    recoverBtn: $("recoverBtn"),
    restoreBtn: $("restoreBtn"),
    branchBtn: $("branchBtn"),
    abandonBtn: $("abandonBtn"),
    feedback: $("feedback"),
    lastValid: $("lastValid"),
    planList: $("planList"),
    eventLog: $("eventLog"),
  };

  const stageInfo = {
    normal: {
      title: "正常生产",
      description: "关键参数处于正常窗口。操作设定会先经过阀门动作速率，再沿进料、预热、混合、反应、分离顺序传播。",
    },
    warning: {
      title: "预警阶段",
      description: "温度、压力或下游纯度越过预警线。仍允许人工纠偏，但新影响不会瞬时消失，需等待管线内物料逐段更新。",
    },
    protection: {
      title: "保护介入",
      description: "安全系统已自动投入紧急冷却、降负荷、泄压或不合格罐切换。若关键量继续越限，将升级为紧急停车。",
    },
    esd: {
      title: "紧急停车",
      description: "联锁切断进料并保持紧急冷却和泄压。待温度、压力降到安全窗口后，操作人员才能发起恢复生产。",
    },
    recovery: {
      title: "恢复生产",
      description: "装置先降压降温，再按最后有效配置低负荷爬坡；温度、压力和下游纯度稳定后自动回到正常生产。",
    },
  };

  const coolingNames = {
    primary: "主冷却",
    backup: "备用冷却",
    emergency: "紧急冷却",
  };

  const planStatusNames = {
    active: "当前尝试",
    branched: "已分支",
    failed: "失败保留",
  };

  function percent(value) {
    return `${Math.round(value * 100)}%`;
  }

  function fixed(value, digits) {
    return Number(value).toFixed(digits);
  }

  function showFeedback(message, ok) {
    elements.feedback.textContent = message || "";
    elements.feedback.className = ok ? "feedback ok" : "feedback";
  }

  function handleAction(action, value) {
    const result = engine.applyAction(store, action, value);
    showFeedback(result.ok ? "操作已设定，影响将按物料顺序传播。" : result.error, result.ok);
    render();
    return result.ok;
  }

  function step() {
    engine.tick(store);
    showFeedback("", true);
    render();
  }

  function setRunning(nextRunning) {
    if (nextRunning) {
      timer = window.setInterval(step, 850);
      elements.runBtn.textContent = "暂停推演";
    } else {
      window.clearInterval(timer);
      timer = null;
      elements.runBtn.textContent = "连续推演";
    }
  }

  function renderStage(state) {
    const info = stageInfo[state.phase];
    elements.clock.textContent = `T+${state.t}s`;
    elements.stageTitle.textContent = info.title;
    elements.stageDescription.textContent = info.description;
    elements.stableBadge.textContent = state.stable ? "稳定点" : "传播中";
    elements.stableBadge.className = `badge ${state.stable ? "stable" : "transient"}`;

    document.querySelectorAll(".stage-track span").forEach((node) => {
      node.classList.toggle("active", node.dataset.stage === state.phase);
    });

    elements.alerts.innerHTML = state.alerts
      .map((alert) => `<div class="alert ${alert.level}">${alert.text}</div>`)
      .join("");
  }

  function segmentStateClass(name, parcel, state) {
    if (name === "reactor") {
      if (state.reactor.temperature >= engine.LIMITS.protect.temperature) return "danger-state";
      if (state.reactor.temperature >= engine.LIMITS.warn.temperature) return "warning-state";
    }
    if (name === "product" || name === "separator") {
      if (parcel.purity <= engine.LIMITS.protect.purity) return "danger-state";
      if (parcel.purity <= engine.LIMITS.warn.purity) return "warning-state";
    }
    return "";
  }

  function pipelineDots(segment) {
    if (!segment.delay) return "";
    return `<div class="pipeline">${Array.from(
      { length: segment.delay },
      (_, index) => `<i class="${index < segment.queue.length ? "filled" : ""}"></i>`
    ).join("")}</div>`;
  }

  function renderProcess(state) {
    const rows = [
      {
        key: "aFeed",
        value: `A ${fixed(state.segments.aFeed.current.aFlow, 1)}`,
        detail: `阀 ${percent(state.effective.valveA)} · 25℃`,
      },
      {
        key: "bFeed",
        value: `B ${fixed(state.segments.bFeed.current.bFlow, 1)}`,
        detail: `阀 ${percent(state.effective.valveB)} · 25℃`,
      },
      {
        key: "preheater",
        value: `${fixed(state.segments.preheater.current.aFlow + state.segments.preheater.current.bFlow, 1)}`,
        detail: `预热至125℃`,
      },
      {
        key: "mixer",
        value: ratioText(state.segments.mixer.current),
        detail: `总流量 ${fixed(totalFlow(state.segments.mixer.current), 1)}`,
      },
      {
        key: "reactor",
        value: `${fixed(state.reactor.temperature, 1)}℃`,
        detail: `${fixed(state.reactor.pressure, 2)}MPa`,
      },
      {
        key: "separator",
        value: `${fixed(state.segments.separator.current.purity, 1)}%`,
        detail: `${fixed(state.segments.separator.current.temperature, 1)}℃`,
      },
      {
        key: "product",
        value: `${fixed(state.segments.product.current.purity, 1)}%`,
        detail: state.protection.divert || state.phase === "esd" ? "不合格罐" : "合格产品",
      },
    ];

    elements.processFlow.innerHTML = rows
      .map((row) => {
        const segment = state.segments[row.key];
        const stateClass = segmentStateClass(row.key, segment.current, state);
        return `
          <article class="segment-card ${stateClass}">
            <h3>${segment.label}</h3>
            <dl>
              <dt>当前值</dt><dd>${row.value}</dd>
              <dt>状态</dt><dd>${row.detail}</dd>
            </dl>
            ${pipelineDots(segment)}
          </article>
        `;
      })
      .join("");
  }

  function totalFlow(parcel) {
    return parcel.aFlow + parcel.bFlow;
  }

  function ratioText(parcel) {
    if (parcel.aFlow < 0.1 || parcel.bFlow < 0.1) return "断料";
    const ratio = Math.max(parcel.aFlow, parcel.bFlow) / Math.min(parcel.aFlow, parcel.bFlow);
    return `比例 ${fixed(ratio, 2)}:1`;
  }

  function renderControls(state) {
    elements.valveA.value = Math.round(state.controls.valveA * 100);
    elements.valveB.value = Math.round(state.controls.valveB * 100);
    elements.load.value = Math.round(state.controls.load * 100);
    elements.valveALabel.textContent = percent(state.controls.valveA);
    elements.valveBLabel.textContent = percent(state.controls.valveB);
    elements.loadLabel.textContent = percent(state.controls.load);

    document.querySelectorAll("[data-cooling]").forEach((button) => {
      button.classList.toggle("active", button.dataset.cooling === state.controls.cooling);
    });

    const locked = state.phase === "esd" || state.phase === "recovery";
    elements.valveA.disabled = locked;
    elements.valveB.disabled = locked;
    elements.load.disabled = locked;
    elements.recoverBtn.disabled =
      state.phase !== "esd" ||
      state.reactor.temperature > 188 ||
      state.reactor.pressure > 2.0;
    elements.restoreBtn.disabled = state.phase === "recovery";
    elements.branchBtn.disabled =
      !state.stable || state.phase === "protection" || state.phase === "esd";
    elements.abandonBtn.disabled = store.plans.filter((plan) => plan.status === "active").length === 0;
  }

  function renderMetrics(state) {
    elements.heatLoad.textContent = fixed(state.reactor.heatLoad, 1);
    elements.coolingLoad.textContent = fixed(state.reactor.coolingLoad, 1);
    elements.reactorTemperature.textContent = `${fixed(state.reactor.temperature, 1)}℃`;
    elements.reactorPressure.textContent = `${fixed(state.reactor.pressure, 2)}MPa`;
  }

  function renderPlans() {
    const cooling = coolingNames[store.lastValid.cooling];
    elements.lastValid.innerHTML = `
      <strong>最后有效配置</strong><br />
      A阀 ${percent(store.lastValid.valveA)} ·
      B阀 ${percent(store.lastValid.valveB)} ·
      负荷 ${percent(store.lastValid.load)} ·
      ${cooling}
    `;

    elements.planList.innerHTML = store.plans
      .slice()
      .reverse()
      .map((plan) => {
        const parent = plan.parentId ? `源自 #${plan.parentId}` : "基线";
        return `
          <li class="plan-item ${plan.status === "active" ? "active" : ""}">
            <div class="plan-title">
              <span>#${plan.id} ${plan.name}</span>
              <span class="status-${plan.status}">${planStatusNames[plan.status]}</span>
            </div>
            <div class="plan-meta">${parent} · 起点 T+${plan.createdAt}s</div>
          </li>
        `;
      })
      .join("");
  }

  function renderEvents(state) {
    elements.eventLog.innerHTML = state.events
      .map(
        (event) => `
          <li class="${event.level}">
            <time>T+${event.t}s</time>
            <span class="level">${stageInfo[event.phase].title}</span>
            <span>${event.text}</span>
          </li>
        `
      )
      .join("");
  }

  function render() {
    const state = store.state;
    renderStage(state);
    renderProcess(state);
    renderControls(state);
    renderMetrics(state);
    renderPlans();
    renderEvents(state);
  }

  elements.stepBtn.addEventListener("click", step);
  elements.runBtn.addEventListener("click", () => {
    setRunning(timer === null);
  });
  elements.resetBtn.addEventListener("click", () => {
    setRunning(false);
    store = engine.createStore();
    showFeedback("已重置为基准稳态，历史失败尝试已清空。", true);
    render();
  });

  elements.valveA.addEventListener("change", (event) => {
    handleAction("setValveA", Number(event.target.value) / 100);
  });
  elements.valveB.addEventListener("change", (event) => {
    handleAction("setValveB", Number(event.target.value) / 100);
  });
  elements.load.addEventListener("change", (event) => {
    handleAction("setLoad", Number(event.target.value) / 100);
  });

  document.querySelectorAll("[data-cooling]").forEach((button) => {
    button.addEventListener("click", () => {
      handleAction("switchCooling", button.dataset.cooling);
    });
  });

  elements.recoverBtn.addEventListener("click", () => {
    const result = engine.beginRecovery(store);
    showFeedback(result.ok ? "恢复程序已启动。" : result.error, result.ok);
    render();
  });

  elements.restoreBtn.addEventListener("click", () => {
    const result = engine.restoreLastValidConfig(store);
    showFeedback(result.ok ? "最后有效配置已载入，风险状态仍需沿流程消除。" : result.error, result.ok);
    render();
  });

  elements.branchBtn.addEventListener("click", () => {
    const result = engine.createPlanAtStablePoint(store);
    showFeedback(result.ok ? "已在当前稳定点生成新方案。" : result.error, result.ok);
    render();
  });

  elements.abandonBtn.addEventListener("click", () => {
    const result = engine.abandonActiveAttempt(store);
    showFeedback(
      result.ok ? "失败尝试已回滚到稳定起点，并保留为失败记录。" : result.error,
      result.ok
    );
    render();
  });

  render();
})();
